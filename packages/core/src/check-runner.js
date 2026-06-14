import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { evaluateCommand } from "../../context/src/command-guard.js";
import { redactSecrets } from "../../context/src/redact.js";
import { appendCheckRecord } from "./check-log.js";
import { loadProjectChecks } from "./project.js";
import { loadSession } from "./shadow-workspace.js";

const OUTPUT_TAIL_LIMIT = 4000;

// Commands that execute scripts defined in a config file the agent controls in
// the shadow workspace. `npm test` looks innocent but runs whatever the agent
// put in package.json "scripts". If that config drifted from the trusted
// baseline, the check is skipped unless the user opts in after review.
const SCRIPT_CONFIG_TARGETS = [
  { test: /\b(npm|pnpm|yarn|bun)\b/i, files: ["package.json"] },
  { test: /\bmake\b/i, files: ["Makefile", "makefile", "GNUmakefile"] },
  { test: /\bjust\b/i, files: ["justfile", "Justfile", ".justfile"] },
  { test: /\b(task|go-task)\b/i, files: ["Taskfile.yml", "Taskfile.yaml", "Taskfile.dist.yml"] },
];

export async function runSessionChecks({
  repoRoot = process.cwd(),
  sessionId,
  checks,
  allowUntrustedChecks = false,
  now = new Date(),
} = {}) {
  const root = path.resolve(repoRoot);
  const session = await loadSession(root, sessionId);
  const checkDefinitions = normalizeChecks(checks ?? (await loadProjectChecks(root)));

  if (checkDefinitions.length === 0) {
    throw new Error("No checks configured. Pass --command or add checks[] to .vibeguard/config.json");
  }

  const records = [];
  for (const check of checkDefinitions) {
    records.push(await runOneCheck(root, session, check, { now, allowUntrustedChecks }));
  }

  return {
    session,
    checks: records,
    ok: records.every((record) => record.status === "passed"),
  };
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) {
    throw new Error("checks must be an array");
  }

  return checks.map((check, index) => {
    const name = String(check?.name ?? "").trim();
    const command = String(check?.command ?? "").trim();

    if (!name) {
      throw new Error(`checks[${index}].name is required`);
    }
    if (!command) {
      throw new Error(`checks[${index}].command is required`);
    }

    return { name, command };
  });
}

async function runOneCheck(repoRoot, session, check, options) {
  const guard = evaluateCommand(check.command);

  if (guard.decision !== "allowed") {
    return appendCheckRecord(repoRoot, session.id, {
      name: check.name,
      status: "skipped",
      command: check.command,
      summary: formatGuardSummary(guard),
      durationMs: 0,
      exitCode: null,
      stdoutTail: "",
      stderrTail: "",
    }, options);
  }

  if (!options.allowUntrustedChecks) {
    const untrusted = await findUntrustedScriptConfig(session, check.command);
    if (untrusted.length > 0) {
      return appendCheckRecord(repoRoot, session.id, {
        name: check.name,
        status: "skipped",
        command: check.command,
        summary: `Untrusted script config changed in shadow: ${untrusted.join(", ")} (re-run with --allow-untrusted-checks after reviewing it)`,
        durationMs: 0,
        exitCode: null,
        stdoutTail: "",
        stderrTail: "",
      }, options);
    }
  }

  const startedAt = Date.now();
  // Run through the platform shell so PATH-resolved shims (npm/pnpm/yarn -> *.cmd
  // on Windows) and shell syntax behave the way users wrote them in config.
  const result = spawnSync(check.command, {
    cwd: session.shadowPath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    shell: true,
  });
  const durationMs = Date.now() - startedAt;
  const exitCode = result.status ?? null;
  const status = result.error || exitCode !== 0 ? "failed" : "passed";
  const summary = result.error ? `spawn error: ${result.error.message}` : `exit ${exitCode}`;

  return appendCheckRecord(repoRoot, session.id, {
    name: check.name,
    status,
    command: check.command,
    summary,
    durationMs,
    exitCode,
    stdoutTail: redactOutput(tail(result.stdout ?? "")),
    stderrTail: redactOutput(tail(result.stderr ?? "")),
  }, options);
}

function formatGuardSummary(guard) {
  const reasons = guard.reasons.length > 0 ? ` (${guard.reasons.join(", ")})` : "";
  return `Command guard: ${guard.decision}${reasons}`;
}

function tail(value) {
  const text = String(value ?? "");
  return text.length > OUTPUT_TAIL_LIMIT ? text.slice(-OUTPUT_TAIL_LIMIT) : text;
}

function redactOutput(value) {
  return redactSecrets(value).content;
}

async function findUntrustedScriptConfig(session, command) {
  const baseline = session.snapshot?.manifest;
  if (!baseline || typeof baseline !== "object") {
    return [];
  }

  const candidates = new Set();
  for (const target of SCRIPT_CONFIG_TARGETS) {
    if (target.test.test(command)) {
      for (const file of target.files) {
        candidates.add(file);
      }
    }
  }

  const changed = [];
  for (const file of candidates) {
    const current = await hashShadowFile(session.shadowPath, file);
    if (current === null) {
      continue;
    }
    if ((baseline[file]?.hash ?? null) !== current) {
      changed.push(file);
    }
  }
  return changed;
}

async function hashShadowFile(shadowPath, relativeFile) {
  try {
    const bytes = await readFile(path.join(shadowPath, relativeFile));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

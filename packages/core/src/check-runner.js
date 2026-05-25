import { spawnSync } from "node:child_process";
import path from "node:path";

import { evaluateCommand } from "../../context/src/command-guard.js";
import { appendCheckRecord } from "./check-log.js";
import { loadProjectChecks } from "./project.js";
import { loadSession } from "./shadow-workspace.js";

const OUTPUT_TAIL_LIMIT = 4000;

export async function runSessionChecks({
  repoRoot = process.cwd(),
  sessionId,
  checks,
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
    records.push(await runOneCheck(root, session, check, { now }));
  }

  return {
    session,
    checks: records,
    ok: records.every((record) => record.status === "passed"),
  };
}

export function parseCommand(command) {
  const normalized = String(command ?? "").trim();
  if (!normalized) {
    throw new Error("Command is required");
  }

  const tokens = [];
  let token = "";
  let quote = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (quote) {
      if (char === "\\" && next === quote) {
        token += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }

  if (quote) {
    throw new Error("Command contains an unclosed quote");
  }
  if (token) {
    tokens.push(token);
  }
  if (tokens.length === 0) {
    throw new Error("Command is required");
  }

  return {
    executable: tokens[0],
    args: tokens.slice(1),
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

  const { executable, args } = parseCommand(check.command);
  const startedAt = Date.now();
  const result = spawnSync(executable, args, {
    cwd: session.shadowPath,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
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
  return String(value ?? "")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:API_KEY]")
    .replace(/\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)\b\s*=\s*[^\s]+/gi, "[REDACTED:SECRET]");
}

import { spawnSync } from "node:child_process";
import path from "node:path";

import { appendCommandRecord } from "./command-log.js";
import { loadSession } from "./shadow-workspace.js";

const DEFAULT_AGENT_REGISTRY = {
  codex: {
    command: "codex",
    defaultArgs: [],
  },
};

export async function runAgentSession({
  repoRoot = process.cwd(),
  sessionId,
  agent,
  args = [],
  dryRun = false,
  sandbox = [],
  agentRegistry = DEFAULT_AGENT_REGISTRY,
  now = new Date(),
} = {}) {
  const agentName = String(agent ?? "").trim();
  if (!agentName) {
    throw new Error("--agent is required");
  }

  const agentConfig = agentRegistry[agentName];
  if (!agentConfig) {
    throw new Error(`Unsupported agent: ${agentName}`);
  }

  const root = path.resolve(repoRoot);
  const session = await loadSession(root, sessionId);
  const executable = agentConfig.command;
  const allArgs = [
    ...(agentConfig.defaultArgs ?? []),
    ...args,
  ].map((item) => String(item));

  // Optional sandbox: a command prefix (e.g. ["docker","run","--rm","-v",
  // "{shadow}:/work","-w","/work","img"]) that wraps the agent launch. {shadow}
  // and {repo} placeholders are substituted. Without it, VibeGuard provides NO
  // containment — the agent is an ordinary child process with full host access.
  const sandboxWrapper = resolveSandboxWrapper(sandbox, {
    shadowPath: session.shadowPath,
    repoRoot: root,
  });
  const spawnExecutable = sandboxWrapper.length > 0 ? sandboxWrapper[0] : executable;
  const spawnArgs =
    sandboxWrapper.length > 0 ? [...sandboxWrapper.slice(1), executable, ...allArgs] : allArgs;
  const commandText = formatCommand([spawnExecutable, ...spawnArgs]);
  const baseResult = {
    sessionId: session.id,
    agent: agentName,
    cwd: session.shadowPath,
    executable,
    args: allArgs,
    sandbox: sandboxWrapper,
    commandText,
    ...(session.handoff?.path
      ? {
          handoffPath: session.handoff.path,
          handoffRelativePath: session.handoff.relativePath,
        }
      : {}),
    dryRun: Boolean(dryRun),
    exitCode: null,
  };

  if (dryRun) {
    return baseResult;
  }

  const record = await appendCommandRecord(root, session.id, {
    command: commandText,
    decision: "allowed",
    reasons: ["agent_launcher"],
  }, {
    now,
  });
  const env = {
    ...process.env,
    VIBEGUARD_SESSION_ID: session.id,
    VIBEGUARD_REPO_ROOT: root,
    VIBEGUARD_SHADOW_PATH: session.shadowPath,
  };
  if (session.handoff?.path) {
    env.VIBEGUARD_HANDOFF_PATH = session.handoff.path;
    env.VIBEGUARD_HANDOFF_RELATIVE_PATH = session.handoff.relativePath;
  }

  // On Windows a bare command (e.g. "codex", or "docker" when sandboxed) is
  // usually a *.cmd shim that spawnSync cannot resolve without a shell. Shell
  // only in that case so an explicit/absolute executable (and every POSIX
  // launch) keeps argv intact.
  const useShell = needsWindowsShell(spawnExecutable);
  const child = spawnSync(
    useShell ? quoteCommandLine([spawnExecutable, ...spawnArgs]) : spawnExecutable,
    useShell ? [] : spawnArgs,
    {
      cwd: session.shadowPath,
      env,
      stdio: "inherit",
      ...(useShell ? { shell: true } : {}),
    },
  );

  if (child.error) {
    throw new Error(`Failed to launch ${agentName}: ${child.error.message}`);
  }

  return {
    ...baseResult,
    exitCode: typeof child.status === "number" ? child.status : 1,
    signal: child.signal ?? null,
    commandRecord: record,
  };
}

function resolveSandboxWrapper(sandbox, { shadowPath, repoRoot }) {
  const tokens = Array.isArray(sandbox)
    ? sandbox
    : (sandbox ? String(sandbox).trim().split(/\s+/) : []);
  return tokens
    .map((token) => String(token))
    .filter(Boolean)
    .map((token) => token.replaceAll("{shadow}", shadowPath).replaceAll("{repo}", repoRoot));
}

function needsWindowsShell(executable) {
  if (process.platform !== "win32") {
    return false;
  }
  return (
    !path.isAbsolute(executable) &&
    !executable.includes("/") &&
    !executable.includes("\\")
  );
}

function quoteCommandLine(parts) {
  return parts.map(quoteShellPart).join(" ");
}

function quoteShellPart(part) {
  const value = String(part);
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function formatCommand(parts) {
  return parts.map(formatCommandPart).join(" ");
}

function formatCommandPart(part) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(part)) {
    return part;
  }
  return JSON.stringify(part);
}

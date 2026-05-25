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
  const commandText = formatCommand([executable, ...allArgs]);
  const baseResult = {
    sessionId: session.id,
    agent: agentName,
    cwd: session.shadowPath,
    executable,
    args: allArgs,
    commandText,
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
  const child = spawnSync(executable, allArgs, {
    cwd: session.shadowPath,
    env: {
      ...process.env,
      VIBEGUARD_SESSION_ID: session.id,
      VIBEGUARD_REPO_ROOT: root,
      VIBEGUARD_SHADOW_PATH: session.shadowPath,
    },
    stdio: "inherit",
  });

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

function formatCommand(parts) {
  return parts.map(formatCommandPart).join(" ");
}

function formatCommandPart(part) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(part)) {
    return part;
  }
  return JSON.stringify(part);
}

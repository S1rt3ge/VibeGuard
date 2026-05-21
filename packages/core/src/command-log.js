import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function appendCommandRecord(repoRoot, sessionId, decision, options = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const command = String(decision.command ?? "").trim();
  if (!command) {
    throw new Error("Command is required");
  }

  const root = path.resolve(repoRoot);
  const commandsDir = path.join(root, ".vibeguard", "commands");
  await mkdir(commandsDir, { recursive: true });

  const record = {
    schemaVersion: "0.1",
    sessionId: id,
    command,
    decision: decision.decision,
    reasons: [...(decision.reasons ?? [])],
    createdAt: (options.now ?? new Date()).toISOString(),
  };

  await appendFile(commandLogPath(root, id), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readCommandRecords(repoRoot, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const records = [];
  let skippedLines = 0;
  let text;

  try {
    text = await readFile(commandLogPath(repoRoot, id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      records.skippedLines = 0;
      return records;
    }
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      skippedLines += 1;
    }
  }

  records.skippedLines = skippedLines;
  return records;
}

function commandLogPath(repoRoot, sessionId) {
  return path.join(path.resolve(repoRoot), ".vibeguard", "commands", `${sessionId}.jsonl`);
}

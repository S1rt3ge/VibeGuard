import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const CHECK_STATUSES = new Set(["passed", "failed", "skipped"]);

export async function appendCheckRecord(repoRoot, sessionId, check, options = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const name = String(check?.name ?? "").trim();
  if (!name) {
    throw new Error("Check name is required");
  }

  const status = String(check?.status ?? "").trim();
  if (!CHECK_STATUSES.has(status)) {
    throw new Error("status must be one of: passed, failed, skipped");
  }

  const durationMs = normalizeDuration(check?.durationMs);
  const root = path.resolve(repoRoot);
  const checksDir = path.join(root, ".vibeguard", "checks");
  await mkdir(checksDir, { recursive: true });

  const record = {
    schemaVersion: "0.1",
    sessionId: id,
    name,
    status,
    command: String(check?.command ?? "").trim(),
    summary: String(check?.summary ?? "").trim(),
    durationMs,
    exitCode: normalizeExitCode(check?.exitCode),
    stdoutTail: String(check?.stdoutTail ?? ""),
    stderrTail: String(check?.stderrTail ?? ""),
    createdAt: (options.now ?? new Date()).toISOString(),
  };

  await appendFile(checkLogPath(root, id), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readCheckRecords(repoRoot, sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const records = [];
  let skippedLines = 0;
  let text;

  try {
    text = await readFile(checkLogPath(repoRoot, id), "utf8");
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

function normalizeDuration(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("durationMs must be a non-negative number");
  }
  return number;
}

function normalizeExitCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error("exitCode must be an integer or null");
  }
  return number;
}

function checkLogPath(repoRoot, sessionId) {
  return path.join(path.resolve(repoRoot), ".vibeguard", "checks", `${sessionId}.jsonl`);
}

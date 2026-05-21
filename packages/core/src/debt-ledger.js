import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeCapsuleDebt(capsule) {
  const slopProblems = capsule.slop?.problems ?? [];

  return {
    filesTouched: Array.isArray(capsule.applied)
      ? capsule.applied.length
      : capsule.filesChanged?.length ?? 0,
    blockedFiles: capsule.blocked?.length ?? 0,
    approvalRequiredChanges: capsule.approvalRequired?.length ?? 0,
    dependencyChanges: countDependencyChanges(capsule.approvalRequired ?? []),
    highRiskSession: capsule.risk?.level === "high" ? 1 : 0,
    todoCommentsAdded: countProblemNumber(slopProblems, /TODO comment/i),
    testsDeletedOrWeakened: countProblemNumber(slopProblems, /test.*deleted or weakened/i),
    slopScore: capsule.slop?.score ?? 0,
    commandsRequested: capsule.commands?.length ?? 0,
    blockedCommands: countCommandDecision(capsule.commands ?? [], "blocked"),
    approvalRequiredCommands: countCommandDecision(capsule.commands ?? [], "approval_required"),
    checksRun: capsule.checks?.length ?? 0,
    failedChecks: countCheckStatus(capsule.checks ?? [], "failed"),
    skippedChecks: countCheckStatus(capsule.checks ?? [], "skipped"),
    rollbacks: 0,
    rolledBackFiles: 0,
  };
}

export function summarizeRollbackDebt(rollback) {
  return {
    filesTouched: 0,
    blockedFiles: 0,
    approvalRequiredChanges: 0,
    dependencyChanges: 0,
    highRiskSession: 0,
    todoCommentsAdded: 0,
    testsDeletedOrWeakened: 0,
    slopScore: 0,
    commandsRequested: 0,
    blockedCommands: 0,
    approvalRequiredCommands: 0,
    checksRun: 0,
    failedChecks: 0,
    skippedChecks: 0,
    rollbacks: 1,
    rolledBackFiles: rollback.rolledBack?.length ?? 0,
  };
}

export async function appendDebtEntry(repoRoot, capsule, options = {}) {
  const root = path.resolve(repoRoot);
  const stateDir = path.join(root, ".vibeguard");
  await mkdir(stateDir, { recursive: true });

  const entry = {
    schemaVersion: "0.1",
    eventType: "capsule",
    capsuleId: capsule.id,
    task: capsule.task,
    sessionId: null,
    applyId: capsule.apply?.id ?? null,
    createdAt: (options.now ?? new Date()).toISOString(),
    metrics: summarizeCapsuleDebt(capsule),
  };

  await appendFile(
    debtLedgerPath(root),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );

  return entry;
}

export async function appendRollbackDebtEntry(repoRoot, rollback, options = {}) {
  const root = path.resolve(repoRoot);
  const stateDir = path.join(root, ".vibeguard");
  await mkdir(stateDir, { recursive: true });

  const entry = {
    schemaVersion: "0.1",
    eventType: "rollback",
    capsuleId: null,
    task: rollback.task ?? "",
    sessionId: rollback.sessionId ?? null,
    applyId: rollback.id ?? null,
    createdAt: rollback.rolledBackAt ?? (options.now ?? new Date()).toISOString(),
    metrics: summarizeRollbackDebt(rollback),
  };

  await appendFile(
    debtLedgerPath(root),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );

  return entry;
}

export async function readDebtEntries(repoRoot) {
  const entries = [];
  let skippedLines = 0;
  let text;

  try {
    text = await readFile(debtLedgerPath(repoRoot), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      entries.skippedLines = 0;
      return entries;
    }
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      skippedLines += 1;
    }
  }

  entries.skippedLines = skippedLines;
  return entries;
}

export function generateDebtReport(entries, options = {}) {
  const days = Number(options.days ?? 30);
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const filtered = entries.filter((entry) => new Date(entry.createdAt) >= cutoff);
  const report = {
    days,
    sessions: filtered.filter((entry) => entry.eventType !== "rollback").length,
    filesTouched: 0,
    blockedFiles: 0,
    approvalRequiredChanges: 0,
    dependencyChanges: 0,
    highRiskSessions: 0,
    todoCommentsAdded: 0,
    testsDeletedOrWeakened: 0,
    commandsRequested: 0,
    blockedCommands: 0,
    approvalRequiredCommands: 0,
    checksRun: 0,
    failedChecks: 0,
    skippedChecks: 0,
    rollbacks: 0,
    rolledBackFiles: 0,
    averageSlopScore: 0,
    skippedLines: entries.skippedLines ?? 0,
  };

  let totalSlop = 0;
  for (const entry of filtered) {
    const metrics = entry.metrics ?? {};
    report.filesTouched += metrics.filesTouched ?? 0;
    report.blockedFiles += metrics.blockedFiles ?? 0;
    report.approvalRequiredChanges += metrics.approvalRequiredChanges ?? 0;
    report.dependencyChanges += metrics.dependencyChanges ?? 0;
    report.highRiskSessions += metrics.highRiskSession ?? 0;
    report.todoCommentsAdded += metrics.todoCommentsAdded ?? 0;
    report.testsDeletedOrWeakened += metrics.testsDeletedOrWeakened ?? 0;
    report.commandsRequested += metrics.commandsRequested ?? 0;
    report.blockedCommands += metrics.blockedCommands ?? 0;
    report.approvalRequiredCommands += metrics.approvalRequiredCommands ?? 0;
    report.checksRun += metrics.checksRun ?? 0;
    report.failedChecks += metrics.failedChecks ?? 0;
    report.skippedChecks += metrics.skippedChecks ?? 0;
    report.rollbacks += metrics.rollbacks ?? 0;
    report.rolledBackFiles += metrics.rolledBackFiles ?? 0;
    totalSlop += metrics.slopScore ?? 0;
  }

  report.averageSlopScore =
    filtered.length === 0 ? 0 : Math.round(totalSlop / filtered.length);

  return report;
}

function debtLedgerPath(repoRoot) {
  return path.join(path.resolve(repoRoot), ".vibeguard", "debt-ledger.jsonl");
}

function countDependencyChanges(items) {
  return items.filter((item) => item.reasons?.includes("dependency_change")).length;
}

function countCommandDecision(items, decision) {
  return items.filter((item) => item.decision === decision).length;
}

function countCheckStatus(items, status) {
  return items.filter((item) => item.status === status).length;
}

function countProblemNumber(problems, pattern) {
  const problem = problems.find((item) => pattern.test(item));
  if (!problem) {
    return 0;
  }
  const match = problem.match(/\d+/);
  return match ? Number(match[0]) : 1;
}

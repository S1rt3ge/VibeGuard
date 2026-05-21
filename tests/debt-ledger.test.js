import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createCapsule } from "../packages/core/src/capsule-store.js";
import {
  appendDebtEntry,
  appendRollbackDebtEntry,
  generateDebtReport,
  readDebtEntries,
  summarizeCapsuleDebt,
} from "../packages/core/src/debt-ledger.js";
import { applySafeChanges, createShadowSession } from "../packages/core/src/shadow-workspace.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("summarizeCapsuleDebt derives practical AI debt metrics", () => {
  const capsule = createDebtFixtureCapsule();
  const summary = summarizeCapsuleDebt(capsule);

  assert.deepEqual(summary, {
    filesTouched: 1,
    blockedFiles: 1,
    approvalRequiredChanges: 2,
    dependencyChanges: 1,
    highRiskSession: 1,
    todoCommentsAdded: 3,
    testsDeletedOrWeakened: 2,
    slopScore: 76,
    commandsRequested: 0,
    blockedCommands: 0,
    approvalRequiredCommands: 0,
    checksRun: 0,
    failedChecks: 0,
    skippedChecks: 0,
    rollbacks: 0,
    rolledBackFiles: 0,
  });
});

test("appendDebtEntry and readDebtEntries roundtrip JSONL entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-debt-"));

  try {
    const capsule = createDebtFixtureCapsule();
    const entry = await appendDebtEntry(root, capsule, {
      now: new Date("2026-05-17T12:00:00.000Z"),
    });
    const entries = await readDebtEntries(root);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].capsuleId, capsule.id);
    assert.equal(entries[0].eventType, "capsule");
    assert.deepEqual(entries[0], entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendRollbackDebtEntry writes rollback event metrics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-rollback-debt-"));

  try {
    const entry = await appendRollbackDebtEntry(root, {
      id: "apply-1",
      sessionId: "session-1",
      task: "rollback billing",
      rolledBack: ["src/app.js", "src/new.js"],
      rolledBackAt: "2026-05-17T12:30:00.000Z",
    });
    const entries = await readDebtEntries(root);

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], entry);
    assert.equal(entry.eventType, "rollback");
    assert.equal(entry.sessionId, "session-1");
    assert.equal(entry.applyId, "apply-1");
    assert.equal(entry.metrics.rollbacks, 1);
    assert.equal(entry.metrics.rolledBackFiles, 2);
    assert.equal(entry.createdAt, "2026-05-17T12:30:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generateDebtReport filters by date and skips corrupt JSONL lines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-debt-report-"));

  try {
    await mkdir(path.join(root, ".vibeguard"), { recursive: true });
    const ledgerPath = path.join(root, ".vibeguard", "debt-ledger.jsonl");
    await writeFile(
      ledgerPath,
      [
        JSON.stringify(makeDebtEntry("recent", "2026-05-16T00:00:00.000Z", { filesTouched: 3 })),
        JSON.stringify(makeRollbackEntry("rollback", "2026-05-16T01:00:00.000Z", {
          rollbacks: 1,
          rolledBackFiles: 2,
        })),
        "{not-json",
        JSON.stringify(makeDebtEntry("old", "2026-03-01T00:00:00.000Z", { filesTouched: 99 })),
        "",
      ].join("\n"),
    );

    const entries = await readDebtEntries(root);
    const report = generateDebtReport(entries, {
      days: 30,
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    assert.equal(entries.skippedLines, 1);
    assert.equal(report.days, 30);
    assert.equal(report.sessions, 1);
    assert.equal(report.filesTouched, 3);
    assert.equal(report.rollbacks, 1);
    assert.equal(report.rolledBackFiles, 2);
    assert.equal(report.skippedLines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges appends an AI debt entry", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "safe apply with debt",
      sessionId: "debt-session",
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");
    await writeFile(path.join(session.shadowPath, "package-lock.json"), "{}\n");

    const result = await applySafeChanges(root, "debt-session", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
    });
    const entries = await readDebtEntries(root);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].capsuleId, result.capsule.id);
    assert.equal(entries[0].metrics.filesTouched, 1);
    assert.equal(entries[0].metrics.blockedFiles, 1);
    assert.equal(entries[0].metrics.dependencyChanges, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI debt report prints aggregate metrics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-debt-cli-"));

  try {
    await appendDebtEntry(root, createDebtFixtureCapsule(), {
      now: new Date("2026-05-17T12:00:00.000Z"),
    });

    const result = spawnSync(
      process.execPath,
      [cliPath, "debt", "report", "--root", root, "--days", "30"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AI Debt Report - last 30 days/);
    assert.match(result.stdout, /Sessions: 1/);
    assert.match(result.stdout, /Files touched: 1/);
    assert.match(result.stdout, /Dependency changes: 1/);
    assert.match(result.stdout, /High-risk sessions: 1/);
    assert.match(result.stdout, /Rollbacks: 0/);
    assert.match(result.stdout, /Rolled back files: 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI debt report rejects invalid days", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "debt", "report", "--days", "zero"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--days must be a positive number/);
});

function createDebtFixtureCapsule() {
  return createCapsule({
    task: "add billing",
    review: {
      blocked: [{ path: ".env.local", reasons: ["protected_file"], riskZones: ["secrets"] }],
      approvalRequired: [
        { path: "package-lock.json", reasons: ["dependency_change"], riskZones: ["dependencies"] },
        { path: "app/auth/session.ts", reasons: ["auth_change"], riskZones: ["auth"] },
      ],
      reviewable: [{ path: "app/billing/page.tsx", reasons: [], riskZones: ["payments"] }],
    },
    score: {
      risk: { level: "high", reasons: ["blocked_files_touched"] },
      slop: {
        score: 76,
        problems: ["3 TODO comments added", "2 tests deleted or weakened"],
      },
    },
    applied: ["app/billing/page.tsx"],
    humanApproval: "safe_apply",
    now: new Date("2026-05-17T10:00:00.000Z"),
  });
}

function makeDebtEntry(id, createdAt, metricsOverrides = {}) {
  return {
    schemaVersion: "0.1",
    capsuleId: id,
    task: id,
    createdAt,
    metrics: {
      filesTouched: 0,
      blockedFiles: 0,
      approvalRequiredChanges: 0,
      dependencyChanges: 0,
      highRiskSession: 0,
      todoCommentsAdded: 0,
      testsDeletedOrWeakened: 0,
      slopScore: 0,
      rollbacks: 0,
      rolledBackFiles: 0,
      ...metricsOverrides,
    },
  };
}

function makeRollbackEntry(id, createdAt, metricsOverrides = {}) {
  return {
    schemaVersion: "0.1",
    eventType: "rollback",
    capsuleId: null,
    task: id,
    sessionId: `${id}-session`,
    applyId: `${id}-apply`,
    createdAt,
    metrics: {
      filesTouched: 0,
      blockedFiles: 0,
      approvalRequiredChanges: 0,
      dependencyChanges: 0,
      highRiskSession: 0,
      todoCommentsAdded: 0,
      testsDeletedOrWeakened: 0,
      slopScore: 0,
      rollbacks: 0,
      rolledBackFiles: 0,
      ...metricsOverrides,
    },
  };
}

async function createApplyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-debt-apply-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, ".env.local"), "TOKEN=root\n");
  return root;
}

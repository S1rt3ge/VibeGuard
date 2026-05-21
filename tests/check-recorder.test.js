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
  appendCheckRecord,
  readCheckRecords,
} from "../packages/core/src/check-log.js";
import { summarizeCapsuleDebt } from "../packages/core/src/debt-ledger.js";
import { applySafeChanges, createShadowSession } from "../packages/core/src/shadow-workspace.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";
import { formatCheckHistory } from "../packages/reporters/src/text.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("appendCheckRecord and readCheckRecords roundtrip JSONL check records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-check-log-"));

  try {
    const record = await appendCheckRecord(root, "session-1", {
      name: "unit",
      status: "passed",
      command: "npm test",
      summary: "49 tests passed",
      durationMs: 1234,
    }, {
      now: new Date("2026-05-17T12:00:00.000Z"),
    });
    const records = await readCheckRecords(root, "session-1");

    assert.equal(records.length, 1);
    assert.deepEqual(records[0], record);
    assert.equal(records[0].schemaVersion, "0.1");
    assert.equal(records[0].sessionId, "session-1");
    assert.equal(records[0].durationMs, 1234);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readCheckRecords returns empty history and skips corrupt lines", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-check-corrupt-"));

  try {
    const missing = await readCheckRecords(root, "missing");
    assert.equal(missing.length, 0);
    assert.equal(missing.skippedLines, 0);

    await mkdir(path.join(root, ".vibeguard", "checks"), { recursive: true });
    await writeFile(
      path.join(root, ".vibeguard", "checks", "session-1.jsonl"),
      [
        JSON.stringify({
          schemaVersion: "0.1",
          sessionId: "session-1",
          name: "lint",
          status: "failed",
          command: "npm run lint",
          summary: "one lint error",
          durationMs: null,
          createdAt: "2026-05-17T12:00:00.000Z",
        }),
        "{not-json",
        "",
      ].join("\n"),
    );

    const records = await readCheckRecords(root, "session-1");
    assert.equal(records.length, 1);
    assert.equal(records.skippedLines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendCheckRecord validates status and duration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-check-invalid-"));

  try {
    await assert.rejects(
      () => appendCheckRecord(root, "", { name: "unit", status: "passed" }),
      /Session is required/,
    );
    await assert.rejects(
      () => appendCheckRecord(root, "session-1", { status: "passed" }),
      /Check name is required/,
    );
    await assert.rejects(
      () => appendCheckRecord(root, "session-1", { name: "unit", status: "maybe" }),
      /status must be one of/,
    );
    await assert.rejects(
      () => appendCheckRecord(root, "session-1", {
        name: "unit",
        status: "passed",
        durationMs: -1,
      }),
      /durationMs must be a non-negative number/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatCheckHistory handles empty histories and corrupt-line counts", () => {
  const empty = [];
  empty.skippedLines = 0;
  assert.match(formatCheckHistory("session-empty", empty), /No check records/);

  const records = [
    {
      name: "e2e",
      status: "skipped",
      command: "",
      summary: "",
      durationMs: null,
    },
  ];
  records.skippedLines = 1;

  const text = formatCheckHistory("session-1", records);
  assert.match(text, /skipped e2e/);
  assert.match(text, /Skipped corrupt lines: 1/);
});

test("CLI check commands validate required options and subcommands", () => {
  const missingSession = spawnSync(
    process.execPath,
    [cliPath, "check", "history"],
    { encoding: "utf8" },
  );
  assert.equal(missingSession.status, 1);
  assert.match(missingSession.stderr, /--session is required/);

  const missingName = spawnSync(
    process.execPath,
    [
      cliPath,
      "check",
      "record",
      "--session",
      "session-1",
      "--status",
      "passed",
    ],
    { encoding: "utf8" },
  );
  assert.equal(missingName.status, 1);
  assert.match(missingName.stderr, /--name is required/);

  const unknown = spawnSync(
    process.execPath,
    [cliPath, "check", "unknown", "--session", "session-1"],
    { encoding: "utf8" },
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown check command/);
});

test("CLI check record writes audit records and history prints them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-check-cli-"));

  try {
    const record = spawnSync(
      process.execPath,
      [
        cliPath,
        "check",
        "record",
        "--root",
        root,
        "--session",
        "session-1",
        "--name",
        "unit",
        "--status",
        "passed",
        "--command",
        "npm test",
        "--summary",
        "49 tests passed",
        "--duration-ms",
        "1200",
      ],
      { encoding: "utf8" },
    );
    assert.equal(record.status, 0, record.stderr);
    assert.match(record.stdout, /Recorded check unit: passed/);

    const history = spawnSync(
      process.execPath,
      [cliPath, "check", "history", "--root", root, "--session", "session-1"],
      { encoding: "utf8" },
    );
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /Check History: session-1/);
    assert.match(history.stdout, /passed unit/);
    assert.match(history.stdout, /npm test/);
    assert.match(history.stdout, /49 tests passed/);

    const records = await readCheckRecords(root, "session-1");
    assert.equal(records.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges includes session check history in capsule and debt", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "apply with checks",
      sessionId: "session-checks",
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await appendCheckRecord(root, "session-checks", {
      name: "unit",
      status: "passed",
      command: "npm test",
    });
    await appendCheckRecord(root, "session-checks", {
      name: "lint",
      status: "failed",
      command: "npm run lint",
      summary: "lint failed before apply",
    });

    const result = await applySafeChanges(root, "session-checks", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
    });
    const capsule = JSON.parse(await readFile(result.capsulePath, "utf8"));

    assert.deepEqual(
      capsule.checks.map((record) => `${record.status}:${record.name}`),
      ["passed:unit", "failed:lint"],
    );
    assert.equal(result.debtEntry.metrics.checksRun, 2);
    assert.equal(result.debtEntry.metrics.failedChecks, 1);
    assert.equal(result.debtEntry.metrics.skippedChecks, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizeCapsuleDebt counts check metrics", () => {
  const capsule = createCapsule({
    task: "check debt",
    review: { blocked: [], approvalRequired: [], reviewable: [] },
    score: { risk: { level: "low", reasons: [] }, slop: { score: 0, problems: [] } },
    checks: [
      { name: "unit", status: "passed" },
      { name: "lint", status: "failed" },
      { name: "e2e", status: "skipped" },
    ],
    now: new Date("2026-05-17T12:00:00.000Z"),
  });

  const summary = summarizeCapsuleDebt(capsule);

  assert.equal(summary.checksRun, 3);
  assert.equal(summary.failedChecks, 1);
  assert.equal(summary.skippedChecks, 1);
});

async function createApplyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-check-apply-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  return root;
}

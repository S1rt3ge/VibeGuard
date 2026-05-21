import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createCapsule } from "../packages/core/src/capsule-store.js";
import { appendDebtEntry } from "../packages/core/src/debt-ledger.js";
import { createShadowSession } from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("CLI version --json prints parseable runtime payload", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const result = spawnSync(process.execPath, [cliPath, "version", "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /VibeGuard /);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.schemaVersion, "0.1");
  assert.equal(payload.command, "version");
  assert.equal(payload.version, packageJson.version);
  assert.equal(payload.node, process.version);
  assert.equal(payload.platform, process.platform);
  assert.equal(payload.arch, process.arch);
});

test("CLI init --json prints parseable initialization payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-json-init-"));

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "init", "--root", root, "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Initialized VibeGuard/);
    assert.doesNotMatch(result.stdout, /Next:/);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "init");
    assert.match(payload.stateDir, /\.vibeguard$/);
    assert.match(payload.configPath, /\.vibeguard[\\/]config\.json$/);
    assert.deepEqual(payload.next, [
      "vibeguard doctor",
      'vibeguard task "fix login bug" --allow "app/**,lib/**,tests/**"',
    ]);
    await access(payload.configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI task --json prints parseable session payload", async () => {
  const root = await createJsonFixture();

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "task",
        "json task",
        "--root",
        root,
        "--session",
        "json-task-session",
        "--allow",
        "src/**,tests/**",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Created shadow session/);
    assert.doesNotMatch(result.stdout, /Open the shadow workspace/);
    assert.doesNotMatch(result.stdout, /Next:/);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "task");
    assert.equal(payload.session.id, "json-task-session");
    assert.equal(payload.session.task, "json task");
    assert.equal(payload.session.agent, "codex");
    assert.equal(payload.session.model, "unknown");
    assert.deepEqual(payload.session.policy.allowedGlobs, ["src/**", "tests/**"]);
    assert.equal(payload.session.status, "created");
    assert.match(payload.session.shadowPath, /json-task-session$/);
    assert.match(payload.session.sessionPath, /json-task-session\.json$/);
    assert.equal(payload.session.snapshot.files, 2);
    assert.ok(payload.session.snapshot.excluded.includes(".env*"));
    await access(payload.session.sessionPath);
    await access(payload.session.shadowPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI manual review --json prints parseable review payload", () => {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "review",
      "--files",
      "src/app.js,.env.local,package-lock.json",
      "--allow",
      "src/**",
      "--json",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.schemaVersion, "0.1");
  assert.equal(payload.command, "review");
  assert.deepEqual(payload.files, ["src/app.js", ".env.local", "package-lock.json"]);
  assert.deepEqual(payload.review.reviewable.map((item) => item.path), ["src/app.js"]);
  assert.deepEqual(payload.review.blocked.map((item) => item.path), [".env.local"]);
  assert.equal(payload.score.risk.level, "high");
});

test("CLI session review --json and status --json expose quarantine state", async () => {
  const root = await createJsonFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "json review",
      sessionId: "json-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

    const review = spawnSync(
      process.execPath,
      [cliPath, "review", "--root", root, "--session", "json-session", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(review.status, 0, review.stderr);
    const reviewPayload = JSON.parse(review.stdout);

    assert.equal(reviewPayload.schemaVersion, "0.1");
    assert.equal(reviewPayload.command, "review");
    assert.equal(reviewPayload.sessionId, "json-session");
    assert.deepEqual(
      reviewPayload.diff.map((item) => `${item.status}:${item.path}`).sort(),
      ["modified:docs/notes.md", "modified:src/app.js"],
    );
    assert.equal(reviewPayload.review.blocked.length, 1);

    const status = spawnSync(
      process.execPath,
      [cliPath, "status", "--root", root, "--session", "json-session", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);

    assert.equal(statusPayload.schemaVersion, "0.1");
    assert.equal(statusPayload.command, "status");
    assert.equal(statusPayload.status.session.id, "json-session");
    assert.equal(statusPayload.status.changedFiles, 2);
    assert.equal(statusPayload.status.blocked, 1);
    assert.deepEqual(statusPayload.status.allowedGlobs, ["src/**"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI debt report --json prints parseable aggregate metrics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-json-debt-"));

  try {
    await appendDebtEntry(root, createCapsule({
      task: "json debt",
      review: {
        blocked: [],
        approvalRequired: [],
        reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }],
      },
      score: {
        risk: { level: "low", reasons: [] },
        slop: { score: 0, problems: [] },
      },
      applied: ["src/app.js"],
      now: new Date("2026-05-17T12:00:00.000Z"),
    }), {
      now: new Date("2026-05-17T12:00:00.000Z"),
    });

    const result = spawnSync(
      process.execPath,
      [cliPath, "debt", "report", "--root", root, "--days", "30", "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "debt_report");
    assert.equal(payload.report.sessions, 1);
    assert.equal(payload.report.filesTouched, 1);
    assert.equal(payload.report.rollbacks, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply --safe --json prints parseable apply payload", async () => {
  const root = await createJsonFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "json apply",
      sessionId: "json-apply-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "json-apply-session",
        "--files",
        "src/new.js",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Applied:/);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "apply");
    assert.equal(payload.sessionId, "json-apply-session");
    assert.deepEqual(payload.applied, ["src/new.js"]);
    assert.deepEqual(payload.skipped, { blocked: 1, approvalRequired: 0 });
    assert.equal(payload.apply.files, 1);
    assert.match(payload.apply.id, /json-apply-session/);
    assert.match(payload.apply.manifestPath, /manifest\.json$/);
    assert.match(payload.capsulePath, /json-apply\.json$/);
    assert.equal(payload.debtEntry.eventType, "capsule");
    assert.equal(payload.debtEntry.metrics.filesTouched, 1);
    assert.equal(await exists(path.join(root, "src", "new.js")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply --safe --dry-run --json prints preview payload without artifacts", async () => {
  const root = await createJsonFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "json dry run apply",
      sessionId: "json-dry-run-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--dry-run",
        "--root",
        root,
        "--session",
        "json-dry-run-session",
        "--files",
        "src/new.js",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Applied:/);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "apply");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.sessionId, "json-dry-run-session");
    assert.deepEqual(payload.wouldApply, ["src/new.js"]);
    assert.deepEqual(payload.applied, []);
    assert.deepEqual(payload.skipped, { blocked: 1, approvalRequired: 0 });
    assert.equal(await exists(path.join(root, "src", "new.js")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "json-dry-run-session")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "capsules")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "debt.jsonl")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rollback --json prints parseable rollback payload", async () => {
  const root = await createJsonFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "json rollback",
      sessionId: "json-rollback-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "temporary file\n");

    const apply = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "json-rollback-session",
        "--files",
        "src/new.js",
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(apply.status, 0, apply.stderr);
    const applyPayload = JSON.parse(apply.stdout);
    assert.equal(await exists(path.join(root, "src", "new.js")), true);

    const rollback = spawnSync(
      process.execPath,
      [
        cliPath,
        "rollback",
        "--root",
        root,
        "--session",
        "json-rollback-session",
        "--apply",
        applyPayload.apply.id,
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(rollback.status, 0, rollback.stderr);
    assert.doesNotMatch(rollback.stdout, /Rolled back apply:/);
    const payload = JSON.parse(rollback.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "rollback");
    assert.equal(payload.sessionId, "json-rollback-session");
    assert.equal(payload.applyId, applyPayload.apply.id);
    assert.deepEqual(payload.rolledBack, ["src/new.js"]);
    assert.match(payload.manifestPath, /manifest\.json$/);
    assert.match(payload.rolledBackAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.debtEntry.eventType, "rollback");
    assert.equal(payload.debtEntry.metrics.rollbacks, 1);
    assert.equal(payload.debtEntry.metrics.rolledBackFiles, 1);
    assert.equal(await exists(path.join(root, "src", "new.js")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createJsonFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-json-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "notes.md"), "notes\n");
  return root;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

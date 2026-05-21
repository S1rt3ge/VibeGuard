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

import { appendCheckRecord } from "../packages/core/src/check-log.js";
import { appendCommandRecord } from "../packages/core/src/command-log.js";
import {
  applySafeChanges,
  buildSessionStatus,
  createShadowSession,
  reviewShadowSession,
} from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("createShadowSession persists allowed scope policy", async () => {
  const root = await createScopeFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "scoped task",
      sessionId: "scope-session",
      allowedGlobs: ["src/**", "tests/**"],
    });
    const saved = JSON.parse(await readFile(session.sessionPath, "utf8"));

    assert.deepEqual(saved.policy.allowedGlobs, ["src/**", "tests/**"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewShadowSession uses persisted session scope when no override is provided", async () => {
  const root = await createScopeFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "scoped review",
      sessionId: "review-scope",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

    const result = await reviewShadowSession(root, "review-scope");

    assert.deepEqual(result.review.reviewable.map((item) => item.path), ["src/app.js"]);
    assert.deepEqual(result.review.blocked.map((item) => item.path), ["docs/notes.md"]);
    assert.ok(result.review.blocked[0].reasons.includes("outside_declared_scope"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges uses persisted session scope and skips out-of-scope shadow files", async () => {
  const root = await createScopeFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "scoped apply",
      sessionId: "apply-scope",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

    const result = await applySafeChanges(root, "apply-scope");

    assert.deepEqual(result.applied, ["src/app.js"]);
    assert.equal(await readFile(path.join(root, "src", "app.js"), "utf8"), "safe change\n");
    assert.equal(await readFile(path.join(root, "docs", "notes.md"), "utf8"), "notes\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSessionStatus aggregates review, risk, scope, and command counts", async () => {
  const root = await createScopeFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "status task",
      sessionId: "status-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");
    await appendCommandRecord(root, "status-session", {
      command: "npm test",
      decision: "allowed",
      reasons: [],
    });
    await appendCommandRecord(root, "status-session", {
      command: "rm -rf dist",
      decision: "blocked",
      reasons: ["destructive_remove"],
    });
    await appendCheckRecord(root, "status-session", {
      name: "unit",
      status: "passed",
      command: "npm test",
    });
    await appendCheckRecord(root, "status-session", {
      name: "lint",
      status: "failed",
      command: "npm run lint",
    });

    const status = await buildSessionStatus(root, "status-session");

    assert.equal(status.session.id, "status-session");
    assert.deepEqual(status.allowedGlobs, ["src/**"]);
    assert.equal(status.changedFiles, 2);
    assert.equal(status.blocked, 1);
    assert.equal(status.reviewable, 1);
    assert.equal(status.commands.total, 2);
    assert.equal(status.commands.blocked, 1);
    assert.equal(status.checks.total, 2);
    assert.equal(status.checks.passed, 1);
    assert.equal(status.checks.failed, 1);
    assert.equal(status.risk.level, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI task --allow persists scope and status prints quarantine summary", async () => {
  const root = await createScopeFixture();

  try {
    const task = spawnSync(
      process.execPath,
      [
        cliPath,
        "task",
        "cli scoped task",
        "--root",
        root,
        "--session",
        "cli-scope",
        "--allow",
        "src/**",
      ],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const sessionPath = path.join(root, ".vibeguard", "sessions", "cli-scope.json");
    const saved = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.deepEqual(saved.policy.allowedGlobs, ["src/**"]);

    await writeFile(path.join(saved.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(saved.shadowPath, "docs", "notes.md"), "scope drift\n");
    await appendCheckRecord(root, "cli-scope", {
      name: "unit",
      status: "passed",
      command: "npm test",
    });

    const review = spawnSync(
      process.execPath,
      [cliPath, "review", "--root", root, "--session", "cli-scope"],
      { encoding: "utf8" },
    );
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /Blocked: 1/);
    assert.match(review.stdout, /Reviewable: 1/);
    assert.match(review.stdout, /blocked docs\/notes\.md/);

    const status = spawnSync(
      process.execPath,
      [cliPath, "status", "--root", root, "--session", "cli-scope"],
      { encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Session: cli-scope/);
    assert.match(status.stdout, /Allowed scope: src\/\*\*/);
    assert.match(status.stdout, /Changed files: 2/);
    assert.match(status.stdout, /Blocked: 1/);
    assert.match(status.stdout, /Reviewable: 1/);
    assert.match(status.stdout, /Checks: 1/);
    assert.match(status.stdout, /Passed checks: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI status can use latest session when --session is omitted", async () => {
  const root = await createScopeFixture();

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "latest status", "--root", root, "--session", "latest-scope"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const status = spawnSync(
      process.execPath,
      [cliPath, "status", "--root", root],
      { encoding: "utf8" },
    );

    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Session: latest-scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createScopeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-scope-status-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "notes.md"), "notes\n");
  return root;
}

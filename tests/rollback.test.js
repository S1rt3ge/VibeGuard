import assert from "node:assert/strict";
import {
  access,
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

import {
  applySafeChanges,
  createShadowSession,
  rollbackAppliedChanges,
} from "../packages/core/src/shadow-workspace.js";
import { readDebtEntries } from "../packages/core/src/debt-ledger.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("applySafeChanges writes backup manifest and rollback restores file states", async () => {
  const root = await createRollbackFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "rollback safe apply",
      sessionId: "rollback-session",
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await rm(path.join(session.shadowPath, "docs", "usage.md"));

    const applyResult = await applySafeChanges(root, "rollback-session", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**", "docs/**"] }),
    });
    const manifest = JSON.parse(await readFile(applyResult.applyRecord.manifestPath, "utf8"));
    const savedCapsule = JSON.parse(await readFile(applyResult.capsulePath, "utf8"));

    assert.equal(manifest.sessionId, "rollback-session");
    assert.equal(manifest.files.length, 3);
    assert.equal(savedCapsule.apply.id, applyResult.applyRecord.id);
    assert.equal(await readText(path.join(root, "src", "app.js")), "safe change\n");
    assert.equal(await readText(path.join(root, "src", "new.js")), "new safe file\n");
    assert.equal(await exists(path.join(root, "docs", "usage.md")), false);

    const rollback = await rollbackAppliedChanges(root, "rollback-session", {
      applyId: applyResult.applyRecord.id,
      now: new Date("2026-05-17T13:00:00.000Z"),
    });
    const rolledManifest = JSON.parse(await readFile(rollback.manifestPath, "utf8"));
    const debtEntries = await readDebtEntries(root);
    const rollbackEntry = debtEntries.find((entry) => entry.eventType === "rollback");

    assert.deepEqual(rollback.rolledBack.sort(), ["docs/usage.md", "src/app.js", "src/new.js"]);
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await exists(path.join(root, "src", "new.js")), false);
    assert.equal(await readText(path.join(root, "docs", "usage.md")), "usage\n");
    assert.equal(rolledManifest.rolledBackAt, "2026-05-17T13:00:00.000Z");
    assert.equal(debtEntries.length, 2);
    assert.equal(rollbackEntry.sessionId, "rollback-session");
    assert.equal(rollbackEntry.applyId, applyResult.applyRecord.id);
    assert.equal(rollbackEntry.metrics.rollbacks, 1);
    assert.equal(rollbackEntry.metrics.rolledBackFiles, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rollback restores the latest apply for a session", async () => {
  const root = await createRollbackFixture();

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "cli rollback", "--root", root, "--session", "cli-rollback"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const shadowPath = path.join(root, ".vibeguard", "shadows", "cli-rollback");
    await writeFile(path.join(shadowPath, "src", "app.js"), "cli safe change\n");
    await writeFile(path.join(shadowPath, "src", "new.js"), "cli new file\n");

    const apply = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "cli-rollback",
        "--allow",
        "src/**",
      ],
      { encoding: "utf8" },
    );
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Apply id:/);
    assert.equal(await readText(path.join(root, "src", "app.js")), "cli safe change\n");
    assert.equal(await readText(path.join(root, "src", "new.js")), "cli new file\n");

    const rollback = spawnSync(
      process.execPath,
      [cliPath, "rollback", "--root", root, "--session", "cli-rollback"],
      { encoding: "utf8" },
    );
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.match(rollback.stdout, /Rolled back apply:/);
    assert.match(rollback.stdout, /Files restored: 2/);
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await exists(path.join(root, "src", "new.js")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback validates session and missing apply records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-rollback-empty-"));

  try {
    await assert.rejects(
      () => rollbackAppliedChanges(root, ""),
      /Session is required/,
    );
    await assert.rejects(
      () => rollbackAppliedChanges(root, "missing-session"),
      /No apply records found/,
    );

    const cli = spawnSync(
      process.execPath,
      [cliPath, "rollback", "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /--session is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback refuses an already rolled back apply", async () => {
  const root = await createRollbackFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "double rollback",
      sessionId: "double-rollback",
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    const applyResult = await applySafeChanges(root, "double-rollback", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
    });

    await rollbackAppliedChanges(root, "double-rollback", {
      applyId: applyResult.applyRecord.id,
    });

    await assert.rejects(
      () => rollbackAppliedChanges(root, "double-rollback", {
        applyId: applyResult.applyRecord.id,
      }),
      /already rolled back/,
    );
    const debtEntries = await readDebtEntries(root);
    assert.equal(
      debtEntries.filter((entry) => entry.eventType === "rollback").length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRollbackFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-rollback-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "usage.md"), "usage\n");
  return root;
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

import { appendCheckRecord } from "../packages/core/src/check-log.js";
import { appendCommandRecord } from "../packages/core/src/command-log.js";
import {
  applySafeChanges,
  createShadowSession,
} from "../packages/core/src/shadow-workspace.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("applySafeChanges writes finalized approval metadata into capsule", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "finalize billing apply",
      sessionId: "finalize-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");
    await writeFile(path.join(session.shadowPath, "package-lock.json"), "{}\n");
    await appendCommandRecord(root, "finalize-session", {
      command: "npm test",
      decision: "allowed",
      reasons: [],
    });
    await appendCheckRecord(root, "finalize-session", {
      name: "unit",
      status: "passed",
      command: "npm test",
    });

    const result = await applySafeChanges(root, "finalize-session", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
    });
    const capsule = JSON.parse(await readFile(result.capsulePath, "utf8"));

    assert.deepEqual(result.approval, {
      decision: "safe_apply",
      applied: ["src/app.js"],
      skipped: {
        blocked: [".env.local"],
        approvalRequired: ["package-lock.json"],
      },
    });
    assert.equal(capsule.sessionId, "finalize-session");
    assert.equal(capsule.humanApproval, "safe_apply");
    assert.equal(capsule.apply.decision, "safe_apply");
    assert.deepEqual(capsule.apply.applied, ["src/app.js"]);
    assert.deepEqual(capsule.apply.skipped, {
      blocked: [".env.local"],
      approvalRequired: ["package-lock.json"],
    });
    assert.deepEqual(capsule.commands.map((record) => record.command), ["npm test"]);
    assert.deepEqual(capsule.checks.map((record) => record.name), ["unit"]);
    assert.equal(result.debtEntry.sessionId, "finalize-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply text output reports finalized approval decision", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "text finalized apply",
      sessionId: "text-finalize-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "text-finalize-session",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /VibeGuard Apply/);
    assert.match(result.stdout, /Session: text-finalize-session/);
    assert.match(result.stdout, /Decision: safe_apply/);
    assert.match(result.stdout, /Applied: 1/);
    assert.match(result.stdout, /Blocked: 1/);
    assert.match(result.stdout, /Approval required: 0/);
    assert.match(result.stdout, /Apply id:/);
    assert.match(result.stdout, /Capsule:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply JSON output includes approval finalization payload", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "json finalized apply",
      sessionId: "json-finalize-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");
    await writeFile(path.join(session.shadowPath, "package-lock.json"), "{}\n");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "json-finalize-session",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.approval.decision, "safe_apply");
    assert.deepEqual(payload.approval.applied, ["src/app.js"]);
    assert.deepEqual(payload.approval.skipped, {
      blocked: [".env.local"],
      approvalRequired: ["package-lock.json"],
    });
    assert.equal(payload.apply.decision, "safe_apply");
    assert.deepEqual(payload.apply.applied, ["src/app.js"]);
    assert.deepEqual(payload.apply.skipped.blocked, [".env.local"]);
    assert.equal(payload.capsule.humanApproval, "safe_apply");
    assert.equal(payload.capsule.applyDecision, "safe_apply");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges rejects traversal and absolute selected paths before artifacts", async () => {
  const root = await createApplyFixture();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "reject unsafe selected path",
      sessionId: "unsafe-selected-session",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");

    await assert.rejects(
      () => applySafeChanges(root, "unsafe-selected-session", {
        policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
        files: ["../src/app.js"],
      }),
      /Selected path escapes workspace/,
    );
    await assert.rejects(
      () => applySafeChanges(root, "unsafe-selected-session", {
        policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
        files: [path.resolve(root, "src", "app.js")],
      }),
      /Selected path must be repo-relative/,
    );

    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "unsafe-selected-session")), false);
    assert.equal(await readFile(path.join(root, "src", "app.js"), "utf8"), "old app\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges rejects non-file root targets before apply artifacts", async () => {
  const root = await createApplyFixture();
  await mkdir(path.join(root, "src", "new.js"), { recursive: true });

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "reject directory target",
      sessionId: "directory-target-session",
      allowedGlobs: ["src/**"],
    });
    await rm(path.join(session.shadowPath, "src", "new.js"), { recursive: true, force: true });
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");

    await assert.rejects(
      () => applySafeChanges(root, "directory-target-session", {
        policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
        files: ["src/new.js"],
      }),
      /Cannot apply over non-file path/,
    );

    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "directory-target-session")), false);
    assert.equal(await exists(path.join(root, "src", "new.js")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createApplyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-apply-finalization-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
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

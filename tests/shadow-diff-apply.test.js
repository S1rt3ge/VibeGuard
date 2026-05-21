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
  analyzeShadowDiff,
  applySafeChanges,
  createShadowSession,
  reviewShadowSession,
} from "../packages/core/src/shadow-workspace.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("task snapshots project files while excluding local and secret state", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "snapshot repo",
      sessionId: "session-copy",
    });

    assert.equal(await readText(path.join(session.shadowPath, "src", "app.js")), "old app\n");
    assert.equal(await exists(path.join(session.shadowPath, "README.md")), true);
    assert.equal(await exists(path.join(session.shadowPath, ".env.local")), false);
    assert.equal(await exists(path.join(session.shadowPath, ".git", "config")), false);
    assert.equal(await exists(path.join(session.shadowPath, ".vibeguard")), false);
    assert.equal(await exists(path.join(session.shadowPath, "node_modules", "left-pad", "index.js")), false);
    assert.equal(await exists(path.join(session.shadowPath, "coverage", "summary.json")), false);
    assert.ok(session.snapshot.excluded.includes(".env*"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadow diff detects added, modified, and deleted files", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "edit shadow",
      sessionId: "session-diff",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "new app\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new file\n");
    await rm(path.join(session.shadowPath, "docs", "usage.md"));

    const diff = await analyzeShadowDiff(root, session.shadowPath);

    assert.deepEqual(
      diff.map((item) => `${item.status}:${item.path}`).sort(),
      ["added:src/new.js", "deleted:docs/usage.md", "modified:src/app.js"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewShadowSession classifies real shadow diff with statuses", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "billing change",
      sessionId: "session-review",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "new app\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");
    await writeFile(path.join(session.shadowPath, "package-lock.json"), "{}\n");

    const result = await reviewShadowSession(root, "session-review", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
    });

    assert.deepEqual(result.review.reviewable.map((item) => item.path), ["src/app.js"]);
    assert.deepEqual(result.review.blocked.map((item) => item.path), [".env.local"]);
    assert.deepEqual(result.review.approvalRequired.map((item) => item.path), ["package-lock.json"]);
    assert.equal(result.review.reviewable[0].status, "modified");
    assert.equal(result.score.risk.level, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges applies only reviewable files and writes a capsule", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "safe apply billing",
      sessionId: "session-apply",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await rm(path.join(session.shadowPath, "docs", "usage.md"));
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");
    await writeFile(path.join(session.shadowPath, "package-lock.json"), "{}\n");

    const result = await applySafeChanges(root, "session-apply", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**", "docs/**"] }),
    });

    assert.deepEqual(result.applied.sort(), ["docs/usage.md", "src/app.js", "src/new.js"]);
    assert.equal(await readText(path.join(root, "src", "app.js")), "safe change\n");
    assert.equal(await readText(path.join(root, "src", "new.js")), "new safe file\n");
    assert.equal(await exists(path.join(root, "docs", "usage.md")), false);
    assert.equal(await readText(path.join(root, ".env.local")), "TOKEN=root\n");
    assert.equal(await exists(path.join(root, "package-lock.json")), false);

    const savedCapsule = JSON.parse(await readFile(result.capsulePath, "utf8"));
    assert.equal(savedCapsule.humanApproval, "safe_apply");
    assert.deepEqual(savedCapsule.applied.sort(), ["docs/usage.md", "src/app.js", "src/new.js"]);
    assert.deepEqual(savedCapsule.blocked.map((item) => item.path), [".env.local"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges can apply only selected reviewable files", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "selectively apply billing",
      sessionId: "session-selective-apply",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await rm(path.join(session.shadowPath, "docs", "usage.md"));

    const result = await applySafeChanges(root, "session-selective-apply", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**", "docs/**"] }),
      files: ["src\\new.js", "docs/usage.md", "src/new.js"],
    });
    const manifest = JSON.parse(await readFile(result.applyRecord.manifestPath, "utf8"));
    const savedCapsule = JSON.parse(await readFile(result.capsulePath, "utf8"));

    assert.deepEqual(result.applied.sort(), ["docs/usage.md", "src/new.js"]);
    assert.deepEqual(manifest.files.map((item) => item.path).sort(), ["docs/usage.md", "src/new.js"]);
    assert.deepEqual(savedCapsule.applied.sort(), ["docs/usage.md", "src/new.js"]);
    assert.deepEqual(
      savedCapsule.reviewable.map((item) => item.path).sort(),
      ["docs/usage.md", "src/app.js", "src/new.js"],
    );
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await readText(path.join(root, "src", "new.js")), "new safe file\n");
    assert.equal(await exists(path.join(root, "docs", "usage.md")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges dry-run previews selected files without writing repo or artifacts", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "dry run safe apply",
      sessionId: "session-dry-run",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "src", "new.js"), "new safe file\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");

    const result = await applySafeChanges(root, "session-dry-run", {
      policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
      files: ["src/new.js"],
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.wouldApply, ["src/new.js"]);
    assert.deepEqual(result.applied, []);
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await exists(path.join(root, "src", "new.js")), false);
    assert.equal(await readText(path.join(root, ".env.local")), "TOKEN=root\n");
    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "session-dry-run")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "capsules")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "debt.jsonl")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applySafeChanges rejects selected files that are not reviewable before writing", async () => {
  const root = await createFixtureRepo();

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "reject unsafe selected apply",
      sessionId: "session-selective-reject",
    });

    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, ".env.local"), "TOKEN=shadow\n");

    await assert.rejects(
      () => applySafeChanges(root, "session-selective-reject", {
        policy: createDefaultPolicy({ allowedGlobs: ["src/**"] }),
        files: ["src/app.js", ".env.local"],
      }),
      /Cannot apply non-reviewable file\(s\): \.env\.local/,
    );

    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await readText(path.join(root, ".env.local")), "TOKEN=root\n");
    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "session-selective-reject")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply --safe --dry-run previews changes without applying them", async () => {
  const root = await createFixtureRepo();

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "dry run cli apply", "--root", root, "--session", "cli-dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const shadowPath = path.join(root, ".vibeguard", "shadows", "cli-dry-run");
    await writeFile(path.join(shadowPath, "src", "app.js"), "cli safe change\n");
    await writeFile(path.join(shadowPath, ".env.local"), "TOKEN=shadow\n");

    const apply = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--dry-run",
        "--root",
        root,
        "--session",
        "cli-dry-run",
        "--allow",
        "src/**",
      ],
      { encoding: "utf8" },
    );

    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Dry run: no files applied/);
    assert.match(apply.stdout, /Would apply:/);
    assert.match(apply.stdout, /src\/app\.js/);
    assert.match(apply.stdout, /Blocked: 1/);
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await readText(path.join(root, ".env.local")), "TOKEN=root\n");
    assert.equal(await exists(path.join(root, ".vibeguard", "applies", "cli-dry-run")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "capsules")), false);
    assert.equal(await exists(path.join(root, ".vibeguard", "debt.jsonl")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reviews and safely applies an edited shadow session", async () => {
  const root = await createFixtureRepo();

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "edit app in shadow", "--root", root, "--session", "cli-session"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const shadowPath = path.join(root, ".vibeguard", "shadows", "cli-session");
    await writeFile(path.join(shadowPath, "src", "app.js"), "cli safe change\n");
    await writeFile(path.join(shadowPath, ".env.local"), "TOKEN=shadow\n");

    const review = spawnSync(
      process.execPath,
      [
        cliPath,
        "review",
        "--root",
        root,
        "--session",
        "cli-session",
        "--allow",
        "src/**",
      ],
      { encoding: "utf8" },
    );
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /modified\s+reviewable\s+src\/app\.js/);
    assert.match(review.stdout, /added\s+blocked\s+\.env\.local/);

    const apply = spawnSync(
      process.execPath,
      [
        cliPath,
        "apply",
        "--safe",
        "--root",
        root,
        "--session",
        "cli-session",
        "--allow",
        "src/**",
      ],
      { encoding: "utf8" },
    );
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Applied: 1/);
    assert.match(apply.stdout, /Skipped blocked: 1/);
    assert.equal(await readText(path.join(root, "src", "app.js")), "cli safe change\n");
    assert.equal(await readText(path.join(root, ".env.local")), "TOKEN=root\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI apply --safe --files applies only selected reviewable files", async () => {
  const root = await createFixtureRepo();

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "selective cli apply", "--root", root, "--session", "cli-selective"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const shadowPath = path.join(root, ".vibeguard", "shadows", "cli-selective");
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
        "cli-selective",
        "--allow",
        "src/**",
        "--files",
        "src/new.js",
      ],
      { encoding: "utf8" },
    );

    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Applied: 1/);
    assert.equal(await readText(path.join(root, "src", "app.js")), "old app\n");
    assert.equal(await readText(path.join(root, "src", "new.js")), "cli new file\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixtureRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-shadow-diff-"));

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, ".vibeguard", "old"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(root, "coverage"), { recursive: true });

  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "usage.md"), "usage\n");
  await writeFile(path.join(root, "README.md"), "readme\n");
  await writeFile(path.join(root, ".env.local"), "TOKEN=root\n");
  await writeFile(path.join(root, ".git", "config"), "git\n");
  await writeFile(path.join(root, ".vibeguard", "old", "state.json"), "{}\n");
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module\n");
  await writeFile(path.join(root, "coverage", "summary.json"), "{}\n");

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

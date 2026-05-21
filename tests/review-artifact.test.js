import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  createReviewPayload,
  saveReviewArtifact,
} from "../packages/core/src/review-store.js";
import {
  createShadowSession,
  reviewShadowSession,
} from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("saveReviewArtifact writes a review --json compatible payload", async () => {
  const root = await createReviewFixture("review-artifact-core");

  try {
    const result = await reviewShadowSession(root, "review-artifact-core");
    const payload = createReviewPayload(result);
    const reviewPath = await saveReviewArtifact(root, payload);
    const saved = JSON.parse(await readFile(reviewPath, "utf8"));

    assert.equal(saved.schemaVersion, "0.1");
    assert.equal(saved.command, "review");
    assert.equal(saved.sessionId, "review-artifact-core");
    assert.deepEqual(saved.diff.map((item) => item.path).sort(), ["docs/notes.md", "src/app.js"]);
    assert.equal(saved.review.blocked.length, 1);
    assert.equal(saved.score.risk.level, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI review --session --save writes artifact and prints its path", async () => {
  const root = await createReviewFixture("review-artifact-cli");

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "review", "--root", root, "--session", "review-artifact-cli", "--save"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Review artifact:/);

    const reviewPath = path.join(root, ".vibeguard", "reviews", "review-artifact-cli.json");
    const saved = JSON.parse(await readFile(reviewPath, "utf8"));

    assert.equal(saved.sessionId, "review-artifact-cli");
    assert.equal(saved.command, "review");
    assert.equal(saved.review.blocked.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI review --session --json --save emits reviewPath in stdout", async () => {
  const root = await createReviewFixture("review-artifact-json");

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "review", "--root", root, "--session", "review-artifact-json", "--save", "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "review");
    assert.equal(payload.sessionId, "review-artifact-json");
    assert.equal(payload.reviewPath, path.join(root, ".vibeguard", "reviews", "review-artifact-json.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI review --files --save fails because manual reviews have no session artifact", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "review", "--files", "src/app.js", "--save"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--save is only supported with --session/);
});

async function createReviewFixture(sessionId) {
  const root = await mkdtemp(path.join(tmpdir(), `${sessionId}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "notes.md"), "notes\n");

  const session = await createShadowSession({
    repoRoot: root,
    task: "save review artifact",
    sessionId,
    allowedGlobs: ["src/**"],
  });
  await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
  await writeFile(path.join(session.shadowPath, "docs", "notes.md"), "scope drift\n");

  return root;
}

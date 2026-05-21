import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCapsule, saveCapsule } from "../packages/core/src/capsule-store.js";
import { createDefaultPolicy, reviewChanges } from "../packages/policy/src/index.js";
import { scoreReview } from "../packages/risk-engine/src/index.js";

test("scores blocked and approval-required changes as high risk", () => {
  const review = reviewChanges(
    [".env.local", "package-lock.json", "app/billing/page.tsx"],
    createDefaultPolicy({ allowedGlobs: ["app/billing/**"] }),
  );

  const result = scoreReview(review, {
    todoCommentsAdded: 2,
    testsDeleted: 1,
  });

  assert.equal(result.risk.level, "high");
  assert.ok(result.risk.reasons.includes("blocked_files_touched"));
  assert.ok(result.slop.score > 50);
  assert.ok(result.slop.problems.includes("2 TODO comments added"));
  assert.ok(result.slop.problems.includes("1 test deleted or weakened"));
});

test("creates and saves a capsule with provenance fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-"));

  try {
    const review = reviewChanges(
      ["app/billing/page.tsx", ".env.local"],
      createDefaultPolicy({ allowedGlobs: ["app/billing/**"] }),
    );
    const score = scoreReview(review);
    const capsule = createCapsule({
      task: "add Stripe subscription",
      agent: "codex",
      model: "gpt-5",
      review,
      score,
      commands: [{ command: "npm test", decision: "allowed", reasons: [] }],
      checks: [{ name: "unit", status: "passed" }],
      applied: ["app/billing/page.tsx"],
      humanApproval: "partial",
      now: new Date("2026-05-16T20:00:00.000Z"),
    });

    assert.equal(capsule.schemaVersion, "0.1");
    assert.equal(capsule.task, "add Stripe subscription");
    assert.equal(capsule.agent, "codex");
    assert.deepEqual(capsule.blocked.map((item) => item.path), [".env.local"]);

    const savedPath = await saveCapsule(root, capsule);
    const saved = JSON.parse(await readFile(savedPath, "utf8"));

    assert.equal(saved.id, capsule.id);
    assert.equal(saved.humanApproval, "partial");
    assert.match(savedPath, /add-stripe-subscription\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scores clean and approval-only reviews distinctly", () => {
  const cleanReview = reviewChanges(
    ["docs/usage.md"],
    createDefaultPolicy({ allowedGlobs: ["docs/**"] }),
  );
  const cleanScore = scoreReview(cleanReview);

  assert.equal(cleanScore.risk.level, "low");
  assert.equal(cleanScore.slop.score, 0);

  const approvalReview = reviewChanges(
    ["package-lock.json"],
    createDefaultPolicy({ allowedGlobs: ["app/billing/**"] }),
  );
  const approvalScore = scoreReview(approvalReview);

  assert.equal(approvalScore.risk.level, "medium");
  assert.ok(approvalScore.slop.problems.includes("1 dependency change requested"));
});

test("capsule creation validates task input and supplies defaults", () => {
  assert.throws(() => createCapsule({ task: "  " }), /Task is required/);

  const capsule = createCapsule({
    task: "review billing diff",
    review: { blocked: [], approvalRequired: [], reviewable: [] },
    now: new Date("2026-05-16T20:00:00.000Z"),
  });

  assert.equal(capsule.agent, "codex");
  assert.equal(capsule.model, "unknown");
  assert.equal(capsule.risk.level, "low");
  assert.equal(capsule.humanApproval, "pending");
});

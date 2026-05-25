import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createShadowSession } from "../packages/core/src/shadow-workspace.js";
import { createDefaultPolicy, reviewChanges } from "../packages/policy/src/index.js";
import { scoreReview } from "../packages/risk-engine/src/index.js";
import {
  buildReviewDecisionSummary,
  formatReviewDecisionSummary,
} from "../packages/reporters/src/text.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("buildReviewDecisionSummary includes intent expected and suspicious changes", () => {
  const review = reviewChanges(
    [
      "app/billing/page.tsx",
      "tests/billing/subscription.test.ts",
      ".env.local",
      "package-lock.json",
      "app/auth/session.ts",
    ],
    createDefaultPolicy({ allowedGlobs: ["app/billing/**", "tests/billing/**"] }),
  );
  const score = scoreReview(review, { todoCommentsAdded: 1 });
  const summary = buildReviewDecisionSummary(review, score, {
    task: "add Stripe subscription",
  });

  assert.equal(summary.intent.task, "add Stripe subscription");
  assert.deepEqual(
    summary.intent.expected.map((item) => `${item.label}:${item.files.join(",")}`),
    [
      "Application route/page changed:app/billing/page.tsx",
      "Tests changed:tests/billing/subscription.test.ts",
    ],
  );
  assert.ok(
    summary.intent.suspicious.some(
      (item) => item.label === "Blocked" && item.path === ".env.local",
    ),
  );
  assert.ok(
    summary.intent.suspicious.some(
      (item) => item.label === "Approval required" && item.path === "package-lock.json",
    ),
  );
  assert.ok(
    summary.intent.suspicious.some(
      (item) =>
        item.label === "Approval required" &&
        item.path === "app/auth/session.ts" &&
        item.riskZones.includes("auth"),
    ),
  );
  assert.ok(
    summary.intent.suspicious.some(
      (item) => item.path === null && item.reasons.includes("1 TODO comment added"),
    ),
  );
});

test("formatReviewDecisionSummary renders intent sections", () => {
  const review = reviewChanges(
    ["src/app.js", "docs/notes.md"],
    createDefaultPolicy({ allowedGlobs: ["src/**"] }),
  );
  const summary = buildReviewDecisionSummary(review, scoreReview(review), {
    task: "fix login redirect",
  });
  const text = formatReviewDecisionSummary(summary);

  assert.match(text, /Intent:/);
  assert.match(text, /Task: fix login redirect/);
  assert.match(text, /Expected changes:/);
  assert.match(text, /Source file changed: src\/app\.js/);
  assert.match(text, /Suspicious changes:/);
  assert.match(text, /Blocked: docs\/notes\.md \(outside_declared_scope\)/);
});

test("CLI review --session --summary prints intent-based review", async () => {
  const root = await createIntentFixture("intent-text-session");

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "review", "--root", root, "--session", "intent-text-session", "--summary"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Decision summary:/);
    assert.match(result.stdout, /Intent:/);
    assert.match(result.stdout, /Task: add Stripe subscription/);
    assert.match(result.stdout, /Application route\/page changed: app\/billing\/page\.tsx/);
    assert.match(result.stdout, /Tests changed: tests\/billing\/subscription\.test\.ts/);
    assert.match(result.stdout, /Approval required: app\/auth\/session\.ts/);
    assert.match(result.stdout, /Approval required: package-lock\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI review --session --summary --json exposes stable intent payload", async () => {
  const root = await createIntentFixture("intent-json-session");

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "review",
        "--root",
        root,
        "--session",
        "intent-json-session",
        "--summary",
        "--json",
      ],
      { encoding: "utf8" },
    );
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.summary.intent.task, "add Stripe subscription");
    assert.deepEqual(
      payload.summary.intent.expected.map((item) => item.label),
      ["Application route/page changed", "Tests changed"],
    );
    assert.deepEqual(
      payload.summary.intent.suspicious.map((item) => item.path).sort(),
      [".env.local", "app/auth/session.ts", "package-lock.json"],
    );
    assert.equal(JSON.stringify(payload.summary.intent).includes("stripe page"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createIntentFixture(sessionId) {
  const root = await mkdtemp(path.join(tmpdir(), `${sessionId}-`));
  await mkdir(path.join(root, "app", "billing"), { recursive: true });
  await mkdir(path.join(root, "app", "auth"), { recursive: true });
  await mkdir(path.join(root, "tests", "billing"), { recursive: true });
  await writeFile(path.join(root, "app", "billing", "page.tsx"), "old billing\n");
  await writeFile(path.join(root, "app", "auth", "session.ts"), "old session\n");
  await writeFile(path.join(root, "tests", "billing", "subscription.test.ts"), "old test\n");
  await writeFile(path.join(root, "package-lock.json"), "{}\n");

  const session = await createShadowSession({
    repoRoot: root,
    task: "add Stripe subscription",
    sessionId,
    allowedGlobs: ["app/billing/**", "tests/billing/**"],
  });

  await writeFile(path.join(session.shadowPath, "app", "billing", "page.tsx"), "stripe page\n");
  await writeFile(
    path.join(session.shadowPath, "tests", "billing", "subscription.test.ts"),
    "stripe test\n",
  );
  await writeFile(path.join(session.shadowPath, "app", "auth", "session.ts"), "session drift\n");
  await writeFile(path.join(session.shadowPath, "package-lock.json"), "{\"changed\":true}\n");
  await writeFile(path.join(session.shadowPath, ".env.local"), "STRIPE_SECRET_KEY=test\n");

  return root;
}

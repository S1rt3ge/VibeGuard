import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyFileChange,
  createDefaultPolicy,
  reviewChanges,
} from "../packages/policy/src/index.js";

test("blocks secret-like files before scope checks", () => {
  const policy = createDefaultPolicy({
    allowedGlobs: ["app/billing/**", "lib/stripe/**"],
  });

  const decision = classifyFileChange(".env.local", policy);

  assert.equal(decision.decision, "blocked");
  assert.ok(decision.reasons.includes("protected_file"));
});

test("approval-gates dependency, CI, auth, and migration changes", () => {
  const policy = createDefaultPolicy({
    allowedGlobs: ["app/billing/**"],
  });

  assert.equal(classifyFileChange("package-lock.json", policy).decision, "approval_required");
  assert.equal(classifyFileChange(".github/workflows/ci.yml", policy).decision, "approval_required");
  assert.equal(classifyFileChange("app/auth/session.ts", policy).decision, "approval_required");
  assert.equal(classifyFileChange("prisma/migrations/001_init.sql", policy).decision, "approval_required");
});

test("blocks out-of-scope files when task scope is declared", () => {
  const policy = createDefaultPolicy({
    allowedGlobs: ["app/billing/**", "lib/stripe/**", "tests/billing/**"],
  });

  const decision = classifyFileChange("app/profile/page.tsx", policy);

  assert.equal(decision.decision, "blocked");
  assert.ok(decision.reasons.includes("outside_declared_scope"));
});

test("groups review results by decision", () => {
  const policy = createDefaultPolicy({
    allowedGlobs: ["app/billing/**", "lib/stripe/**", "tests/billing/**"],
  });

  const review = reviewChanges(
    [
      "app/billing/page.tsx",
      "lib/stripe/client.ts",
      "tests/billing/subscription.test.ts",
      ".env.local",
      "package-lock.json",
      "app/profile/page.tsx",
    ],
    policy,
  );

  assert.deepEqual(
    review.reviewable.map((item) => item.path),
    ["app/billing/page.tsx", "lib/stripe/client.ts", "tests/billing/subscription.test.ts"],
  );
  assert.deepEqual(
    review.approvalRequired.map((item) => item.path),
    ["package-lock.json"],
  );
  assert.deepEqual(
    review.blocked.map((item) => item.path),
    [".env.local", "app/profile/page.tsx"],
  );
});

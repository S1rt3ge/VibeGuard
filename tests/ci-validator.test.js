import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  discoverCiArtifacts,
  validateCiArtifacts,
} from "../packages/core/src/ci-validator.js";
import { createCapsule } from "../packages/core/src/capsule-store.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("validateCiArtifacts passes a valid capsule", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-valid-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule());
    const result = await validateCiArtifacts({ repoRoot: root, capsulePath });

    assert.equal(result.valid, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.capsule.task, "ci validation");
    assert.equal(result.capsule.filesChanged, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts reports missing and invalid capsules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-missing-"));

  try {
    const missing = await validateCiArtifacts({
      repoRoot: root,
      capsulePath: "missing.json",
    });
    assert.equal(missing.valid, false);
    assert.equal(missing.findings[0].code, "missing_capsule");

    await writeFile(path.join(root, "bad.json"), "{not-json\n");
    const invalid = await validateCiArtifacts({
      repoRoot: root,
      capsulePath: "bad.json",
    });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.findings[0].code, "invalid_capsule_json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts fails high-risk pending capsules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-risk-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule({
      risk: { level: "high", reasons: ["blocked_files_touched"] },
      humanApproval: "pending",
    }));
    const result = await validateCiArtifacts({ repoRoot: root, capsulePath });

    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === "high_risk_without_approval"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts binds the capsule to the actual PR changed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-bind-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule());

    const covered = await validateCiArtifacts({
      repoRoot: root,
      capsulePath,
      changedFiles: ["src/app.js"],
    });
    assert.equal(covered.valid, true);

    const uncovered = await validateCiArtifacts({
      repoRoot: root,
      capsulePath,
      changedFiles: ["src/app.js", "src/sneaky.js"],
    });
    assert.equal(uncovered.valid, false);
    assert.ok(uncovered.findings.some((finding) =>
      finding.code === "capsule_missing_changed_file" && finding.path === "src/sneaky.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts enforces a required provenance level", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-provenance-"));

  try {
    const enforcedPath = await writeJson(root, "enforced.json", makeCapsule());
    const attestedPath = await writeJson(root, "attested.json", createCapsule({
      task: "attested change",
      review: {
        blocked: [],
        approvalRequired: [],
        reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }],
      },
      score: { risk: { level: "low", reasons: [] }, slop: { score: 0, problems: [] } },
      applied: ["src/app.js"],
      humanApproval: "attested",
      provenance: "git_range",
      now: new Date("2026-05-17T12:00:00.000Z"),
    }));

    // enforced requirement: vibeguard_apply passes, git_range fails.
    assert.equal(
      (await validateCiArtifacts({ repoRoot: root, capsulePath: enforcedPath, requireProvenance: "enforced" })).valid,
      true,
    );
    const attestedUnderEnforced = await validateCiArtifacts({
      repoRoot: root,
      capsulePath: attestedPath,
      requireProvenance: "enforced",
    });
    assert.equal(attestedUnderEnforced.valid, false);
    assert.ok(attestedUnderEnforced.findings.some((finding) => finding.code === "provenance_requirement_unmet"));

    // attested requirement: git_range passes (it is at least attested).
    assert.equal(
      (await validateCiArtifacts({ repoRoot: root, capsulePath: attestedPath, requireProvenance: "attested" })).valid,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts fails high-risk auto-applied capsules with no review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-highrisk-apply-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule({
      risk: { level: "high", reasons: ["high_risk_zones_touched"] },
      humanApproval: "safe_apply",
    }));
    const result = await validateCiArtifacts({ repoRoot: root, capsulePath });

    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === "high_risk_without_review"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts fails when blocked or approval-required files were applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-applied-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule({
      blocked: [{ path: ".env.local", reasons: ["protected_file"], riskZones: ["secrets"] }],
      approvalRequired: [{ path: "package-lock.json", reasons: ["dependency_change"], riskZones: ["dependencies"] }],
      applied: ["src/app.js", ".env.local", "package-lock.json"],
    }));
    const result = await validateCiArtifacts({ repoRoot: root, capsulePath });

    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === "blocked_file_applied"));
    assert.ok(result.findings.some((finding) => finding.code === "approval_required_file_applied"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts checks optional review JSON consistency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-review-"));

  try {
    const capsulePath = await writeJson(root, "capsule.json", makeCapsule({
      applied: ["src/app.js", "private/notes.md"],
    }));
    const reviewPath = await writeJson(root, "review.json", {
      schemaVersion: "0.1",
      command: "review",
      review: {
        blocked: [{ path: "private/notes.md", reasons: ["protected_file"], riskZones: ["internal"] }],
        approvalRequired: [],
        reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }],
      },
      score: {
        risk: { level: "high", reasons: ["blocked_files_touched"] },
        slop: { score: 40, problems: [] },
      },
    });

    const result = await validateCiArtifacts({ repoRoot: root, capsulePath, reviewPath });

    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === "review_blocked_file_applied"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverCiArtifacts and CLI --latest choose the newest capsule", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-latest-"));

  try {
    const olderCapsule = await writeJson(root, ".vibeguard/capsules/older.json", makeCapsule());
    const newestCapsule = await writeJson(root, ".vibeguard/capsules/newest.json", makeCapsule());
    await writeJson(root, ".vibeguard/capsules/nested/ignored.json", makeCapsule({
      risk: { level: "high", reasons: ["nested_should_be_ignored"] },
      humanApproval: "pending",
    }));

    await touch(olderCapsule, "2026-05-17T10:00:00.000Z");
    await touch(newestCapsule, "2026-05-17T11:00:00.000Z");

    const discovered = await discoverCiArtifacts({ repoRoot: root, latest: true });
    assert.equal(discovered.capsulePath, newestCapsule);

    const result = await validateCiArtifacts({ repoRoot: root, latest: true });
    assert.equal(result.valid, true);
    assert.equal(result.capsulePath, newestCapsule);

    const cli = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--latest", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const payload = JSON.parse(cli.stdout);

    assert.equal(payload.validation.capsulePath, newestCapsule);
    assert.equal(payload.validation.valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverCiArtifacts --review-latest chooses the newest direct review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-review-latest-"));

  try {
    const olderReview = await writeJson(root, ".vibeguard/reviews/older.json", makeReview());
    const newestReview = await writeJson(root, ".vibeguard/reviews/newest.json", makeReview({
      sessionId: "newest",
    }));
    await writeJson(root, ".vibeguard/reviews/nested/ignored.json", makeReview({
      sessionId: "nested",
    }));

    await touch(olderReview, "2026-05-17T10:00:00.000Z");
    await touch(newestReview, "2026-05-17T11:00:00.000Z");

    const discovered = await discoverCiArtifacts({ repoRoot: root, reviewLatest: true });

    assert.equal(discovered.reviewPath, newestReview);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts --review-latest checks latest saved review consistency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-review-latest-consistency-"));

  try {
    const capsulePath = await writeJson(root, ".vibeguard/capsules/current.json", makeCapsule({
      applied: ["src/app.js", "private/notes.md"],
    }));
    const reviewPath = await writeJson(root, ".vibeguard/reviews/current.json", makeReview({
      blocked: [{ path: "private/notes.md", reasons: ["protected_file"], riskZones: ["internal"] }],
    }));

    const result = await validateCiArtifacts({ repoRoot: root, latest: true, reviewLatest: true });

    assert.equal(result.valid, false);
    assert.equal(result.capsulePath, capsulePath);
    assert.equal(result.reviewPath, reviewPath);
    assert.equal(result.review.blocked, 1);
    assert.ok(result.findings.some((finding) => finding.code === "review_blocked_file_applied"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts --review-latest blocks when no saved review exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-review-latest-missing-"));

  try {
    await writeJson(root, ".vibeguard/capsules/current.json", makeCapsule());

    const result = await validateCiArtifacts({ repoRoot: root, latest: true, reviewLatest: true });

    assert.equal(result.valid, false);
    assert.equal(result.reviewPath, "");
    assert.ok(result.findings.some((finding) => finding.code === "missing_review"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateCiArtifacts --latest reports missing_capsule when no capsules exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-latest-empty-"));

  try {
    const result = await validateCiArtifacts({ repoRoot: root, latest: true });

    assert.equal(result.valid, false);
    assert.equal(result.findings[0].code, "missing_capsule");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI ci validate supports text and JSON output with contract exit codes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-cli-"));

  try {
    const validCapsule = await writeJson(root, "valid-capsule.json", makeCapsule());
    const text = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--capsule", validCapsule],
      { encoding: "utf8" },
    );
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /CI Validation: passed/);

    const invalidCapsule = await writeJson(root, "invalid-capsule.json", makeCapsule({
      risk: { level: "high", reasons: ["blocked_files_touched"] },
      humanApproval: "pending",
    }));
    const json = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--capsule", invalidCapsule, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(json.status, 2, json.stderr);
    const payload = JSON.parse(json.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "ci_validate");
    assert.equal(payload.validation.valid, false);
    assert.ok(payload.validation.findings.some((finding) => finding.code === "high_risk_without_approval"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI ci validate supports --latest with --review-latest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-cli-review-latest-"));

  try {
    await writeJson(root, ".vibeguard/capsules/current.json", makeCapsule({
      applied: ["src/app.js", "private/notes.md"],
    }));
    const reviewPath = await writeJson(root, ".vibeguard/reviews/current.json", makeReview({
      blocked: [{ path: "private/notes.md", reasons: ["protected_file"], riskZones: ["internal"] }],
    }));

    const cli = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--latest", "--review-latest", "--json"],
      { encoding: "utf8" },
    );

    assert.equal(cli.status, 2, cli.stderr);
    const payload = JSON.parse(cli.stdout);

    assert.equal(payload.validation.reviewPath, reviewPath);
    assert.ok(payload.validation.findings.some((finding) => finding.code === "review_blocked_file_applied"));

    const ambiguous = spawnSync(
      process.execPath,
      [
        cliPath,
        "ci",
        "validate",
        "--root",
        root,
        "--latest",
        "--review",
        reviewPath,
        "--review-latest",
      ],
      { encoding: "utf8" },
    );

    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /--review and --review-latest cannot be combined/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI ci validate honors --require-provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-cli-provenance-"));

  try {
    await writeJson(root, ".vibeguard/capsules/current.json", createCapsule({
      task: "attested",
      review: { blocked: [], approvalRequired: [], reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }] },
      score: { risk: { level: "low", reasons: [] }, slop: { score: 0, problems: [] } },
      applied: ["src/app.js"],
      humanApproval: "attested",
      provenance: "git_range",
      now: new Date("2026-05-17T12:00:00.000Z"),
    }));

    const fail = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--latest", "--require-provenance", "enforced", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(fail.status, 2, fail.stderr);
    assert.ok(JSON.parse(fail.stdout).validation.findings.some((f) => f.code === "provenance_requirement_unmet"));

    const bad = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--latest", "--require-provenance", "nope"],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /must be one of: enforced, attested/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeCapsule(overrides = {}) {
  return createCapsule({
    task: "ci validation",
    review: {
      blocked: overrides.blocked ?? [],
      approvalRequired: overrides.approvalRequired ?? [],
      reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }],
    },
    score: {
      risk: overrides.risk ?? { level: "low", reasons: [] },
      slop: { score: 0, problems: [] },
    },
    applied: overrides.applied ?? ["src/app.js"],
    humanApproval: overrides.humanApproval ?? "safe_apply",
    now: overrides.now ?? new Date("2026-05-17T12:00:00.000Z"),
  });
}

function makeReview(overrides = {}) {
  return {
    schemaVersion: "0.1",
    command: "review",
    sessionId: overrides.sessionId ?? "ci-review",
    review: {
      blocked: overrides.blocked ?? [],
      approvalRequired: overrides.approvalRequired ?? [],
      reviewable: overrides.reviewable ?? [{ path: "src/app.js", reasons: [], riskZones: [] }],
    },
    score: {
      risk: overrides.risk ?? { level: "low", reasons: [] },
      slop: overrides.slop ?? { score: 0, problems: [] },
    },
  };
}

async function writeJson(root, fileName, value) {
  const filePath = path.join(root, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function touch(filePath, timestamp) {
  const date = new Date(timestamp);
  await utimes(filePath, date, date);
}

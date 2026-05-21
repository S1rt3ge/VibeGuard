import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { createCapsule } from "../packages/core/src/capsule-store.js";
import { formatCiAnnotations } from "../packages/reporters/src/text.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("formatCiAnnotations emits escaped GitHub Actions annotations", () => {
  const output = formatCiAnnotations({
    valid: false,
    findings: [
      {
        severity: "error",
        code: "blocked:file,applied",
        path: "src/app,main.js",
        message: "Blocked 100%\nReview now",
      },
      {
        severity: "warning",
        code: "soft_warning",
        message: "No file path",
      },
    ],
  });

  assert.equal(
    output,
    [
      "::error file=src/app%2Cmain.js,title=blocked%3Afile%2Capplied::Blocked 100%25%0AReview now",
      "::warning title=soft_warning::No file path",
    ].join("\n"),
  );
});

test("formatCiAnnotations prints a success line when validation passes", () => {
  assert.equal(
    formatCiAnnotations({ valid: true, findings: [] }),
    "CI Annotations: no findings",
  );
});

test("CLI ci annotate emits annotations and uses validation exit codes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-ci-annotate-"));

  try {
    const invalidCapsule = await writeJson(root, "invalid-capsule.json", makeCapsule({
      risk: { level: "high", reasons: ["blocked_files_touched"] },
      humanApproval: "pending",
    }));
    const invalid = spawnSync(
      process.execPath,
      [cliPath, "ci", "annotate", "--root", root, "--capsule", invalidCapsule],
      { encoding: "utf8" },
    );

    assert.equal(invalid.status, 2, invalid.stderr);
    assert.match(invalid.stdout, /::error title=high_risk_without_approval::/);
    assert.doesNotMatch(invalid.stdout, /\n.*::error.*\n.*::error/s);

    const validCapsule = await writeJson(root, "valid-capsule.json", makeCapsule());
    const valid = spawnSync(
      process.execPath,
      [cliPath, "ci", "annotate", "--root", root, "--capsule", validCapsule],
      { encoding: "utf8" },
    );

    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /CI Annotations: no findings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeCapsule(overrides = {}) {
  return createCapsule({
    task: "ci annotations",
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
    now: new Date("2026-05-18T12:00:00.000Z"),
  });
}

async function writeJson(root, fileName, value) {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, fileName);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

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

import {
  loadProjectConfig,
  loadProjectPolicy,
} from "../packages/core/src/project.js";
import {
  applySafeChanges,
  buildSessionStatus,
  createShadowSession,
  reviewShadowSession,
} from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("loadProjectPolicy uses config fields and falls back to defaults", async () => {
  const root = await createPolicyConfigFixture({
    policy: {
      blockedGlobs: ["private/**"],
      approvalGlobs: ["generated/**"],
      riskZones: { "private/**": "internal", "generated/**": "generated" },
    },
  });

  try {
    const config = await loadProjectConfig(root);
    const policy = await loadProjectPolicy(root);

    assert.equal(config.product, "vibeguard");
    assert.deepEqual(policy.blockedGlobs, ["private/**"]);
    assert.deepEqual(policy.approvalGlobs, ["generated/**"]);
    assert.deepEqual(policy.riskZones, { "private/**": "internal", "generated/**": "generated" });
    assert.deepEqual(policy.allowedGlobs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProjectPolicy validates invalid config fields", async () => {
  const root = await createPolicyConfigFixture({
    policy: {
      blockedGlobs: "private/**",
    },
  });

  try {
    await assert.rejects(
      () => loadProjectPolicy(root),
      /policy.blockedGlobs must be an array/,
    );

    await writeFile(path.join(root, ".vibeguard", "config.json"), "{not-json\n");
    await assert.rejects(
      () => loadProjectConfig(root),
      /Invalid VibeGuard config JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewShadowSession uses config policy and session scope precedence", async () => {
  const root = await createPolicyConfigFixture({
    policy: {
      allowedGlobs: ["docs/**"],
      blockedGlobs: ["private/**"],
      approvalGlobs: ["generated/**"],
      riskZones: { "private/**": "internal", "generated/**": "generated" },
    },
  });

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "config policy review",
      sessionId: "config-review",
      allowedGlobs: ["src/**"],
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "private", "notes.md"), "blocked\n");
    await writeFile(path.join(session.shadowPath, "generated", "client.js"), "approval\n");
    await writeFile(path.join(session.shadowPath, "docs", "usage.md"), "config scope only\n");

    const result = await reviewShadowSession(root, "config-review");

    assert.deepEqual(result.review.reviewable.map((item) => item.path), ["src/app.js"]);
    assert.deepEqual(
      result.review.approvalRequired.map((item) => item.path),
      ["generated/client.js"],
    );
    assert.deepEqual(
      result.review.blocked.map((item) => item.path).sort(),
      ["docs/usage.md", "private/notes.md"],
    );
    assert.ok(result.review.blocked.find((item) => item.path === "docs/usage.md").reasons.includes("outside_declared_scope"));
    assert.ok(result.review.blocked.find((item) => item.path === "private/notes.md").reasons.includes("protected_file"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status and apply use config policy when session has no scope", async () => {
  const root = await createPolicyConfigFixture({
    policy: {
      allowedGlobs: ["src/**"],
      blockedGlobs: ["private/**"],
      approvalGlobs: ["generated/**"],
      riskZones: { "private/**": "internal", "generated/**": "generated" },
    },
  });

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "config status apply",
      sessionId: "config-apply",
    });
    await writeFile(path.join(session.shadowPath, "src", "app.js"), "safe change\n");
    await writeFile(path.join(session.shadowPath, "docs", "usage.md"), "scope drift\n");

    const status = await buildSessionStatus(root, "config-apply");
    const applied = await applySafeChanges(root, "config-apply");

    assert.deepEqual(status.allowedGlobs, ["src/**"]);
    assert.equal(status.blocked, 1);
    assert.deepEqual(applied.applied, ["src/app.js"]);
    assert.equal(await readFile(path.join(root, "src", "app.js"), "utf8"), "safe change\n");
    assert.equal(await readFile(path.join(root, "docs", "usage.md"), "utf8"), "usage\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI manual review uses project config policy", async () => {
  const root = await createPolicyConfigFixture({
    policy: {
      allowedGlobs: ["src/**"],
      blockedGlobs: ["private/**"],
      approvalGlobs: ["generated/**"],
      riskZones: { "private/**": "internal", "generated/**": "generated" },
    },
  });

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "review",
        "--root",
        root,
        "--files",
        "src/app.js,private/notes.md,generated/client.js,docs/usage.md",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Blocked: 2/);
    assert.match(result.stdout, /Approval required: 1/);
    assert.match(result.stdout, /Reviewable: 1/);
    assert.match(result.stdout, /blocked private\/notes\.md/);
    assert.match(result.stdout, /approval_required generated\/client\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createPolicyConfigFixture(config) {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-policy-config-"));
  await mkdir(path.join(root, ".vibeguard"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "private"), { recursive: true });
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  await writeFile(path.join(root, "docs", "usage.md"), "usage\n");
  await writeFile(path.join(root, ".vibeguard", "config.json"), `${JSON.stringify({
    schemaVersion: "0.1",
    product: "vibeguard",
    ...config,
  }, null, 2)}\n`);
  return root;
}

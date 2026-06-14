import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cliPath = path.resolve("apps/cli/src/index.js");

function git(root, args) {
  const result = spawnSync(
    "git",
    ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=test", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

test("capsule from derives a git_range capsule and feeds the CI gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-from-"));

  try {
    git(root, ["init", "-q"]);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.js"), "old\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "baseline"]);

    // A later commit adds an in-scope file and a protected secret file.
    await writeFile(path.join(root, "src", "new.js"), "new\n");
    await writeFile(path.join(root, ".env.local"), "SECRET=value\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "agent change"]);

    const result = spawnSync(
      process.execPath,
      [cliPath, "capsule", "from", "--root", root, "--base", "HEAD~1", "--agent", "codex", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.command, "capsule_from");
    const capsule = payload.capsule;
    assert.equal(capsule.provenance, "git_range");
    assert.equal(capsule.humanApproval, "attested");
    assert.equal(capsule.agent, "codex");
    assert.ok(capsule.filesChanged.includes("src/new.js"));
    assert.ok(capsule.filesChanged.includes(".env.local"));
    assert.deepEqual(capsule.blocked.map((item) => item.path), [".env.local"]);
    assert.ok(capsule.applied.includes(".env.local"));

    // The derived capsule plugs straight into the existing CI gate, which
    // catches the protected file that landed in the range.
    const ci = spawnSync(
      process.execPath,
      [cliPath, "ci", "validate", "--root", root, "--latest", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(ci.status, 2, ci.stderr);
    const validation = JSON.parse(ci.stdout).validation;
    assert.equal(validation.valid, false);
    assert.ok(validation.findings.some((finding) => finding.code === "blocked_file_applied"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capsule from requires a base ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-from-nobase-"));

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "capsule", "from", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--base is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

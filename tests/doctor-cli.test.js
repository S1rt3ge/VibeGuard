import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cliPath = path.resolve("apps/cli/src/index.js");

test("CLI doctor reports an uninitialized project with next init step", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-doctor-empty-"));

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "doctor", "--root", root],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /VibeGuard Doctor/);
    assert.match(result.stdout, /Node: ok v\d+\.\d+\.\d+/);
    assert.match(result.stdout, /Git: ok git version/);
    assert.match(result.stdout, /Project: not initialized/);
    assert.match(result.stdout, /Next:/);
    assert.match(result.stdout, /vibeguard init/);
    assert.equal(await exists(path.join(root, ".vibeguard")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI doctor reports initialized project with next task step", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-doctor-ready-"));

  try {
    await mkdir(path.join(root, ".vibeguard"), { recursive: true });
    await writeFile(path.join(root, ".vibeguard", "config.json"), "{}\n");

    const result = spawnSync(
      process.execPath,
      [cliPath, "doctor", "--root", root],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Project: ok .*\.vibeguard.*config\.json/);
    assert.match(result.stdout, /vibeguard task "fix login bug"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI doctor --json emits parseable readiness payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-doctor-json-"));

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "doctor", "--root", root, "--json"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /VibeGuard Doctor/);
    assert.doesNotMatch(result.stdout, /Next:/);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "doctor");
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.find((check) => check.name === "node").status, "ok");
    assert.equal(payload.checks.find((check) => check.name === "git").status, "ok");
    assert.deepEqual(
      payload.checks.find((check) => check.name === "project"),
      { name: "project", status: "warning", message: "not initialized" },
    );
    assert.deepEqual(payload.next, ["vibeguard init"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

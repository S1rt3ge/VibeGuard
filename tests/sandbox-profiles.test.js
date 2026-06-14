import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { expandSandboxProfile } from "../packages/core/src/sandbox-profiles.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("expandSandboxProfile substitutes the image into a known profile", () => {
  assert.deepEqual(expandSandboxProfile("docker", "my-agent"), [
    "docker",
    "run",
    "--rm",
    "-i",
    "-v",
    "{shadow}:/work",
    "-w",
    "/work",
    "my-agent",
  ]);
  assert.equal(expandSandboxProfile("podman", "img")[0], "podman");
});

test("expandSandboxProfile rejects unknown profiles and missing images", () => {
  assert.throws(() => expandSandboxProfile("firejail", "img"), /Unknown sandbox profile/);
  assert.throws(() => expandSandboxProfile("docker", "  "), /requires an image/);
});

test("CLI run --sandbox-profile expands to a wrapped launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-sandbox-profile-"));

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "profile run", "--root", root, "--session", "profile-session"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent",
        "codex",
        "--root",
        root,
        "--session",
        "profile-session",
        "--sandbox-profile",
        "docker",
        "--image",
        "vibeguard-agent",
        "--dry-run",
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.run.sandbox[0], "docker");
    assert.equal(payload.run.sandbox.at(-1), "vibeguard-agent");
    // {shadow} was substituted to the real shadow path at launch.
    assert.ok(payload.run.sandbox.some((token) => token.endsWith(":/work") && token.includes("profile-session")));
    assert.match(payload.run.commandText, /docker run .*vibeguard-agent codex$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI run reports a helpful error when a profile has no image", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-sandbox-profile-noimg-"));

  try {
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "x" }, null, 2)}\n`,
    );
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "no image", "--root", root, "--session", "noimg-session"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent",
        "codex",
        "--root",
        root,
        "--session",
        "noimg-session",
        "--sandbox-profile",
        "docker",
        "--dry-run",
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an image/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

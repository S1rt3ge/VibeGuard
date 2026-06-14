import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("the drop-in AI change gate workflow is well-formed", async () => {
  const yml = await readFile(path.resolve("examples/github-actions/ai-change-gate.yml"), "utf8");

  assert.match(yml, /on:\s*\n\s*pull_request:/);
  assert.match(yml, /permissions:\s*\n\s*contents: read/);
  assert.match(yml, /fetch-depth: 0/);
  assert.match(yml, /vibeguard capsule from --base/);
  assert.match(yml, /vibeguard ci validate --latest --git-base/);
  assert.doesNotMatch(yml, /pull_request_target/);
});

test("the demo blocks a secret-leaking PR and passes a clean one", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("examples/demo/demo.mjs")],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gate BLOCKED/);
  assert.match(result.stdout, /\.env\.local/);
  assert.match(result.stdout, /blocked_file_applied/);
  assert.match(result.stdout, /Gate PASSED/);
});

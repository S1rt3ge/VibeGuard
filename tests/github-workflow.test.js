import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const workflowPath = path.resolve(".github/workflows/vibeguard.yml");

test("GitHub Action PR gate uses safe triggers and read-only permissions", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /write-all/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("GitHub Action PR gate runs local quality gates and VibeGuard capsule validation", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /node-version: "22"/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run security:scan/);
  assert.match(workflow, /node apps\/cli\/src\/index\.js ci annotate --latest --review-latest/);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  createCapsule,
  listCapsules,
  readCapsule,
  readCapsuleArtifact,
  readLatestCapsule,
} from "../packages/core/src/capsule-store.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("listCapsules sorts newest first and ignores nested capsule JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-list-"));

  try {
    const olderPath = await writeJson(root, ".vibeguard/capsules/older.json", makeCapsule({
      task: "older capsule",
      now: new Date("2026-05-17T10:00:00.000Z"),
    }));
    const newestPath = await writeJson(root, ".vibeguard/capsules/newest.json", makeCapsule({
      task: "newest capsule",
      now: new Date("2026-05-17T11:00:00.000Z"),
    }));
    await writeJson(root, ".vibeguard/capsules/nested/ignored.json", makeCapsule({
      task: "nested capsule",
    }));
    await touch(olderPath, "2026-05-17T10:00:00.000Z");
    await touch(newestPath, "2026-05-17T11:00:00.000Z");

    const result = await listCapsules(root);

    assert.equal(result.capsules.length, 2);
    assert.equal(result.capsules[0].path, newestPath);
    assert.equal(result.capsules[0].task, "newest capsule");
    assert.equal(result.capsules[1].path, olderPath);
    assert.deepEqual(result.skipped, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listCapsules skips corrupt capsule JSON but readCapsule fails clearly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-corrupt-"));

  try {
    const validPath = await writeJson(root, ".vibeguard/capsules/valid.json", makeCapsule());
    const corruptPath = path.join(root, ".vibeguard/capsules/corrupt.json");
    await writeFile(corruptPath, "{not-json\n", "utf8");

    const result = await listCapsules(root);

    assert.equal(result.capsules.length, 1);
    assert.equal(result.capsules[0].path, validPath);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].path, corruptPath);
    assert.equal(result.skipped[0].code, "invalid_capsule_json");
    await assert.rejects(
      () => readCapsule(corruptPath),
      /Invalid capsule JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLatestCapsule returns the same newest capsule used by listCapsules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-latest-"));

  try {
    const olderPath = await writeJson(root, ".vibeguard/capsules/older.json", makeCapsule({
      task: "older capsule",
    }));
    const newestPath = await writeJson(root, ".vibeguard/capsules/newest.json", makeCapsule({
      task: "latest capsule",
    }));
    await touch(olderPath, "2026-05-17T10:00:00.000Z");
    await touch(newestPath, "2026-05-17T11:00:00.000Z");

    const result = await readLatestCapsule(root);

    assert.equal(result.path, newestPath);
    assert.equal(result.capsule.task, "latest capsule");
    assert.equal(result.summary.filesChanged, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capsule inspection handles empty stores and missing show path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-empty-"));

  try {
    const result = await listCapsules(root);

    assert.deepEqual(result, { capsules: [], skipped: [] });
    await assert.rejects(
      () => readLatestCapsule(root),
      /No capsules found/,
    );
    await assert.rejects(
      () => readCapsuleArtifact({ repoRoot: root }),
      /--path is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI capsule list and show support JSON and text output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-capsule-cli-"));

  try {
    const capsulePath = await writeJson(root, ".vibeguard/capsules/current.json", makeCapsule({
      task: "inspect capsule",
    }));
    await touch(capsulePath, "2026-05-17T11:00:00.000Z");

    const list = spawnSync(
      process.execPath,
      [cliPath, "capsule", "list", "--root", root, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(list.status, 0, list.stderr);
    const listPayload = JSON.parse(list.stdout);

    assert.equal(listPayload.schemaVersion, "0.1");
    assert.equal(listPayload.command, "capsule_list");
    assert.equal(listPayload.capsules.length, 1);
    assert.equal(listPayload.capsules[0].path, capsulePath);

    const textList = spawnSync(
      process.execPath,
      [cliPath, "capsule", "list", "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(textList.status, 0, textList.stderr);
    assert.match(textList.stdout, /Capsules: 1/);
    assert.match(textList.stdout, /Skipped corrupt capsules: 0/);
    assert.match(textList.stdout, /inspect capsule/);

    const show = spawnSync(
      process.execPath,
      [cliPath, "capsule", "show", "--root", root, "--latest"],
      { encoding: "utf8" },
    );
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Capsule: inspect capsule/);
    assert.match(show.stdout, /Path:/);

    const showJson = spawnSync(
      process.execPath,
      [cliPath, "capsule", "show", "--root", root, "--path", capsulePath, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(showJson.status, 0, showJson.stderr);
    const showPayload = JSON.parse(showJson.stdout);

    assert.equal(showPayload.schemaVersion, "0.1");
    assert.equal(showPayload.command, "capsule_show");
    assert.equal(showPayload.path, capsulePath);
    assert.equal(showPayload.summary.task, "inspect capsule");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeCapsule(overrides = {}) {
  return createCapsule({
    task: overrides.task ?? "capsule inspection",
    review: {
      blocked: [],
      approvalRequired: [],
      reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }],
    },
    score: {
      risk: { level: "low", reasons: [] },
      slop: { score: 0, problems: [] },
    },
    applied: ["src/app.js"],
    humanApproval: "safe_apply",
    now: overrides.now ?? new Date("2026-05-17T12:00:00.000Z"),
  });
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

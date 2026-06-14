import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createShadowSession,
  loadSession,
} from "../packages/core/src/shadow-workspace.js";
import { createCapsule, saveCapsule } from "../packages/core/src/capsule-store.js";
import { validateCiArtifacts } from "../packages/core/src/ci-validator.js";
import { ensureSigningKey } from "../packages/core/src/signing.js";

async function withKeyDir(fn) {
  const previous = process.env.VIBEGUARD_KEY_DIR;
  const keyDir = await mkdtemp(path.join(tmpdir(), "vibeguard-keys-"));
  process.env.VIBEGUARD_KEY_DIR = keyDir;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.VIBEGUARD_KEY_DIR;
    } else {
      process.env.VIBEGUARD_KEY_DIR = previous;
    }
    await rm(keyDir, { recursive: true, force: true });
  }
}

test("signed session loads normally and rejects tampering", async () => {
  await withKeyDir(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibeguard-sign-session-"));
    try {
      const session = await createShadowSession({
        repoRoot: root,
        task: "signed session",
        sessionId: "signed-session",
        allowedGlobs: ["src/**"],
      });

      // A genuine, untouched session verifies and loads.
      const loaded = await loadSession(root, session.id);
      assert.deepEqual(loaded.policy.allowedGlobs, ["src/**"]);

      // An agent widening its own scope by editing the JSON breaks the signature.
      const saved = JSON.parse(await readFile(session.sessionPath, "utf8"));
      assert.ok(saved.signature, "session should be signed when VIBEGUARD_KEY_DIR is set");
      saved.policy.allowedGlobs = ["**"];
      await writeFile(session.sessionPath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

      await assert.rejects(() => loadSession(root, session.id), /integrity check failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("ci validator flags a tampered capsule signature", async () => {
  await withKeyDir(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibeguard-sign-capsule-"));
    try {
      await ensureSigningKey(root);
      const capsule = createCapsule({
        task: "signed capsule",
        review: { blocked: [], approvalRequired: [], reviewable: [{ path: "src/app.js", reasons: [], riskZones: [] }] },
        score: { risk: { level: "low", reasons: [] }, slop: { score: 0, problems: [] } },
        applied: ["src/app.js"],
        humanApproval: "safe_apply",
        now: new Date("2026-05-17T12:00:00.000Z"),
      });
      const capsulePath = await saveCapsule(root, capsule);

      // Untampered capsule validates.
      const ok = await validateCiArtifacts({ repoRoot: root, capsulePath });
      assert.equal(ok.valid, true);

      // Flip a field but keep the old signature.
      const saved = JSON.parse(await readFile(capsulePath, "utf8"));
      assert.ok(saved.signature, "capsule should be signed when VIBEGUARD_KEY_DIR is set");
      saved.applied = ["src/app.js", "src/backdoor.js"];
      await writeFile(capsulePath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

      const tampered = await validateCiArtifacts({ repoRoot: root, capsulePath });
      assert.equal(tampered.valid, false);
      assert.ok(tampered.findings.some((finding) => finding.code === "capsule_signature_invalid"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("signing stays inert without VIBEGUARD_KEY_DIR", async () => {
  const previous = process.env.VIBEGUARD_KEY_DIR;
  delete process.env.VIBEGUARD_KEY_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-sign-off-"));
  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "unsigned session",
      sessionId: "unsigned-session",
    });
    const saved = JSON.parse(await readFile(session.sessionPath, "utf8"));
    assert.equal(Object.hasOwn(saved, "signature"), false);
    const loaded = await loadSession(root, session.id);
    assert.equal(loaded.id, "unsigned-session");
  } finally {
    if (previous !== undefined) {
      process.env.VIBEGUARD_KEY_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

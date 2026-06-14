import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Tamper-evident signing for VibeGuard trust artifacts (session records, capsules,
// review artifacts). A per-repo HMAC key is stored OUTSIDE the repo, in the
// directory named by VIBEGUARD_KEY_DIR. When that env var is unset, signing is
// fully inert: artifacts are written unsigned and verification is a no-op, so
// default behavior is unchanged.
//
// LIMITATION: this is defense-in-depth, not containment. An agent with host
// access (VibeGuard does not sandbox the agent) could read the key directory and
// forge signatures. Signing reliably detects accidental corruption and tampering
// by anything that does NOT hold the key; it is not a guarantee against a fully
// compromised agent. See the security notes in the README.

function keyDir() {
  const dir = process.env.VIBEGUARD_KEY_DIR;
  return dir ? path.resolve(dir) : null;
}

function repoKeyPath(repoRoot) {
  const dir = keyDir();
  if (!dir) {
    return null;
  }
  const id = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 32);
  return path.join(dir, `${id}.key`);
}

export async function loadSigningKey(repoRoot) {
  const keyPath = repoKeyPath(repoRoot);
  if (!keyPath) {
    return null;
  }
  try {
    const text = (await readFile(keyPath, "utf8")).trim();
    return text || null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function ensureSigningKey(repoRoot) {
  const keyPath = repoKeyPath(repoRoot);
  if (!keyPath) {
    return null;
  }
  const existing = await loadSigningKey(repoRoot);
  if (existing) {
    return existing;
  }
  await mkdir(path.dirname(keyPath), { recursive: true });
  const key = randomBytes(32).toString("hex");
  await writeFile(keyPath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
}

export async function signArtifact(repoRoot, artifact) {
  const key = await loadSigningKey(repoRoot);
  if (!key) {
    return artifact;
  }
  const { signature, ...rest } = artifact;
  return {
    ...rest,
    signature: { algorithm: "HMAC-SHA256", value: computeSignature(rest, key) },
  };
}

export async function verifyArtifact(repoRoot, artifact) {
  const key = await loadSigningKey(repoRoot);
  const signature = artifact?.signature;

  if (!key) {
    return { status: signature ? "unverified" : "unsigned" };
  }
  if (!signature) {
    return { status: "unsigned" };
  }

  const { signature: _omit, ...rest } = artifact;
  const expected = computeSignature(rest, key);
  const actual = String(signature.value ?? "");
  const valid =
    expected.length === actual.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  return { status: valid ? "valid" : "invalid" };
}

export function computeSignature(payload, key) {
  return createHmac("sha256", key).update(canonicalize(payload)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

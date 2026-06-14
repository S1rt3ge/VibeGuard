import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { signArtifact } from "./signing.js";

export function createCapsule({
  task,
  sessionId = null,
  agent = "codex",
  model = "unknown",
  review,
  score,
  commands = [],
  checks = [],
  apply = null,
  applied = [],
  humanApproval = "pending",
  now = new Date(),
} = {}) {
  const trimmedTask = String(task ?? "").trim();
  if (!trimmedTask) {
    throw new Error("Task is required");
  }

  const createdAt = now.toISOString();
  const id = `${createdAt.slice(0, 10)}-${slugify(trimmedTask)}`;
  const safeReview = review ?? { blocked: [], approvalRequired: [], reviewable: [] };
  const safeScore = score ?? {
    risk: { level: "low", reasons: [] },
    slop: { score: 0, problems: [] },
  };

  return {
    schemaVersion: "0.1",
    id,
    task: trimmedTask,
    sessionId,
    agent,
    model,
    filesChanged: [
      ...safeReview.blocked,
      ...safeReview.approvalRequired,
      ...safeReview.reviewable,
    ].map((item) => item.path),
    commands,
    checks,
    apply,
    risk: safeScore.risk,
    slop: safeScore.slop,
    blocked: safeReview.blocked,
    approvalRequired: safeReview.approvalRequired,
    reviewable: safeReview.reviewable,
    applied,
    humanApproval,
    createdAt,
  };
}

export async function saveCapsule(repoRoot, capsule) {
  const root = path.resolve(repoRoot);
  const capsulesDir = path.join(root, ".vibeguard", "capsules");
  await mkdir(capsulesDir, { recursive: true });

  const filePath = path.join(capsulesDir, `${capsule.id}.json`);
  const signed = await signArtifact(root, capsule);
  await writeFile(filePath, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
  return filePath;
}

export async function listCapsules(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const capsulesDir = path.join(root, ".vibeguard", "capsules");

  let entries;
  try {
    entries = await readdir(capsulesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { capsules: [], skipped: [] };
    }
    throw error;
  }

  const candidates = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(capsulesDir, entry.name);
    const info = await stat(filePath);
    try {
      const capsule = await readCapsule(filePath);
      candidates.push({
        ...summarizeCapsule(capsule, filePath),
        mtimeMs: info.mtimeMs,
        fileName: entry.name,
      });
    } catch (error) {
      if (error.code === "INVALID_CAPSULE_JSON") {
        skipped.push({
          path: filePath,
          code: "invalid_capsule_json",
          message: error.message,
        });
      } else {
        throw error;
      }
    }
  }

  candidates.sort(compareCapsuleSummaries);

  return {
    capsules: candidates.map(({ mtimeMs, fileName, ...capsule }) => capsule),
    skipped,
  };
}

export async function readCapsule(capsulePath) {
  const filePath = path.resolve(String(capsulePath));
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const invalid = new Error(`Invalid capsule JSON: ${filePath}`);
      invalid.code = "INVALID_CAPSULE_JSON";
      invalid.path = filePath;
      throw invalid;
    }
    throw error;
  }
}

export async function readLatestCapsule(repoRoot = process.cwd()) {
  const result = await listCapsules(repoRoot);
  const latest = result.capsules[0];
  if (!latest) {
    throw new Error("No capsules found.");
  }

  return {
    path: latest.path,
    capsule: await readCapsule(latest.path),
    summary: latest,
    skipped: result.skipped,
  };
}

export async function readCapsuleArtifact({ repoRoot = process.cwd(), capsulePath, latest = false } = {}) {
  if (latest) {
    return readLatestCapsule(repoRoot);
  }
  if (!capsulePath || capsulePath === true) {
    throw new Error("--path is required unless --latest is used");
  }
  const filePath = path.resolve(repoRoot, String(capsulePath));
  const capsule = await readCapsule(filePath);
  return {
    path: filePath,
    capsule,
    summary: summarizeCapsule(capsule, filePath),
    skipped: [],
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "task";
}

function summarizeCapsule(capsule, filePath) {
  return {
    path: filePath,
    id: capsule.id ?? "",
    task: capsule.task ?? "",
    createdAt: capsule.createdAt ?? "",
    risk: capsule.risk?.level ?? "unknown",
    slopScore: typeof capsule.slop?.score === "number" ? capsule.slop.score : null,
    humanApproval: capsule.humanApproval ?? "unknown",
    filesChanged: Array.isArray(capsule.filesChanged) ? capsule.filesChanged.length : 0,
    applied: Array.isArray(capsule.applied) ? capsule.applied.length : 0,
    blocked: Array.isArray(capsule.blocked) ? capsule.blocked.length : 0,
    approvalRequired: Array.isArray(capsule.approvalRequired)
      ? capsule.approvalRequired.length
      : 0,
  };
}

function compareCapsuleSummaries(left, right) {
  return right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName);
}

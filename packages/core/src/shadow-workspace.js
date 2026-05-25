import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createApplyRecord, rollbackApplyRecord } from "./apply-log.js";
import { createCapsule, saveCapsule } from "./capsule-store.js";
import { readCheckRecords } from "./check-log.js";
import { readCommandRecords } from "./command-log.js";
import { appendDebtEntry, appendRollbackDebtEntry } from "./debt-ledger.js";
import { assertCleanGitWorktree, inspectGitWorktree } from "./git-status.js";
import {
  HANDOFF_RELATIVE_PATH,
  createHandoffMetadata,
  writeTaskHandoff,
} from "./handoff.js";
import { loadProjectPolicy } from "./project.js";
import { normalizeRepoPath, reviewChanges } from "../../policy/src/index.js";
import { scoreReview } from "../../risk-engine/src/index.js";

const SNAPSHOT_EXCLUDES = [
  ".git",
  ".git/**",
  ".vibeguard",
  ".vibeguard/**",
  "node_modules",
  "node_modules/**",
  "coverage",
  "coverage/**",
  ".nyc_output",
  ".nyc_output/**",
  ".env*",
  "**/.env*",
];

const DIFF_EXCLUDES = [
  HANDOFF_RELATIVE_PATH,
];

export async function createShadowSession({
  repoRoot = process.cwd(),
  task,
  sessionId,
  agent = "codex",
  model = "unknown",
  allowedGlobs = [],
  allowDirty = false,
  now = new Date(),
} = {}) {
  const trimmedTask = String(task ?? "").trim();
  if (!trimmedTask) {
    throw new Error("Task is required");
  }

  const root = path.resolve(repoRoot);
  const id = sessionId ?? makeSessionId(trimmedTask, now);
  const stateDir = path.join(root, ".vibeguard");
  const shadowPath = path.join(stateDir, "shadows", id);
  const sessionsDir = path.join(stateDir, "sessions");
  const sessionPath = path.join(sessionsDir, `${id}.json`);
  const git = inspectGitWorktree(root, { allowDirty });

  assertCleanGitWorktree(git);

  await mkdir(shadowPath, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  const manifest = await copyWorkspaceSnapshot(root, shadowPath);
  const handoff = createHandoffMetadata(shadowPath);

  const session = {
    schemaVersion: "0.1",
    id,
    task: trimmedTask,
    agent,
    model,
    repoRoot: root,
    shadowPath,
    policy: {
      allowedGlobs: [...allowedGlobs],
    },
    git,
    handoff,
    snapshot: {
      excluded: [...SNAPSHOT_EXCLUDES],
      manifest,
    },
    createdAt: now.toISOString(),
    status: "created",
  };

  await writeTaskHandoff(session);
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  return {
    ...session,
    sessionPath,
  };
}

export async function analyzeShadowDiff(repoRoot, shadowPath, snapshotManifest = null) {
  const root = path.resolve(repoRoot);
  const shadow = path.resolve(shadowPath);
  const manifest = snapshotManifest ?? (await buildManifest(root));
  const shadowManifest = await buildManifest(shadow, { includeAll: true });
  const paths = [...new Set([...Object.keys(manifest), ...Object.keys(shadowManifest)])]
    .filter((relativePath) => !isDiffExcluded(relativePath))
    .sort();
  const diff = [];

  for (const relativePath of paths) {
    const before = manifest[relativePath];
    const after = shadowManifest[relativePath];

    if (!before && after) {
      diff.push({ path: relativePath, status: "added" });
    } else if (before && !after) {
      diff.push({ path: relativePath, status: "deleted" });
    } else if (before && after && before.hash !== after.hash) {
      diff.push({ path: relativePath, status: "modified" });
    }
  }

  return diff;
}

export async function reviewShadowSession(repoRoot, sessionId, options = {}) {
  const session = await loadSession(repoRoot, sessionId);
  const diff = await analyzeShadowDiff(
    repoRoot,
    session.shadowPath,
    session.snapshot?.manifest ?? null,
  );
  const configPolicy = await loadProjectPolicy(repoRoot);
  const allowedGlobs = resolveAllowedGlobs(
    options.allowedGlobs,
    session.policy?.allowedGlobs,
    configPolicy.allowedGlobs,
  );
  const policy = options.policy ?? (await loadProjectPolicy(repoRoot, { allowedGlobs }));
  const review = reviewChanges(diff.map((item) => item.path), policy);
  attachDiffStatus(review, diff);
  const score = scoreReview(review);

  return {
    session,
    diff,
    policy,
    review,
    score,
  };
}

export async function buildSessionStatus(repoRoot, sessionId, options = {}) {
  const result = await reviewShadowSession(repoRoot, sessionId, options);
  const commands = await readCommandRecords(repoRoot, result.session.id);
  const checks = await readCheckRecords(repoRoot, result.session.id);

  return {
    session: result.session,
    allowedGlobs: result.policy.allowedGlobs,
    changedFiles: result.diff.length,
    blocked: result.review.blocked.length,
    approvalRequired: result.review.approvalRequired.length,
    reviewable: result.review.reviewable.length,
    commands: {
      total: commands.length,
      blocked: commands.filter((record) => record.decision === "blocked").length,
      approvalRequired: commands.filter((record) => record.decision === "approval_required").length,
      skippedLines: commands.skippedLines ?? 0,
    },
    checks: {
      total: checks.length,
      passed: checks.filter((record) => record.status === "passed").length,
      failed: checks.filter((record) => record.status === "failed").length,
      skipped: checks.filter((record) => record.status === "skipped").length,
      skippedLines: checks.skippedLines ?? 0,
    },
    risk: result.score.risk,
    slop: result.score.slop,
    review: result.review,
  };
}

function resolveAllowedGlobs(explicitAllowedGlobs, sessionAllowedGlobs, configAllowedGlobs) {
  if (explicitAllowedGlobs !== undefined) {
    return explicitAllowedGlobs;
  }
  if (Array.isArray(sessionAllowedGlobs) && sessionAllowedGlobs.length > 0) {
    return sessionAllowedGlobs;
  }
  return configAllowedGlobs ?? [];
}

export async function applySafeChanges(repoRoot, sessionId, options = {}) {
  const result = await reviewShadowSession(repoRoot, sessionId, options);
  const root = path.resolve(repoRoot);
  const shadow = path.resolve(result.session.shadowPath);
  const filesToApply = selectReviewableFiles(result.review.reviewable, options.files);
  const applied = [];

  if (options.dryRun) {
    return {
      ...result,
      dryRun: true,
      wouldApply: filesToApply.map((item) => item.path),
      applied,
    };
  }

  const applyRecord = await createApplyRecord(root, result.session.id, filesToApply, {
    applyId: options.applyId,
    task: result.session.task,
    now: options.now,
  });

  for (const item of filesToApply) {
    const rootTarget = resolveInside(root, item.path);
    const shadowSource = resolveInside(shadow, item.path);

    if (item.status === "deleted") {
      await rm(rootTarget, { force: true });
    } else {
      await mkdir(path.dirname(rootTarget), { recursive: true });
      await copyFile(shadowSource, rootTarget);
    }
    applied.push(item.path);
  }

  const capsule = createCapsule({
    task: result.session.task,
    agent: result.session.agent,
    model: result.session.model,
    review: result.review,
    score: result.score,
    commands: await readCommandRecords(root, result.session.id),
    checks: await readCheckRecords(root, result.session.id),
    apply: {
      id: applyRecord.id,
      manifestPath: applyRecord.manifestPath,
      files: applyRecord.files.length,
    },
    applied,
    humanApproval: "safe_apply",
  });
  const capsulePath = await saveCapsule(root, capsule);
  const debtEntry = await appendDebtEntry(root, capsule);

  return {
    ...result,
    applied,
    applyRecord,
    capsule,
    capsulePath,
    debtEntry,
  };
}

function selectReviewableFiles(reviewable, files) {
  const selectedFiles = normalizeSelectedFiles(files);
  if (!selectedFiles) {
    return reviewable;
  }

  const reviewableByPath = new Map(reviewable.map((item) => [item.path, item]));
  const nonReviewable = selectedFiles.filter((filePath) => !reviewableByPath.has(filePath));
  if (nonReviewable.length > 0) {
    throw new Error(`Cannot apply non-reviewable file(s): ${nonReviewable.join(", ")}`);
  }

  return selectedFiles.map((filePath) => reviewableByPath.get(filePath));
}

function normalizeSelectedFiles(files) {
  if (files === undefined || files === null) {
    return null;
  }

  const values = Array.isArray(files) ? files : String(files).split(",");
  const normalized = [];
  const seen = new Set();

  for (const value of values) {
    const filePath = normalizeRepoPath(String(value ?? "").trim());
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    normalized.push(filePath);
    seen.add(filePath);
  }

  if (normalized.length === 0) {
    throw new Error("At least one file is required");
  }

  return normalized;
}

export async function rollbackAppliedChanges(repoRoot, sessionId, options = {}) {
  const rollback = await rollbackApplyRecord(repoRoot, sessionId, options.applyId, {
    now: options.now,
  });
  const debtEntry = await appendRollbackDebtEntry(repoRoot, rollback, {
    now: options.now,
  });

  return {
    ...rollback,
    debtEntry,
  };
}

export async function loadSession(repoRoot, sessionId) {
  const id = sessionId ?? (await findLatestSessionId(repoRoot));
  if (!id) {
    throw new Error("Session is required");
  }

  const sessionPath = path.join(path.resolve(repoRoot), ".vibeguard", "sessions", `${id}.json`);
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  return {
    ...session,
    sessionPath,
  };
}

function makeSessionId(task, now) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${date}-${slugify(task)}-${randomSuffix()}`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function copyWorkspaceSnapshot(repoRoot, shadowPath) {
  await copyDirectoryContents(repoRoot, shadowPath, repoRoot);
  return buildManifest(shadowPath, { includeAll: true });
}

async function copyDirectoryContents(sourceDir, targetDir, repoRoot) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = toRepoPath(path.relative(repoRoot, sourcePath));
    if (isSnapshotExcluded(relativePath)) {
      continue;
    }

    const targetPath = path.join(targetDir, relativePath);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDirectoryContents(sourcePath, targetDir, repoRoot);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function buildManifest(root, options = {}) {
  const includeAll = Boolean(options.includeAll);
  const files = await collectFiles(root, root, includeAll);
  const manifest = {};

  for (const file of files) {
    const bytes = await readFile(path.join(root, file));
    manifest[file] = {
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  return manifest;
}

async function collectFiles(directory, root, includeAll) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = toRepoPath(path.relative(root, fullPath));
    if (!includeAll && isSnapshotExcluded(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, root, includeAll)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function attachDiffStatus(review, diff) {
  const statusByPath = new Map(diff.map((item) => [item.path, item.status]));

  for (const group of [review.blocked, review.approvalRequired, review.reviewable]) {
    for (const item of group) {
      item.status = statusByPath.get(item.path) ?? "modified";
    }
  }
}

async function findLatestSessionId(repoRoot) {
  const sessionsDir = path.join(path.resolve(repoRoot), ".vibeguard", "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const sessions = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const fullPath = path.join(sessionsDir, entry);
    const info = await stat(fullPath);
    sessions.push({ id: entry.replace(/\.json$/, ""), mtimeMs: info.mtimeMs });
  }

  sessions.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return sessions[0]?.id ?? null;
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return target;
}

function isSnapshotExcluded(relativePath) {
  return SNAPSHOT_EXCLUDES.some((glob) => matchesSnapshotGlob(relativePath, glob));
}

function isDiffExcluded(relativePath) {
  return DIFF_EXCLUDES.some((glob) => matchesSnapshotGlob(relativePath, glob));
}

function matchesSnapshotGlob(relativePath, glob) {
  const normalized = toRepoPath(relativePath);
  if (glob.endsWith("/**")) {
    const base = glob.slice(0, -3);
    return normalized === base || normalized.startsWith(`${base}/`);
  }
  if (glob.startsWith("**/")) {
    const suffix = glob.slice(3).replace("*", "");
    if (glob.endsWith("*")) {
      return normalized.split("/").some((part) => part.startsWith(suffix));
    }
    return normalized.endsWith(suffix);
  }
  if (glob.endsWith("*")) {
    return normalized.startsWith(glob.slice(0, -1));
  }
  return normalized === glob;
}

function toRepoPath(value) {
  return String(value).replaceAll("\\", "/");
}

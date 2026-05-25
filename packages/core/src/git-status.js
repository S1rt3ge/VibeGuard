import { spawnSync } from "node:child_process";

import { normalizeRepoPath } from "../../policy/src/index.js";

export function inspectGitWorktree(repoRoot, options = {}) {
  const allowDirty = Boolean(options.allowDirty);
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );

  if (result.error || result.status !== 0) {
    return {
      available: false,
      dirty: false,
      allowDirty,
      files: [],
      reason: gitUnavailableReason(result),
    };
  }

  const files = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parsePorcelainLine)
    .filter((item) => !isVibeGuardStatePath(item.path));

  return {
    available: true,
    dirty: files.length > 0,
    allowDirty,
    files,
  };
}

export function assertCleanGitWorktree(git) {
  if (!git.available || !git.dirty || git.allowDirty) {
    return;
  }

  const preview = git.files
    .slice(0, 5)
    .map((item) => item.path)
    .join(", ");
  const suffix = git.files.length > 5 ? `, +${git.files.length - 5} more` : "";
  throw new Error(
    `Working tree has uncommitted changes: ${preview}${suffix}. ` +
      "Commit, stash, or rerun with --allow-dirty to record this baseline.",
  );
}

function parsePorcelainLine(line) {
  const status = line.slice(0, 2).trim() || "?";
  const rawPath = line.slice(3);
  const path = rawPath.includes(" -> ")
    ? rawPath.split(" -> ").at(-1)
    : rawPath;

  return {
    path: normalizeRepoPath(unquotePath(path)),
    status,
  };
}

function unquotePath(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function isVibeGuardStatePath(filePath) {
  return filePath === ".vibeguard" || filePath.startsWith(".vibeguard/");
}

function gitUnavailableReason(result) {
  if (result.error) {
    return result.error.message;
  }

  return String(result.stderr || result.stdout || "git status unavailable").trim();
}

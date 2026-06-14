import { spawnSync } from "node:child_process";
import path from "node:path";

import { normalizeRepoPath } from "../../policy/src/index.js";

// Produce a [{path, status}] diff for a Git range, so a capsule can be derived
// from commits made by ANY agent (or none) rather than only the shadow flow.
export function gitRangeDiff(repoRoot, base, head = "HEAD") {
  const root = path.resolve(repoRoot);
  const range = base ? `${base}...${head}` : head;
  const result = spawnSync("git", ["-C", root, "diff", "--name-status", range], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr ?? "").trim();
    throw new Error(`git diff failed for range "${range}": ${detail || "git error"}`);
  }
  return parseNameStatus(result.stdout);
}

function parseNameStatus(stdout) {
  const diff = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const code = parts[0];

    if (code.startsWith("R") || code.startsWith("C")) {
      // Rename/copy: "<code>\t<old>\t<new>". A rename drops the old path.
      const oldPath = normalizeRepoPath(parts[1]);
      const newPath = normalizeRepoPath(parts[2] ?? parts[1]);
      if (code.startsWith("R") && oldPath) {
        diff.push({ path: oldPath, status: "deleted" });
      }
      if (newPath) {
        diff.push({ path: newPath, status: "added" });
      }
      continue;
    }

    const filePath = normalizeRepoPath(parts[1]);
    if (!filePath) {
      continue;
    }
    const status = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : "modified";
    diff.push({ path: filePath, status });
  }

  return diff;
}

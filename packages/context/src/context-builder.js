import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { matchesAny, normalizeRepoPath } from "../../policy/src/index.js";
import { redactSecrets } from "./redact.js";

const EXCLUDED_GLOBS = [
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
  "**/*secret*",
  "**/*token*",
  "**/*.pem",
  "**/id_rsa*",
];

export async function buildContextBundle({
  repoRoot = process.cwd(),
  task,
  includeGlobs = [],
  now = new Date(),
} = {}) {
  const trimmedTask = String(task ?? "").trim();
  if (!trimmedTask) {
    throw new Error("Task is required");
  }

  const root = path.resolve(repoRoot);
  const bundle = {
    schemaVersion: "0.1",
    id: `${now.toISOString().slice(0, 10)}-${slugify(trimmedTask)}`,
    task: trimmedTask,
    includeGlobs: [...includeGlobs],
    included: [],
    excluded: [],
    redactions: [],
    stats: {
      included: 0,
      excluded: 0,
      redactions: 0,
    },
    createdAt: now.toISOString(),
  };

  await collectContextEntries(root, root, includeGlobs, bundle);
  bundle.stats.included = bundle.included.length;
  bundle.stats.excluded = bundle.excluded.length;
  bundle.stats.redactions = bundle.redactions.length;
  return bundle;
}

export async function saveContextBundle(repoRoot, bundle) {
  const contextDir = path.join(path.resolve(repoRoot), ".vibeguard", "context");
  await mkdir(contextDir, { recursive: true });

  const bundlePath = path.join(contextDir, `${bundle.id}.json`);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return bundlePath;
}

async function collectContextEntries(directory, root, includeGlobs, bundle) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = normalizeRepoPath(path.relative(root, fullPath));
    const excludedReason = exclusionReason(relativePath);

    if (excludedReason) {
      bundle.excluded.push({ path: relativePath, reason: excludedReason });
      continue;
    }

    if (entry.isDirectory()) {
      await collectContextEntries(fullPath, root, includeGlobs, bundle);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (includeGlobs.length > 0 && !matchesAny(relativePath, includeGlobs)) {
      continue;
    }

    let bytes;
    try {
      bytes = await readFile(fullPath);
    } catch {
      bundle.excluded.push({ path: relativePath, reason: "binary_or_unreadable" });
      continue;
    }

    if (isLikelyBinary(bytes)) {
      bundle.excluded.push({ path: relativePath, reason: "binary_or_unreadable" });
      continue;
    }

    const original = bytes.toString("utf8");
    const { content, redactions } = redactContent(relativePath, original);
    bundle.included.push({
      path: relativePath,
      content,
      redactions: redactions.map((item) => item.reason),
    });
    bundle.redactions.push(...redactions);
  }
}

function exclusionReason(relativePath) {
  if (!matchesAny(relativePath, EXCLUDED_GLOBS)) {
    return null;
  }
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    return "git_state";
  }
  if (relativePath === ".vibeguard" || relativePath.startsWith(".vibeguard/")) {
    return "vibeguard_state";
  }
  if (relativePath === "node_modules" || relativePath.startsWith("node_modules/")) {
    return "dependency_cache";
  }
  if (
    relativePath === "coverage" ||
    relativePath.startsWith("coverage/") ||
    relativePath === ".nyc_output" ||
    relativePath.startsWith(".nyc_output/")
  ) {
    return "generated_artifact";
  }
  return "secret_file";
}

function redactContent(filePath, content) {
  const { content: redacted, redactions } = redactSecrets(content);
  return {
    content: redacted,
    redactions: redactions.map((item) => ({
      path: filePath,
      pattern: item.pattern,
      reason: item.reason,
    })),
  };
}

function isLikelyBinary(bytes) {
  return bytes.includes(0);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "task";
}

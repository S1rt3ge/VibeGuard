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

export async function createApplyRecord(repoRoot, sessionId, files, options = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const root = path.resolve(repoRoot);
  const applyId = options.applyId ?? makeApplyId(id, options.now ?? new Date());
  const applyDir = path.join(root, ".vibeguard", "applies", id, applyId);
  const beforeDir = path.join(applyDir, "before");
  await mkdir(beforeDir, { recursive: true });

  const manifestFiles = [];
  for (const file of files) {
    const relativePath = toRepoPath(file.path);
    const sourcePath = resolveInside(root, relativePath);
    const backupPath = path.join(beforeDir, relativePath);
    const existing = await getExistingFileState(sourcePath);

    if (existing.existedBefore) {
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(sourcePath, backupPath);
    }

    manifestFiles.push({
      path: relativePath,
      status: file.status ?? "modified",
      existedBefore: existing.existedBefore,
      backupPath: existing.existedBefore
        ? toRepoPath(path.relative(applyDir, backupPath))
        : null,
    });
  }

  const manifest = {
    schemaVersion: "0.1",
    id: applyId,
    sessionId: id,
    task: options.task ?? "",
    files: manifestFiles,
    createdAt: (options.now ?? new Date()).toISOString(),
    rolledBackAt: null,
  };
  const manifestPath = path.join(applyDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    ...manifest,
    applyDir,
    manifestPath,
  };
}

export async function rollbackApplyRecord(repoRoot, sessionId, applyId, options = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    throw new Error("Session is required");
  }

  const root = path.resolve(repoRoot);
  const targetApplyId = applyId ?? (await findLatestApplyId(root, id));
  if (!targetApplyId) {
    throw new Error(`No apply records found for session: ${id}`);
  }

  const applyDir = path.join(root, ".vibeguard", "applies", id, targetApplyId);
  const manifestPath = path.join(applyDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.rolledBackAt) {
    throw new Error(`Apply already rolled back: ${targetApplyId}`);
  }

  const rolledBack = [];
  for (const file of manifest.files ?? []) {
    const targetPath = resolveInside(root, file.path);

    if (file.existedBefore) {
      const backupPath = resolveInside(applyDir, file.backupPath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(backupPath, targetPath);
    } else {
      await rm(targetPath, { force: true });
    }

    rolledBack.push(file.path);
  }

  const updatedManifest = {
    ...manifest,
    rolledBackAt: (options.now ?? new Date()).toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");

  return {
    ...updatedManifest,
    applyDir,
    manifestPath,
    rolledBack,
  };
}

async function getExistingFileState(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error(`Cannot back up non-file path: ${filePath}`);
    }
    return { existedBefore: true };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { existedBefore: false };
    }
    throw error;
  }
}

async function findLatestApplyId(repoRoot, sessionId) {
  const appliesDir = path.join(repoRoot, ".vibeguard", "applies", sessionId);
  let entries;
  try {
    entries = await readdir(appliesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const applies = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const fullPath = path.join(appliesDir, entry.name, "manifest.json");
    try {
      const info = await stat(fullPath);
      applies.push({ id: entry.name, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  applies.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return applies[0]?.id ?? null;
}

function makeApplyId(sessionId, now) {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${timestamp}-${slugify(sessionId)}-${randomSuffix()}`;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return target;
}

function toRepoPath(value) {
  return String(value).replaceAll("\\", "/");
}

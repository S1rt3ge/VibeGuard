import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const files = await collectFiles(root);
let failed = false;

for (const file of files.filter((item) => item.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Syntax OK (${files.filter((item) => item.endsWith(".js")).length} JS files)`);
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (shouldSkip(entry.name)) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath)));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

function shouldSkip(name) {
  return [
    ".agents",
    ".codex",
    ".git",
    ".nyc_output",
    ".vibeguard",
    "coverage",
    "docs",
    "node_modules",
  ].includes(name);
}

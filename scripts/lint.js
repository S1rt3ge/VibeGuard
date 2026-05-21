import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const files = await collectFiles(root);
const lintable = files.filter((file) => /\.(js|json|md|yaml)$/.test(file));
const issues = [];

for (const file of lintable) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (/[ \t]$/.test(line)) {
      issues.push(`${relative(file)}:${index + 1} trailing whitespace`);
    }
  });

  if (!text.endsWith("\n")) {
    issues.push(`${relative(file)} missing final newline`);
  }
}

if (issues.length > 0) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Lint OK (${lintable.length} files)`);
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

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

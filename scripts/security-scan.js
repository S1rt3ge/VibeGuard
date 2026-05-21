import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const files = await collectFiles(root);
const codeFiles = files.filter((file) => /\.(js|json)$/.test(file));
const patterns = [
  { name: "openai_secret_key", regex: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "generic_private_key", regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "hardcoded_password", regex: /\b(password|passwd|pwd)\s*[:=]\s*["'][^"']{8,}["']/i },
];
const findings = [];

for (const file of codeFiles) {
  const text = await readFile(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      findings.push(`${relative(file)} ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Security scan OK (${codeFiles.length} files)`);
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

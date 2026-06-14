#!/usr/bin/env node
// Live 30-second demo of the VibeGuard AI change gate.
//
//   node examples/demo/demo.mjs
//
// It spins up two throwaway git repos that mimic two agent-authored PRs:
//   1. a "bad" PR that slips a .env.local secret into the diff  -> gate BLOCKS
//   2. a "clean" PR that only touches source                    -> gate PASSES
// For each it derives a capsule from the PR diff and runs the same CI check the
// GitHub Action runs, then prints the verdict. Nothing here touches your repo.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(fileURLToPath(import.meta.url), "../../../apps/cli/src/index.js");

function git(root, ...args) {
  const r = spawnSync("git", ["-C", root, "-c", "user.email=demo@x", "-c", "user.name=demo", ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function vg(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
}

function scenario(label, makeChange) {
  const root = mkdtempSync(path.join(tmpdir(), "vibeguard-demo-"));
  try {
    git(root, "init", "-q");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.js"), "export const app = true;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "baseline");
    const base = git(root, "rev-parse", "HEAD");

    makeChange(root); // the "agent" makes its edits
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "agent PR");

    // This is exactly what the GitHub Action does:
    vg(root, ["capsule", "from", "--base", base, "--head", "HEAD", "--agent", "demo"]);
    const out = vg(root, ["ci", "validate", "--latest", "--git-base", base, "--json"]);
    const validation = JSON.parse(out.stdout).validation;

    console.log(`\n=== ${label} ===`);
    if (validation.valid) {
      console.log("  ✅ Gate PASSED — change is in scope, no secrets, provenance recorded.");
    } else {
      console.log("  ❌ Gate BLOCKED the PR:");
      for (const f of validation.findings) {
        console.log(`     - ${f.code}${f.path ? `: ${f.path}` : ""}`);
      }
    }
    console.log(`  (capsule: risk=${validation.capsule?.risk}, exit=${out.status})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("VibeGuard AI change gate — demo");

scenario("PR #1: agent adds a feature AND leaks a .env.local secret", (root) => {
  writeFileSync(path.join(root, "src", "feature.js"), "export const feature = true;\n");
  writeFileSync(path.join(root, ".env.local"), "STRIPE_SECRET_KEY=sk_live_oops\n");
});

scenario("PR #2: agent adds a clean feature", (root) => {
  writeFileSync(path.join(root, "src", "feature.js"), "export const feature = true;\n");
});

console.log("\nThat is the whole product: no AI-PR merges without a clean, signed capsule.\n");

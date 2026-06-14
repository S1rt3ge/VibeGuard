import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDefaultPolicy } from "../../policy/src/index.js";
import { ensureSigningKey } from "./signing.js";

export async function initializeProject(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const stateDir = path.join(root, ".vibeguard");
  await mkdir(stateDir, { recursive: true });
  await ensureSigningKey(root);

  const configPath = path.join(stateDir, "config.json");
  const config = {
    schemaVersion: "0.1",
    product: "vibeguard",
    policy: createDefaultPolicy(),
    checks: [],
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    root,
    stateDir,
    configPath,
    config,
  };
}

export async function loadProjectConfig(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const configPath = path.join(root, ".vibeguard", "config.json");

  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schemaVersion: "0.1",
        product: "vibeguard",
        policy: createDefaultPolicy(),
      };
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid VibeGuard config JSON: ${configPath}`);
  }
}

export async function loadProjectPolicy(repoRoot = process.cwd(), overrides = {}) {
  const config = await loadProjectConfig(repoRoot);
  const defaults = createDefaultPolicy();
  const configPolicy = config.policy ?? {};

  return {
    allowedGlobs: resolveArrayPolicyField(
      "policy.allowedGlobs",
      overrides.allowedGlobs ?? configPolicy.allowedGlobs,
      defaults.allowedGlobs,
    ),
    blockedGlobs: resolveArrayPolicyField(
      "policy.blockedGlobs",
      configPolicy.blockedGlobs,
      defaults.blockedGlobs,
    ),
    approvalGlobs: resolveArrayPolicyField(
      "policy.approvalGlobs",
      configPolicy.approvalGlobs,
      defaults.approvalGlobs,
    ),
    riskZones: resolveRiskZones(configPolicy.riskZones, defaults.riskZones),
  };
}

export async function loadProjectChecks(repoRoot = process.cwd()) {
  const config = await loadProjectConfig(repoRoot);
  const checks = config.checks ?? [];

  if (!Array.isArray(checks)) {
    throw new Error("checks must be an array");
  }

  return checks.map((check, index) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error(`checks[${index}] must be an object`);
    }

    const name = String(check.name ?? "").trim();
    const command = String(check.command ?? "").trim();

    if (!name) {
      throw new Error(`checks[${index}].name is required`);
    }
    if (!command) {
      throw new Error(`checks[${index}].command is required`);
    }

    return { name, command };
  });
}

function resolveArrayPolicyField(name, value, fallback) {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${name} must contain only strings`);
    }
  }
  return [...value];
}

function resolveRiskZones(value, fallback) {
  if (value === undefined) {
    return { ...fallback };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("policy.riskZones must be an object");
  }

  for (const [glob, zone] of Object.entries(value)) {
    if (typeof glob !== "string" || typeof zone !== "string") {
      throw new Error("policy.riskZones must map strings to strings");
    }
  }

  return { ...value };
}

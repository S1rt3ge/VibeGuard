#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  createCapsule,
  listCapsules,
  readCapsuleArtifact,
  saveCapsule,
} from "../../../packages/core/src/capsule-store.js";
import { initializeProject, loadProjectPolicy } from "../../../packages/core/src/project.js";
import {
  buildContextBundle,
  saveContextBundle,
} from "../../../packages/context/src/context-builder.js";
import {
  appendCheckRecord,
  readCheckRecords,
} from "../../../packages/core/src/check-log.js";
import { validateCiArtifacts } from "../../../packages/core/src/ci-validator.js";
import {
  appendCommandRecord,
  readCommandRecords,
} from "../../../packages/core/src/command-log.js";
import {
  generateDebtReport,
  readDebtEntries,
} from "../../../packages/core/src/debt-ledger.js";
import {
  applySafeChanges,
  buildSessionStatus,
  createShadowSession,
  reviewShadowSession,
  rollbackAppliedChanges,
} from "../../../packages/core/src/shadow-workspace.js";
import {
  createReviewPayload,
  saveReviewArtifact,
} from "../../../packages/core/src/review-store.js";
import { evaluateCommand } from "../../../packages/context/src/command-guard.js";
import { reviewChanges } from "../../../packages/policy/src/index.js";
import { scoreReview } from "../../../packages/risk-engine/src/index.js";
import {
  formatCommandDecision,
  formatCommandHistory,
  formatCheckHistory,
  formatCiValidation,
  formatCiAnnotations,
  formatCapsuleList,
  formatCapsuleShow,
  formatContextSummary,
  formatDebtReport,
  formatReviewSummary,
  formatSessionStatus,
} from "../../../packages/reporters/src/text.js";

async function main(argv) {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "doctor") {
    const options = parseOptions(args);
    const result = await runDoctor(options.root ?? process.cwd());
    if (options.json) {
      printJson(createDoctorPayload(result));
    } else {
      console.log(formatDoctor(result));
    }
    return result.ok ? 0 : 2;
  }

  if (command === "init") {
    const options = parseOptions(args);
    const result = await initializeProject(options.root ?? process.cwd());
    console.log(`Initialized VibeGuard at ${result.stateDir}`);
    console.log("");
    console.log("Next: create a quarantined AI task:");
    console.log('  vibeguard task "fix login bug" --allow "app/**,lib/**,tests/**"');
    return 0;
  }

  if (command === "task") {
    const options = parseOptions(args);
    const task = options.positionals.join(" ");
    const session = await createShadowSession({
      repoRoot: options.root ?? process.cwd(),
      task,
      sessionId: options.session,
      allowedGlobs: parseMultiValueOption(options.allow),
    });
    if (options.json) {
      printJson(createTaskPayload(session));
    } else {
      console.log(`Created shadow session ${session.id}`);
      console.log(`Shadow workspace: ${session.shadowPath}`);
      console.log("");
      console.log("Next:");
      console.log("  1. Open the shadow workspace in your AI coding tool.");
      console.log("  2. Let the agent edit files there, not in your real repo.");
      console.log(`  3. Run: vibeguard review --session ${session.id}`);
      console.log(`  4. Run: vibeguard apply --safe --session ${session.id}`);
    }
    return 0;
  }

  if (command === "status") {
    const options = parseOptions(args);
    const allowedGlobs = parseMultiValueOption(options.allow);
    const status = await buildSessionStatus(options.root ?? process.cwd(), options.session, {
      allowedGlobs: allowedGlobs.length > 0 ? allowedGlobs : undefined,
    });
    if (options.json) {
      printJson({
        schemaVersion: "0.1",
        command: "status",
        status,
      });
    } else {
      console.log(formatSessionStatus(status));
    }
    return 0;
  }

  if (command === "guard-command") {
    const options = parseOptions(args);
    const rawCommand = options.positionals.join(" ");
    const decision = evaluateCommand(rawCommand);
    if (options.session) {
      await appendCommandRecord(options.root ?? process.cwd(), options.session, decision);
    }
    console.log(formatCommandDecision(decision));
    return decision.decision === "blocked" ? 2 : 0;
  }

  if (command === "command") {
    const [subcommand, ...subArgs] = args;
    if (subcommand !== "history") {
      throw new Error("Unknown command command. Use: vibeguard command history");
    }
    const options = parseOptions(subArgs);
    if (!options.session || options.session === true) {
      throw new Error("--session is required");
    }
    const records = await readCommandRecords(options.root ?? process.cwd(), options.session);
    console.log(formatCommandHistory(options.session, records));
    return 0;
  }

  if (command === "check") {
    const [subcommand, ...subArgs] = args;
    const options = parseOptions(subArgs);
    if (!options.session || options.session === true) {
      throw new Error("--session is required");
    }

    if (subcommand === "record") {
      const record = await appendCheckRecord(options.root ?? process.cwd(), options.session, {
        name: requireOption(options.name, "name"),
        status: requireOption(options.status, "status"),
        command: optionString(options.command),
        summary: optionString(options.summary),
        durationMs: parseOptionalNonNegativeNumberOption(options["duration-ms"], "duration-ms"),
      });
      console.log(`Recorded check ${record.name}: ${record.status}`);
      return 0;
    }

    if (subcommand === "history") {
      const records = await readCheckRecords(options.root ?? process.cwd(), options.session);
      console.log(formatCheckHistory(options.session, records));
      return 0;
    }

    throw new Error("Unknown check command. Use: vibeguard check record|history");
  }

  if (command === "ci") {
    const [subcommand, ...subArgs] = args;
    if (subcommand !== "validate" && subcommand !== "annotate") {
      throw new Error("Unknown ci command. Use: vibeguard ci validate|annotate");
    }
    const options = parseOptions(subArgs);
    const validation = await validateCiOptions(options);

    if (subcommand === "annotate") {
      console.log(formatCiAnnotations(validation));
    } else if (options.json) {
      printJson({
        schemaVersion: "0.1",
        command: "ci_validate",
        validation,
      });
    } else {
      console.log(formatCiValidation(validation));
    }

    return validation.valid ? 0 : 2;
  }

  if (command === "context") {
    const [subcommand, ...subArgs] = args;
    if (subcommand !== "build") {
      throw new Error("Unknown context command. Use: vibeguard context build");
    }
    const options = parseOptions(subArgs);
    const task = options.positionals.join(" ");
    const bundle = await buildContextBundle({
      repoRoot: options.root ?? process.cwd(),
      task,
      includeGlobs: parseMultiValueOption(options.include),
    });
    const bundlePath = await saveContextBundle(options.root ?? process.cwd(), bundle);
    if (options.json) {
      printJson(createContextBuildPayload(bundle, bundlePath));
    } else {
      console.log(formatContextSummary(bundle, bundlePath));
    }
    return 0;
  }

  if (command === "debt") {
    const [subcommand, ...subArgs] = args;
    if (subcommand !== "report") {
      throw new Error("Unknown debt command. Use: vibeguard debt report");
    }
    const options = parseOptions(subArgs);
    const days = parsePositiveNumberOption(options.days ?? "30", "days");
    const entries = await readDebtEntries(options.root ?? process.cwd());
    const report = generateDebtReport(entries, { days });
    if (options.json) {
      printJson({
        schemaVersion: "0.1",
        command: "debt_report",
        report,
      });
    } else {
      console.log(formatDebtReport(report));
    }
    return 0;
  }

  if (command === "review") {
    const options = parseOptions(args);
    const allowedGlobs = parseMultiValueOption(options.allow);
    if (options.session) {
      const result = await reviewShadowSession(options.root ?? process.cwd(), options.session, {
        allowedGlobs: allowedGlobs.length > 0 ? allowedGlobs : undefined,
      });
      const payload = createReviewPayload(result);
      const reviewPath = options.save
        ? await saveReviewArtifact(options.root ?? process.cwd(), payload)
        : "";
      if (options.json) {
        printJson({
          ...payload,
          ...(reviewPath ? { reviewPath } : {}),
        });
      } else {
        console.log(formatReviewSummary(result.review, result.score));
        if (reviewPath) {
          console.log(`Review artifact: ${reviewPath}`);
        }
      }
    } else {
      if (options.save) {
        throw new Error("--save is only supported with --session");
      }
      const files = parseCsvOption(options.files, "files");
      const policy = await loadProjectPolicy(options.root ?? process.cwd(), {
        allowedGlobs: allowedGlobs.length > 0 ? allowedGlobs : undefined,
      });
      const review = reviewChanges(files, policy);
      const score = scoreReview(review);
      if (options.json) {
        printJson({
          schemaVersion: "0.1",
          command: "review",
          files,
          review,
          score,
        });
      } else {
        console.log(formatReviewSummary(review, score));
      }
    }
    return 0;
  }

  if (command === "apply") {
    const options = parseOptions(args);
    if (!options.safe) {
      throw new Error("apply requires --safe for this slice");
    }
    const allowedGlobs = parseMultiValueOption(options.allow);
    const result = await applySafeChanges(options.root ?? process.cwd(), options.session, {
      allowedGlobs: allowedGlobs.length > 0 ? allowedGlobs : undefined,
      files: options.files ? parseCsvOption(options.files, "files") : undefined,
    });
    if (options.json) {
      printJson(createApplyPayload(result));
    } else {
      console.log(`Applied: ${result.applied.length}`);
      console.log(`Skipped blocked: ${result.review.blocked.length}`);
      console.log(`Skipped approval required: ${result.review.approvalRequired.length}`);
      console.log(`Apply id: ${result.applyRecord.id}`);
      console.log(`Capsule: ${result.capsulePath}`);
    }
    return 0;
  }

  if (command === "rollback") {
    const options = parseOptions(args);
    if (!options.session || options.session === true) {
      throw new Error("--session is required");
    }
    const result = await rollbackAppliedChanges(options.root ?? process.cwd(), options.session, {
      applyId: optionString(options.apply) || undefined,
    });
    if (options.json) {
      printJson(createRollbackPayload(result));
    } else {
      console.log(`Rolled back apply: ${result.id}`);
      console.log(`Files restored: ${result.rolledBack.length}`);
      console.log(`Manifest: ${result.manifestPath}`);
    }
    return 0;
  }

  if (command === "capsule") {
    const [subcommand, ...subArgs] = args;

    if (subcommand === "list") {
      const options = parseOptions(subArgs);
      const result = await listCapsules(options.root ?? process.cwd());
      if (options.json) {
        printJson({
          schemaVersion: "0.1",
          command: "capsule_list",
          capsules: result.capsules,
          skipped: result.skipped,
        });
      } else {
        console.log(formatCapsuleList(result));
      }
      return 0;
    }

    if (subcommand === "show") {
      const options = parseOptions(subArgs);
      const result = await readCapsuleArtifact({
        repoRoot: options.root ?? process.cwd(),
        capsulePath: optionString(options.path) || undefined,
        latest: optionFlag(options.latest),
      });
      if (options.json) {
        printJson({
          schemaVersion: "0.1",
          command: "capsule_show",
          path: result.path,
          summary: result.summary,
          capsule: result.capsule,
        });
      } else {
        console.log(formatCapsuleShow(result));
      }
      return 0;
    }

    const options = parseOptions(args);
    const files = parseCsvOption(options.files, "files");
    const task = options.task;
    const allowedGlobs = parseMultiValueOption(options.allow);
    const policy = await loadProjectPolicy(options.root ?? process.cwd(), {
      allowedGlobs: allowedGlobs.length > 0 ? allowedGlobs : undefined,
    });
    const review = reviewChanges(files, policy);
    const score = scoreReview(review);
    const capsule = createCapsule({
      task,
      review,
      score,
      applied: review.reviewable.map((item) => item.path),
      humanApproval: review.blocked.length > 0 ? "partial" : "yes",
    });
    const savedPath = await saveCapsule(options.root ?? process.cwd(), capsule);
    console.log(`Wrote capsule ${savedPath}`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args) {
  const options = { positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function parseCsvOption(value, name) {
  if (!value || value === true) {
    throw new Error(`--${name} is required`);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMultiValueOption(value) {
  if (!value || value === true) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveNumberOption(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return number;
}

function parseOptionalNonNegativeNumberOption(value, name) {
  if (value === undefined || value === true) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return number;
}

function requireOption(value, name) {
  if (!value || value === true) {
    throw new Error(`--${name} is required`);
  }
  return String(value);
}

function optionString(value) {
  if (!value || value === true) {
    return "";
  }
  return String(value);
}

async function validateCiOptions(options) {
  const latest = optionFlag(options.latest);
  const reviewPath = optionString(options.review);
  const reviewLatest = optionFlag(options["review-latest"]);
  if (!latest && !optionString(options.capsule)) {
    throw new Error("--capsule is required unless --latest is used");
  }
  if (reviewPath && reviewLatest) {
    throw new Error("--review and --review-latest cannot be combined");
  }
  return validateCiArtifacts({
    repoRoot: options.root ?? process.cwd(),
    capsulePath: optionString(options.capsule) || undefined,
    reviewPath: reviewPath || undefined,
    latest,
    reviewLatest,
  });
}

function optionFlag(value) {
  return value === true || value === "true";
}

async function runDoctor(repoRoot) {
  const root = path.resolve(repoRoot);
  await access(root);

  const checks = [
    checkNodeVersion(),
    checkGitAvailable(),
    await checkProjectState(root),
  ];
  const projectReady = checks.find((check) => check.name === "project")?.status === "ok";

  return {
    ok: checks.every((check) => check.status !== "failed"),
    checks,
    next: projectReady
      ? ['vibeguard task "fix login bug" --allow "app/**,lib/**,tests/**"']
      : ["vibeguard init"],
  };
}

function checkNodeVersion() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (Number.isFinite(major) && major >= 22) {
    return { name: "node", status: "ok", message: `v${version}` };
  }
  return { name: "node", status: "failed", message: `v${version} (requires >=22)` };
}

function checkGitAvailable() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    return { name: "git", status: "ok", message: result.stdout.trim() };
  }
  return { name: "git", status: "failed", message: "git executable not found" };
}

async function checkProjectState(root) {
  const configPath = path.join(root, ".vibeguard", "config.json");
  try {
    await access(configPath);
    return { name: "project", status: "ok", message: configPath };
  } catch {
    return { name: "project", status: "warning", message: "not initialized" };
  }
}

function createDoctorPayload(result) {
  return {
    schemaVersion: "0.1",
    command: "doctor",
    ok: result.ok,
    checks: result.checks,
    next: result.next,
  };
}

function formatDoctor(result) {
  const labels = {
    node: "Node",
    git: "Git",
    project: "Project",
  };
  const lines = ["VibeGuard Doctor"];

  for (const check of result.checks) {
    const label = labels[check.name] ?? check.name;
    if (check.status === "ok") {
      lines.push(`${label}: ok ${check.message}`);
    } else if (check.status === "warning") {
      lines.push(`${label}: ${check.message}`);
    } else {
      lines.push(`${label}: failed ${check.message}`);
    }
  }

  lines.push("", "Next:");
  for (const command of result.next) {
    lines.push(`  ${command}`);
  }

  return lines.join("\n");
}

function createTaskPayload(session) {
  return {
    schemaVersion: "0.1",
    command: "task",
    session: {
      id: session.id,
      task: session.task,
      agent: session.agent,
      model: session.model,
      repoRoot: session.repoRoot,
      shadowPath: session.shadowPath,
      sessionPath: session.sessionPath,
      policy: {
        allowedGlobs: session.policy?.allowedGlobs ?? [],
      },
      snapshot: {
        excluded: session.snapshot?.excluded ?? [],
        files: Object.keys(session.snapshot?.manifest ?? {}).length,
      },
      createdAt: session.createdAt,
      status: session.status,
    },
  };
}

function createContextBuildPayload(bundle, bundlePath) {
  return {
    schemaVersion: "0.1",
    command: "context_build",
    bundlePath,
    bundle: {
      id: bundle.id,
      task: bundle.task,
      includeGlobs: bundle.includeGlobs,
      included: bundle.included.map((item) => ({
        path: item.path,
        redactions: item.redactions,
      })),
      excluded: bundle.excluded,
      redactions: bundle.redactions,
      stats: bundle.stats,
      createdAt: bundle.createdAt,
    },
  };
}

function createApplyPayload(result) {
  return {
    schemaVersion: "0.1",
    command: "apply",
    sessionId: result.session.id,
    applied: result.applied,
    skipped: {
      blocked: result.review.blocked.length,
      approvalRequired: result.review.approvalRequired.length,
    },
    apply: {
      id: result.applyRecord.id,
      manifestPath: result.applyRecord.manifestPath,
      files: result.applyRecord.files.length,
    },
    capsulePath: result.capsulePath,
    debtEntry: result.debtEntry,
  };
}

function createRollbackPayload(result) {
  return {
    schemaVersion: "0.1",
    command: "rollback",
    sessionId: result.sessionId,
    applyId: result.id,
    rolledBack: result.rolledBack,
    manifestPath: result.manifestPath,
    rolledBackAt: result.rolledBackAt,
    debtEntry: result.debtEntry,
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`VibeGuard

AI-native change control for coding agents.
Let AI code fast. Merge safely.

Quick start:
  vibeguard doctor
  vibeguard init
  vibeguard task "fix login bug" --allow "app/**,lib/**,tests/**"
  # Open the printed shadow workspace in your AI coding tool.
  vibeguard review --session "<session-id>"
  vibeguard apply --safe --session "<session-id>"

Commands:
  vibeguard doctor [--root <path>] [--json]
  vibeguard init [--root <path>]
  vibeguard task "<task>" [--root <path>] [--session <id>] [--allow <csv>] [--json]
  vibeguard status [--session <id>] [--root <path>] [--json]
  vibeguard guard-command [--session <id>] "<command>"
  vibeguard command history --session <id> [--root <path>]
  vibeguard check record --session <id> --name <name> --status <passed|failed|skipped> [--command <command>] [--summary <text>] [--duration-ms <n>] [--root <path>]
  vibeguard check history --session <id> [--root <path>]
  vibeguard ci validate --capsule <path> [--review <path>] [--root <path>] [--json]
  vibeguard ci validate --latest [--review-latest] [--root <path>] [--json]
  vibeguard ci annotate (--latest|--capsule <path>) [--review <path>|--review-latest] [--root <path>]
  vibeguard context build "<task>" [--include <csv>] [--root <path>] [--json]
  vibeguard debt report [--days <n>] [--root <path>] [--json]
  vibeguard review --files <csv> [--allow <csv>] [--json]
  vibeguard review --session <id> [--allow <csv>] [--root <path>] [--json] [--save]
  vibeguard apply --safe --session <id> [--files <csv>] [--allow <csv>] [--root <path>] [--json]
  vibeguard rollback --session <id> [--apply <apply-id>] [--root <path>] [--json]
  vibeguard capsule list [--root <path>] [--json]
  vibeguard capsule show (--latest|--path <path>) [--root <path>] [--json]
  vibeguard capsule --task "<task>" --files <csv> [--allow <csv>] [--root <path>]

Read more: https://github.com/S1rt3ge/VibeGuard#readme`);
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

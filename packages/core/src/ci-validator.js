import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeRepoPath } from "../../policy/src/index.js";

const CAPSULE_REQUIRED_FIELDS = [
  "task",
  "filesChanged",
  "risk",
  "slop",
  "blocked",
  "approvalRequired",
  "reviewable",
  "applied",
  "humanApproval",
];

export async function validateCiArtifacts({
  repoRoot = process.cwd(),
  capsulePath,
  reviewPath,
  latest = false,
  reviewLatest = false,
} = {}) {
  const root = path.resolve(repoRoot);
  const findings = [];
  const artifacts = await discoverCiArtifacts({
    repoRoot: root,
    capsulePath,
    reviewPath,
    latest,
    reviewLatest,
  });

  if (!artifacts.capsulePath) {
    findings.push(errorFinding("missing_capsule", "Capsule artifact is required."));
    return buildValidation({ findings, capsulePath: "", reviewPath: "" });
  }

  const resolvedCapsulePath = artifacts.capsulePath;
  const capsuleResult = await readJsonArtifact(resolvedCapsulePath, {
    missingCode: "missing_capsule",
    invalidCode: "invalid_capsule_json",
    label: "Capsule",
  });
  findings.push(...capsuleResult.findings);

  if (!capsuleResult.value) {
    return buildValidation({
      findings,
      capsulePath: resolvedCapsulePath,
      reviewPath: artifacts.reviewPath,
    });
  }

  const capsule = capsuleResult.value;
  validateCapsuleShape(capsule, findings);
  validateCapsuleBoundaries(capsule, findings);

  let review = null;
  let resolvedReviewPath = "";
  if (artifacts.reviewRequested && !artifacts.reviewPath) {
    findings.push(errorFinding("missing_review", "Review artifact is required."));
  } else if (artifacts.reviewPath) {
    resolvedReviewPath = artifacts.reviewPath;
    const reviewResult = await readJsonArtifact(resolvedReviewPath, {
      missingCode: "missing_review",
      invalidCode: "invalid_review_json",
      label: "Review",
    });
    findings.push(...reviewResult.findings);
    review = reviewResult.value;

    if (review) {
      validateReviewPayload(review, findings);
      validateReviewConsistency(review, capsule, findings);
    }
  }

  return buildValidation({
    findings,
    capsulePath: resolvedCapsulePath,
    reviewPath: resolvedReviewPath,
    capsule,
    review,
  });
}

export async function discoverCiArtifacts({
  repoRoot = process.cwd(),
  capsulePath,
  reviewPath,
  latest = false,
  reviewLatest = false,
} = {}) {
  const root = path.resolve(repoRoot);
  const resolvedCapsulePath = latest
    ? await findLatestJsonFile(path.join(root, ".vibeguard", "capsules"))
    : optionPath(root, capsulePath);
  const explicitReviewPath = optionPath(root, reviewPath);
  const resolvedReviewPath = reviewLatest
    ? await findLatestJsonFile(path.join(root, ".vibeguard", "reviews"))
    : explicitReviewPath;

  return {
    capsulePath: resolvedCapsulePath,
    reviewPath: resolvedReviewPath,
    reviewRequested: Boolean(reviewLatest || explicitReviewPath),
  };
}

function validateCapsuleShape(capsule, findings) {
  if (capsule.schemaVersion !== "0.1") {
    findings.push(errorFinding(
      "unsupported_capsule_schema",
      "Capsule schemaVersion must be 0.1.",
    ));
  }

  for (const field of CAPSULE_REQUIRED_FIELDS) {
    if (!Object.hasOwn(capsule, field)) {
      findings.push(errorFinding(
        "invalid_capsule_shape",
        `Capsule is missing required field: ${field}.`,
        { field },
      ));
    }
  }

  for (const field of ["filesChanged", "blocked", "approvalRequired", "reviewable", "applied"]) {
    if (Object.hasOwn(capsule, field) && !Array.isArray(capsule[field])) {
      findings.push(errorFinding(
        "invalid_capsule_shape",
        `Capsule field must be an array: ${field}.`,
        { field },
      ));
    }
  }

  if (capsule.risk?.level === "high" && capsule.humanApproval === "pending") {
    findings.push(errorFinding(
      "high_risk_without_approval",
      "High-risk capsule requires human approval before merge.",
    ));
  }
}

function validateCapsuleBoundaries(capsule, findings) {
  const applied = new Set(pathsFromStrings(capsule.applied));

  for (const filePath of pathsFromDecisionItems(capsule.blocked)) {
    if (applied.has(filePath)) {
      findings.push(errorFinding(
        "blocked_file_applied",
        `Blocked file was applied: ${filePath}.`,
        { path: filePath },
      ));
    }
  }

  for (const filePath of pathsFromDecisionItems(capsule.approvalRequired)) {
    if (applied.has(filePath)) {
      findings.push(errorFinding(
        "approval_required_file_applied",
        `Approval-required file was applied: ${filePath}.`,
        { path: filePath },
      ));
    }
  }
}

function validateReviewPayload(review, findings) {
  if (review.schemaVersion !== "0.1" || review.command !== "review") {
    findings.push(errorFinding(
      "invalid_review_payload",
      "Review artifact must be review --json output with schemaVersion 0.1.",
    ));
  }

  if (!review.review || typeof review.review !== "object" || Array.isArray(review.review)) {
    findings.push(errorFinding(
      "invalid_review_payload",
      "Review artifact must include a review object.",
    ));
    return;
  }

  for (const field of ["blocked", "approvalRequired", "reviewable"]) {
    if (!Array.isArray(review.review[field])) {
      findings.push(errorFinding(
        "invalid_review_payload",
        `Review field must be an array: ${field}.`,
        { field },
      ));
    }
  }
}

function validateReviewConsistency(review, capsule, findings) {
  const reviewBody = review.review;
  if (!reviewBody || typeof reviewBody !== "object" || Array.isArray(reviewBody)) {
    return;
  }

  const applied = new Set(pathsFromStrings(capsule.applied));

  for (const filePath of pathsFromDecisionItems(reviewBody.blocked)) {
    if (applied.has(filePath)) {
      findings.push(errorFinding(
        "review_blocked_file_applied",
        `Review-blocked file was applied: ${filePath}.`,
        { path: filePath },
      ));
    }
  }

  for (const filePath of pathsFromDecisionItems(reviewBody.approvalRequired)) {
    if (applied.has(filePath)) {
      findings.push(errorFinding(
        "review_approval_required_file_applied",
        `Review approval-required file was applied: ${filePath}.`,
        { path: filePath },
      ));
    }
  }
}

async function readJsonArtifact(filePath, { missingCode, invalidCode, label }) {
  try {
    const text = await readFile(filePath, "utf8");
    return {
      value: JSON.parse(text),
      findings: [],
    };
  } catch (readError) {
    if (readError.code === "ENOENT") {
      return {
        value: null,
        findings: [errorFinding(missingCode, `${label} artifact is missing.`, { path: filePath })],
      };
    }

    if (readError instanceof SyntaxError) {
      return {
        value: null,
        findings: [errorFinding(invalidCode, `${label} artifact contains invalid JSON.`, { path: filePath })],
      };
    }

    throw readError;
  }
}

function buildValidation({
  findings,
  capsulePath,
  reviewPath,
  capsule = null,
  review = null,
}) {
  return {
    valid: findings.every((finding) => finding.severity !== "error"),
    capsulePath,
    reviewPath,
    findings,
    capsule: summarizeCapsule(capsule),
    review: summarizeReview(review),
  };
}

function summarizeCapsule(capsule) {
  if (!capsule) {
    return null;
  }

  return {
    task: String(capsule.task ?? ""),
    filesChanged: Array.isArray(capsule.filesChanged) ? capsule.filesChanged.length : 0,
    risk: capsule.risk?.level ?? "unknown",
    humanApproval: capsule.humanApproval ?? "unknown",
  };
}

function summarizeReview(review) {
  if (!review?.review) {
    return null;
  }

  return {
    blocked: Array.isArray(review.review.blocked) ? review.review.blocked.length : 0,
    approvalRequired: Array.isArray(review.review.approvalRequired)
      ? review.review.approvalRequired.length
      : 0,
    reviewable: Array.isArray(review.review.reviewable) ? review.review.reviewable.length : 0,
  };
}

function pathsFromDecisionItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => normalizeRepoPath(item?.path))
    .filter(Boolean);
}

function pathsFromStrings(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => normalizeRepoPath(item))
    .filter(Boolean);
}

function resolveArtifactPath(root, artifactPath) {
  return path.resolve(root, String(artifactPath));
}

function optionPath(root, artifactPath) {
  if (!artifactPath || artifactPath === true) {
    return "";
  }
  return resolveArtifactPath(root, artifactPath);
}

async function findLatestJsonFile(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (readError) {
    if (readError.code === "ENOENT") {
      return "";
    }
    throw readError;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    const info = await stat(filePath);
    candidates.push({
      filePath,
      name: entry.name,
      mtimeMs: info.mtimeMs,
    });
  }

  candidates.sort((left, right) => (
    right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name)
  ));

  return candidates[0]?.filePath ?? "";
}

function errorFinding(code, message, extra = {}) {
  return {
    severity: "error",
    code,
    message,
    ...extra,
  };
}

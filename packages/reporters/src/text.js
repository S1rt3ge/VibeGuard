export function formatReviewSummary(review, score) {
  const lines = [
    `Blocked: ${review.blocked.length}`,
    `Approval required: ${review.approvalRequired.length}`,
    `Reviewable: ${review.reviewable.length}`,
    `Risk: ${score.risk.level}`,
    `Slop score: ${score.slop.score}/100`,
  ];

  const changedFiles = [
    ...review.blocked,
    ...review.approvalRequired,
    ...review.reviewable,
  ];

  if (changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const item of changedFiles) {
      lines.push(`  ${item.status ?? "modified"} ${item.decision} ${item.path}`);
    }
  }

  return lines.join("\n");
}

export function buildReviewDecisionSummary(review, score) {
  const counts = {
    blocked: review.blocked.length,
    approvalRequired: review.approvalRequired.length,
    reviewable: review.reviewable.length,
  };
  const decision = reviewDecision(counts);

  return {
    decision,
    headline: reviewHeadline(decision),
    counts,
    risk: score.risk.level,
    why: reviewWhy(score),
    next: reviewNextSteps(decision),
  };
}

export function formatReviewDecisionSummary(summary) {
  const lines = [
    "Decision summary:",
    `  Decision: ${summary.decision}`,
    `  Headline: ${summary.headline}`,
    "  Why:",
  ];

  for (const item of summary.why) {
    lines.push(`    - ${item}`);
  }

  lines.push("  Next:");
  for (const item of summary.next) {
    lines.push(`    - ${item}`);
  }

  return lines.join("\n");
}

function reviewDecision(counts) {
  if (counts.blocked > 0) {
    return "blocked";
  }
  if (counts.approvalRequired > 0) {
    return "approval_required";
  }
  if (counts.reviewable > 0) {
    return "reviewable";
  }
  return "clean";
}

function reviewHeadline(decision) {
  if (decision === "blocked") {
    return "High risk: blocked files need review before apply.";
  }
  if (decision === "approval_required") {
    return "Approval required: sensitive changes need review before apply.";
  }
  if (decision === "reviewable") {
    return "Reviewable changes are ready for dry-run before apply.";
  }
  return "No changes detected.";
}

function reviewWhy(score) {
  if (score.slop.problems.length > 0) {
    return score.slop.problems;
  }
  if (score.risk.reasons.length > 0) {
    return score.risk.reasons;
  }
  return ["No risk signals detected."];
}

function reviewNextSteps(decision) {
  if (decision === "blocked") {
    return [
      "Preview reviewable files with apply --safe --dry-run.",
      "Inspect blocked files before applying.",
    ];
  }
  if (decision === "approval_required") {
    return [
      "Review approval-required changes before applying.",
      "Use apply --safe --dry-run to preview reviewable files.",
    ];
  }
  if (decision === "reviewable") {
    return [
      "Run apply --safe --dry-run to preview writes.",
      "Run apply --safe when ready.",
    ];
  }
  return ["No apply needed."];
}

export function formatCommandDecision(decision) {
  const reasons = decision.reasons.length > 0 ? ` (${decision.reasons.join(", ")})` : "";
  return `${decision.decision}${reasons}`;
}

export function formatContextSummary(bundle, bundlePath) {
  return [
    `Context bundle: ${bundlePath}`,
    `Included: ${bundle.stats.included}`,
    `Excluded: ${bundle.stats.excluded}`,
    `Redactions: ${bundle.stats.redactions}`,
  ].join("\n");
}

export function formatDebtReport(report) {
  return [
    `AI Debt Report - last ${report.days} days`,
    `Sessions: ${report.sessions}`,
    `Files touched: ${report.filesTouched}`,
    `Blocked files: ${report.blockedFiles}`,
    `Approval required changes: ${report.approvalRequiredChanges}`,
    `Dependency changes: ${report.dependencyChanges}`,
    `High-risk sessions: ${report.highRiskSessions}`,
    `TODO comments added: ${report.todoCommentsAdded}`,
    `Tests deleted or weakened: ${report.testsDeletedOrWeakened}`,
    `Commands requested: ${report.commandsRequested}`,
    `Blocked commands: ${report.blockedCommands}`,
    `Approval required commands: ${report.approvalRequiredCommands}`,
    `Checks run: ${report.checksRun}`,
    `Failed checks: ${report.failedChecks}`,
    `Skipped checks: ${report.skippedChecks}`,
    `Rollbacks: ${report.rollbacks}`,
    `Rolled back files: ${report.rolledBackFiles}`,
    `Average slop score: ${report.averageSlopScore}`,
    `Skipped ledger lines: ${report.skippedLines}`,
  ].join("\n");
}

export function formatCommandHistory(sessionId, records) {
  const lines = [`Command History: ${sessionId}`];

  if (records.length === 0) {
    lines.push("No command records.");
    return lines.join("\n");
  }

  for (const record of records) {
    const reasons = record.reasons?.length > 0 ? ` (${record.reasons.join(", ")})` : "";
    lines.push(`${record.decision} ${record.command}${reasons}`);
  }

  if (records.skippedLines > 0) {
    lines.push(`Skipped corrupt lines: ${records.skippedLines}`);
  }

  return lines.join("\n");
}

export function formatCheckHistory(sessionId, records) {
  const lines = [`Check History: ${sessionId}`];

  if (records.length === 0) {
    lines.push("No check records.");
    return lines.join("\n");
  }

  for (const record of records) {
    const command = record.command ? ` (${record.command})` : "";
    const duration = record.durationMs === null ? "" : ` [${record.durationMs}ms]`;
    const summary = record.summary ? ` - ${record.summary}` : "";
    lines.push(`${record.status} ${record.name}${command}${duration}${summary}`);
  }

  if (records.skippedLines > 0) {
    lines.push(`Skipped corrupt lines: ${records.skippedLines}`);
  }

  return lines.join("\n");
}

export function formatSessionStatus(status) {
  return [
    `Session: ${status.session.id}`,
    `Task: ${status.session.task}`,
    `Shadow: ${status.session.shadowPath}`,
    `Allowed scope: ${status.allowedGlobs.length > 0 ? status.allowedGlobs.join(", ") : "(none)"}`,
    `Changed files: ${status.changedFiles}`,
    `Blocked: ${status.blocked}`,
    `Approval required: ${status.approvalRequired}`,
    `Reviewable: ${status.reviewable}`,
    `Commands: ${status.commands.total}`,
    `Blocked commands: ${status.commands.blocked}`,
    `Approval required commands: ${status.commands.approvalRequired}`,
    `Checks: ${status.checks.total}`,
    `Passed checks: ${status.checks.passed}`,
    `Failed checks: ${status.checks.failed}`,
    `Skipped checks: ${status.checks.skipped}`,
    `Risk: ${status.risk.level}`,
    `Slop score: ${status.slop.score}/100`,
  ].join("\n");
}

export function formatCiValidation(validation) {
  const lines = [
    `CI Validation: ${validation.valid ? "passed" : "failed"}`,
    `Findings: ${validation.findings.length}`,
  ];

  for (const finding of validation.findings) {
    const filePath = finding.path ? ` ${finding.path}` : "";
    lines.push(`  ${finding.severity} ${finding.code}:${filePath} ${finding.message}`);
  }

  return lines.join("\n");
}

export function formatCiAnnotations(validation) {
  if (validation.findings.length === 0) {
    return "CI Annotations: no findings";
  }

  return validation.findings
    .map((finding) => {
      const command = finding.severity === "error" ? "error" : "warning";
      const properties = [
        finding.path ? `file=${escapeAnnotationProperty(finding.path)}` : "",
        `title=${escapeAnnotationProperty(finding.code)}`,
      ].filter(Boolean);
      return `::${command} ${properties.join(",")}::${escapeAnnotationData(finding.message)}`;
    })
    .join("\n");
}

export function formatCapsuleList(result) {
  const lines = [
    `Capsules: ${result.capsules.length}`,
    `Skipped corrupt capsules: ${result.skipped.length}`,
  ];

  for (const capsule of result.capsules) {
    lines.push(
      `${capsule.createdAt || "(unknown date)"} ${capsule.risk} ${capsule.task} (${capsule.filesChanged} files)`,
    );
    lines.push(`  ${capsule.path}`);
  }

  return lines.join("\n");
}

export function formatCapsuleShow(result) {
  const summary = result.summary;
  return [
    `Capsule: ${summary.task}`,
    `Path: ${result.path}`,
    `Created: ${summary.createdAt || "(unknown)"}`,
    `Risk: ${summary.risk}`,
    `Slop score: ${summary.slopScore ?? "unknown"}`,
    `Human approval: ${summary.humanApproval}`,
    `Files changed: ${summary.filesChanged}`,
    `Applied: ${summary.applied}`,
    `Blocked: ${summary.blocked}`,
    `Approval required: ${summary.approvalRequired}`,
  ].join("\n");
}

function escapeAnnotationData(value) {
  return String(value ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value)
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

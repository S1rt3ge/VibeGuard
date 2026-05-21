const HIGH_RISK_ZONES = new Set(["auth", "payments", "secrets", "ci", "database"]);

export function scoreReview(review, signals = {}) {
  const blocked = review.blocked ?? [];
  const approvalRequired = review.approvalRequired ?? [];
  const reviewable = review.reviewable ?? [];
  const allChanges = [...blocked, ...approvalRequired, ...reviewable];
  const problems = [];
  const reasons = [];
  let slopScore = 0;

  if (blocked.length > 0) {
    reasons.push("blocked_files_touched");
    problems.push(`${blocked.length} blocked file${blocked.length === 1 ? "" : "s"} touched`);
    slopScore += Math.min(40, 25 + blocked.length * 5);
  }

  if (approvalRequired.length > 0) {
    reasons.push("approval_required_changes");
    problems.push(`${approvalRequired.length} approval-required change${approvalRequired.length === 1 ? "" : "s"}`);
    slopScore += Math.min(25, 10 + approvalRequired.length * 5);
  }

  const outsideScopeCount = blocked.filter((item) =>
    item.reasons.includes("outside_declared_scope"),
  ).length;
  if (outsideScopeCount > 0) {
    problems.push(`${outsideScopeCount} out-of-scope file${outsideScopeCount === 1 ? "" : "s"}`);
    slopScore += Math.min(20, outsideScopeCount * 10);
  }

  const highRiskZones = unique(
    allChanges.flatMap((item) => item.riskZones ?? []).filter((zone) => HIGH_RISK_ZONES.has(zone)),
  );
  if (highRiskZones.length > 0) {
    reasons.push("high_risk_zones_touched");
    problems.push(`High-risk zones touched: ${highRiskZones.join(", ")}`);
    slopScore += 20;
  }

  const dependencyChanges = approvalRequired.filter((item) =>
    item.reasons.includes("dependency_change"),
  ).length;
  if (dependencyChanges > 0) {
    problems.push(`${dependencyChanges} dependency change${dependencyChanges === 1 ? "" : "s"} requested`);
    slopScore += Math.min(15, dependencyChanges * 10);
  }

  const todoCommentsAdded = Number(signals.todoCommentsAdded ?? 0);
  if (todoCommentsAdded > 0) {
    problems.push(`${todoCommentsAdded} TODO comment${todoCommentsAdded === 1 ? "" : "s"} added`);
    slopScore += Math.min(15, todoCommentsAdded * 5);
  }

  const testsDeleted = Number(signals.testsDeleted ?? 0);
  if (testsDeleted > 0) {
    reasons.push("tests_deleted_or_weakened");
    problems.push(`${testsDeleted} test${testsDeleted === 1 ? "" : "s"} deleted or weakened`);
    slopScore += Math.min(30, testsDeleted * 20);
  }

  const level = riskLevel({ blocked, approvalRequired, highRiskZones, testsDeleted, slopScore });

  return {
    risk: {
      level,
      reasons: unique(reasons),
    },
    slop: {
      score: Math.min(100, slopScore),
      problems,
    },
  };
}

function riskLevel({ blocked, approvalRequired, highRiskZones, testsDeleted, slopScore }) {
  if (blocked.length > 0 || highRiskZones.length > 0 || testsDeleted > 0) {
    return "high";
  }
  if (approvalRequired.length > 0 || slopScore >= 30) {
    return "medium";
  }
  return "low";
}

function unique(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

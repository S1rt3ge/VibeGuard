import { reviewChanges } from "../../policy/src/index.js";
import { scoreReview } from "../../risk-engine/src/index.js";

// Source-agnostic review: given a diff (a list of {path, status}) and a policy,
// classify and score it. The shadow flow feeds it a shadow-workspace diff; the
// `capsule from` flow feeds it a git-range diff. Neither engine cares where the
// diff came from, which is what makes the capsule a cross-source provenance unit.
export function buildReviewResult(diff, policy) {
  const review = reviewChanges(diff.map((item) => item.path), policy);
  attachDiffStatus(review, diff);
  const score = scoreReview(review);
  return { review, score };
}

function attachDiffStatus(review, diff) {
  const statusByPath = new Map(diff.map((item) => [item.path, item.status]));

  for (const group of [review.blocked, review.approvalRequired, review.reviewable]) {
    for (const item of group) {
      item.status = statusByPath.get(item.path) ?? "modified";
    }
  }
}

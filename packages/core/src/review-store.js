import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function createReviewPayload(result) {
  return {
    schemaVersion: "0.1",
    command: "review",
    sessionId: result.session.id,
    diff: result.diff,
    review: result.review,
    score: result.score,
  };
}

export async function saveReviewArtifact(repoRoot, payload) {
  const root = path.resolve(repoRoot);
  const sessionId = String(payload?.sessionId ?? "").trim();
  if (!sessionId) {
    throw new Error("Review artifact requires sessionId.");
  }

  const reviewsDir = path.join(root, ".vibeguard", "reviews");
  await mkdir(reviewsDir, { recursive: true });

  const reviewPath = path.join(reviewsDir, `${sessionId}.json`);
  await writeFile(reviewPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reviewPath;
}

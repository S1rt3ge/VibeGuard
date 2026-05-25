import { writeFile } from "node:fs/promises";
import path from "node:path";

export const HANDOFF_RELATIVE_PATH = "VIBEGUARD_TASK.md";

export function createHandoffMetadata(shadowPath) {
  return {
    relativePath: HANDOFF_RELATIVE_PATH,
    path: path.join(shadowPath, HANDOFF_RELATIVE_PATH),
  };
}

export async function writeTaskHandoff(session) {
  await writeFile(session.handoff.path, formatTaskHandoff(session), "utf8");
  return session.handoff;
}

export function formatTaskHandoff(session) {
  const allowedGlobs = session.policy?.allowedGlobs ?? [];
  const allowedScope = allowedGlobs.length > 0 ? allowedGlobs.join(", ") : "not declared";

  return [
    "# VibeGuard Task Handoff",
    "",
    `Task: ${session.task}`,
    `Session: ${session.id}`,
    `Agent: ${session.agent}`,
    `Model: ${session.model}`,
    `Repository root: ${session.repoRoot}`,
    `Shadow workspace: ${session.shadowPath}`,
    `Allowed scope: ${allowedScope}`,
    "",
    "## Context Bundle",
    "",
    ...formatContextSection(session),
    "",
    "## Safety Rules",
    "",
    "- Edit only this shadow workspace.",
    "- Do not edit the source repository directly.",
    "- Do not touch secrets, .env files, private keys, tokens, or credentials.",
    "- Avoid dependency, auth, CI, payment, and migration changes unless the task explicitly requires them.",
    "- Do not run destructive commands or pipe remote scripts into a shell.",
    "- Expect VibeGuard review and safe apply after edits.",
    "",
    "## Next Human Commands",
    "",
    `- vibeguard review --session ${session.id} --summary`,
    `- vibeguard apply --safe --dry-run --session ${session.id}`,
    `- vibeguard apply --safe --session ${session.id}`,
    "",
  ].join("\n");
}

function formatContextSection(session) {
  if (!session.context) {
    const allowedGlobs = session.policy?.allowedGlobs ?? [];
    const includeHint = allowedGlobs.length > 0 ? allowedGlobs.join(",") : "<scope>";
    return [
      "Context bundle: not generated",
      `Generate one with: vibeguard context build "${session.task}" --include "${includeHint}"`,
    ];
  }

  return [
    `Context bundle: ${session.context.bundlePath}`,
    `Context include globs: ${formatList(session.context.bundle.includeGlobs)}`,
    `Included files: ${session.context.bundle.stats.included}`,
    `Excluded files: ${session.context.bundle.stats.excluded}`,
    `Redactions: ${session.context.bundle.stats.redactions}`,
  ];
}

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "not declared";
}

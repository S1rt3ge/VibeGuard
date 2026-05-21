const BLOCK_RULES = [
  {
    reason: "pipe_to_shell",
    matches: (command) =>
      /\b(curl|wget|iwr|irm)\b[\s\S]*\|[\s\S]*\b(sh|bash|zsh|fish|powershell|pwsh|iex|invoke-expression)\b/i.test(command),
  },
  {
    reason: "destructive_remove",
    matches: (command) =>
      /\brm\s+.*-(?=[^\s]*r)(?=[^\s]*f)[^\s]*/i.test(command) ||
      (/\bremove-item\b/i.test(command) &&
        /-recurse\b/i.test(command) &&
        /-force\b/i.test(command)),
  },
];

const APPROVAL_RULES = [
  {
    reason: "dependency_change",
    matches: (command) =>
      /\bnpm\s+(install|i)\b/i.test(command) ||
      /\bpnpm\s+add\b/i.test(command) ||
      /\byarn\s+add\b/i.test(command) ||
      /\bbun\s+add\b/i.test(command) ||
      /\bnpm\s+audit\s+fix\b/i.test(command),
  },
  {
    reason: "remote_git_mutation",
    matches: (command) =>
      /\bgit\s+push\b/i.test(command) ||
      /\bgh\s+pr\s+merge\b/i.test(command) ||
      /\bgh\s+workflow\s+run\b/i.test(command),
  },
];

export function evaluateCommand(command) {
  const normalized = String(command ?? "").trim();
  if (!normalized) {
    throw new Error("Command is required");
  }

  const blockedReasons = BLOCK_RULES
    .filter((rule) => rule.matches(normalized))
    .map((rule) => rule.reason);

  if (blockedReasons.length > 0) {
    return {
      command: normalized,
      decision: "blocked",
      reasons: blockedReasons,
    };
  }

  const approvalReasons = APPROVAL_RULES
    .filter((rule) => rule.matches(normalized))
    .map((rule) => rule.reason);

  if (approvalReasons.length > 0) {
    return {
      command: normalized,
      decision: "approval_required",
      reasons: approvalReasons,
    };
  }

  return {
    command: normalized,
    decision: "allowed",
    reasons: [],
  };
}

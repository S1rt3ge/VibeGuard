// NOTE: this guard is BEST-EFFORT / ADVISORY. It is a denylist of known-risky
// command shapes, not a sandbox. A determined command can evade it; real
// containment requires running the agent/checks in an actual sandbox. The rules
// below aim to catch the common, accidental cases without false-flagging
// ordinary read-only commands.
const BLOCK_RULES = [
  {
    reason: "pipe_to_shell",
    matches: (command) =>
      // curl/wget/... | sh|bash|python|node|...
      /\b(curl|wget|iwr|irm|fetch)\b[\s\S]*\|[\s\S]*\b(sh|bash|zsh|fish|dash|ksh|powershell|pwsh|iex|invoke-expression|python[0-9.]*|node|ruby|perl|php)\b/i.test(command) ||
      // sh -c "$(curl ...)" / bash -c "`wget ...`"
      /\b(sh|bash|zsh|dash|ksh|pwsh|powershell)\b[\s\S]*-c\b[\s\S]*\b(curl|wget|iwr|irm)\b/i.test(command) ||
      // iex (New-Object ...).DownloadString / iex (irm ...)
      /\b(iex|invoke-expression)\b[\s\S]*\b(curl|wget|iwr|irm|downloadstring|downloadfile)\b/i.test(command),
  },
  {
    reason: "destructive_remove",
    matches: (command) => isDestructiveRemove(command),
  },
];

const APPROVAL_RULES = [
  {
    reason: "dependency_change",
    matches: (command) =>
      /\bnpm\s+(install|i|ci|add)\b/i.test(command) ||
      /\bnpm\s+audit\s+fix\b/i.test(command) ||
      /\bnpx\b/i.test(command) ||
      /\bpnpm\s+(add|install|dlx)\b/i.test(command) ||
      /\byarn\s+(add|install)\b/i.test(command) ||
      /\bbun\s+(add|install|x)\b/i.test(command) ||
      /\bpip[0-9]?\s+install\b/i.test(command) ||
      /\bpipx\s+(install|run)\b/i.test(command) ||
      /\bpoetry\s+add\b/i.test(command) ||
      /\buv\s+(add|pip\s+install)\b/i.test(command) ||
      /\b(cargo|gem)\s+install\b/i.test(command) ||
      /\bgo\s+(install|get)\b/i.test(command) ||
      /\b(brew|apt|apt-get|yum|dnf|apk|choco|scoop|winget)\s+(install|add)\b/i.test(command),
  },
  {
    reason: "remote_git_mutation",
    matches: (command) =>
      /\bgit\s+push\b/i.test(command) ||
      /\bgh\s+pr\s+(merge|create)\b/i.test(command) ||
      /\bgh\s+(workflow|run)\s+(run|dispatch)\b/i.test(command) ||
      /\bgh\s+release\s+create\b/i.test(command),
  },
];

function isDestructiveRemove(command) {
  if (/\brimraf\b/i.test(command)) {
    return true;
  }
  if (/\bshred\b/i.test(command)) {
    return true;
  }
  if (/\bfind\b[\s\S]*\s-delete\b/i.test(command)) {
    return true;
  }
  if (/\btruncate\b[\s\S]*-s\s*0\b/i.test(command)) {
    return true;
  }
  if (
    /\bremove-item\b/i.test(command) &&
    /(-recurse|-r)\b/i.test(command) &&
    /(-force|-f)\b/i.test(command)
  ) {
    return true;
  }
  if (/\brm\b/i.test(command)) {
    const recursive = /(^|\s)-[a-z]*r[a-z]*\b/i.test(command) || /--recursive\b/i.test(command);
    const force = /(^|\s)-[a-z]*f[a-z]*\b/i.test(command) || /--force\b/i.test(command);
    if (recursive && force) {
      return true;
    }
  }
  return false;
}

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

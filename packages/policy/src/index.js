const DEFAULT_BLOCKED_GLOBS = [
  ".env*",
  "**/.env*",
  "**/*secret*",
  "**/*token*",
  "**/*.pem",
  "**/id_rsa*",
];

const DEFAULT_APPROVAL_GLOBS = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".github/workflows/**",
  "**/migrations/**",
  "**/auth/**",
];

const DEFAULT_RISK_ZONES = {
  ".env*": "secrets",
  "**/.env*": "secrets",
  "**/*secret*": "secrets",
  "**/*token*": "secrets",
  "**/auth/**": "auth",
  "**/billing/**": "payments",
  "**/stripe/**": "payments",
  ".github/workflows/**": "ci",
  "**/migrations/**": "database",
  "package-lock.json": "dependencies",
  "pnpm-lock.yaml": "dependencies",
  "yarn.lock": "dependencies",
  "bun.lockb": "dependencies",
};

export function normalizeRepoPath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

export function createDefaultPolicy(overrides = {}) {
  return {
    allowedGlobs: [...(overrides.allowedGlobs ?? [])],
    blockedGlobs: [
      ...DEFAULT_BLOCKED_GLOBS,
      ...(overrides.blockedGlobs ?? []),
    ],
    approvalGlobs: [
      ...DEFAULT_APPROVAL_GLOBS,
      ...(overrides.approvalGlobs ?? []),
    ],
    riskZones: {
      ...DEFAULT_RISK_ZONES,
      ...(overrides.riskZones ?? {}),
    },
  };
}

export function classifyFileChange(filePath, policy = createDefaultPolicy()) {
  const normalizedPath = normalizeRepoPath(filePath);
  if (!normalizedPath) {
    throw new Error("File path is required");
  }

  const riskZones = findRiskZones(normalizedPath, policy.riskZones);

  if (matchesAny(normalizedPath, policy.blockedGlobs)) {
    return {
      path: normalizedPath,
      decision: "blocked",
      reasons: ["protected_file"],
      riskZones,
    };
  }

  if (matchesAny(normalizedPath, policy.approvalGlobs)) {
    return {
      path: normalizedPath,
      decision: "approval_required",
      reasons: [approvalReason(normalizedPath)],
      riskZones,
    };
  }

  if (
    policy.allowedGlobs.length > 0 &&
    !matchesAny(normalizedPath, policy.allowedGlobs)
  ) {
    return {
      path: normalizedPath,
      decision: "blocked",
      reasons: ["outside_declared_scope"],
      riskZones,
    };
  }

  return {
    path: normalizedPath,
    decision: "reviewable",
    reasons: [],
    riskZones,
  };
}

export function reviewChanges(filePaths, policy = createDefaultPolicy()) {
  const review = {
    blocked: [],
    approvalRequired: [],
    reviewable: [],
  };

  for (const filePath of filePaths) {
    const decision = classifyFileChange(filePath, policy);
    if (decision.decision === "blocked") {
      review.blocked.push(decision);
    } else if (decision.decision === "approval_required") {
      review.approvalRequired.push(decision);
    } else {
      review.reviewable.push(decision);
    }
  }

  return review;
}

export function matchesGlob(filePath, glob) {
  const regex = globToRegExp(normalizeRepoPath(glob));
  return regex.test(normalizeRepoPath(filePath));
}

export function matchesAny(filePath, globs) {
  return globs.some((glob) => matchesGlob(filePath, glob));
}

function findRiskZones(filePath, riskZones) {
  return Object.entries(riskZones)
    .filter(([glob]) => matchesGlob(filePath, glob))
    .map(([, zone]) => zone)
    .filter((zone, index, zones) => zones.indexOf(zone) === index);
}

function approvalReason(filePath) {
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(filePath)) {
    return "dependency_change";
  }
  if (filePath.startsWith(".github/workflows/")) {
    return "ci_change";
  }
  if (filePath.includes("/auth/") || filePath.startsWith("auth/")) {
    return "auth_change";
  }
  if (filePath.includes("/migrations/") || filePath.startsWith("migrations/")) {
    return "migration_change";
  }
  return "approval_required";
}

function globToRegExp(glob) {
  let source = "^";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    const afterNext = glob[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }

  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

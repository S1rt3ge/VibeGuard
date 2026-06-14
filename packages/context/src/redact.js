// Shared secret redaction used by both the context firewall (files bundled for
// the agent) and the check runner (command output stored in capsules). Keep the
// rule order specific-first: a named assignment is redacted before generic
// token-shape rules get a chance to re-scan the already-masked value.
export const SECRET_REDACTION_RULES = [
  {
    name: "secret_assignment",
    reason: "secret_value",
    // KEY/SECRET/TOKEN/PASSWORD/URL/DSN-style env assignments: NAME=value.
    regex:
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|URL|DSN|CREDENTIAL|CREDENTIALS))\s*[:=]\s*("?)([^\s'"]+)\2/gi,
    replace: (_match, key) => `${key}=[REDACTED:${key.toUpperCase()}]`,
  },
  {
    name: "openai_style_key",
    reason: "api_key",
    regex: /\bsk[-_][A-Za-z0-9_-]{16,}\b/g,
    replace: () => "[REDACTED:API_KEY]",
  },
  {
    name: "stripe_key",
    reason: "stripe_key",
    regex: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: () => "[REDACTED:STRIPE_KEY]",
  },
  {
    name: "aws_access_key_id",
    reason: "aws_key",
    regex: /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA)[A-Z0-9]{12,}\b/g,
    replace: () => "[REDACTED:AWS_KEY]",
  },
  {
    name: "github_token",
    reason: "github_token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    replace: () => "[REDACTED:GITHUB_TOKEN]",
  },
  {
    name: "slack_token",
    reason: "slack_token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => "[REDACTED:SLACK_TOKEN]",
  },
  {
    name: "google_api_key",
    reason: "google_key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => "[REDACTED:GOOGLE_KEY]",
  },
  {
    name: "jwt",
    reason: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => "[REDACTED:JWT]",
  },
  {
    name: "connection_string",
    reason: "connection_string",
    // proto://user:password@host — credentials embedded in a URL.
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
    replace: () => "[REDACTED:CONNECTION_STRING]",
  },
  {
    name: "private_key_block",
    reason: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:PRIVATE_KEY]",
  },
];

export function redactSecrets(content) {
  const redactions = [];
  let redacted = String(content ?? "");

  for (const rule of SECRET_REDACTION_RULES) {
    redacted = redacted.replace(rule.regex, (...args) => {
      redactions.push({ pattern: rule.name, reason: rule.reason });
      return rule.replace(...args);
    });
  }

  return { content: redacted, redactions };
}

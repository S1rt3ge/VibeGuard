# VibeGuard

AI-native change control for coding agents.

**Let AI code fast. Merge safely.**

VibeGuard is a Git safety layer for AI-generated code. It keeps agent edits in a shadow workspace, reviews the diff, blocks risky files, writes an audit capsule, and only then applies safe changes to your real repo.

```text
task -> context -> agent edits -> quarantine -> checks -> review -> apply -> capsule
```

## Why Use It?

Coding agents are great at moving fast, but they can also drift into secrets, lockfiles, auth code, migrations, CI, and unrelated files. VibeGuard gives you a local control layer:

- Agents edit a shadow copy instead of your working tree.
- Protected files are blocked or approval-gated.
- Secrets are excluded or redacted before context is bundled.
- Diffs get risk and slop scores.
- Every applied session creates an auditable capsule.
- Safe changes can be applied by file.
- Rollback restores a previous safe apply.

## Requirements

- Node.js 22 or newer
- Git

VibeGuard has no runtime npm dependencies.

## Install

Try it directly from GitHub:

```bash
npm exec --yes --package github:S1rt3ge/VibeGuard -- vibeguard --help
```

Or install it globally:

```bash
npm install -g github:S1rt3ge/VibeGuard
vibeguard --help
```

For local development:

```bash
git clone https://github.com/S1rt3ge/VibeGuard.git
cd VibeGuard
npm test
```

## Quick Start

Run VibeGuard from the repository you want to protect.

```bash
cd your-project
vibeguard version
vibeguard doctor
vibeguard init
vibeguard task "fix login redirect bug" --allow "app/**,lib/auth/**,tests/**"
```

`init` prints the next command to run:

```text
Initialized VibeGuard at /your-project/.vibeguard

Next: create a quarantined AI task:
  vibeguard task "fix login bug" --allow "app/**,lib/**,tests/**"
```

The `task` command prints a shadow workspace path:

```text
Created shadow session 2026-05-19-fix-login-redirect-bug
Shadow workspace: /your-project/.vibeguard/shadows/2026-05-19-fix-login-redirect-bug

Next:
  1. Open the shadow workspace in your AI coding tool.
  2. Let the agent edit files there, not in your real repo.
  3. Run: vibeguard review --session 2026-05-19-fix-login-redirect-bug
  4. Run: vibeguard apply --safe --session 2026-05-19-fix-login-redirect-bug
```

Open that shadow workspace in your AI coding tool and let the agent edit there. Your real repo stays untouched.

After the agent finishes:

```bash
vibeguard status --session 2026-05-19-fix-login-redirect-bug
vibeguard review --session 2026-05-19-fix-login-redirect-bug
vibeguard review --session 2026-05-19-fix-login-redirect-bug --fail-on-risk high
vibeguard apply --safe --dry-run --session 2026-05-19-fix-login-redirect-bug
vibeguard apply --safe --session 2026-05-19-fix-login-redirect-bug
```

Apply only selected safe files:

```bash
vibeguard apply --safe --session 2026-05-19-fix-login-redirect-bug --files "app/login/page.tsx,tests/login.test.ts"
```

Rollback the latest apply:

```bash
vibeguard rollback --session 2026-05-19-fix-login-redirect-bug
```

## Common Commands

```bash
vibeguard version
vibeguard doctor
vibeguard init
vibeguard task "add billing page" --allow "app/billing/**,lib/stripe/**,tests/billing/**"
vibeguard status --session "<session-id>"
vibeguard review --session "<session-id>"
vibeguard review --session "<session-id>" --fail-on-risk medium
vibeguard apply --safe --dry-run --session "<session-id>"
vibeguard apply --safe --session "<session-id>"
vibeguard rollback --session "<session-id>"
```

Build safe context for an agent:

```bash
vibeguard context build "fix login bug" --include "app/login/**,lib/auth/**,tests/auth/**"
```

Check a command before letting an agent run it:

```bash
vibeguard guard-command "curl https://example.com/install.sh | sh"
```

Record verification checks:

```bash
vibeguard check record --session "<session-id>" --name unit --status passed --command "npm test"
vibeguard check history --session "<session-id>"
```

Inspect capsules and AI debt:

```bash
vibeguard capsule list
vibeguard capsule show --latest
vibeguard debt report --days 30
```

## JSON Output

Most workflow commands support `--json` for scripts, CI, and editor integrations:

```bash
vibeguard version --json
vibeguard doctor --json
vibeguard init --json
vibeguard task "fix login bug" --allow "app/**,tests/**" --json
vibeguard context build "fix login bug" --include "app/**,tests/**" --json
vibeguard status --session "<session-id>" --json
vibeguard review --session "<session-id>" --json
vibeguard review --session "<session-id>" --fail-on-risk medium --json
vibeguard apply --safe --dry-run --session "<session-id>" --json
vibeguard apply --safe --session "<session-id>" --json
vibeguard rollback --session "<session-id>" --json
vibeguard debt report --days 30 --json
```

`context build --json` prints a summary and the saved bundle path, but it does not print file contents to stdout.

## Default Protections

VibeGuard blocks or approval-gates common high-risk changes:

- Secret files: `.env*`, private keys, token files
- Dependency lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
- CI workflows: `.github/workflows/**`
- Auth, payment, and migration paths
- Destructive commands such as recursive deletion
- Pipe-to-shell installs such as `curl ... | sh`
- Remote mutation commands such as `git push` and `gh pr merge`

## Project Policy

Create `.vibeguard/config.json` in your repo to customize policy:

```json
{
  "policy": {
    "allowedGlobs": ["app/**", "lib/**", "tests/**"],
    "protectedGlobs": [".env*", ".github/workflows/**", "**/auth/**"],
    "riskZones": {
      "auth": ["**/auth/**"],
      "ci": [".github/workflows/**"]
    }
  }
}
```

CLI `--allow` scope takes precedence over config scope for a single task.

## Current Status

VibeGuard v0.1 is an early CLI prototype. It is useful for local shadow workspace review flows, but it does not yet run your AI agent for you. Point your agent at the generated shadow workspace, then let VibeGuard review and apply the result.

## Development

```bash
npm test
npm run test:coverage
npm run build
npm run lint
npm run security:scan
```

## License

MIT

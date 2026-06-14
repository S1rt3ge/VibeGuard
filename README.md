# VibeGuard

AI-native change control for coding agents.

**Let AI code fast. Merge safely.**

VibeGuard is a Git safety layer for AI-generated code. It keeps agent edits in a shadow workspace, reviews the diff, blocks risky files, writes an audit capsule, and only then applies safe changes to your real repo.

```text
task -> context -> agent edits -> quarantine -> checks -> review -> apply -> capsule
```

## What VibeGuard Is (and Is Not)

VibeGuard is **change governance**, not a sandbox. Its job is to make an AI
agent's edits visible, scoped, scored, and auditable before they reach your real
repository — so accidental drift (secrets, lockfiles, auth, CI, unrelated
rewrites) is caught at the review/apply boundary.

By default the shadow workspace is a working-directory convention, **not OS-level
containment**. The agent runs as an ordinary child process with your
permissions, so a *malicious or compromised* agent could write outside the shadow
directly. VibeGuard protects strongly against an agent that *makes mistakes*; to
also defend against an agent that is *actively hostile*, run it inside a real
sandbox (see [Sandboxing the agent](#sandboxing-the-agent)) and enable
[tamper-evident artifacts](#tamper-evident-artifacts). Treat risk scores and
policy decisions as decision support, not an absolute safety guarantee.

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
vibeguard task "fix login redirect bug" --allow "app/**,lib/auth/**,tests/**" --context
```

`task` refuses to start from a dirty Git worktree by default. Commit or stash local changes first, or use `--allow-dirty` when you intentionally want the dirty baseline recorded in the session.
Add `--context` to create a redacted context bundle during task setup. By default it uses the `--allow` scope; use `--include` when the context scope should differ from apply scope.

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
Task handoff: /your-project/.vibeguard/shadows/2026-05-19-fix-login-redirect-bug/VIBEGUARD_TASK.md

Next:
  1. Run Codex in the shadow workspace:
     vibeguard run --agent codex --session 2026-05-19-fix-login-redirect-bug
  2. Or open the shadow workspace in your AI coding tool.
  3. Let the agent edit files there, not in your real repo.
  4. Run: vibeguard check run --session 2026-05-19-fix-login-redirect-bug --name unit --command "npm test"
  5. Run: vibeguard review --session 2026-05-19-fix-login-redirect-bug
  6. Run: vibeguard apply --safe --session 2026-05-19-fix-login-redirect-bug
```

Run Codex through VibeGuard, or open the shadow workspace manually in another AI coding tool. Your real repo stays untouched.
The generated `VIBEGUARD_TASK.md` file in the shadow workspace contains the task, allowed scope, safety boundaries, and review/apply commands.

```bash
vibeguard run --agent codex --session 2026-05-19-fix-login-redirect-bug
```

After the agent finishes:

```bash
vibeguard check run --session 2026-05-19-fix-login-redirect-bug --name unit --command "npm test"
vibeguard status --session 2026-05-19-fix-login-redirect-bug
vibeguard review --session 2026-05-19-fix-login-redirect-bug --summary
vibeguard review --session 2026-05-19-fix-login-redirect-bug --fail-on-risk high
vibeguard apply --safe --dry-run --session 2026-05-19-fix-login-redirect-bug
vibeguard apply --safe --session 2026-05-19-fix-login-redirect-bug
```

`review --summary` adds an intent-based explanation: task intent, expected changes, suspicious changes, risk reasons, and next steps.
`apply --safe` finalizes the approval boundary: it reports the safe-applied files, skipped blocked/approval-required files, apply manifest id, and saved capsule path.

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
vibeguard task "add billing page" --allow "app/billing/**,lib/stripe/**,tests/billing/**" --context
vibeguard task "continue local WIP" --allow "src/**,tests/**" --allow-dirty
vibeguard run --agent codex --session "<session-id>"
vibeguard check run --session "<session-id>" --name unit --command "npm test"
vibeguard status --session "<session-id>"
vibeguard review --session "<session-id>" --summary
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

Run or record verification checks:

```bash
vibeguard check run --session "<session-id>" --name unit --command "npm test"
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
vibeguard run --agent codex --session "<session-id>" --dry-run --json
vibeguard context build "fix login bug" --include "app/**,tests/**" --json
vibeguard check run --session "<session-id>" --name unit --command "npm test" --json
vibeguard status --session "<session-id>" --json
vibeguard review --session "<session-id>" --summary --json
vibeguard review --session "<session-id>" --fail-on-risk medium --json
vibeguard apply --safe --dry-run --session "<session-id>" --json
vibeguard apply --safe --session "<session-id>" --json
vibeguard rollback --session "<session-id>" --json
vibeguard debt report --days 30 --json
```

`context build --json` prints a summary and the saved bundle path, but it does not print file contents to stdout.

## Works With Any Agent

VibeGuard is agent-neutral. Built-in launch adapters: `codex`, `claude`, and
`cursor-agent` run inside the shadow workspace; `cursor` opens the shadow folder
in the IDE so you can drive Cursor's agent there.

```bash
vibeguard task "fix login bug" --allow "app/**,tests/**" --agent claude
vibeguard run --agent claude --session "<session-id>"
# Cursor (GUI): open the shadow workspace, then review/apply as usual
vibeguard run --agent cursor --session "<session-id>"
```

Add or override agents in `.vibeguard/config.json` without code changes:

```json
{
  "agents": {
    "aider": { "command": "aider", "defaultArgs": ["--yes"] }
  }
}
```

For an agent VibeGuard never launched (e.g. you used Cursor's GUI agent directly,
or an agent on a CI branch), attest the result after the fact — the capsule is
tagged with whatever agent you name:

```bash
vibeguard capsule from --base origin/main --head HEAD --agent cursor
```

The agent you pick on `task`/`run`/`capsule from` is recorded in the session and
the capsule, so provenance is correct across Codex, Claude Code, and Cursor.

## Gate AI PRs in Your Repo (one file)

Copy [`examples/github-actions/ai-change-gate.yml`](examples/github-actions/ai-change-gate.yml)
into your `.github/workflows/`. On every pull request it derives a signed capsule
from the PR diff and **fails the check** if a secret/protected/out-of-scope file
landed, a high-risk change has no review, or a changed file isn't described by
the capsule. No setup, no shadow workflow, works with any agent:

```yaml
- run: npx --yes --package github:S1rt3ge/VibeGuard --
    vibeguard capsule from --base "$BASE" --head HEAD --agent ci
- run: npx --yes --package github:S1rt3ge/VibeGuard --
    vibeguard ci validate --latest --git-base "$BASE"
```

See it block a secret-leaking PR and pass a clean one, locally, in 30 seconds:

```bash
node examples/demo/demo.mjs
```

## Default Protections

VibeGuard blocks or approval-gates common high-risk changes:

- Secret files: `.env*`, private keys, token files
- Dependency lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
- CI workflows: `.github/workflows/**`
- Auth, payment, and migration paths
- Destructive commands such as recursive deletion (including split flags like
  `rm -r -f`, `rimraf`, and `find ... -delete`)
- Pipe-to-shell installs such as `curl ... | sh` and `bash -c "$(curl ...)"`
- Remote mutation commands such as `git push` and `gh pr merge`

Secrets are also excluded from the shadow workspace itself (not just the context
bundle), and command output captured into capsules is redacted for a broad set
of secret shapes (cloud keys, GitHub/Slack/Stripe tokens, JWTs, connection
strings, private-key blocks).

The command guard is **best-effort/advisory**: it is a denylist of known-risky
command shapes, not a sandbox. Use it as a signal, and rely on a real sandbox for
enforcement.

## Security Hardening

These are off by default and opt-in.

### Sandboxing the agent

To give the agent real containment, wrap its launch in a sandbox via
`run.sandbox` in `.vibeguard/config.json`. The `{shadow}` and `{repo}`
placeholders are substituted at launch:

```json
{
  "run": {
    "sandbox": ["docker", "run", "--rm", "-v", "{shadow}:/work", "-w", "/work", "vibeguard-agent"]
  }
}
```

VibeGuard then runs `docker run ... vibeguard-agent codex ...` instead of `codex`
directly. You can also pass `--sandbox "<command>"` to `vibeguard run` for a
one-off. Choose an image/sandbox that does not mount your real repo or home
directory.

For the common case, use a built-in profile (`docker` or `podman`) and just name
an image instead of hand-writing the wrapper:

```json
{
  "run": {
    "sandboxProfile": "docker",
    "image": "vibeguard-agent"
  }
}
```

That expands to `docker run --rm -i -v {shadow}:/work -w /work vibeguard-agent`.
You can also pass `--sandbox-profile docker --image vibeguard-agent` to
`vibeguard run`. The image must contain your agent (e.g. Codex); networking is
left enabled so the agent can reach its model API.

`vibeguard doctor` reports your containment posture (whether a container runtime
is available and whether `run.sandbox` is configured), and `vibeguard run` warns
on stderr when it launches an agent with no sandbox.

### Tamper-evident artifacts

Set `VIBEGUARD_KEY_DIR` to a directory **outside** your repository to sign
session records, capsules, and review artifacts with a per-repo HMAC key:

```bash
export VIBEGUARD_KEY_DIR="$HOME/.config/vibeguard/keys"
vibeguard init
```

With signing enabled, `review`/`apply` refuse a session whose record was
tampered with, and `vibeguard ci validate` reports `capsule_signature_invalid` /
`review_signature_invalid` for altered artifacts. This reliably detects
corruption and tampering by anything that does not hold the key; it is not a
guarantee against an agent that already has full host access (see
[What VibeGuard Is](#what-vibeguard-is-and-is-not)).

### Untrusted check scripts

`check run` executes commands inside the shadow workspace. A command like
`npm test` runs whatever the agent put in the shadow's `package.json` scripts. If
that script-bearing config (`package.json`, `Makefile`, `justfile`, `Taskfile`)
drifted from the trusted baseline, the check is **skipped** as untrusted. Review
the change, then re-run with `--allow-untrusted-checks` to execute it.

### Binding CI to the PR diff

`vibeguard ci validate` can verify the capsule actually describes the pull
request, not a stale/unrelated one:

```bash
vibeguard ci validate --latest --review-latest --git-base origin/main
# or pass paths directly:
vibeguard ci validate --latest --changed-files "src/app.js,src/login.tsx"
```

Any changed file the capsule does not describe fails the gate, and a high-risk
applied capsule with no saved review is rejected.

A capsule can also be derived from any commit range — even from an agent that
never used VibeGuard's shadow flow — and still feed the gate:

```bash
vibeguard capsule from --base origin/main --head HEAD --agent codex
vibeguard ci validate --latest --require-provenance attested
```

Such a capsule is marked `provenance: git_range` (attested), versus
`vibeguard_apply` (enforced) for changes VibeGuard applied itself.
`--require-provenance enforced|attested` lets a gate demand a minimum level. See
`docs/specs/capsule-format.md`.

## Project Policy

Create `.vibeguard/config.json` in your repo to customize policy and checks:

```json
{
  "policy": {
    "allowedGlobs": ["app/**", "lib/**", "tests/**"],
    "blockedGlobs": [".env*"],
    "approvalGlobs": [".github/workflows/**", "**/auth/**"],
    "riskZones": {
      "**/auth/**": "auth",
      ".github/workflows/**": "ci"
    }
  },
  "checks": [
    { "name": "unit", "command": "npm test" },
    { "name": "lint", "command": "npm run lint" }
  ]
}
```

CLI `--allow` scope takes precedence over config scope for a single task.
`check run --session <id>` runs configured checks in the shadow workspace. Every check command is passed through the command guard first; blocked or approval-required commands are recorded as skipped instead of executed.

## Current Status

VibeGuard v0.1 is an early CLI prototype. It can launch Codex inside a shadow workspace, then review and apply the result. Other AI coding tools can still be used manually by opening the generated shadow workspace.

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

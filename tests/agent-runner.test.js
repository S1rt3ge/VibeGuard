import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { readCommandRecords } from "../packages/core/src/command-log.js";
import { runAgentSession } from "../packages/core/src/agent-runner.js";
import { createShadowSession } from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("runAgentSession dry-run previews Codex launch without writing command history", async () => {
  const root = await createFixture("vibeguard-agent-dry-run-");

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "dry run agent",
      sessionId: "agent-dry-run",
    });

    const result = await runAgentSession({
      repoRoot: root,
      sessionId: "agent-dry-run",
      agent: "codex",
      args: ["--ask-for-approval", "never"],
      dryRun: true,
    });
    const records = await readCommandRecords(root, "agent-dry-run");

    assert.equal(result.dryRun, true);
    assert.equal(result.sessionId, "agent-dry-run");
    assert.equal(result.agent, "codex");
    assert.equal(result.cwd, session.shadowPath);
    assert.equal(result.executable, "codex");
    assert.deepEqual(result.args, ["--ask-for-approval", "never"]);
    assert.equal(result.commandText, "codex --ask-for-approval never");
    assert.equal(result.handoffPath, session.handoff.path);
    assert.equal(result.handoffRelativePath, "VIBEGUARD_TASK.md");
    assert.equal(result.exitCode, null);
    assert.equal(records.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAgentSession launches injected Codex executable inside shadow workspace", async () => {
  const root = await createFixture("vibeguard-agent-run-");

  try {
    const session = await createShadowSession({
      repoRoot: root,
      task: "run agent",
      sessionId: "agent-run",
    });
    const scriptPath = path.join(root, "fake-codex.js");
    await writeFile(
      scriptPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('agent-output.txt', [process.env.VIBEGUARD_SESSION_ID, process.env.VIBEGUARD_HANDOFF_PATH].join('\\n'));",
      ].join("\n"),
    );

    const result = await runAgentSession({
      repoRoot: root,
      sessionId: "agent-run",
      agent: "codex",
      args: ["--task", "edit app"],
      agentRegistry: {
        codex: {
          command: process.execPath,
          defaultArgs: [scriptPath],
        },
      },
    });
    const records = await readCommandRecords(root, "agent-run");

    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(path.join(session.shadowPath, "agent-output.txt"), "utf8"),
      `agent-run\n${session.handoff.path}`,
    );
    assert.equal(result.handoffPath, session.handoff.path);
    await assert.rejects(() => access(path.join(root, "agent-output.txt")));
    assert.equal(records.length, 1);
    assert.equal(records[0].decision, "allowed");
    assert.deepEqual(records[0].reasons, ["agent_launcher"]);
    assert.match(records[0].command, /^".*node.*" ".*fake-codex\.js" --task "edit app"$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAgentSession rejects unsupported agents", async () => {
  const root = await createFixture("vibeguard-agent-unsupported-");

  try {
    await createShadowSession({
      repoRoot: root,
      task: "unsupported agent",
      sessionId: "unsupported-agent",
    });

    await assert.rejects(
      () =>
        runAgentSession({
          repoRoot: root,
          sessionId: "unsupported-agent",
          agent: "cursor",
          dryRun: true,
        }),
      /Unsupported agent: cursor/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI run --agent codex --dry-run --json emits launch preview", async () => {
  const root = await createFixture("vibeguard-agent-cli-");

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "cli agent", "--root", root, "--session", "cli-agent"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent",
        "codex",
        "--root",
        root,
        "--session",
        "cli-agent",
        "--dry-run",
        "--json",
        "--",
        "--ask-for-approval",
        "never",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "run");
    assert.equal(payload.run.sessionId, "cli-agent");
    assert.equal(payload.run.agent, "codex");
    assert.match(payload.run.cwd, /cli-agent$/);
    assert.equal(payload.run.executable, "codex");
    assert.deepEqual(payload.run.args, ["--ask-for-approval", "never"]);
    assert.equal(payload.run.commandText, "codex --ask-for-approval never");
    assert.match(payload.run.handoffPath, /VIBEGUARD_TASK\.md$/);
    assert.equal(payload.run.handoffRelativePath, "VIBEGUARD_TASK.md");
    assert.equal(payload.run.dryRun, true);
    assert.equal(payload.run.exitCode, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI run --json requires dry-run", async () => {
  const root = await createFixture("vibeguard-agent-json-guard-");

  try {
    const task = spawnSync(
      process.execPath,
      [cliPath, "task", "json guard agent", "--root", root, "--session", "json-guard-agent"],
      { encoding: "utf8" },
    );
    assert.equal(task.status, 0, task.stderr);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent",
        "codex",
        "--root",
        root,
        "--session",
        "json-guard-agent",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /run --json is only supported with --dry-run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "app.js"), "old app\n");
  return root;
}

import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  buildContextBundle,
  saveContextBundle,
} from "../packages/context/src/context-builder.js";
import { createShadowSession } from "../packages/core/src/shadow-workspace.js";

const cliPath = path.resolve("apps/cli/src/index.js");

test("buildContextBundle includes only scoped files and excludes local state", async () => {
  const root = await createContextFixture();

  try {
    const bundle = await buildContextBundle({
      repoRoot: root,
      task: "fix login bug",
      includeGlobs: ["app/login/**", "lib/auth/**", "tests/auth/**"],
    });

    assert.deepEqual(
      bundle.included.map((item) => item.path).sort(),
      ["app/login/page.tsx", "lib/auth/session.ts", "tests/auth/login.test.ts"],
    );
    assert.equal(bundle.excluded.some((item) => item.path === ".env.local"), true);
    assert.equal(bundle.excluded.some((item) => item.path === ".git"), true);
    assert.equal(bundle.excluded.some((item) => item.path === ".vibeguard"), true);
    assert.equal(bundle.excluded.some((item) => item.path === "node_modules"), true);
    assert.equal(bundle.excluded.some((item) => item.path === "coverage"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextBundle redacts inline secrets while preserving useful content", async () => {
  const root = await createContextFixture();

  try {
    const fakeOpenAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
    const fakeStripeKey = ["sk_live", "abcdefghijklmnopqrstuvwxyz"].join("_");
    await writeFile(
      path.join(root, "lib", "auth", "session.ts"),
      [
        "export const name = 'session';",
        `const key = '${fakeOpenAiKey}';`,
        "DATABASE_URL=postgres://user:pass@example.com/db",
        "JWT_SECRET=super-secret-value",
        `STRIPE_SECRET_KEY=${fakeStripeKey}`,
        `OPENAI_API_KEY=${fakeOpenAiKey}`,
        "",
      ].join("\n"),
    );

    const bundle = await buildContextBundle({
      repoRoot: root,
      task: "fix login bug",
      includeGlobs: ["lib/auth/**"],
    });

    const session = bundle.included.find((item) => item.path === "lib/auth/session.ts");
    assert.ok(session.content.includes("export const name = 'session';"));
    assert.equal(session.content.includes("super-secret-value"), false);
    assert.equal(session.content.includes("postgres://user:pass@example.com/db"), false);
    assert.equal(session.content.includes(fakeOpenAiKey), false);
    assert.ok(session.content.includes("[REDACTED"));
    assert.ok(bundle.redactions.length >= 5);
    assert.equal(bundle.stats.redactions, bundle.redactions.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextBundle redacts a broad set of secret shapes", async () => {
  const root = await createContextFixture();

  try {
    const awsKey = ["AKIA", "ABCDEFGHIJ123456"].join("");
    const githubToken = ["ghp", "a".repeat(36)].join("_");
    const jwt = ["eyJhbGciOiJIUzI1Ni1", "eyJzdWIiOiIxMjM0NTY3", "abcdefghij1234567890"].join(".");
    await writeFile(
      path.join(root, "lib", "auth", "session.ts"),
      [
        "export const ok = true;",
        `const a = "${awsKey}";`,
        `const g = "${githubToken}";`,
        `const j = "${jwt}";`,
        "const c = 'mongodb://admin:hunter2@db.example.com:27017/app';",
        "",
      ].join("\n"),
    );

    const bundle = await buildContextBundle({
      repoRoot: root,
      task: "audit secrets",
      includeGlobs: ["lib/auth/**"],
    });
    const session = bundle.included.find((item) => item.path === "lib/auth/session.ts");

    assert.ok(session.content.includes("export const ok = true;"));
    assert.equal(session.content.includes(awsKey), false);
    assert.equal(session.content.includes(githubToken), false);
    assert.equal(session.content.includes(jwt), false);
    assert.equal(session.content.includes("admin:hunter2"), false);
    const reasons = new Set(session.redactions);
    assert.ok(reasons.has("aws_key"));
    assert.ok(reasons.has("github_token"));
    assert.ok(reasons.has("jwt"));
    assert.ok(reasons.has("connection_string"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextBundle excludes binary files safely", async () => {
  const root = await createContextFixture();

  try {
    await writeFile(path.join(root, "app", "login", "image.bin"), Buffer.from([0, 1, 2, 3]));

    const bundle = await buildContextBundle({
      repoRoot: root,
      task: "fix login bug",
      includeGlobs: ["app/login/**"],
    });

    assert.equal(bundle.included.some((item) => item.path === "app/login/image.bin"), false);
    assert.deepEqual(
      bundle.excluded.filter((item) => item.path === "app/login/image.bin").map((item) => item.reason),
      ["binary_or_unreadable"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveContextBundle writes bundle JSON under .vibeguard/context", async () => {
  const root = await createContextFixture();

  try {
    const bundle = await buildContextBundle({
      repoRoot: root,
      task: "fix login bug",
      includeGlobs: ["app/login/**"],
      now: new Date("2026-05-17T10:00:00.000Z"),
    });

    const savedPath = await saveContextBundle(root, bundle);
    const saved = JSON.parse(await readFile(savedPath, "utf8"));

    assert.equal(saved.id, "2026-05-17-fix-login-bug");
    assert.match(savedPath, /fix-login-bug\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI context build writes bundle and prints counts", async () => {
  const root = await createContextFixture();

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "context",
        "build",
        "fix login bug",
        "--root",
        root,
        "--include",
        "app/login/**,lib/auth/**",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Context bundle:/);
    assert.match(result.stdout, /Included: 2/);
    assert.match(result.stdout, /Excluded:/);
    assert.match(result.stdout, /Redactions:/);

    const files = await readdir(path.join(root, ".vibeguard", "context"));
    assert.equal(files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI context build --json prints summary without bundled file contents", async () => {
  const root = await createContextFixture();

  try {
    const fakeOpenAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
    await writeFile(
      path.join(root, "lib", "auth", "session.ts"),
      [
        "export const session = true;",
        `const key = '${fakeOpenAiKey}';`,
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "context",
        "build",
        "fix login bug",
        "--root",
        root,
        "--include",
        "lib/auth/**",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Context bundle:/);
    assert.equal(result.stdout.includes(fakeOpenAiKey), false);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.schemaVersion, "0.1");
    assert.equal(payload.command, "context_build");
    assert.match(payload.bundlePath, /fix-login-bug\.json$/);
    assert.equal(payload.bundle.id.endsWith("fix-login-bug"), true);
    assert.equal(payload.bundle.task, "fix login bug");
    assert.deepEqual(payload.bundle.includeGlobs, ["lib/auth/**"]);
    assert.deepEqual(
      payload.bundle.included.map((item) => item.path),
      ["lib/auth/session.ts"],
    );
    assert.equal(Object.hasOwn(payload.bundle.included[0], "content"), false);
    assert.ok(payload.bundle.included[0].redactions.includes("api_key"));
    assert.ok(payload.bundle.excluded.some((item) => item.path === ".env.local"));
    assert.ok(payload.bundle.redactions.some((item) => item.reason === "api_key"));
    assert.equal(payload.bundle.stats.included, 1);
    assert.equal(payload.bundle.stats.redactions, 1);

    const saved = JSON.parse(await readFile(payload.bundlePath, "utf8"));
    assert.equal(saved.included[0].content.includes(fakeOpenAiKey), false);
    assert.ok(saved.included[0].content.includes("[REDACTED:API_KEY]"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createShadowSession can attach a redacted context bundle summary", async () => {
  const root = await createContextFixture();

  try {
    const fakeOpenAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
    await writeFile(
      path.join(root, "lib", "auth", "session.ts"),
      [
        "export const session = true;",
        `const key = '${fakeOpenAiKey}';`,
        "",
      ].join("\n"),
    );

    const session = await createShadowSession({
      repoRoot: root,
      task: "fix login bug",
      sessionId: "context-session",
      allowedGlobs: ["app/login/**"],
      buildContext: true,
      contextIncludeGlobs: ["lib/auth/**"],
      now: new Date("2026-05-25T10:00:00.000Z"),
    });
    const savedSession = JSON.parse(await readFile(session.sessionPath, "utf8"));
    const savedBundle = JSON.parse(await readFile(session.context.bundlePath, "utf8"));
    const handoff = await readFile(session.handoff.path, "utf8");

    assert.match(session.context.bundlePath, /fix-login-bug\.json$/);
    assert.deepEqual(session.context.bundle.includeGlobs, ["lib/auth/**"]);
    assert.deepEqual(session.context.bundle.included, ["lib/auth/session.ts"]);
    assert.equal(session.context.bundle.stats.included, 1);
    assert.equal(session.context.bundle.stats.redactions, 1);
    assert.equal(JSON.stringify(session.context).includes(fakeOpenAiKey), false);
    assert.equal(JSON.stringify(savedSession.context).includes("export const session"), false);
    assert.equal(savedBundle.included[0].content.includes(fakeOpenAiKey), false);
    assert.ok(savedBundle.included[0].content.includes("[REDACTED:API_KEY]"));
    assert.match(handoff, /Context bundle:/);
    assert.match(handoff, /Included files: 1/);
    assert.match(handoff, /Redactions: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI task --context uses allow scope as default context include globs", async () => {
  const root = await createContextFixture();

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "task",
        "fix login bug",
        "--root",
        root,
        "--session",
        "cli-context-session",
        "--allow",
        "app/login/**,tests/auth/**",
        "--context",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.deepEqual(payload.session.policy.allowedGlobs, ["app/login/**", "tests/auth/**"]);
    assert.deepEqual(payload.session.context.bundle.includeGlobs, ["app/login/**", "tests/auth/**"]);
    assert.deepEqual(
      payload.session.context.bundle.included.sort(),
      ["app/login/page.tsx", "tests/auth/login.test.ts"],
    );
    assert.equal(JSON.stringify(payload).includes("export default function Page"), false);
    await access(payload.session.context.bundlePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI task --context --include overrides context scope only", async () => {
  const root = await createContextFixture();

  try {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "task",
        "fix login bug",
        "--root",
        root,
        "--session",
        "cli-context-include-session",
        "--allow",
        "app/login/**",
        "--context",
        "--include",
        "lib/auth/**",
        "--json",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.deepEqual(payload.session.policy.allowedGlobs, ["app/login/**"]);
    assert.deepEqual(payload.session.context.bundle.includeGlobs, ["lib/auth/**"]);
    assert.deepEqual(payload.session.context.bundle.included, ["lib/auth/session.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context build rejects empty tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-context-empty-"));

  try {
    await assert.rejects(
      () => buildContextBundle({ repoRoot: root, task: " " }),
      /Task is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createContextFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vibeguard-context-"));

  await mkdir(path.join(root, "app", "login"), { recursive: true });
  await mkdir(path.join(root, "lib", "auth"), { recursive: true });
  await mkdir(path.join(root, "tests", "auth"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, ".vibeguard"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "coverage"), { recursive: true });

  await writeFile(path.join(root, "app", "login", "page.tsx"), "export default function Page() {}\n");
  await writeFile(path.join(root, "lib", "auth", "session.ts"), "export const session = true;\n");
  await writeFile(path.join(root, "tests", "auth", "login.test.ts"), "test('login', () => {});\n");
  await writeFile(path.join(root, ".env.local"), "JWT_SECRET=do-not-share\n");
  await writeFile(path.join(root, ".git", "config"), "git\n");
  await writeFile(path.join(root, ".vibeguard", "state.json"), "{}\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module\n");
  await writeFile(path.join(root, "coverage", "summary.json"), "{}\n");

  await access(root);
  return root;
}

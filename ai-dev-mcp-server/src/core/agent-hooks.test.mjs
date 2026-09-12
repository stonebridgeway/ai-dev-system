import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_HOOKS_CONTRACT,
  CURSOR_HOOKS_FORMATS,
  CURSOR_HOOKS_FORMAT_VERSION,
  agentHooksStatus,
  claudeHookEntries,
  cursorHookWarnings,
  cursorHooksDocument,
  defaultPolicy,
  installAgentHooks,
  mergeClaudeSettings,
  mergeCursorHooks,
  renderHookPatterns
} from "./agent-hooks.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooksSourceDir = path.join(serverRoot, "hooks");
const fixturesDir = path.join(serverRoot, "test", "fixtures");

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runHook(projectRoot, script, args, payload, env = {}) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, ".ai-dev", "hooks", script), ...args], {
    cwd: projectRoot,
    input: JSON.stringify({ cwd: projectRoot, ...payload }),
    encoding: "utf8",
    env: { ...process.env, AI_DEV_STATE_ROOT: path.join(projectRoot, "..", "state"), ...env },
    timeout: 20_000,
    windowsHide: true
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function fixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-"));
  // Windows keeps handles on freshly written git objects for a moment, so give
  // the cleanup a few attempts instead of failing the test in its `after` hook.
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // The hooks resolve the project root with realpath, so the fixture must hand
  // out resolved paths too: the state root the test reads has to be the one the
  // hook writes to (macOS /var -> /private/var, Windows junctions).
  const root = await fs.realpath(created);
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "index.js"), "export const a = 1;\n");
  await fs.writeFile(path.join(projectRoot, ".eslintrc.json"), "{}\n");
  runGit(projectRoot, ["init", "-q", "-b", "main"]);
  runGit(projectRoot, ["add", "."]);
  runGit(projectRoot, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return { root, projectRoot: await fs.realpath(projectRoot) };
}

test("installer writes hooks, patterns, policy, and merges harness registrations idempotently", async (t) => {
  const { projectRoot } = await fixture(t);
  await fs.mkdir(path.join(projectRoot, ".claude"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node my-own-hook.js" }] }] }
  }, null, 2));

  const dry = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude", "cursor"], dryRun: true });
  assert.ok(dry.planned.includes(".ai-dev/hooks/guard.mjs"));
  assert.ok(dry.planned.includes(".claude/settings.json"));
  assert.equal(await fs.access(path.join(projectRoot, ".ai-dev")).then(() => true).catch(() => false), false);

  const first = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude", "cursor"], profile: "standard" });
  assert.ok(first.written.includes(".ai-dev/hooks/patterns.json"));
  assert.ok(first.written.includes(".ai-dev/policy.json"));
  assert.ok(first.updated.includes(".claude/settings.json"));
  assert.equal(first.backups.length, 1);
  const settings = JSON.parse(await fs.readFile(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "node my-own-hook.js", "foreign entries are preserved");
  assert.ok(settings.hooks.PreToolUse.some((entry) => entry.hooks[0].command === "node .ai-dev/hooks/guard.mjs bash"));
  assert.ok(settings.hooks.SessionStart);
  assert.deepEqual(settings.hooks.Stop[0].hooks.map((hook) => hook.command), [".ai-dev/hooks/session-end.mjs", ".ai-dev/hooks/cost-capture.mjs", ".ai-dev/hooks/stop-check.mjs"].map((script) => `node ${script}`));
  const cursor = JSON.parse(await fs.readFile(path.join(projectRoot, ".cursor", "hooks.json"), "utf8"));
  assert.equal(cursor.hooks.beforeShellExecution[0].command, "node .ai-dev/hooks/guard.mjs bash --cursor");

  const second = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude", "cursor"], profile: "standard" });
  assert.equal(second.written.length + second.updated.length, 0, "second install is a no-op");
  const minimal = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "minimal" });
  assert.ok(minimal.updated.includes(".ai-dev/policy.json"), "profile change updates policy");
  const minimalSettings = JSON.parse(await fs.readFile(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  assert.equal(minimalSettings.hooks.SessionStart, undefined);
  assert.equal(minimalSettings.hooks.PreToolUse.filter((entry) => entry.hooks[0].command.includes(".ai-dev/hooks/")).length, 2);

  const status = await agentHooksStatus(projectRoot);
  assert.equal(status.installed, true);
  assert.equal(status.profile, "minimal");
  assert.equal(status.claude_entries, 4);
  await assert.rejects(installAgentHooks({ projectRoot, hooksSourceDir, profile: "turbo" }), /Unknown hook profile/);
  await assert.rejects(installAgentHooks({ projectRoot, hooksSourceDir, targets: ["vim"] }), /Unknown hooks target/);
});

test("hook path helpers are platform-agnostic", async (t) => {
  const { normalizePath, projectIdOf, relativePosix, samePath } = await import("../../hooks/lib.mjs");
  const { projectRoot } = await fixture(t);

  // Records written by a hook are read back by the server and by session-start:
  // relative paths are POSIX on every platform, never `src\\login.js`.
  assert.equal(relativePosix(projectRoot, path.join(projectRoot, "src", "login.js")), "src/login.js");
  assert.equal(relativePosix(projectRoot, projectRoot), "");

  // Task records store the path the server saw; the hook compares it to its own
  // resolved root, which on Windows may differ in case and separators.
  assert.equal(samePath(projectRoot, `${projectRoot}${path.sep}`), true);
  assert.equal(samePath(projectRoot, path.join(projectRoot, "src")), false);
  assert.equal(samePath("", projectRoot), false);
  assert.equal(samePath(projectRoot, undefined), false);
  assert.equal(normalizePath(projectRoot).includes("\\"), false);
  if (process.platform === "win32") {
    assert.equal(samePath("C:\\Repos\\App", "c:/repos/app"), true);
    assert.equal(projectIdOf("C:\\Repos\\App"), projectIdOf("c:/repos/app/"));
  } else {
    assert.equal(samePath("/repos/App", "/repos/app"), false);
  }
});

test("pure helpers: patterns, entries, merges", () => {
  const patterns = renderHookPatterns();
  assert.ok(patterns.secrets.some((item) => item.id === "aws_access_key"));
  assert.ok(patterns.protected_config_files.includes("biome.json"));
  assert.equal(defaultPolicy("strict").profile, "strict");
  assert.equal(defaultPolicy("weird").profile, "standard");
  assert.equal(claudeHookEntries("minimal").PostToolUse, undefined);
  assert.ok(claudeHookEntries("strict").PostToolUse.length === 1);
  const merged = mergeClaudeSettings({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node .ai-dev/hooks/old.mjs" }] }, { hooks: [{ type: "command", command: "echo keep" }] }] } }, claudeHookEntries("minimal"));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, "echo keep");
  const cursorMerged = mergeCursorHooks({ version: 1, hooks: { stop: [{ command: "node other.js" }] } }, cursorHooksDocument("standard"));
  assert.equal(cursorMerged.hooks.stop[0].command, "node other.js");
  assert.equal(cursorMerged.hooks.stop.length, 2);
});

test("the Cursor adapter is pinned to a checked hooks.json format version", () => {
  // Checked 2026-09-10 against Cursor's hooks reference and two independent
  // transcriptions of the same contract (see CURSOR_HOOKS_CONTRACT.sources):
  // Cursor 3.x still reads `"version": 1`. When that stops being true, add a
  // builder for the new version — do not edit the version-1 one — and move
  // these expectations onto it.
  assert.equal(CURSOR_HOOKS_FORMAT_VERSION, 1);
  assert.equal(CURSOR_HOOKS_CONTRACT.verified_on, "2026-09-10");
  assert.deepEqual(CURSOR_HOOKS_FORMATS, [1]);

  const document = cursorHooksDocument("standard");
  assert.equal(document.version, 1);
  // Every event we register is one Cursor names, spelled Cursor's way.
  assert.deepEqual(Object.keys(document.hooks).sort(), Object.keys(CURSOR_HOOKS_CONTRACT.events).sort());
  assert.deepEqual(Object.keys(cursorHooksDocument("minimal").hooks).sort(), ["beforeShellExecution", "preCompact", "sessionEnd"]);
  assert.deepEqual(cursorHooksDocument("weird").hooks, document.hooks, "an unknown profile falls back to standard");
  assert.throws(() => cursorHooksDocument("standard", { version: 2 }), /Unknown \.cursor\/hooks\.json format version: 2\. Known: 1/);

  // The document is stamped with the version our entries speak, and what the
  // merge cannot decide comes back as a warning instead of a silent rewrite.
  const foreign = { version: 2, hooks: { beforeShellExecution: [{ command: "node theirs.js" }] } };
  assert.equal(mergeCursorHooks(foreign, document).version, 1);
  assert.equal(mergeCursorHooks(foreign, document).hooks.beforeShellExecution[0].command, "node theirs.js");
  const warnings = cursorHookWarnings(foreign, document);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /declared format version 2/);
  assert.match(warnings[1], /beforeShellExecution already lists 1 foreign hook/);
  assert.deepEqual(cursorHookWarnings(null, document), []);
  assert.deepEqual(cursorHookWarnings({ version: 1, hooks: {} }, document), []);
});

test("installing for Cursor records the format version and reports what it could not decide", async (t) => {
  const { projectRoot } = await fixture(t);
  await fs.mkdir(path.join(projectRoot, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".cursor", "hooks.json"), JSON.stringify({
    version: 1,
    hooks: { beforeShellExecution: [{ command: "node audit.js" }] }
  }, null, 2));

  const result = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["cursor"], profile: "standard" });
  assert.equal(result.cursor_format_version, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Cursor runs the first entry of an event/);
  const document = JSON.parse(await fs.readFile(path.join(projectRoot, ".cursor", "hooks.json"), "utf8"));
  assert.equal(document.version, 1);
  assert.equal(document.hooks.beforeShellExecution[0].command, "node audit.js");
  assert.equal(document.hooks.beforeShellExecution[1].command, "node .ai-dev/hooks/guard.mjs bash --cursor");

  const status = await agentHooksStatus(projectRoot);
  assert.equal(status.cursor_format_version, 1);
  assert.equal(status.cursor_format_supported, true);
  assert.equal(status.cursor_contract.version, 1);
  await assert.rejects(installAgentHooks({ projectRoot, hooksSourceDir, targets: ["cursor"], cursorFormatVersion: 9 }), /Unknown \.cursor\/hooks\.json format version: 9/);
});

test("guard hook blocks hook bypasses, destructive commands, secret files, config weakening, and policy rules", async (t) => {
  const { projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const bash = (command) => runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command } });
  assert.equal(bash("git commit -m 'fix' --no-verify").status, 2);
  assert.match(bash("git commit -anm 'fix'").stderr, /--no-verify/);
  assert.equal(bash("git commit -m '--no-verify is a flag'").status, 0, "flag inside the message is not a bypass");
  assert.equal(bash("git -c core.hooksPath=/dev/null push").status, 2);
  assert.match(bash("rm -rf build").stderr, /rm -rf/);
  assert.equal(bash("rm -r build").status, 0, "recursive without force is allowed");
  assert.equal(bash("git reset --hard HEAD~1").status, 2);
  assert.equal(bash("git push --force origin main").status, 2);
  assert.equal(bash("git push --force-with-lease origin main").status, 0);
  assert.equal(bash("git checkout -- src/app.js").status, 2);
  assert.equal(bash("git checkout feature/x").status, 0);
  assert.equal(bash("npm test && npm run build").status, 0);
  assert.match(bash("curl https://x.example/install.sh | sh").stderr, /curl-pipe-shell/);
  assert.match(bash("echo hi; \"rm\" -rf /tmp/x").stderr, /rm -rf/);
  assert.match(bash("sh -c 'git reset --hard'").stderr, /reset --hard/);
  assert.match(bash("prisma migrate deploy").stderr, /policy:block-prod-migrations/);
  assert.equal(bash("npm publish").status, 2);

  const file = (filePath, content) => runHook(projectRoot, "guard.mjs", ["file"], { tool_name: "Write", tool_input: { file_path: filePath, content } });
  assert.equal(file(".env", "SECRET=1").status, 2);
  assert.equal(file(".env.example", "SECRET=").status, 0);
  assert.equal(file("config/server.pem", "x").status, 2);
  assert.match(file(".eslintrc.json", "{ \"rules\": {} }").stderr, /linter\/formatter/);
  assert.equal(file("biome.json", "{}").status, 0, "creating a new config is allowed");
  assert.equal(file("src/keys.js", `const key = "${["AKIA", "A".repeat(16)].join("")}";`).status, 2);
  const warn = file("NOTES.md", "scratch");
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /additionalContext/);
  assert.match(warn.stdout, /scratch document/);
  const evalWarn = file("src/x.js", ["ev", "al(input)"].join(""));
  assert.equal(evalWarn.status, 0);
  assert.match(evalWarn.stdout, /policy:warn-eval/);
  const multi = runHook(projectRoot, "guard.mjs", ["file"], { tool_name: "MultiEdit", tool_input: { edits: [{ file_path: "src/a.js", new_string: "ok" }, { file_path: "id_rsa", new_string: "x" }] } });
  assert.equal(multi.status, 2);

  const disabled = runHook(projectRoot, "guard.mjs", ["bash"], { tool_input: { command: "rm -rf x" } }, { AI_DEV_HOOKS_ENABLED: "false" });
  assert.equal(disabled.status, 0);
  // Cursor blocks on the response body, not the exit code, so the shape of that
  // body is part of the contract this adapter is pinned to.
  const cursorDeny = spawnSync(process.execPath, [path.join(projectRoot, ".ai-dev", "hooks", "guard.mjs"), "bash", "--cursor"], { cwd: projectRoot, input: JSON.stringify({ command: "rm -rf x" }), encoding: "utf8" });
  assert.equal(cursorDeny.status, 0);
  assert.match(cursorDeny.stdout, /"permission":"deny"/);
  const denied = JSON.parse(cursorDeny.stdout);
  assert.equal(denied.permission, "deny");
  assert.deepEqual(Object.keys(denied).sort(), [...CURSOR_HOOKS_CONTRACT.deny_response].sort());
});

test("session hooks capture transcripts, inject handoffs and instincts, and advise compaction", async (t) => {
  const { root, projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const stateRoot = path.join(root, "state");
  const transcript = path.join(root, "transcript.jsonl");
  const usage = { input_tokens: 150_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 10 };
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", message: { role: "user", content: "Add login validation" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", usage, content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(projectRoot, "src", "login.js") } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Now add tests" } }),
    ""
  ].join("\n"));

  const ended = runHook(projectRoot, "session-end.mjs", [], { session_id: "abc123", transcript_path: transcript });
  assert.equal(ended.status, 0);
  const sessionsDir = path.join(stateRoot, "sessions");
  const [projectDir] = await fs.readdir(sessionsDir);
  const record = JSON.parse(await fs.readFile(path.join(sessionsDir, projectDir, "hook-abc123.json"), "utf8"));
  assert.equal(record.source, "hook");
  assert.equal(record.confirmed, false, "a transcript capture is a draft until an agent confirms it");
  assert.equal(record.topic, "Add login validation");
  assert.deepEqual(record.files.map((file) => file.path), ["src/login.js"]);

  const { resolveProjectIdentity } = await import("./project-identity.mjs");
  const identity = await resolveProjectIdentity(projectRoot);
  assert.equal(projectDir, identity.repository_id, "hook and server derive the same repository id");
  assert.equal(record.project_id, identity.project_id, "hook and server derive the same project id");

  await fs.writeFile(path.join(stateRoot, "instincts.json"), JSON.stringify({ instincts: [
    { id: "a", trigger: "when writing tests", action: "use table-driven cases", scope: "project", project_id: identity.project_id, confidence: 0.8, status: "active" },
    { id: "b", trigger: "when x", action: "low confidence", scope: "global", confidence: 0.4, status: "active" }
  ] }));
  await fs.mkdir(path.join(stateRoot, "tasks"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "tasks", "task-20260101T000000-abcdef12.json"), JSON.stringify({ id: "task-20260101T000000-abcdef12", status: "active", task: "Finish login", project: { path: projectRoot }, updated_at: "2026-01-01" }));
  const started = runHook(projectRoot, "session-start.mjs", [], { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(started.status, 0);
  const context = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /HISTORICAL REFERENCE ONLY/);
  // The injected handoff is that draft, so the caveat travels with it.
  assert.match(context, /UNCONFIRMED HOOK DRAFT \(session-hook-abc123\)/);
  assert.match(context, /confirm it with save_session\(confirm_hook_draft: true\)/);
  assert.match(context, /Add login validation/);
  assert.match(context, /task-20260101T000000-abcdef12 \[active\] Finish login/);
  assert.match(context, /use table-driven cases/);
  assert.doesNotMatch(context, /low confidence/);

  const sessionId = `compact${process.pid}${Date.now()}`;
  t.after(() => Promise.all([`ai-dev-context-bucket-${sessionId}`, `ai-dev-tool-count-${sessionId}`].map((name) => fs.rm(path.join(os.tmpdir(), name), { force: true }))));
  const advice = runHook(projectRoot, "compact-advisor.mjs", [], { session_id: sessionId, transcript_path: transcript, tool_input: { file_path: "x" } });
  assert.match(advice.stdout, /Context ~170k tokens/);
  const again = runHook(projectRoot, "compact-advisor.mjs", [], { session_id: sessionId, transcript_path: transcript, tool_input: { file_path: "x" } });
  assert.doesNotMatch(again.stdout, /Context ~170k/, "same bucket does not repeat");

  await fs.writeFile(path.join(projectRoot, "src.js"), "console.log('x');\n");
  const stop = runHook(projectRoot, "stop-check.mjs", [], {});
  assert.match(stop.stderr, /console\.log in src\.js/);
  assert.match(stop.stderr, /Task task-20260101T000000-abcdef12 is active/);
  const formatted = runHook(projectRoot, "post-edit.mjs", [], { tool_input: { file_path: "src.js" } });
  assert.equal(formatted.status, 0);
});

test("the compact advisor reads the newest assistant usage out of a real transcript", async () => {
  const { COMPACT_DEFAULTS, compactSettings, contextThresholdFor, contextWindowFor, latestAssistantUsage } = await import("../../hooks/lib.mjs");
  const transcript = path.join(fixturesDir, "claude-transcript.jsonl");

  // The fixture ends with a tool result and a subagent turn; the usage that
  // describes this session's context is the last non-sidechain assistant one.
  const usage = latestAssistantUsage(transcript);
  assert.deepEqual(usage, { tokens: 170_000, model: "claude-sonnet-5", output_tokens: 412 });
  assert.equal(latestAssistantUsage(path.join(fixturesDir, "does-not-exist.jsonl")), null);
  assert.equal(latestAssistantUsage(""), null);
  // Only the tail is read, and the line it starts mid-way through is dropped
  // rather than parsed as a truncated record.
  assert.equal(latestAssistantUsage(transcript, 1024), null);

  // Every threshold is policy-driven; the defaults are the ECC ones.
  const defaults = compactSettings({});
  assert.equal(defaults.tool_threshold, COMPACT_DEFAULTS.tool_threshold);
  assert.equal(contextThresholdFor(defaults, contextWindowFor(usage.model, usage.tokens)), 160_000);
  assert.equal(contextWindowFor(usage.model, usage.tokens), 200_000);
  assert.equal(contextWindowFor("claude-opus-5[1m]", 40_000), 1_000_000);
  assert.equal(contextThresholdFor(defaults, contextWindowFor("claude-opus-5[1m]", 40_000)), 250_000);
  assert.equal(contextWindowFor("claude-sonnet-5", 640_000), 1_000_000, "a count no standard window holds implies the large one");

  const tuned = compactSettings({ compact_tool_threshold: 10, compact_tool_interval: 5, compact_context_thresholds: { standard: 120_000 }, compact_context_window: 300_000, compact_context_interval: 10_000 });
  assert.equal(tuned.tool_threshold, 10);
  assert.equal(tuned.tool_interval, 5);
  assert.equal(tuned.context_window, 300_000);
  assert.equal(contextThresholdFor(tuned, contextWindowFor(usage.model, usage.tokens, tuned.context_window)), 120_000);
  assert.equal(tuned.context_thresholds.large, COMPACT_DEFAULTS.context_thresholds.large, "an unset half keeps its default");
  assert.equal(contextThresholdFor(compactSettings({ compact_context_threshold: 90_000 }), 200_000), 90_000, "an absolute threshold wins over the window");
  // Nonsense in policy.json must not silence the advisor.
  assert.deepEqual(compactSettings({ compact_tool_threshold: "soon", compact_context_interval: -5 }), defaults);
});

test("compaction advice follows the thresholds in policy.json", async (t) => {
  const { projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, compact_context_threshold: 200_000, compact_tool_threshold: 2 }, null, 2));
  const transcript = path.join(fixturesDir, "claude-transcript.jsonl");
  const sessionId = `policy${process.pid}${Date.now()}`;
  t.after(() => Promise.all([`ai-dev-context-bucket-${sessionId}`, `ai-dev-tool-count-${sessionId}`].map((name) => fs.rm(path.join(os.tmpdir(), name), { force: true }))));
  const advise = () => runHook(projectRoot, "compact-advisor.mjs", [], { session_id: sessionId, transcript_path: transcript, tool_input: { file_path: "x" } });

  // 170k of context is under the 200k this project asked for.
  const quiet = advise();
  assert.doesNotMatch(quiet.stdout, /Context ~/);
  // ...but the tool counter is set to 2, so the second call advises on that.
  assert.match(advise().stdout, /2 tool calls in this session/);

  await fs.writeFile(policyPath, JSON.stringify({ ...policy, compact_context_threshold: 100_000 }, null, 2));
  assert.match(advise().stdout, /Context ~170k tokens \(85% of 200k\)/);
});

test("hook memory is keyed by repository, so a worktree capture reaches the main checkout", async (t) => {
  const { projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const stateRoot = path.join(path.dirname(projectRoot), "state");
  const worktree = path.join(path.dirname(projectRoot), "worktrees", "task-one");
  runGit(projectRoot, ["worktree", "add", "-q", "-b", "task/one", worktree]);
  const transcript = path.join(path.dirname(projectRoot), "worktree-transcript.jsonl");
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", message: { role: "user", content: "Add rate limiting to the public API" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "Now exclude the health check" } }),
    ""
  ].join("\n"));

  // The agent works inside the task worktree; the hook runs from there.
  const ended = runHook(projectRoot, "session-end.mjs", [], { session_id: "wt1", transcript_path: transcript, cwd: worktree });
  assert.equal(ended.status, 0);
  const { resolveProjectIdentity } = await import("./project-identity.mjs");
  const [main, linked] = await Promise.all([resolveProjectIdentity(projectRoot), resolveProjectIdentity(worktree)]);
  assert.notEqual(linked.project_id, main.project_id);
  const record = JSON.parse(await fs.readFile(path.join(stateRoot, "sessions", main.repository_id, "hook-wt1.json"), "utf8"));
  assert.equal(record.repository_id, main.repository_id);
  assert.equal(record.project_id, linked.project_id, "the record still says which working tree it came from");

  // SessionStart in the main checkout reads it back.
  const started = runHook(projectRoot, "session-start.mjs", [], { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(started.status, 0);
  assert.match(JSON.parse(started.stdout).hookSpecificOutput.additionalContext, /Add rate limiting to the public API/);
});

test("cost capture sums a transcript into the usage ledger, once per message", async (t) => {
  const { UsageLedger } = await import("./usage-ledger.mjs");
  const { root, projectRoot } = await fixture(t);
  // Cost capture is a minimal-profile hook: a session nobody measured cannot be
  // priced afterwards.
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "minimal" });
  const stateRoot = path.join(root, "state");
  const transcript = path.join(root, "cost-transcript.jsonl");
  const ledgerPath = path.join(stateRoot, "usage", "events.jsonl");
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 6000 };
  const assistant = (id, model, entry = {}) => JSON.stringify({ type: "assistant", message: { id, role: "assistant", model, usage }, ...entry });
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", message: { role: "user", content: "Add login validation" } }),
    assistant("msg_1", "claude-sonnet-5"),
    // One API response written out as two transcript lines: billed once.
    assistant("msg_1", "claude-sonnet-5"),
    ""
  ].join("\n"));
  await fs.mkdir(path.join(stateRoot, "tasks"), { recursive: true });
  await fs.writeFile(path.join(stateRoot, "tasks", "task-20260101T000000-abcdef12.json"), JSON.stringify({ id: "task-20260101T000000-abcdef12", status: "active", task: "Finish login", project: { path: projectRoot }, updated_at: "2026-01-01" }));
  const events = async () => (await fs.readFile(ledgerPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const first = runHook(projectRoot, "cost-capture.mjs", [], { session_id: "cost1", transcript_path: transcript });
  assert.equal(first.status, 0, first.stderr);
  const [captured] = await events();
  assert.equal(captured.kind, "usage");
  assert.equal(captured.model, "claude-sonnet-5");
  assert.equal(captured.input_tokens, 1000);
  assert.equal(captured.cache_read_tokens, 40_000);
  assert.equal(captured.cache_creation_tokens, 6000);
  assert.equal(captured.turns, 1);
  assert.equal(captured.source, "hook:cost-capture");
  assert.equal(captured.session_id, "cost1");
  const { samePath } = await import("../../hooks/lib.mjs");
  assert.ok(samePath(captured.project_path, projectRoot), `${captured.project_path} is not ${projectRoot}`);
  assert.equal(captured.task_id, "task-20260101T000000-abcdef12", "spend lands on the task that is open");
  // The hook records tokens; the rate table prices them at read time.
  assert.equal(captured.cost_usd, 0);

  // Stop fires after every turn, so a re-run with nothing new must add nothing.
  runHook(projectRoot, "cost-capture.mjs", [], { session_id: "cost1", transcript_path: transcript });
  assert.equal((await events()).length, 1, "the transcript cursor stops the same turn being billed twice");

  // Only the delta is billed: a second model appears, the first is not re-read.
  await fs.appendFile(transcript, `${assistant("msg_2", "claude-opus-5[1m]", { isSidechain: true })}\n`);
  runHook(projectRoot, "cost-capture.mjs", [], { session_id: "cost1", transcript_path: transcript });
  const all = await events();
  assert.equal(all.length, 2);
  assert.equal(all[1].model, "claude-opus-5[1m]", "a subagent's tokens are billed to the same account");

  // What the hook wrote is what the server reads, priced from the published
  // table: Sonnet 5 ($2 / $10 per MTok, cache 2.50 / 0.20) costs 0.027 for this
  // turn and Opus 5 ($5 / $25, cache 6.25 / 0.50) costs 0.0675.
  const report = await new UsageLedger({ stateRoot }).report({ projectPath: projectRoot });
  assert.equal(report.usage.events, 2);
  assert.equal(report.usage.cache_read_tokens, 80_000);
  assert.equal(report.usage.cost_usd, 0.0945);
  assert.equal(report.usage.reported_cost_usd, 0);
  assert.deepEqual(report.rates.unpriced_models, []);
  assert.equal(report.tasks[0].task_id, "task-20260101T000000-abcdef12");
  assert.equal(report.periods.today.usage_events, 2);

  // A transcript that was replaced under a reused session id is read from the
  // top rather than from a cursor that points into the middle of it.
  await fs.writeFile(transcript, `${assistant("msg_3", "claude-sonnet-5")}\n`);
  runHook(projectRoot, "cost-capture.mjs", [], { session_id: "cost1", transcript_path: transcript });
  assert.equal((await events()).length, 3);
  // Cursor sends a conversation id and no transcript: nothing to read, no event.
  runHook(projectRoot, "cost-capture.mjs", ["--cursor"], { conversation_id: "cost1" });
  assert.equal((await events()).length, 3);
});

test("cost capture reads a real transcript in whole lines, chunk by chunk", async () => {
  const { sumAssistantUsage } = await import("../../hooks/lib.mjs");
  const transcript = path.join(fixturesDir, "claude-transcript.jsonl");

  const all = sumAssistantUsage(transcript);
  assert.equal(all.messages, 3);
  assert.deepEqual(all.models.map((row) => row.model), ["claude-sonnet-5", "claude-opus-5[1m]"]);
  // Two assistant turns on Sonnet, and the subagent turn the compaction advisor
  // ignores — it is another context window, but the same bill.
  assert.deepEqual(all.models[0], { model: "claude-sonnet-5", messages: 2, input_tokens: 2004, output_tokens: 508, cache_read_tokens: 214_000, cache_creation_tokens: 14_100 });
  assert.equal(all.models[1].input_tokens, 900_000);
  assert.equal(all.offset, (await fs.stat(transcript)).size);
  assert.deepEqual(sumAssistantUsage(transcript, { fromOffset: all.offset }), { offset: all.offset, messages: 0, models: [] });

  // A chunk that lands mid-line stops at the last newline; the next run resumes
  // exactly there, so the two halves add up to the whole and no line is split.
  const head = sumAssistantUsage(transcript, { chunkBytes: 1024 });
  assert.ok(head.offset > 0 && head.offset < all.offset, `unexpected chunk boundary ${head.offset}`);
  const tail = sumAssistantUsage(transcript, { fromOffset: head.offset });
  assert.equal(tail.offset, all.offset);
  assert.equal(head.messages + tail.messages, all.messages);
  const sonnetInput = [head, tail].flatMap((part) => part.models).filter((row) => row.model === "claude-sonnet-5").reduce((sum, row) => sum + row.input_tokens, 0);
  assert.equal(sonnetInput, 2004);

  assert.deepEqual(sumAssistantUsage(""), { offset: 0, messages: 0, models: [] });
  assert.deepEqual(sumAssistantUsage(path.join(fixturesDir, "does-not-exist.jsonl"), { fromOffset: 12 }), { offset: 12, messages: 0, models: [] });
});

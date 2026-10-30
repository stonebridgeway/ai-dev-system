import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GIT_HOOKS_RELATIVE_DIR, agentHooksStatus, defaultPolicy, installAgentHooks, renderHookPatterns } from "./agent-hooks.mjs";
import { parseAddedLines } from "./change-hygiene.mjs";
import { observationsFileName, proposeInstincts } from "./instinct-proposals.mjs";
import {
  FACT_FORCE_DEFAULTS,
  FACT_KEYS,
  decideFactForce,
  destructiveIntent,
  factForceSettings,
  factsFor,
  guardStatePath,
  isExempt,
  matchesGlob,
  readGuardState,
  rollbackStated,
  writeGuardState
} from "../../hooks/fact-force.mjs";
import {
  gitHookSettings,
  parseAddedLines as hookParseAddedLines,
  scanStaged,
  verificationReminder
} from "../../hooks/git-hooks.mjs";

// The scripts `install_agent_hooks` copies into a repository, exercised both as
// modules and — where the contract is the exit code — as the processes a
// harness and git actually run. The installer itself, its merges and its
// generated documents are in agent-hooks.test.mjs.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooksSourceDir = path.join(serverRoot, "hooks");

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
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "hook-scripts-"));
  t.after(() => fs.rm(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = await fs.realpath(created);
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "index.js"), "export const a = 1;\n");
  runGit(projectRoot, ["init", "-q", "-b", "main"]);
  runGit(projectRoot, ["add", "."]);
  runGit(projectRoot, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return { root, projectRoot: await fs.realpath(projectRoot) };
}

test("fact_force settings read the policy, the environment, and their own defaults", () => {
  assert.equal(factForceSettings({}).enabled, false);
  assert.equal(factForceSettings(defaultPolicy("standard")).enabled, false);
  assert.equal(factForceSettings(defaultPolicy("strict")).enabled, true);
  assert.equal(factForceSettings(defaultPolicy("strict"), { AI_DEV_FACT_FORCE: "0" }).enabled, false);
  assert.equal(factForceSettings({}, { AI_DEV_FACT_FORCE: "on" }).enabled, true);
  assert.ok(factForceSettings({}, { AI_DEV_FACT_FORCE_EXEMPT: "generated/**, *.pb.go" }).exempt_globs.includes("*.pb.go"));
  assert.equal(factForceSettings({ fact_force: { expiry_minutes: 0 } }).expiry_minutes, FACT_FORCE_DEFAULTS.expiry_minutes);

  // The policy the installer writes and the defaults the hook falls back to are
  // two copies of one table; this is what keeps them from drifting apart.
  assert.deepEqual(defaultPolicy("strict").fact_force, { ...FACT_FORCE_DEFAULTS, enabled: true });
  assert.deepEqual(defaultPolicy("standard").fact_force, { ...FACT_FORCE_DEFAULTS, enabled: false });
});

test("fact_force reads globs, facts, rollback lines and destructive intent", () => {
  assert.equal(matchesGlob("**/*.md", "docs/deep/notes.md"), true);
  assert.equal(matchesGlob("**/*.md", "README.md"), true, "**/ also matches nothing");
  assert.equal(matchesGlob("**/*.md", "src/app.mjs"), false);
  assert.equal(matchesGlob("src/*.mjs", "src/nested/app.mjs"), false, "* stops at a separator");
  assert.equal(matchesGlob(".ai-dev/**", ".ai-dev/hooks/guard.mjs"), true);
  assert.equal(isExempt("src/app.mjs", FACT_FORCE_DEFAULTS.exempt_globs), false);
  assert.equal(isExempt("package-lock.json", ["**/*.lock", "**/*-lock.json"]), true);

  const said = [
    "Looking at the router before touching it.",
    "",
    "FACTS src/router.mjs",
    "importers: src/app.mjs and src/server.mjs",
    "api: adds a `resolve` export, nothing removed",
    "data: reads the route table in config/routes.json",
    "instruction: \"make the router resolve nested paths\""
  ].join("\n");
  assert.deepEqual(factsFor(said, "src/router.mjs").missing, []);
  assert.deepEqual(factsFor(said, "src/other.mjs").missing, [...FACT_KEYS]);
  assert.deepEqual(factsFor(said.replace(/^data:.*$/m, "data:"), "src/router.mjs").missing, ["data"]);
  // The block may be written as a Markdown list, and the path may be quoted.
  const listed = "**FACTS** `src/router.mjs`\n- importers: none\n- api: none\n- data: none\n- instruction: \"tidy it\"";
  assert.deepEqual(factsFor(listed, "src/router.mjs").missing, []);
  // A key with nothing after it must not borrow the next line's answer.
  assert.deepEqual(factsFor("FACTS a.mjs\nimporters:\napi: none\ndata: none\ninstruction: \"x y z\"", "a.mjs").missing, ["importers"]);

  assert.equal(rollbackStated("ROLLBACK: git revert the commit this creates"), true);
  assert.equal(rollbackStated("- **ROLLBACK**: restore from .ai-dev snapshot 3"), true);
  assert.equal(rollbackStated("ROLLBACK: none"), false, "a shrug is not a plan");
  assert.equal(rollbackStated("I will roll it back if needed"), false);

  assert.equal(destructiveIntent("rm build/output.js").id, "file-removal");
  assert.equal(destructiveIntent("git commit --amend -m 'fix'").id, "history-rewrite");
  assert.equal(destructiveIntent("npm install left-pad").id, "dependency-change");
  assert.equal(destructiveIntent("sed -i 's/a/b/' src/app.mjs").id, "in-place-edit");
  assert.equal(destructiveIntent("kubectl apply -f deploy.yaml").id, "infrastructure");
  assert.equal(destructiveIntent("npm test"), null);
  assert.equal(destructiveIntent("git status"), null);
  assert.equal(destructiveIntent("grep -rn 'rm ' src"), null, "a search for a word is not the word");
});

test("fact_force decides one call at a time and stops refusing after the cap", () => {
  const settings = factForceSettings(defaultPolicy("strict"));
  const empty = { files: {}, bash: 0, denials: 0 };
  const grounded = ["FACTS src/app.mjs", "importers: none", "api: none", "data: none", "instruction: \"add a flag\""].join("\n");

  const first = decideFactForce({ mode: "file", targets: ["src/app.mjs"], said: "", settings, state: empty });
  assert.match(first.deny, /first edit of src\/app\.mjs/);
  assert.match(first.deny, /Missing: importers, api, data, instruction/);
  assert.equal(first.state.denials, 1);
  assert.deepEqual(first.state.files, {});

  const answered = decideFactForce({ mode: "file", targets: ["src/app.mjs"], said: grounded, settings, state: first.state });
  assert.equal(answered.deny, "");
  assert.ok(answered.state.files["src/app.mjs"] > 0);
  const again = decideFactForce({ mode: "file", targets: ["src/app.mjs"], said: "", settings, state: answered.state });
  assert.equal(again.deny, "", "a file is grounded once per session");

  // Exempt paths and a transcript we cannot read are both left alone, but the
  // unreadable one still counts the file as seen.
  assert.equal(decideFactForce({ mode: "file", targets: ["README.md"], said: "", settings, state: empty }).deny, "");
  const blind = decideFactForce({ mode: "file", targets: ["src/b.mjs"], said: "", transcript: false, settings, state: empty });
  assert.equal(blind.deny, "");
  assert.ok(blind.state.files["src/b.mjs"] > 0);

  const bash = decideFactForce({ mode: "bash", command: "rm build/out.js", said: "", settings, state: empty });
  assert.match(bash.deny, /deletes files/);
  assert.match(bash.deny, /ROLLBACK:/);
  const undone = decideFactForce({ mode: "bash", command: "rm build/out.js", said: "ROLLBACK: rebuild with npm run build", settings, state: bash.state });
  assert.equal(undone.deny, "");
  assert.ok(undone.state.bash > 0);
  assert.equal(decideFactForce({ mode: "bash", command: "npm test", said: "", settings, state: empty }).deny, "");

  // Damping: after max_denials refusals the gate keeps saying so, out of the way.
  const capped = { files: {}, bash: 0, denials: settings.max_denials };
  const damped = decideFactForce({ mode: "file", targets: ["src/c.mjs"], said: "", settings, state: capped });
  assert.equal(damped.deny, "");
  assert.match(damped.note, /stopped refusing after 3 refusals/);
  assert.ok(damped.state.files["src/c.mjs"] > 0);
});

test("fact_force session state expires, is capped, and survives an unreadable file", () => {
  const settings = factForceSettings(defaultPolicy("strict"));
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const sessionId = `expiry-${process.pid}`;
  const files = { "src/fresh.mjs": now - 60_000, "src/stale.mjs": now - 45 * 60_000 };
  assert.equal(writeGuardState(sessionId, { files, bash: now - 45 * 60_000, denials: 2 }), true);

  const state = readGuardState(sessionId, settings, now);
  assert.deepEqual(Object.keys(state.files), ["src/fresh.mjs"], "entries older than the expiry are re-grounded");
  assert.equal(state.bash, 0);
  assert.equal(state.denials, 2);

  const many = Object.fromEntries(Array.from({ length: 10 }, (unused, index) => [`src/f${index}.mjs`, now - index * 1000]));
  writeGuardState(sessionId, { files: many, bash: 0, denials: 0 });
  const capped = readGuardState(sessionId, { ...settings, max_entries: 4 }, now);
  assert.deepEqual(Object.keys(capped.files), ["src/f0.mjs", "src/f1.mjs", "src/f2.mjs", "src/f3.mjs"], "the newest survive the cap");

  // A state file that cannot be parsed, and one that was never written, both
  // read as empty rather than refusing every edit for the rest of the session.
  fsSync.writeFileSync(guardStatePath(sessionId), "{ not json");
  assert.deepEqual(readGuardState(sessionId, settings, now), { files: {}, bash: 0, denials: 0 });
  assert.deepEqual(readGuardState(`missing-${process.pid}`, settings, now), { files: {}, bash: 0, denials: 0 });
});

test("the strict guard refuses an ungrounded first edit and takes the answer from the transcript", async (t) => {
  const { root, projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "strict" });
  const transcript = path.join(root, "transcript.jsonl");
  const say = async (...texts) => {
    await fs.writeFile(transcript, texts.map((text) => `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`).join(""));
  };
  const edit = (filePath, sessionId = "s1") => runHook(projectRoot, "guard.mjs", ["file"], {
    tool_name: "Edit",
    session_id: sessionId,
    transcript_path: transcript,
    tool_input: { file_path: filePath, new_string: "export const a = 2;" }
  });

  await say("Editing the entry point now.");
  const refused = edit("index.js");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /fact_force/);
  assert.match(refused.stderr, /FACTS index\.js/);
  assert.match(refused.stderr, /Missing: importers, api, data, instruction/);

  await say("Editing the entry point now.", [
    "FACTS index.js",
    "importers: nothing imports it yet",
    "api: changes the `a` export from 1 to 2",
    "data: none",
    "instruction: \"bump the counter\""
  ].join("\n"));
  assert.equal(edit("index.js").status, 0, "the stated facts let the edit through");
  await say("No facts this time.");
  assert.equal(edit("index.js").status, 0, "and the file stays grounded for the session");
  assert.equal(edit("index.js", "s2").status, 2, "a new session starts from nothing");

  // Exempt by default, and the whole gate is off under the standard profile.
  assert.equal(edit("docs/notes.md").status, 0);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard", overwrite: true });
  assert.equal(edit("src/untouched.js", "s3").status, 0);

  // A destructive command asks for the way back instead.
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "strict", overwrite: true });
  const bash = (command, sessionId) => runHook(projectRoot, "guard.mjs", ["bash"], {
    tool_name: "Bash",
    session_id: sessionId,
    transcript_path: transcript,
    tool_input: { command }
  });
  await say("Removing the build output.");
  assert.equal(bash("npm test", "s4").status, 0, "a harmless command is not gated");
  const noWayBack = bash("rm build/out.js", "s4");
  assert.equal(noWayBack.status, 2);
  assert.match(noWayBack.stderr, /ROLLBACK:/);
  // The hard rules come first: this one is refused for being irreversible.
  assert.match(bash("rm -rf build", "s4").stderr, /rm -rf/);
  await say("ROLLBACK: rebuild with npm run build");
  assert.equal(bash("rm build/out.js", "s4").status, 0);

  // Without a transcript the gate cannot see the answer, so it does not ask.
  const blind = runHook(projectRoot, "guard.mjs", ["file"], { tool_name: "Edit", session_id: "s5", tool_input: { file_path: "index.js", new_string: "x" } });
  assert.equal(blind.status, 0);
});

test("a policy full of slow rules costs the guard one deadline, not one budget per rule", async (t) => {
  const { projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  // Written by hand, which is the case the budget exists for: upsert_policy_rule
  // refuses this pattern, and .ai-dev/policy.json is a file anyone can edit.
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  const slowRules = Array.from({ length: 30 }, (_, index) => ({
    id: `slow-${index}`,
    event: "bash",
    pattern: "(a|a)+$",
    action: "warn",
    message: "slow rule",
    enabled: true
  }));
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []), ...slowRules] }, null, 2));

  const started = Date.now();
  const answered = runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command: `echo ${"a".repeat(40)}!` } });
  const elapsed = Date.now() - started;
  assert.equal(answered.status, 0);
  // Thirty per-rule budgets are 8.7 seconds measured, and the client abandons a
  // hook at ten.
  assert.ok(elapsed < 5_000, `the guard should answer near its deadline, took ${elapsed} ms`);
  const context = JSON.parse(answered.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
  const unchecked = /(\d+) rule\(s\) were never matched/.exec(context);
  assert.ok(unchecked, `the guard should say how many rules it never reached: ${context}`);
  assert.ok(Number(unchecked[1]) > 0);
  assert.match(context, /slow-/, "and name some of them");

  // The same policy without the catastrophic patterns is unaffected: the
  // deadline bounds the damage, it does not ration honest rules.
  const honest = slowRules.map((rule) => ({ ...rule, pattern: `never-matches-${rule.id}` }));
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []), ...honest] }, null, 2));
  const fast = runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command: "echo hello" } });
  assert.equal(fast.status, 0);
  assert.doesNotMatch(JSON.parse(fast.stdout || "{}").hookSpecificOutput?.additionalContext ?? "", /were never matched|was not evaluated/);
});

test("rules a thread could not start for are said to be the machine's doing, not a rule's", async (t) => {
  const { root, projectRoot } = await fixture(t);
  // A hook pack whose threads get one millisecond to start, which no thread does: the busy machine, made certain.
  const busyHooks = path.join(root, "busy-hooks");
  await fs.cp(hooksSourceDir, busyHooks, { recursive: true });
  const lib = path.join(busyHooks, "lib.mjs");
  const source = await fs.readFile(lib, "utf8");
  assert.match(source, /^export const POLICY_MATCH_START_MS = 3000;$/m);
  await fs.writeFile(lib, source.replace(/^export const POLICY_MATCH_START_MS = 3000;$/m, "export const POLICY_MATCH_START_MS = 1;"));
  await installAgentHooks({ projectRoot, hooksSourceDir: busyHooks, targets: ["claude"], profile: "standard" });
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  const rule = { id: "no-deploy", event: "bash", pattern: "deploy-prod", action: "block", message: "Deploys go through CI.", enabled: true };
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []), rule] }, null, 2));
  const answered = runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command: "./deploy-prod.sh" } });
  assert.equal(answered.status, 0, "a rule that never ran cannot block");
  const context = JSON.parse(answered.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
  // The default policy's own rule is among them.
  assert.match(context, /\[policy\] 2 rule\(s\) were not matched: this machine is so busy that the thread matching them did not start within 1 ms\. Not evaluated: block-prod-migrations, no-deploy\. Nothing is wrong with the rules; this command went unchecked by them\./);
  assert.doesNotMatch(context, /was not evaluated: matching its pattern took longer|A rule ahead of them/, "neither the rule nor the rules ahead of it are blamed");
});

test("a thread that fails is said to have failed, in one line for every rule it left, not taken for a slow pattern or a busy machine", async (t) => {
  const { root, projectRoot } = await fixture(t);
  const head = 'const { parentPort, workerData } = require("node:worker_threads");';
  // Hook packs whose match thread throws, or exits, before it says ready.
  for (const [name, failure, reason] of [["throws", 'throw new Error("boom");', "boom"], ["exits", "process.exit(0);", "the match worker exited before it answered"]]) {
    const brokenHooks = path.join(root, `broken-hooks-${name}`);
    await fs.cp(hooksSourceDir, brokenHooks, { recursive: true });
    const lib = path.join(brokenHooks, "lib.mjs");
    const source = await fs.readFile(lib, "utf8");
    assert.ok(source.includes(head));
    await fs.writeFile(lib, source.replace(head, failure));
    await installAgentHooks({ projectRoot, hooksSourceDir: brokenHooks, targets: ["claude"], profile: "standard" });
    const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
    const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    const rule = { id: "no-deploy", event: "bash", pattern: "deploy-prod", action: "block", message: "Deploys go through CI.", enabled: true };
    const more = Array.from({ length: 30 }, (_, index) => ({ id: `rule-${index}`, event: "bash", pattern: `deploy-${index}`, action: "block", message: "m", enabled: true }));
    await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []).filter((entry) => !/^(no-deploy|rule-\d+)$/.test(entry.id)), rule, ...more] }, null, 2));
    const answered = runHook(projectRoot, "guard.mjs", ["bash"], { tool_name: "Bash", tool_input: { command: "./deploy-prod.sh" } });
    assert.equal(answered.status, 0, "a rule that never ran cannot block");
    const context = JSON.parse(answered.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
    // The default policy's own rule is among them. Before, a line per rule, and a thread made and lost for each.
    assert.equal(context.split("\n").filter((line) => /thread matching (it|them) failed/.test(line)).length, 1, context);
    assert.ok(context.includes(`[policy] 32 rule(s) were not evaluated: the thread matching them failed (${reason}). Not evaluated: block-prod-migrations, no-deploy, rule-0, rule-1, rule-2, and 27 more. Nothing here says the pattern is wrong in any of them; this command went unchecked by them.`), context);
    assert.doesNotMatch(context, /took longer|did not start within/, `${name}: neither the pattern nor a busy machine is blamed`);
  }
});

test("a thread the permission model refuses is named in the line, its own full stop not doubled after it", async (t) => {
  const { projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  const rule = { id: "no-env-edit", event: "file", pattern: "\\.env", action: "block", message: "Not the env file.", enabled: true };
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []), rule] }, null, 2));
  // Node run with --permission and without --allow-worker makes no thread: "… Use --allow-worker to manage permissions."
  const answered = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", "--allow-fs-write=*", path.join(projectRoot, ".ai-dev", "hooks", "guard.mjs"), "file"], {
    cwd: projectRoot,
    input: JSON.stringify({ cwd: projectRoot, tool_name: "Write", tool_input: { file_path: "notes.md", content: "hello" } }),
    encoding: "utf8",
    env: { ...process.env, AI_DEV_STATE_ROOT: path.join(projectRoot, "..", "state") },
    timeout: 20_000,
    windowsHide: true
  });
  assert.equal(answered.status, 0, answered.stderr);
  const context = JSON.parse(answered.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /\[policy\] 3 rule\(s\) were not evaluated: the thread matching them failed \(Access to this API has been restricted\. Use --allow-worker to manage permissions\)\. Not evaluated: warn-eval, warn-inner-html, no-env-edit\. Nothing here says the pattern is wrong in any of them; this write went unchecked by them\./);
  assert.doesNotMatch(context, /\.\)\./, "no full stop before the closing bracket and another after it");
});

test("a write the rules could not check is called a write", async (t) => {
  const { root, projectRoot } = await fixture(t);
  const busyHooks = path.join(root, "busy-hooks");
  await fs.cp(hooksSourceDir, busyHooks, { recursive: true });
  const lib = path.join(busyHooks, "lib.mjs");
  const source = await fs.readFile(lib, "utf8");
  await fs.writeFile(lib, source.replace(/^export const POLICY_MATCH_START_MS = 3000;$/m, "export const POLICY_MATCH_START_MS = 1;"));
  await installAgentHooks({ projectRoot, hooksSourceDir: busyHooks, targets: ["claude"], profile: "standard" });
  const policyPath = path.join(projectRoot, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  const rule = { id: "no-env-edit", event: "file", pattern: "\\.env", action: "block", message: "Not the env file.", enabled: true };
  await fs.writeFile(policyPath, JSON.stringify({ ...policy, rules: [...(policy.rules ?? []), rule] }, null, 2));
  const answered = runHook(projectRoot, "guard.mjs", ["file"], { tool_name: "Write", tool_input: { file_path: "notes.md", content: "hello" } });
  assert.equal(answered.status, 0);
  const context = JSON.parse(answered.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
  // The default policy's own file rules are among them.
  assert.match(context, /Not evaluated: [^.]*no-env-edit\. Nothing is wrong with the rules; this write went unchecked by them\./);
  assert.doesNotMatch(context, /this command went unchecked/);
});

test("the git hook reads the server's own rules and the diff the same way", async () => {
  assert.deepEqual(gitHookSettings({}), { pre_commit: "block", pre_push: "warn" });
  assert.deepEqual(gitHookSettings({ git_hooks: { pre_commit: "warn", pre_push: "block" } }), { pre_commit: "warn", pre_push: "block" });
  assert.deepEqual(gitHookSettings({ git_hooks: { pre_commit: "shout" } }), { pre_commit: "block", pre_push: "warn" }, "an unknown mode falls back");

  // The hook cannot import the server, so it carries its own copy of the diff
  // reader. This is what keeps the copy honest.
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,0 +2,2 @@",
    "+added two",
    "+added three",
    "diff --git a/old.js b/old.js",
    "--- a/old.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone"
  ].join("\n");
  assert.deepEqual([...hookParseAddedLines(diff)], [...parseAddedLines(diff)]);

  const patterns = renderHookPatterns();
  const rules = {
    secretFile: new RegExp(patterns.secret_file, "i"),
    placeholder: new RegExp(patterns.placeholder_value, "i"),
    secrets: patterns.secrets.filter((item) => item.severity === "block").map((item) => ({ ...item, regex: new RegExp(item.source, item.flags) })),
    leftovers: patterns.leftovers.filter((item) => item.severity === "block").map((item) => ({ ...item, regex: new RegExp(item.source, item.flags) }))
  };
  const staged = new Map([
    ["src/a.js", [
      { line: 1, text: "<<<<<<< HEAD" },
      { line: 4, text: "  debugger;" },
      { line: 7, text: `const key = "${["AKIA", "B".repeat(16)].join("")}";` },
      { line: 9, text: [["pass", "word"].join(""), " = ", "\"correct-horse-battery\""].join("") },
      { line: 11, text: [["pass", "word"].join(""), " = ", "\"REPLACE_ME\""].join("") }
    ]],
    ["app/main.py", [{ line: 3, text: "  breakpoint()" }, { line: 5, text: "  debugger;" }]],
    [".env", []]
  ]);
  const found = scanStaged(staged, rules);
  const byRule = found.map((item) => `${item.file}:${item.line} ${item.rule}`);
  assert.ok(byRule.includes("src/a.js:1 merge_conflict_marker"));
  assert.ok(byRule.includes("src/a.js:4 debugger_statement"));
  assert.ok(byRule.includes("src/a.js:7 secret:aws_access_key"));
  assert.ok(byRule.includes("src/a.js:9 secret:generic_secret_assignment"));
  assert.ok(!byRule.includes("src/a.js:11 secret:generic_secret_assignment"), "a placeholder is not a secret");
  assert.ok(byRule.includes("app/main.py:3 breakpoint_call"));
  assert.ok(!byRule.some((item) => item.startsWith("app/main.py:5")), "a JavaScript rule does not read Python");
  assert.ok(byRule.includes(".env:0 secret_file_in_change_set"));
  assert.deepEqual(scanStaged(new Map([["src/ok.js", [{ line: 1, text: "export const ok = 1;" }]]]), rules), []);

  assert.equal(verificationReminder(null), "");
  assert.match(verificationReminder({ id: "task-1", verifications: [] }), /no recorded verification/);
  assert.match(verificationReminder({ id: "task-1", verifications: [{ id: "v1", passed: false }] }), /\(v1\) failed/);
  assert.equal(verificationReminder({ id: "task-1", verifications: [{ id: "v1", passed: false }, { id: "v2", passed: true }] }), "");
});

test("targets git point core.hooksPath at stubs that refuse a bad commit", async (t) => {
  const { projectRoot } = await fixture(t);
  const dry = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["git"], profile: "standard", dryRun: true });
  assert.ok(dry.planned.includes(".ai-dev/git-hooks/pre-commit"));
  assert.ok(dry.planned.includes(`git config core.hooksPath ${GIT_HOOKS_RELATIVE_DIR}`));
  // `git config --get` exits 1 for a key nobody set, so this one is read directly.
  const hooksPath = () => spawnSync("git", ["-C", projectRoot, "config", "--get", "core.hooksPath"], { encoding: "utf8", windowsHide: true, shell: false }).stdout.trim();
  assert.equal(hooksPath(), "", "a dry run changes nothing");

  const installed = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["git"], profile: "standard" });
  assert.ok(installed.written.includes(".ai-dev/git-hooks/pre-push"));
  assert.equal(hooksPath(), GIT_HOOKS_RELATIVE_DIR);
  if (process.platform !== "win32") {
    const stat = await fs.stat(path.join(projectRoot, ".ai-dev", "git-hooks", "pre-commit"));
    assert.equal(stat.mode & 0o111, 0o111, "git only runs a hook it can execute");
  }
  const status = await agentHooksStatus(projectRoot);
  assert.deepEqual(status.git_hooks, { "pre-commit": true, "pre-push": true });
  assert.equal(status.git_hooks_active, true);
  assert.equal(status.core_hooks_path, GIT_HOOKS_RELATIVE_DIR);

  const commit = (message) => spawnSync("git", ["-C", projectRoot, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message], { encoding: "utf8", windowsHide: true, shell: false });
  await fs.writeFile(path.join(projectRoot, "conflict.js"), "<<<<<<< HEAD\nexport const a = 1;\n");
  runGit(projectRoot, ["add", "conflict.js"]);
  const refused = commit("feat: conflicted");
  assert.notEqual(refused.status, 0, "the pre-commit stub ran and refused");
  assert.match(refused.stderr, /merge_conflict_marker/);

  await fs.writeFile(path.join(projectRoot, "conflict.js"), "export const a = 1;\n");
  runGit(projectRoot, ["add", "conflict.js"]);
  assert.equal(commit("feat: clean").status, 0, "a clean staged change commits");

  // A hooks path someone else chose is reported, never taken over.
  runGit(projectRoot, ["config", "core.hooksPath", ".githooks"]);
  const foreign = await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["git"], profile: "standard" });
  assert.ok(foreign.warnings.some((line) => line.includes(".githooks")));
  assert.equal(hooksPath(), ".githooks");
  assert.equal((await agentHooksStatus(projectRoot)).git_hooks_active, false);
});

test("session-end leaves an observation log the server can turn into instinct proposals", async (t) => {
  const { root, projectRoot } = await fixture(t);
  await installAgentHooks({ projectRoot, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const transcript = path.join(root, "transcript.jsonl");
  const assistant = (...content) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
  const said = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  const failed = (id, text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text }] }] } });
  await fs.writeFile(transcript, [
    said("Split the router out of the entry point"),
    assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }),
    assistant({ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }),
    said("No, never edit the generated client by hand"),
    assistant({ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }),
    assistant({ type: "tool_use", id: "t4", name: "Edit", input: { file_path: "src/router.mjs" } }),
    assistant({ type: "tool_use", id: "t5", name: "Bash", input: { command: "node build.mjs" } }),
    failed("t5", "Error: Cannot find module '/repo/dist/a.js'"),
    assistant({ type: "tool_use", id: "t6", name: "Bash", input: { command: "node build.mjs" } }),
    failed("t6", "Error: Cannot find module '/repo/dist/b.js'"),
    assistant({ type: "tool_use", id: "t7", name: "Bash", input: { command: "npm ci" } })
  ].join("\n") + "\n");

  const result = runHook(projectRoot, "session-end.mjs", [], { session_id: "s-9", transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);

  // The hook writes the log beside the draft, under the name the server reads.
  const sessionsRoot = path.join(root, "state", "sessions");
  const [scopeKey] = await fs.readdir(sessionsRoot);
  const logPath = path.join(sessionsRoot, scopeKey, observationsFileName("s-9"));
  const log = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.equal(log.session_id, "s-9");
  assert.equal(log.project_path, projectRoot);
  assert.ok(log.events.length >= 10);
  // A tool_result turn is the harness speaking, so it is an error event and not
  // a user message.
  assert.deepEqual(log.events.filter((event) => event.k === "user").map((event) => event.t), [
    "Split the router out of the entry point",
    "No, never edit the generated client by hand"
  ]);
  assert.deepEqual(log.events.filter((event) => event.k === "error").map((event) => event.c), ["node build.mjs", "node build.mjs"]);

  const { proposals } = proposeInstincts({ events: log.events, projectName: "project" });
  const kinds = proposals.map((item) => item.kind);
  assert.ok(kinds.includes("correction"), `no correction in ${kinds.join(", ")}`);
  assert.ok(kinds.includes("repeated_command"));
  assert.equal(proposals.find((item) => item.kind === "resolved_error").action, "run `npm ci`");
});

test("hooks fired in a package of a monorepo keep the workspace's policy, secrets, protected configs, stop checks and formatter", async (t) => {
  const { root } = await fixture(t);
  const repo = path.join(root, "mono");
  const web = path.join(repo, "apps", "web");
  await fs.mkdir(path.join(web, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), "{\"name\":\"root\",\"private\":true,\"workspaces\":[\"apps/*\"]}\n");
  await fs.writeFile(path.join(web, "package.json"), "{\"name\":\"web\"}\n");
  await fs.writeFile(path.join(web, "tsconfig.json"), "{}\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  await installAgentHooks({ projectRoot: repo, hooksSourceDir, targets: ["claude"], profile: "standard" });
  const policyFile = path.join(repo, ".ai-dev", "policy.json");
  const policy = JSON.parse(await fs.readFile(policyFile, "utf8"));
  policy.rules = [{ id: "no-prod-deploy", event: "bash", pattern: "deploy --prod", action: "block", message: "never deploy to prod from an agent" }];
  await fs.writeFile(policyFile, JSON.stringify(policy));
  // A formatter installed at the root, as a hoisted monorepo has it.
  const marker = path.join(root, "formatted.txt");
  if (process.platform !== "win32") {
    await fs.mkdir(path.join(repo, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", ".bin", "prettier"), `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o755 });
  }
  const inPackage = (script, args, payload) => runHook(repo, script, args, { ...payload, cwd: web });

  const deploy = inPackage("guard.mjs", ["bash"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run deploy --prod" } });
  assert.equal(deploy.status, 2, deploy.stderr);
  assert.match(deploy.stderr, /never deploy to prod from an agent/);
  const key = ["AKIA", "B".repeat(16)].join("");
  const secret = inPackage("guard.mjs", ["file"], { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(web, "src", "k.js"), content: `const k = "${key}";` } });
  assert.equal(secret.status, 2, secret.stderr);
  const config = inPackage("guard.mjs", ["file"], { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(web, "tsconfig.json"), new_string: "{\"strict\":false}" } });
  assert.equal(config.status, 2, config.stderr);
  assert.match(config.stderr, /tsconfig\.json is a linter\/formatter\/type-checker config/);

  await fs.writeFile(path.join(web, "src", "app.js"), "export function f() {\n  console.log(\"left\");\n  debugger;\n}\n");
  const stop = inPackage("stop-check.mjs", [], { hook_event_name: "Stop", session_id: "s1" });
  assert.match(stop.stderr, /WARNING: console\.log in apps\/web\/src\/app\.js/);
  assert.match(stop.stderr, /WARNING: debugger in apps\/web\/src\/app\.js/);

  if (process.platform !== "win32") {
    inPackage("post-edit.mjs", [], { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(web, "src", "app.js") } });
    assert.match(await fs.readFile(marker, "utf8"), /apps\/web\/src\/app\.js/, "the root's formatter ran on the package's file");
  }
});

test("a hook finds the open task whose project holds its directory, the nearest first", async (t) => {
  const { root } = await fixture(t);
  const state = path.join(root, "state");
  const repo = path.join(root, "mono");
  const web = path.join(repo, "apps", "web");
  await fs.mkdir(path.join(state, "tasks"), { recursive: true });
  const task = (id, projectPath, status = "active", updated = "2026-10-12T00:00:00Z") => fs.writeFile(path.join(state, "tasks", `${id}.json`),
    JSON.stringify({ id, status, task: id, updated_at: updated, project: { path: projectPath } }));
  const { activeTaskFor, openTasksFor } = await import(`../../hooks/lib.mjs?tasks=${Date.now()}`);
  const previous = process.env.AI_DEV_STATE_ROOT;
  process.env.AI_DEV_STATE_ROOT = state;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_DEV_STATE_ROOT;
    else process.env.AI_DEV_STATE_ROOT = previous;
  });
  await task("repo-task", repo);
  assert.equal(activeTaskFor(web)?.id, "repo-task", "a task begun for the repository covers its packages");
  await task("web-task", web, "verified");
  await task("api-task", path.join(repo, "apps", "api"));
  await task("done-task", web, "completed");
  assert.equal(activeTaskFor(web)?.id, "web-task", "the package's own task is nearer");
  assert.deepEqual(openTasksFor(web).map((record) => record.id), ["web-task", "repo-task"]);
  assert.deepEqual(openTasksFor(repo).map((record) => record.id), ["repo-task"], "a package's task does not cover the repository");
  assert.equal(activeTaskFor(path.join(root, "elsewhere")), null);
  assert.equal(activeTaskFor(`${repo}-sibling`), null, "a sibling whose name starts with the project's is not inside it");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as hookLib from "../../hooks/lib.mjs";
import {
  DEFAULT_MATCH_BUDGET_MS,
  DEFAULT_WORKER_START_MS,
  MAX_MATCH_INPUT,
  clampMatchInput,
  matchOneWithBudget,
  matchWithBudget,
  riskyPatternProbes
} from "./regex-budget.mjs";

// A pattern the heuristic in policy-rules.mjs does not see
// (the quantifier is over an alternation, not over another quantifier), and it
// takes 38.8 seconds against twenty-eight characters.
const CATASTROPHIC = "(a|a)+$";
const CATASTROPHIC_INPUT = `${"a".repeat(40)}!`;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("an honest pattern answers, and its answer is the engine's", async () => {
  const answers = await matchWithBudget([
    { pattern: "git\\s+push\\s+--force", flags: "i", haystack: "GIT  PUSH --force origin main" },
    { pattern: "git\\s+push\\s+--force", flags: "i", haystack: "git push --force-with-lease" },
    { pattern: "\\bdrop\\s+table\\b", flags: "i", haystack: "select 1" }
  ]);
  assert.deepEqual(answers.map((answer) => answer.matched), [true, true, false]);
  assert.deepEqual(answers.map((answer) => answer.timed_out), [false, false, false]);
  assert.deepEqual(answers.map((answer) => answer.error), ["", "", ""]);
});

test("a pattern that backtracks catastrophically is cut off at the budget", async () => {
  const started = process.hrtime.bigint();
  const answer = await matchOneWithBudget({ pattern: CATASTROPHIC, flags: "i", haystack: CATASTROPHIC_INPUT, budgetMs: 200 });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(answer.timed_out, true);
  assert.equal(answer.matched, null);
  assert.match(answer.error, /did not finish within 200 ms/);
  // Without the budget this is 38.8 seconds. The ceiling here is the budget
  // plus worker startup plus the slack a loaded CI box needs.
  assert.ok(elapsed < 4000, `the match should be abandoned promptly, took ${Math.round(elapsed)} ms`);
});

test("the jobs behind a timed-out one are still evaluated", async () => {
  const answers = await matchWithBudget([
    { pattern: "alpha", flags: "i", haystack: "alpha" },
    { pattern: CATASTROPHIC, flags: "i", haystack: CATASTROPHIC_INPUT },
    { pattern: "omega", flags: "i", haystack: "omega" },
    { pattern: CATASTROPHIC, flags: "i", haystack: CATASTROPHIC_INPUT },
    { pattern: "zeta", flags: "i", haystack: "nothing here" }
    // The batch deadline is stated rather than inherited, so that this test
    // measures what it claims and not the deadline, which the next test covers.
  ], { budgetMs: 150, deadlineMs: 5000 });
  assert.deepEqual(answers.map((answer) => answer.matched), [true, null, true, null, false]);
  assert.deepEqual(answers.map((answer) => answer.timed_out), [false, true, false, true, false]);
});

test("one deadline covers the whole batch, and the jobs it cuts off say so", async () => {
  const slow = { pattern: CATASTROPHIC, flags: "i", haystack: CATASTROPHIC_INPUT };
  const jobs = [...Array.from({ length: 8 }, () => slow), { pattern: "omega", flags: "i", haystack: "omega" }];
  const started = process.hrtime.bigint();
  const answers = await matchWithBudget(jobs, { budgetMs: 150, deadlineMs: 600 });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  // Eight budgets would be 1.2 seconds before worker startup is counted; the
  // deadline is what the caller actually waits for.
  assert.ok(elapsed < 2500, `the batch should end near its deadline, took ${Math.round(elapsed)} ms`);
  assert.equal(answers.length, jobs.length, "every job gets an answer either way");
  const ran = answers.filter((answer) => answer.checked);
  const cut = answers.filter((answer) => !answer.checked);
  assert.ok(ran.length >= 1 && cut.length >= 1, `the deadline should stop the batch part-way, ran ${ran.length}`);
  assert.ok(ran.every((answer) => answer.timed_out), "the jobs that ran are the slow ones");
  for (const answer of cut) {
    assert.equal(answer.matched, null);
    assert.equal(answer.timed_out, false, "never run is not the same as too slow");
    assert.equal(answer.not_run, "deadline");
    assert.match(answer.error, /600 ms deadline passed before this match was run/);
  }
});

test("a worker's startup is charged to no pattern: budgets and a deadline far below it still answer, in both copies", async () => {
  // A worker takes tens of milliseconds to start; these matches take microseconds once it has. Before the fix both
  // copies answered none of twenty such calls: the startup ran out the first job's budget.
  const jobs = [{ pattern: "alpha", flags: "", haystack: "alpha" }, { pattern: "omega", flags: "", haystack: "alpha" }];
  const server = await matchWithBudget(jobs, { budgetMs: 5, deadlineMs: 5 });
  assert.deepEqual(server.map((answer) => [answer.checked, answer.matched, answer.timed_out]), [[true, true, false], [true, false, false]]);
  const hooks = await hookLib.matchWithBudget(jobs, { budgetMs: 5, deadlineMs: 5 });
  assert.deepEqual(hooks, [{ matched: true, checked: true }, { matched: false, checked: true }]);
});

test("a worker that cannot start within its allowance runs nothing, and the answers say the machine is busy, not the pattern slow", async () => {
  assert.equal(DEFAULT_WORKER_START_MS, 3000);
  assert.equal(hookLib.POLICY_MATCH_START_MS, DEFAULT_WORKER_START_MS, "the hooks' copy starts its workers under the same allowance");
  const jobs = [{ pattern: "alpha", haystack: "alpha" }, { pattern: "beta", haystack: "beta" }];
  // No worker is ready within a millisecond.
  const server = await matchWithBudget(jobs, { startMs: 1 });
  for (const answer of server) {
    assert.deepEqual([answer.checked, answer.matched, answer.timed_out, answer.not_run], [false, null, false, "start"]);
    assert.match(answer.error, /^no match worker could start within 1 ms — the machine is too busy — so this match was not run$/);
  }
  assert.deepEqual(await hookLib.matchWithBudget(jobs, { startMs: 1 }), [
    { matched: null, checked: false, not_run: "start" },
    { matched: null, checked: false, not_run: "start" }
  ]);
});

test("a worker that fails, rather than starts slowly, is answered as run with its error, in both copies", () => {
  // Under --permission without --allow-worker no thread can be made: a failure, not a busy machine. The hooks' copy
  // used to call that a slow start and leave every rule behind it unrun, where the server's copy moves on.
  const modules = [path.join(serverRoot, "src", "core", "regex-budget.mjs"), path.join(serverRoot, "hooks", "lib.mjs")]
    .map((file) => pathToFileURL(file).href);
  const script = `const jobs = [{ pattern: "alpha", flags: "", haystack: "alpha" }, { pattern: "beta", flags: "", haystack: "beta" }];
const [server, hooks] = await Promise.all(${JSON.stringify(modules)}.map((url) => import(url)));
console.log(JSON.stringify({ server: await server.matchWithBudget(jobs), hooks: await hooks.matchWithBudget(jobs) }));`;
  const run = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${serverRoot}`, "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const { server, hooks } = JSON.parse(run.stdout);
  for (const answer of server) {
    assert.deepEqual([answer.checked, answer.matched, answer.not_run], [true, null, undefined]);
    assert.match(answer.error, /--allow-worker/);
  }
  assert.equal(hooks.length, 2);
  for (const answer of hooks) {
    assert.deepEqual([answer.checked, answer.matched, answer.not_run], [true, null, undefined], JSON.stringify(hooks));
    assert.match(answer.error, /--allow-worker/);
  }
});

test("a worker that fails before it is ready answers every job left with one reason, from one thread, the same in both copies", async (t) => {
  // Each copy loaded with a match worker that fails before it says ready — it throws, throws with no message, or
  // exits. Every worker made first marks the file every job's haystack names, so the file counts the threads.
  // Before, both copies made a thread per job (30 rules: 1.9 s in the guard), the server took an empty message for a
  // worker that never started, and nothing held the hooks' exit path.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "regex-budget-failing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const head = 'const { parentPort, workerData } = require("node:worker_threads");';
  const counted = 'const { workerData } = require("node:worker_threads"); require("node:fs").appendFileSync(workerData.jobs[0].haystack, "w"); ';
  const cases = [
    ["throws", 'throw new Error("boom");', "boom"],
    ["throws-without-a-message", 'throw new Error("");', "Error"],
    ["exits", "process.exit(0);", "the match worker exited before it answered"],
    // Odd things thrown: each copy reads them with the same expression, and says the same of each.
    ["throws-null", "throw null;", "it gave no reason"],
    ["throws-zero", "throw 0;", "it gave no reason"],
    ["throws-blanks", 'throw "  ";', "it gave no reason"],
    ["throws-a-blank-error", 'throw new Error(" ");', "it gave no reason"],
    ["throws-a-string", 'throw " out of threads. ";', "out of threads."],
    ["throws-a-symbol", 'throw Symbol("s");', "Symbol(s)"],
    ["throws-an-object", 'throw { message: "" };', "[object Object]"],
    ["throws-a-message", 'throw { message: " no thread. " };', "no thread."]
  ];
  for (const [name, failure, reason] of cases) {
    const said = {};
    for (const [copy, relative] of [["server", path.join("src", "core", "regex-budget.mjs")], ["hooks", path.join("hooks", "lib.mjs")]]) {
      const source = await fs.readFile(path.join(serverRoot, relative), "utf8");
      assert.ok(source.includes(head), `${relative} starts its match worker the way this test replaces`);
      const module = path.join(root, `${name}-${copy}.mjs`);
      await fs.writeFile(module, source.replace(head, `${counted}${failure}`));
      const threads = path.join(root, `${name}-${copy}.threads`);
      const { matchWithBudget: match } = await import(pathToFileURL(module).href);
      const answers = await match(Array.from({ length: 12 }, (_, index) => ({ pattern: `p${index}`, flags: "i", haystack: threads })));
      assert.equal(answers.length, 12);
      for (const answer of answers) {
        assert.deepEqual([answer.checked, answer.matched, answer.error, answer.not_run], [true, null, reason, undefined], `${copy}, ${name}: ${JSON.stringify(answer)}`);
      }
      assert.equal(await fs.readFile(threads, "utf8"), "w", `${copy}, ${name}: one thread for the batch, not one per job`);
      said[copy] = answers;
    }
    assert.deepEqual(said.server.map((answer) => answer.error), said.hooks.map((answer) => answer.error), `${name}: both copies give one reason`);
  }
});

test("a worker that exits on a job answers that job with the reason, and the jobs behind it from a fresh worker, in both copies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "regex-budget-exiting-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const line = "matched = new RegExp(job.pattern, job.flags).test(job.haystack);";
  for (const [copy, relative] of [["server", path.join("src", "core", "regex-budget.mjs")], ["hooks", path.join("hooks", "lib.mjs")]]) {
    const source = await fs.readFile(path.join(serverRoot, relative), "utf8");
    assert.equal(source.split(line).length, 2, `${relative} matches a job the way this test replaces`);
    // Ready, then gone in the middle of the batch: the worker exits on the job named "exit".
    const module = path.join(root, `${copy}.mjs`);
    await fs.writeFile(module, source.replace(line, `if (job.pattern === "exit") process.exit(0);\n    ${line}`));
    const { matchWithBudget: match } = await import(pathToFileURL(module).href);
    const answers = await match([{ pattern: "alpha", flags: "", haystack: "alpha" }, { pattern: "exit", flags: "", haystack: "x" }, { pattern: "omega", flags: "", haystack: "alpha" }]);
    assert.deepEqual(answers.map((answer) => [answer.checked, answer.matched, answer.error ?? ""]), [[true, true, ""], [true, null, "the match worker exited before it answered"], [true, false, ""]], copy);
  }
});

test("an honest batch is not touched by the deadline, however many jobs it holds", async () => {
  const jobs = Array.from({ length: 200 }, (_, index) => ({
    pattern: "rm\\s+-rf\\s+/",
    flags: "i",
    haystack: index % 2 === 0 ? "rm -rf /tmp/x" : "npm test"
  }));
  const answers = await matchWithBudget(jobs, { budgetMs: 150, deadlineMs: 600 });
  assert.ok(answers.every((answer) => answer.checked), "no honest job goes unchecked");
  assert.deepEqual(answers.map((answer) => answer.matched), jobs.map((_, index) => index % 2 === 0));
});

test("a pattern that does not compile is an error, not a throw", async () => {
  const answer = await matchOneWithBudget({ pattern: "[unclosed", flags: "i", haystack: "x" });
  assert.equal(answer.matched, null);
  assert.equal(answer.timed_out, false);
  assert.match(answer.error, /Unterminated character class/);
});

test("input is clamped before the engine sees it", async () => {
  const clamped = clampMatchInput("x".repeat(MAX_MATCH_INPUT + 10));
  assert.equal(clamped.text.length, MAX_MATCH_INPUT);
  assert.equal(clamped.truncated, true);
  assert.equal(clamped.length, MAX_MATCH_INPUT + 10);
  assert.deepEqual(clampMatchInput(undefined), { text: "", truncated: false, length: 0 });
  assert.equal(clampMatchInput("abcdef", 0).text.length, 6, "a limit that is not a positive number falls back to the default");

  const answers = await matchWithBudget([{ pattern: "needle", flags: "", haystack: `${"h".repeat(40)}needle` }], { maxInput: 20 });
  assert.equal(answers[0].matched, false, "the needle was past the clamp");
  assert.equal(answers[0].truncated, true);
});

test("an empty batch costs nothing and answers nothing", async () => {
  assert.deepEqual(await matchWithBudget([]), []);
  assert.deepEqual(await matchWithBudget(null), []);
  assert.ok(DEFAULT_MATCH_BUDGET_MS > 0);
});

test("the probes are built from the pattern's own alphabet, with a tail it cannot match", () => {
  const probes = riskyPatternProbes(CATASTROPHIC, { length: 12 });
  assert.ok(probes.includes("a".repeat(12)));
  assert.ok(probes.includes(`${"a".repeat(12)}!`), "the blocking tail is what forces the exhaustive search");
  assert.ok(probes.includes("0".repeat(12)), "the class seeds cover patterns with no literals of their own");
  assert.equal(riskyPatternProbes("(a|a)+$", { length: 0 })[0].length, 48, "a nonsense length falls back to the default");

  const shell = riskyPatternProbes("git\\s+push\\s+--force", { length: 10 });
  assert.match(shell[0], /^[gitpush\-force]+$/, "escapes and whitespace classes do not reach the probe");
  assert.ok(riskyPatternProbes("[^a-z]+", { length: 6 }).every((probe) => probe.length >= 6));
  assert.ok(riskyPatternProbes("\\d{2,}", { length: 6 })[0].length >= 6, "a pattern with no literals still gets a probe");
});

test("a probe exposes the patterns the nested-quantifier heuristic misses", async () => {
  // Both forms known to pass the structural check.
  for (const pattern of [CATASTROPHIC, "(\\w|\\d)+$"]) {
    const probes = riskyPatternProbes(pattern);
    const answers = await matchWithBudget(probes.map((haystack) => ({ pattern, flags: "i", haystack })), { budgetMs: 200 });
    assert.ok(answers.some((answer) => answer.timed_out), `${pattern}: at least one probe must blow the budget`);
  }

  // Every pattern the existing policy tests and the default policy rely on.
  const honest = [
    "git\\s+push\\s+(?:[^|;]*\\s)?--force(?!-with-lease)",
    "\\beval\\s*\\(",
    "\\.innerHTML\\s*=|dangerouslySetInnerHTML",
    "(migrate|migration).*(--prod|production)|prisma\\s+migrate\\s+deploy",
    "deploy\\s+--env\\s+prod",
    "^tests/.*\\nconst token",
    "(^|/)(\\.env(?!\\.(?:example|sample|template|dist)$)(?:\\.[^/]+)?|[^/]*\\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$"
  ];
  for (const pattern of honest) {
    const answers = await matchWithBudget(riskyPatternProbes(pattern).map((haystack) => ({ pattern, flags: "i", haystack })));
    assert.deepEqual(answers.map((answer) => answer.timed_out), answers.map(() => false), `${pattern}: an honest rule must not be caught by the probe`);
  }
});

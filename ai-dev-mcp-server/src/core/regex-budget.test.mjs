import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MATCH_BUDGET_MS,
  MAX_MATCH_INPUT,
  clampMatchInput,
  matchOneWithBudget,
  matchWithBudget,
  riskyPatternProbes
} from "./regex-budget.mjs";

// The pattern from Д-16: the heuristic in policy-rules.mjs does not see it
// (the quantifier is over an alternation, not over another quantifier), and it
// takes 38.8 seconds against twenty-eight characters.
const CATASTROPHIC = "(a|a)+$";
const CATASTROPHIC_INPUT = `${"a".repeat(40)}!`;

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
  ], { budgetMs: 150 });
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
    assert.match(answer.error, /600 ms deadline passed before this match was run/);
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
  // Both forms named in Д-16 as passing the structural check.
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

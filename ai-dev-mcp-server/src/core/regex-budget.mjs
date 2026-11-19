/**
 * Running a regular expression under a time budget.
 *
 * Node has no way to interrupt a match in progress: `RegExp.prototype.test` is
 * a synchronous call into the engine, and a pattern that backtracks
 * catastrophically holds the thread until it finishes. Measured on this
 * repository: `(a|a)+$` against twenty-eight `a` and a `!` takes 38.8 seconds.
 * One such rule in `.ai-dev/policy.json`
 * stalls the guard on every Bash command and every file write.
 *
 * A worker thread *can* be terminated, so that is what this module does: the
 * match runs in a worker, the caller gets a budget, and a job that outlives it
 * comes back as `timed_out` instead of never coming back. The protection does
 * not depend on recognising a dangerous pattern — no pattern gets more than the
 * budget, whatever it looks like. {@link riskyPatternProbes} is the other half,
 * used when a rule is written rather than when it fires: it builds adversarial
 * input from the pattern's own alphabet so a rule that would blow the budget
 * later can be refused now.
 *
 * The cost is one worker per call — roughly 40 ms of startup, paid once for a
 * whole batch of jobs, and not paid at all for an empty batch. Startup is the
 * machine's cost, not a pattern's, and it is never charged to one: see
 * {@link DEFAULT_WORKER_START_MS}.
 */
import { Worker } from "node:worker_threads";

/** How long one match may take before the worker running it is killed. */
export const DEFAULT_MATCH_BUDGET_MS = 250;

/**
 * How long a whole batch gets, however many jobs it holds.
 *
 * The per-job budget bounds one rule; it does not bound an event. Thirty rules
 * that each overstay cost thirty budgets — measured on this repository, thirty
 * `(a|a)+$` rules held the guard for 8.7 seconds and the client abandons a hook
 * at ten. So the batch has a deadline of its
 * own: when it passes, the jobs behind it come back unchecked instead of being
 * run, and the caller reports them rather than paying for them.
 *
 * It also bounds the worker churn. A stuck worker can only be stopped by
 * killing it, so every overrun costs a fresh thread; the deadline caps that at
 * four or five per batch.
 */
export const DEFAULT_MATCH_DEADLINE_MS = 1000;

/**
 * How long the worker threads of one batch may take to start, all of them
 * together.
 *
 * On a busy machine a thread can take longer to start than a pattern's whole
 * budget. Charged to the first job, that startup made an honest pattern
 * `timed_out` and its `block` rule let the command through: under 32 busy
 * loops on 4 cores the guard let a forbidden command through 27 times in 30,
 * telling the user to fix a pattern that had never run. So startup has its own
 * allowance and the deadline counts matching
 * only: a busy machine slows a check down instead of switching rules off.
 * Together the two still end an event well inside the ten seconds a client
 * gives a hook.
 */
export const DEFAULT_WORKER_START_MS = 3000;

/**
 * The longest input a budgeted match is given. Backtracking grows with input
 * length, so this is the second limit: it does not make an exponential pattern
 * safe (twenty-eight characters were enough), but it keeps an honest pattern on
 * a megabyte of file content linear in something small.
 */
export const MAX_MATCH_INPUT = 4096;

// CommonJS on purpose: with `eval: true` Node decides the module kind by
// sniffing the source, and a string with no import/export is a CommonJS module
// in every version that runs this server. The source is a constant — nothing
// from the caller is ever spliced into it, only passed as workerData.
const MATCH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.postMessage({ ready: true });
for (const job of workerData.jobs) {
  let matched = null;
  let error = "";
  try {
    matched = new RegExp(job.pattern, job.flags).test(job.haystack);
  } catch (cause) {
    error = String((cause && cause.message) || cause);
  }
  parentPort.postMessage({ matched, error });
}
parentPort.postMessage({ done: true });
`;

/**
 * Cut an input down to what a budgeted match will see.
 *
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {{ text: string, truncated: boolean, length: number }}
 */
export function clampMatchInput(text, limit = MAX_MATCH_INPUT) {
  const source = String(text ?? "");
  const ceiling = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_MATCH_INPUT;
  return { text: source.slice(0, ceiling), truncated: source.length > ceiling, length: source.length };
}

// Why a worker failed, in words that are never empty: a worker that throws
// `new Error("")` has failed all the same. The hooks' copy reads a failure with
// this same expression, so both say the same of one.
function failureReason(cause) {
  return String((cause && cause.message) || cause || "").trim() || "it gave no reason";
}

// One worker, jobs in order, resolved as soon as a job outlives the budget.
// Until the worker says `ready` it is only starting up: that has its own
// ceiling, `startMs`, and a worker that does not start within it comes back
// `notStarted` with no job charged. The per-job timer starts on `ready`.
// `startupMs` is how long the start took. A worker
// that cannot be made, errors or exits comes back `failed`, with its reason in
// `error` — told from a slow start by the flag, never by the reason's text.
function runBatch(jobs, budgetMs, startMs) {
  return new Promise((resolve) => {
    const results = [];
    const created = Date.now();
    let startupMs = null;
    let settled = false;
    let timer = null;
    let worker = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve({ results, startupMs: startupMs ?? Date.now() - created, notStarted: startupMs === null, ...outcome });
    };
    const fail = (cause) => finish({ timedOutAt: -1, failed: true, error: failureReason(cause) });
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ timedOutAt: results.length, failed: false, error: "" }), budgetMs);
    };
    try {
      worker = new Worker(MATCH_WORKER_SOURCE, { eval: true, workerData: { jobs } });
    } catch (cause) {
      fail(cause);
      return;
    }
    worker.on("message", (message) => {
      if (message?.ready) {
        startupMs = Date.now() - created;
        arm();
        return;
      }
      if (message?.done) {
        finish({ timedOutAt: -1, failed: false, error: "" });
        return;
      }
      results.push({ matched: message?.matched ?? null, error: String(message?.error ?? "") });
      arm();
    });
    worker.on("error", fail);
    worker.on("exit", () => fail("the match worker exited before it answered"));
    timer = setTimeout(() => finish({ timedOutAt: -1, failed: false, error: "" }), startMs);
  });
}

/**
 * Match a batch of `{ pattern, flags, haystack }` jobs, each under its own
 * budget and all of them under one deadline. Every job gets an answer:
 *
 * - `checked: true` — the job ran. `matched` is the answer, or `null` with
 *   `timed_out: true` when it outlived its own budget; the jobs behind it are
 *   still evaluated, in a fresh worker, because terminating the first one is
 *   the only way to stop the match it was stuck in. `matched: null` with an
 *   `error` and no `timed_out` is a worker that failed on the job: one that
 *   failed before it was ready answers every job left with that error.
 * - `checked: false` — never run: the batch's deadline passed before this
 *   job's turn (`not_run: "deadline"`), or no worker could start for it within
 *   the start allowance (`not_run: "start"` — the machine is too busy, not the
 *   pattern too slow). The caller says so instead of paying for it.
 *
 * The deadline counts the time the jobs run, not the time workers take to
 * start; that has its own allowance, `startMs`, for the whole batch.
 *
 * @param {Array<{ pattern: string, flags?: string, haystack?: string }>} jobs
 * @param {{ budgetMs?: number, deadlineMs?: number, startMs?: number, maxInput?: number }} [options]
 * @returns {Promise<Array<{ matched: boolean | null, checked: boolean, timed_out: boolean, error: string, truncated: boolean, not_run?: "deadline" | "start" }>>}
 */
export async function matchWithBudget(jobs, {
  budgetMs = DEFAULT_MATCH_BUDGET_MS,
  deadlineMs = DEFAULT_MATCH_DEADLINE_MS,
  startMs = DEFAULT_WORKER_START_MS,
  maxInput = MAX_MATCH_INPUT
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return [];
  const prepared = list.map((job) => {
    const clamped = clampMatchInput(job?.haystack, maxInput);
    return {
      pattern: String(job?.pattern ?? ""),
      flags: String(job?.flags ?? ""),
      haystack: clamped.text,
      truncated: clamped.truncated
    };
  });
  const answers = new Array(prepared.length).fill(null);
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEFAULT_MATCH_DEADLINE_MS;
  const startAllowance = Number.isFinite(startMs) && startMs > 0 ? startMs : DEFAULT_WORKER_START_MS;
  let matching = 0;
  let starting = 0;
  let notRun = "deadline";
  let offset = 0;
  while (offset < prepared.length) {
    // What is left of the deadline is also the ceiling for the next job: the
    // last job of a batch may not overrun the batch.
    const left = deadline - matching;
    if (left <= 0) break;
    if (startAllowance - starting <= 0) {
      notRun = "start";
      break;
    }
    const began = Date.now();
    const { results, timedOutAt, failed, error, startupMs, notStarted } = await runBatch(prepared.slice(offset), Math.min(budgetMs, left), startAllowance - starting);
    starting += startupMs;
    matching += Math.max(0, Date.now() - began - startupMs);
    if (notStarted && !failed) {
      notRun = "start";
      break;
    }
    if (notStarted) {
      // A worker that failed before it was ready ran none of these jobs, and the
      // next one would fail the same way: every job left is answered with its
      // error, instead of a thread made and lost per job.
      for (let index = offset; index < prepared.length; index += 1) {
        answers[index] = { matched: null, checked: true, timed_out: false, error, truncated: prepared[index].truncated };
      }
      break;
    }
    for (let index = 0; index < results.length && offset + index < prepared.length; index += 1) {
      answers[offset + index] = {
        matched: results[index].matched,
        checked: true,
        timed_out: false,
        error: results[index].error,
        truncated: prepared[offset + index].truncated
      };
    }
    const stuck = timedOutAt >= 0 ? offset + timedOutAt : offset + results.length;
    if (stuck >= prepared.length) break;
    answers[stuck] = {
      matched: null,
      checked: true,
      timed_out: timedOutAt >= 0,
      error: timedOutAt >= 0 ? `the match did not finish within ${budgetMs} ms` : (error || "the match worker stopped early"),
      truncated: prepared[stuck].truncated
    };
    offset = stuck + 1;
  }
  return answers.map((answer, index) => answer ?? {
    matched: null,
    checked: false,
    timed_out: false,
    error: notRun === "start"
      ? `no match worker could start within ${startAllowance} ms — the machine is too busy — so this match was not run`
      : `the batch's ${deadline} ms deadline passed before this match was run`,
    truncated: prepared[index].truncated,
    not_run: notRun
  });
}

/**
 * Match one pattern under a budget.
 *
 * @param {{ pattern: string, flags?: string, haystack?: string, budgetMs?: number, maxInput?: number }} job
 * @returns {Promise<{ matched: boolean | null, timed_out: boolean, error: string, truncated: boolean }>}
 */
export async function matchOneWithBudget({ pattern, flags = "", haystack = "", budgetMs, maxInput } = {}) {
  const [answer] = await matchWithBudget([{ pattern, flags, haystack }], { budgetMs, maxInput });
  return answer ?? { matched: null, checked: false, timed_out: false, error: "the match was never run", truncated: false };
}

// Literal characters a pattern is built from, with escapes, classes, groups and
// operators folded away. `(a|a)+$` yields "a"; `git\s+push\s+--force` yields
// "gitpush-force".
function patternAlphabet(pattern) {
  const folded = String(pattern ?? "")
    .replace(/\\[dDwWsSbBnrtfv0]/g, "")
    .replace(/\\u\{[^}]*\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\[\^?([^\]]*)\]/g, "$1")
    .replace(/\{\d+(?:,\d*)?\}/g, "")
    .replace(/[()|?*+^$.]/g, "");
  const seen = [];
  for (const char of folded) {
    if (!/\s/.test(char) && !seen.includes(char)) seen.push(char);
  }
  return seen.join("");
}

/**
 * Seed alphabets a probe run is built from. The pattern's own literal
 * characters come first, then three that cover what character classes overlap
 * on: `(\w|\d)+$` is catastrophic on digits and linear on letters, so a probe
 * made only of the pattern's literals (it has none) would miss it.
 */
const PROBE_SEEDS = ["0", "a", "a0_"];

/**
 * Inputs built to make a pattern backtrack as hard as it can: long runs of
 * characters the pattern can match, each also given a tail the pattern cannot
 * match. The tail is what turns a quantified alternation such as `(a|a)+$` from
 * a fast match into an exhaustive search, because every split of the run has to
 * fail in turn before the match gives up.
 *
 * This is a probe, not an analysis — it is how a bad pattern is caught when a
 * rule is *written*, so the author hears about it instead of the guard stalling
 * later. The guard's own safety comes from the budget, not from this list.
 *
 * @param {string} pattern
 * @param {{ length?: number }} [options]
 * @returns {string[]}
 */
export function riskyPatternProbes(pattern, { length = 48 } = {}) {
  const span = Number.isFinite(length) && length > 0 ? Math.floor(length) : 48;
  const seeds = [patternAlphabet(pattern), ...PROBE_SEEDS].filter(Boolean);
  const probes = new Set();
  for (const seed of seeds) {
    const run = seed.repeat(Math.ceil(span / seed.length)).slice(0, span);
    const blocker = ["!", "~", "Z"].find((candidate) => !seed.includes(candidate)) ?? "!";
    probes.add(run);
    probes.add(`${run}${blocker}`);
  }
  return [...probes];
}

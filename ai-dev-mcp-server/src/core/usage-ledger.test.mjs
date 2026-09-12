import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  RATE_TABLE,
  RATE_TABLE_SOURCE,
  HISTORICAL_MODELS,
  UsageLedger,
  isHistoricalModel,
  estimateCostUsd,
  mergeRateTable,
  normalizeModelId,
  resolveModelRates,
  usageHintsFromArgs
} from "./usage-ledger.mjs";

// A made-up table: these tests are about the arithmetic and the lookup, not
// about what Anthropic charges this week. The published numbers are checked
// separately, in one place, against the row they were read from.
const FIXTURE_RATES = {
  "model-a": { input: 10, output: 100, cache_read: 0.5 },
  "model-b": { input: 4, output: 20 }
};

/** Local midnight `daysAgo` days before `base`, the way the report slices days. */
function localMidnight(base, daysAgo = 0) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysAgo);
  return start;
}

function at(base, daysAgo, hour) {
  return new Date(localMidnight(base, daysAgo).getTime() + hour * 3_600_000).toISOString();
}

test("usage ledger records tool calls and usage, then aggregates a report", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const project = path.join(stateRoot, "project");

  await ledger.recordToolCall({ tool: "begin_task", ok: true, durationMs: 120, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "verify_task", ok: false, durationMs: 900, taskId: "task-1", projectPath: project, error: "quality gate failed" });
  await ledger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 300, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "search_knowledge", ok: true, durationMs: 10 });
  await ledger.recordUsage({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 200, costUsd: 0.05, taskId: "task-1", projectPath: project, turns: 3 });
  await ledger.recordUsage({ model: "claude-sonnet-5", inputTokens: 500, outputTokens: 50, costUsd: 0.01, taskId: "task-2", projectPath: project });
  await assert.rejects(ledger.recordUsage({ model: "x" }), /needs input_tokens/);

  const all = await ledger.report();
  assert.equal(all.events, 6);
  assert.equal(all.tool_calls, 4);
  assert.equal(all.tools[0].tool, "verify_task");
  assert.equal(all.tools[0].failures, 1);
  assert.equal(all.tools[0].failure_rate, 0.5);
  assert.equal(all.tools[0].average_ms, 600);
  assert.equal(all.slowest_tools[0].tool, "verify_task");
  assert.equal(all.usage.input_tokens, 1500);
  assert.equal(all.usage.cost_usd, 0.06);
  assert.equal(all.models.length, 2);

  const task = await ledger.report({ taskId: "task-1" });
  assert.equal(task.events, 4);
  assert.equal(task.tasks[0].tool_calls, 3);
  assert.equal(task.tasks[0].cost_usd, 0.05);

  const scoped = await ledger.report({ projectPath: project });
  assert.equal(scoped.events, 5, "events without a project path are excluded from a project report");

  const future = await ledger.report({ since: "2999-01-01T00:00:00.000Z" });
  assert.equal(future.events, 0);
  assert.deepEqual(usageHintsFromArgs({ task_id: "t", project_path: "/p", other: 1 }), { taskId: "t", projectPath: "/p" });
  assert.deepEqual(usageHintsFromArgs({ task_id: 5 }), { taskId: "", projectPath: "" });
});

test("usage ledger prunes to the newest lines when the file grows past the cap", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-prune-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot, maxBytes: 600, keepLines: 5 });
  for (let index = 0; index < 12; index += 1) {
    await ledger.recordToolCall({ tool: `tool_${index}`, ok: true, durationMs: index });
  }
  const events = await ledger.readEvents();
  assert.ok(events.length <= 6 && events.length >= 1, `unexpected ${events.length} events after prune`);
  assert.equal(events.at(-1).tool, "tool_11");
  await fs.writeFile(ledger.filePath, "not json\n{\"kind\":\"tool_call\",\"tool\":\"kept\",\"ok\":true,\"at\":\"2026-01-01T00:00:00.000Z\"}\n");
  const report = await ledger.report();
  assert.equal(report.events, 1);
});

test("cost estimation prices a turn from the rate table", () => {
  // Cache prices a row leaves out come from the multipliers; a row that states
  // one (as Claude Fable 5.1 does for cache reads) keeps its own number.
  const derived = resolveModelRates("model-b", FIXTURE_RATES);
  assert.equal(derived.cache_write, 4 * CACHE_WRITE_MULTIPLIER);
  assert.equal(derived.cache_write_1h, 8);
  assert.equal(derived.cache_read, 4 * CACHE_READ_MULTIPLIER);
  assert.equal(resolveModelRates("model-a", FIXTURE_RATES).cache_read, 0.5);

  // 1M input at $10 + 0.5M output at $100 + 0.2M cache writes at $12.50
  // + 4M cache reads at $0.50.
  assert.equal(estimateCostUsd({
    model: "model-a",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheCreationTokens: 200_000,
    cacheReadTokens: 4_000_000
  }, FIXTURE_RATES), 64.5);
  assert.equal(estimateCostUsd({ model: "model-b", inputTokens: 250_000 }, FIXTURE_RATES), 1);
  assert.equal(estimateCostUsd({ model: "model-b", inputTokens: -5, outputTokens: "nonsense" }, FIXTURE_RATES), 0);

  // An unknown model stays unpriced: a report that names it is honest, a report
  // that charges it at a neighbour's price is not.
  assert.equal(estimateCostUsd({ model: "model-z", inputTokens: 1_000_000 }, FIXTURE_RATES), null);
  assert.equal(estimateCostUsd({ inputTokens: 10 }, FIXTURE_RATES), null);
  assert.equal(resolveModelRates("", FIXTURE_RATES), null);
  assert.equal(resolveModelRates("model-a", { "model-a": { input: 1 } }), null, "a row without both base prices is not a rate");
});

test("model ids are matched across the dialects clients report them in", () => {
  assert.equal(normalizeModelId(" Model-A[1m] "), "model-a");
  assert.equal(normalizeModelId("us.anthropic.model-b"), "model-b");
  assert.equal(normalizeModelId("anthropic.model-b-v1:0"), "model-b");
  assert.equal(normalizeModelId("model-b@20260101"), "model-b-20260101");
  assert.equal(normalizeModelId(undefined), "");

  // A dated snapshot falls back to its dateless row; a new family member does
  // not borrow the price of the model whose name it starts with.
  assert.equal(resolveModelRates("model-b-20260101", FIXTURE_RATES).matched, "model-b");
  assert.equal(resolveModelRates("model-b@20260101", FIXTURE_RATES).input, 4);
  assert.equal(resolveModelRates("model-b-1", FIXTURE_RATES), null);
});

test("policy overrides replace, add and reject rate rows", () => {
  const { table, applied, rejected } = mergeRateTable({
    "Model-A": { input: 12, output: 120 },
    "model-c": { input: 1, output: 2, cache_write: 3, cache_read: 0.01 },
    "model-d": { input: "free" },
    "": { input: 1, output: 1 }
  }, FIXTURE_RATES);
  assert.deepEqual(applied, ["model-a", "model-c"]);
  assert.deepEqual(rejected, ["", "model-d"]);
  assert.equal(table["model-a"].input, 12);
  assert.equal(table["model-a"].cache_read, 1.2, "an override that omits cache prices falls back to the multipliers");
  assert.equal(table["model-c"].cache_write, 3);
  assert.equal(table["model-b"].input, 4, "rows nobody overrode are untouched");
  assert.deepEqual(mergeRateTable(null, FIXTURE_RATES).applied, []);
  assert.equal(mergeRateTable("nonsense", FIXTURE_RATES).table["model-b"].output, 20);
});

test("the published rate table is the one that was read from the pricing page", () => {
  // One pinned row per price shape, so a typo in the table fails here rather
  // than quietly mispricing a month of usage. Source and date: RATE_TABLE_SOURCE.
  assert.match(RATE_TABLE_SOURCE.checked_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(RATE_TABLE_SOURCE.url, "https://platform.claude.com/docs/en/about-claude/pricing");
  assert.deepEqual(RATE_TABLE["claude-opus-5"], { input: 5, output: 25 });
  const opus = resolveModelRates("claude-opus-5");
  assert.equal(opus.cache_write, 6.25);
  assert.equal(opus.cache_read, 0.5);
  // Claude Fable 5.1 reads cache at 0.025x, not the usual 0.1x.
  assert.equal(resolveModelRates("claude-fable-5-1").cache_read, 0.25);
  assert.equal(resolveModelRates("claude-sonnet-5").output, 10);
  assert.equal(resolveModelRates("claude-haiku-4-5-20251001").input, 1);
  assert.equal(estimateCostUsd({ model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }), 30);
});

test("the report slices today, yesterday and the last seven days, and prices what the client did not", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-periods-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const now = new Date();
  const usage = (when, model, extra = {}) => JSON.stringify({
    at: when,
    kind: "usage",
    model,
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    task_id: "task-1",
    ...extra
  });
  await fs.mkdir(path.dirname(ledger.filePath), { recursive: true });
  await fs.writeFile(ledger.filePath, [
    usage(at(now, 0, 9), "model-a"),
    // What the client billed wins over the table: 10x the tokens, 1 cent.
    usage(at(now, 0, 10), "model-b", { input_tokens: 10_000_000, cost_usd: 0.01 }),
    usage(at(now, 0, 11), "model-z"),
    usage(at(now, 1, 9), "model-b"),
    usage(at(now, 8, 9), "model-b"),
    JSON.stringify({ at: at(now, 0, 12), kind: "tool_call", tool: "verify_task", ok: true, duration_ms: 10, task_id: "task-1" }),
    JSON.stringify({ at: "not a date", kind: "usage", model: "model-a", input_tokens: 1_000_000 }),
    ""
  ].join("\n"));

  const report = await ledger.report({ rates: FIXTURE_RATES, now });
  assert.equal(report.usage.events, 6);
  assert.equal(report.periods.today.events, 4, "three usage events and one tool call");
  assert.equal(report.periods.today.tool_calls, 1);
  assert.equal(report.periods.today.cost_usd, 10.01, "$10 estimated for model-a plus the cent the client reported");
  assert.equal(report.periods.today.estimated_cost_usd, 10);
  assert.equal(report.periods.today.reported_cost_usd, 0.01);
  assert.equal(report.periods.yesterday.events, 1);
  assert.equal(report.periods.yesterday.cost_usd, 4);
  assert.equal(report.periods.last_7_days.cost_usd, 14.01, "the event eight days back is outside the window");
  assert.equal(report.periods.last_7_days.input_tokens, 13_000_000);

  // Models are ranked by spend over everything the filter kept, windows aside:
  // model-a's second event carries a timestamp no window can place.
  const [top] = report.models;
  assert.equal(top.model, "model-a");
  assert.equal(top.cost_usd, 20);
  assert.equal(top.events, 2);
  const modelB = report.models.find((row) => row.model === "model-b");
  assert.equal(modelB.cost_usd, 8.01);
  assert.equal(modelB.reported_cost_usd, 0.01);
  assert.equal(modelB.rate_usd_per_mtok.input, 4);
  assert.deepEqual(report.rates.unpriced_models, ["model-z"], "an unpriced model is named, not silently counted as free");
  assert.equal(report.models.find((row) => row.model === "model-z").rate_usd_per_mtok, null);
  assert.equal(report.rates.source.url, RATE_TABLE_SOURCE.url);
  assert.equal(report.tasks[0].task_id, "task-1");
  assert.equal(report.tasks[0].tool_calls, 1);
  assert.equal(report.tasks[0].cost_usd, 18.01, "everything but the event that carries no task id");
  assert.equal(report.usage.cost_usd, 28.01);
});


// prune_state rotates the ledger on a schedule rather than waiting for the
// byte ceiling, which a project that stays small never reaches.
test("the ledger can be rotated to a line count, and says what a rotation would do", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-rotate-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  for (let index = 0; index < 12; index += 1) {
    await ledger.recordToolCall({ tool: `tool-${index}`, ok: true, durationMs: 1 });
  }
  await ledger.flush();

  assert.deepEqual(await ledger.rotationPlan(5), { lines: 12, kept: 5, removed: 7 });
  assert.deepEqual((await ledger.readEvents()).length, 12, "the plan changes nothing");

  assert.deepEqual(await ledger.rotate(5), { lines: 12, kept: 5, removed: 7 });
  const kept = await ledger.readEvents();
  assert.deepEqual(kept.map((event) => event.tool), ["tool-7", "tool-8", "tool-9", "tool-10", "tool-11"]);

  // A rotation that has nothing to remove leaves the file alone.
  assert.deepEqual(await ledger.rotate(5), { lines: 5, kept: 5, removed: 0 });
  assert.deepEqual((await ledger.readEvents()).length, 5);

  // A ledger that was never written answers rather than throwing.
  const empty = new UsageLedger({ stateRoot: path.join(stateRoot, "nowhere") });
  assert.deepEqual(await empty.rotationPlan(10), { lines: 0, kept: 0, removed: 0 });
  assert.deepEqual(await empty.rotate(10), { lines: 0, kept: 0, removed: 0 });
});


// Д-8. The prices of retired models were read from a page that no longer lists
// them, so nothing re-verifies them. They stay in the table because a ledger
// keeps old events, and they are marked so a total that rests on them says so.
test("a model the price page no longer lists is priced, marked and reported apart", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-historical-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const project = path.join(stateRoot, "project");

  await ledger.recordUsage({ model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 0, projectPath: project });
  await ledger.recordUsage({ model: "claude-opus-4-1", inputTokens: 1_000_000, outputTokens: 0, projectPath: project });
  await ledger.flush();

  const report = await ledger.report({ projectPath: project });
  // Every total still carries both: dropping the retired model's cost would
  // make the total wrong in the other direction, and silently.
  assert.equal(report.usage.cost_usd, 20, "5 for opus-5 plus 15 for opus-4-1");
  assert.equal(report.usage.historical_cost_usd, 15, "and this much of it cannot be re-checked");

  // The breakdown, though, does not mix a verified price with an unverifiable one.
  assert.deepEqual(report.models.map((row) => row.model), ["claude-opus-5"]);
  assert.deepEqual(report.models[0].price_basis, "published");
  assert.deepEqual(report.historical_models.map((row) => row.model), ["claude-opus-4-1"]);
  assert.equal(report.historical_models[0].price_basis, "historical");
  assert.equal(report.historical_models[0].historical_cost_usd, 15);
  assert.deepEqual(report.rates.historical_models, ["claude-opus-4-1"]);
  assert.match(report.rates.notice, /^claude-opus-4-1 is priced from rates https:\/\/.* no longer lists/);
  assert.match(report.rates.notice, /usage\.historical_cost_usd is how much of the total rests on them/);

  // A caller who wants one list says so.
  const folded = await ledger.report({ projectPath: project, includeHistoricalModels: true });
  assert.deepEqual(folded.models.map((row) => row.model), ["claude-opus-4-1", "claude-opus-5"]);
  assert.equal("historical_models" in folded, false);
  assert.equal(folded.usage.historical_cost_usd, 15);
});

test("a report with no retired model says nothing about them", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-current-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const project = path.join(stateRoot, "project");
  await ledger.recordUsage({ model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0, projectPath: project });
  await ledger.flush();
  const report = await ledger.report({ projectPath: project });
  assert.equal(report.usage.historical_cost_usd, 0);
  assert.deepEqual(report.historical_models, []);
  assert.deepEqual(report.rates.historical_models, []);
  assert.equal("notice" in report.rates, false);
});

test("the historical list is exactly the models the price page dropped", () => {
  assert.deepEqual(HISTORICAL_MODELS, [
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-opus-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-haiku-3-5"
  ]);
  for (const model of HISTORICAL_MODELS) {
    assert.ok(RATE_TABLE[model], `${model} is marked historical but has no price`);
    assert.equal(isHistoricalModel(model), true);
  }
  // The current models are not touched: their prices are the verified ones.
  for (const model of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
    assert.equal(isHistoricalModel(model), false, model);
  }
  // Every dialect normalizeModelId understands lands on the same answer.
  assert.equal(isHistoricalModel("us.anthropic.claude-opus-4-1"), true);
  assert.equal(isHistoricalModel("claude-opus-4-5@20251101"), true);
  assert.equal(isHistoricalModel("claude-opus-5[1m]"), false);
  assert.equal(isHistoricalModel(""), false);
  assert.equal(isHistoricalModel(undefined), false);
});

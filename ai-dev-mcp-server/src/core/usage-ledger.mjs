import fs from "node:fs/promises";
import path from "node:path";
import { atomicAppendFile, atomicWriteFile } from "./atomic-files.mjs";

export const USAGE_EVENT_KINDS = ["tool_call", "usage"];
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const KEEP_LINES_AFTER_PRUNE = 20_000;

function now() {
  return new Date().toISOString();
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

/**
 * Where the prices below come from, and when they were read. Prices change, so
 * the table is data: `.ai-dev/policy.json` can override any row (see
 * {@link mergeRateTable}) without waiting for a release.
 */
export const RATE_TABLE_SOURCE = {
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checked_on: "2026-09-11"
};

/**
 * Prompt-caching multipliers on the base input price, from the same page:
 * a 5-minute cache write costs 1.25x, a 1-hour write 2x, and a cache hit 0.1x.
 * A model whose published cache price is not the multiplier (Claude Fable 5.1
 * and Claude Mythos 5.1 read cache at 0.025x) carries that price explicitly in
 * {@link RATE_TABLE}; for every other row the derived number is the published
 * one.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Models the published price page no longer lists, with the price this table
 * carries for them.
 *
 * Their rows were read from {@link RATE_TABLE_SOURCE} while each model was
 * current, and the page has since dropped them — so `checked_on` does not cover
 * them and nothing re-verifies them (docs/ecc-upgrades/DEBTS.md, Д-8). They
 * stay in the table because a ledger keeps old events and a report over last
 * quarter has to price what actually ran; they are marked so a total that
 * leans on them says so, and they are kept out of the per-model breakdown
 * unless a caller asks for them.
 */
export const HISTORICAL_MODELS = Object.freeze([
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-3-5"
]);

/**
 * Whether a model's price in this table is a historical one: read once, from a
 * page that no longer carries it.
 *
 * A dated snapshot resolves to its dateless row, the same way
 * {@link resolveModelRates} resolves it. The answer is about this table's own
 * row, so a project that overrides the price in `.ai-dev/policy.json` still
 * sees the mark — what it marks is where the default came from.
 *
 * @param {string} model - Any dialect {@link normalizeModelId} understands.
 * @returns {boolean}
 */
export function isHistoricalModel(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return false;
  return HISTORICAL_MODELS.includes(normalized) || HISTORICAL_MODELS.includes(normalized.replace(/-\d{8}$/, ""));
}

/**
 * USD per million tokens, keyed by Claude API model id. `input` and `output`
 * are the published base prices; `cache_write` (5-minute TTL) and `cache_read`
 * are derived from the multipliers above unless a row states them.
 *
 * Read from {@link RATE_TABLE_SOURCE} on the date recorded there. The rows in
 * {@link HISTORICAL_MODELS} are the exception: the page no longer lists those
 * models, so their prices are what it said while they were current.
 */
export const RATE_TABLE = {
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cache_read: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-3-5": { input: 0.8, output: 4 }
};

function positivePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Fill the cache prices a row leaves to the multipliers. */
function completeRates(entry) {
  const input = positivePrice(entry?.input);
  const output = positivePrice(entry?.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cache_write: positivePrice(entry?.cache_write) ?? round(input * CACHE_WRITE_MULTIPLIER),
    cache_write_1h: positivePrice(entry?.cache_write_1h) ?? round(input * CACHE_WRITE_1H_MULTIPLIER),
    cache_read: positivePrice(entry?.cache_read) ?? round(input * CACHE_READ_MULTIPLIER)
  };
}

/**
 * The model id as the rate table spells it. Transcripts and runners report the
 * same model in several dialects: a context-window suffix (`claude-opus-5[1m]`),
 * a Bedrock vendor or region prefix (`us.anthropic.claude-opus-5`), a Vertex
 * `@`-separated snapshot (`claude-opus-4-5@20251101`).
 *
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelId(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "")
    .replace("@", "-")
    .replace(/-v\d+:\d+$/, "");
}

/**
 * Prices for a model, or null when the table does not know it. A dated snapshot
 * (`claude-haiku-4-5-20251001`) falls back to its dateless row; anything else
 * unknown stays unpriced on purpose — a report that says "these models have no
 * rate" is honest, a report that guesses a neighbouring model's price is not.
 *
 * @param {string} model
 * @param {Record<string, object>} [table]
 * @returns {{ model: string, matched: string, input: number, output: number, cache_write: number, cache_write_1h: number, cache_read: number } | null}
 */
export function resolveModelRates(model, table = RATE_TABLE) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  const candidates = [normalized, normalized.replace(/-\d{8}$/, "")];
  for (const candidate of candidates) {
    const rates = completeRates(table?.[candidate]);
    if (rates) return { model: normalized, matched: candidate, ...rates };
  }
  return null;
}

/**
 * What a turn cost at list prices, or null when the model has no rate. Used
 * only where the client reported none: a client-reported cost is what was
 * actually billed, an estimate is arithmetic over published prices.
 *
 * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number }} usage
 * @param {Record<string, object>} [table]
 * @returns {number | null}
 */
export function estimateCostUsd(usage = {}, table = RATE_TABLE) {
  const rates = resolveModelRates(usage.model, table);
  if (!rates) return null;
  const priced = (tokens, perMillion) => (Math.max(0, finiteOrNull(tokens) ?? 0) / 1_000_000) * perMillion;
  return round(
    priced(usage.inputTokens, rates.input)
    + priced(usage.outputTokens, rates.output)
    + priced(usage.cacheCreationTokens, rates.cache_write)
    + priced(usage.cacheReadTokens, rates.cache_read)
  );
}

/**
 * The built-in table with per-model overrides applied, for the projects whose
 * `.ai-dev/policy.json` carries a `model_rates` block. An override may correct
 * a price that moved or add a model the table has never heard of; a row without
 * usable `input`/`output` numbers is ignored rather than half-applied.
 *
 * @param {Record<string, object>} overrides
 * @param {Record<string, object>} [base]
 * @returns {{ table: Record<string, object>, applied: string[], rejected: string[] }}
 */
export function mergeRateTable(overrides, base = RATE_TABLE) {
  const table = { ...base };
  const applied = [];
  const rejected = [];
  for (const [model, entry] of Object.entries(overrides && typeof overrides === "object" ? overrides : {})) {
    const key = normalizeModelId(model);
    const merged = completeRates({ ...(entry && typeof entry === "object" ? entry : {}) });
    if (!key || !merged) {
      rejected.push(String(model));
      continue;
    }
    table[key] = merged;
    applied.push(key);
  }
  return { table, applied: applied.sort(), rejected: rejected.sort() };
}

/** Local midnight `daysAgo` days before `now`: the boundaries of a developer's day. */
function dayBoundary(now, daysAgo = 0) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysAgo);
  return start;
}

function withinWindow(event, from, to) {
  const at = Date.parse(event?.at);
  if (!Number.isFinite(at)) return false;
  return at >= from.getTime() && (to === null || at < to.getTime());
}

/**
 * One usage event's cost, split into what the client reported and what the rate
 * table estimates. A reported cost is what was billed, so it always wins; an
 * event whose model has no rate is counted as unpriced rather than as free.
 */
function costOf(event, rates) {
  const reported = finiteOrNull(event.cost_usd) ?? 0;
  if (reported > 0) return { reported, estimated: 0, unpriced: false };
  const estimated = estimateCostUsd({
    model: event.model,
    inputTokens: event.input_tokens,
    outputTokens: event.output_tokens,
    cacheReadTokens: event.cache_read_tokens,
    cacheCreationTokens: event.cache_creation_tokens
  }, rates);
  return { reported: 0, estimated: estimated ?? 0, unpriced: estimated === null };
}

/** The prices a model row was costed at, or null when the table has no rate for it. */
function modelRateRow(model, rates) {
  const resolved = resolveModelRates(model, rates);
  if (!resolved) return null;
  const { model: _normalized, ...prices } = resolved;
  return prices;
}

function emptyUsage(extra = {}) {
  return {
    events: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    reported_cost_usd: 0,
    estimated_cost_usd: 0,
    historical_cost_usd: 0,
    duration_ms: 0,
    turns: 0,
    ...extra
  };
}

function roundCosts(row) {
  return {
    ...row,
    cost_usd: round(row.cost_usd, 4),
    reported_cost_usd: round(row.reported_cost_usd, 4),
    estimated_cost_usd: round(row.estimated_cost_usd, 4),
    historical_cost_usd: round(row.historical_cost_usd, 4)
  };
}

/** Fold a set of ledger events into per-tool, per-task, per-model and total rows. */
function accumulate(events, rates) {
  const tools = new Map();
  const tasks = new Map();
  const models = new Map();
  const unpriced = new Set();
  const historicalModels = new Set();
  const usage = emptyUsage();
  let toolCalls = 0;
  const taskRow = (taskId) => {
    const row = tasks.get(taskId) ?? emptyUsage({ task_id: taskId, tool_calls: 0, tool_failures: 0 });
    tasks.set(taskId, row);
    return row;
  };
  for (const event of events) {
    if (event.kind === "tool_call") {
      toolCalls += 1;
      const entry = tools.get(event.tool) ?? { tool: event.tool, calls: 0, failures: 0, total_ms: 0, max_ms: 0 };
      entry.calls += 1;
      if (!event.ok) entry.failures += 1;
      entry.total_ms += Number(event.duration_ms) || 0;
      entry.max_ms = Math.max(entry.max_ms, Number(event.duration_ms) || 0);
      tools.set(event.tool, entry);
      if (event.task_id) {
        const task = taskRow(event.task_id);
        task.tool_calls += 1;
        if (!event.ok) task.tool_failures += 1;
      }
    } else if (event.kind === "usage") {
      const cost = costOf(event, rates);
      if (cost.unpriced) unpriced.add(String(event.model || "unknown"));
      const historical = isHistoricalModel(event.model);
      if (historical) historicalModels.add(normalizeModelId(event.model));
      const model = models.get(event.model) ?? emptyUsage({
        model: event.model,
        rate_usd_per_mtok: modelRateRow(event.model, rates),
        price_basis: historical ? "historical" : "published"
      });
      for (const row of [usage, model, ...(event.task_id ? [taskRow(event.task_id)] : [])]) {
        row.events += 1;
        for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "duration_ms", "turns"]) {
          row[key] += Number(event[key]) || 0;
        }
        row.reported_cost_usd += cost.reported;
        row.estimated_cost_usd += cost.estimated;
        row.cost_usd += cost.reported + cost.estimated;
        // What part of this total rests on a price nobody can re-check.
        if (historical) row.historical_cost_usd += cost.reported + cost.estimated;
      }
      models.set(event.model, model);
    }
  }
  return { tools, tasks, models, usage, unpriced, historicalModels, toolCalls };
}

/**
 * Append-only JSONL ledger of MCP tool calls and client-reported model usage
 * (`~/.ai-dev/state/usage/events.jsonl`). The MCP server cannot see model
 * tokens itself; the client (or an orchestrator such as a session runner) posts
 * them through `record_usage`, while tool calls are recorded by the tool
 * dispatcher (`callTool` in `mcp-stdio.mjs`) whichever caller invoked it: the
 * MCP transport, the CLI, a smoke script, or a tool composed from other tools.
 */
export class UsageLedger {
  constructor({ stateRoot, maxBytes = MAX_LEDGER_BYTES, keepLines = KEEP_LINES_AFTER_PRUNE }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "usage", "events.jsonl");
    this.maxBytes = maxBytes;
    this.keepLines = Math.max(1, Number(keepLines) || KEEP_LINES_AFTER_PRUNE);
    this.queue = Promise.resolve();
  }

  async append(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await atomicAppendFile(this.filePath, line, "utf8");
        await this.pruneIfNeeded();
      });
    await this.queue;
    return event;
  }

  /**
   * Wait for every queued append to reach disk. Callers that record a tool call
   * without awaiting it (the tool dispatcher) use this to settle the ledger
   * before reading it back.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this.queue.catch(() => undefined);
  }

  /**
   * What a rotation would remove, without touching the file. `prune_state`
   * reports this in `dry_run` mode.
   *
   * @param {number} keepLines
   * @returns {Promise<{ lines: number, kept: number, removed: number }>}
   */
  async rotationPlan(keepLines) {
    const keep = Math.max(1, Number(keepLines) || this.keepLines);
    const text = await fs.readFile(this.filePath, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean).length;
    const kept = Math.min(lines, keep);
    return { lines, kept, removed: lines - kept };
  }

  /**
   * Keep the newest `keepLines` events and drop the rest.
   *
   * {@link pruneIfNeeded} only fires when the file passes its byte ceiling, so
   * a project that never reaches 8 MiB keeps every tool call it ever made. This
   * is the rotation `prune_state` asks for on a schedule instead.
   *
   * @param {number} keepLines
   * @returns {Promise<{ lines: number, kept: number, removed: number }>}
   */
  async rotate(keepLines) {
    const plan = await this.rotationPlan(keepLines);
    if (plan.removed <= 0) return plan;
    const lines = (await fs.readFile(this.filePath, "utf8")).split("\n").filter(Boolean);
    await atomicWriteFile(this.filePath, `${lines.slice(-plan.kept).join("\n")}\n`, "utf8");
    return plan;
  }

  async pruneIfNeeded() {
    const stats = await fs.stat(this.filePath).catch(() => null);
    if (!stats || stats.size <= this.maxBytes) return false;
    const lines = (await fs.readFile(this.filePath, "utf8")).split("\n").filter(Boolean);
    const kept = lines.slice(-this.keepLines);
    await atomicWriteFile(this.filePath, `${kept.join("\n")}\n`, "utf8");
    return true;
  }

  /**
   * Record one MCP tool invocation (name, duration, outcome, task/project hints).
   *
   * @param {{ tool: string, ok: boolean, durationMs: number, taskId?: string, projectPath?: string, error?: string, client?: string }} input
   */
  async recordToolCall({ tool, ok, durationMs, taskId = "", projectPath = "", error = "", client = "" }) {
    return this.append({
      at: now(),
      kind: "tool_call",
      tool: String(tool || ""),
      ok: Boolean(ok),
      duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      task_id: String(taskId || ""),
      project_path: String(projectPath || ""),
      error: String(error || "").slice(0, 300),
      client: String(client || "")
    });
  }

  /**
   * Record model usage reported by the client for a turn, task, or session.
   *
   * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number, costUsd?: number, durationMs?: number, turns?: number, taskId?: string, projectPath?: string, sessionId?: string, source?: string, note?: string }} input
   */
  async recordUsage(input = {}) {
    const inputTokens = finiteOrNull(input.inputTokens);
    const outputTokens = finiteOrNull(input.outputTokens);
    if (inputTokens === null && outputTokens === null && finiteOrNull(input.costUsd) === null) {
      throw new Error("record_usage needs input_tokens, output_tokens, or cost_usd.");
    }
    return this.append({
      at: now(),
      kind: "usage",
      model: String(input.model || "unknown"),
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
      cache_read_tokens: finiteOrNull(input.cacheReadTokens) ?? 0,
      cache_creation_tokens: finiteOrNull(input.cacheCreationTokens) ?? 0,
      cost_usd: finiteOrNull(input.costUsd) ?? 0,
      duration_ms: Math.max(0, Math.round(finiteOrNull(input.durationMs) ?? 0)),
      turns: Math.max(0, Math.round(finiteOrNull(input.turns) ?? 0)),
      task_id: String(input.taskId || ""),
      project_path: String(input.projectPath || ""),
      session_id: String(input.sessionId || ""),
      source: String(input.source || "client"),
      note: String(input.note || "").slice(0, 300)
    });
  }

  async readEvents() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return text.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Aggregate the ledger: per-tool call counts, failures, and latency; per-task
   * token and cost totals; per-model usage; and the today / yesterday / last
   * seven days slices, optionally filtered by project path, task id, or a start
   * timestamp.
   *
   * Cost comes from the client where the client reported one and from the rate
   * table everywhere else — the hook that reads transcripts records tokens
   * only, so that a change of prices re-prices history instead of freezing a
   * stale number into the ledger.
   *
   * @param {{ projectPath?: string, taskId?: string, since?: string, limitTools?: number, rates?: Record<string, object>, now?: Date }} [filter]
   * @returns {Promise<object>} Report.
   */
  async report({ projectPath = "", taskId = "", since = "", limitTools = 15, rates = RATE_TABLE, includeHistoricalModels = false, now = new Date() } = {}) {
    const events = (await this.readEvents()).filter((event) => {
      if (taskId && event.task_id !== taskId) return false;
      if (projectPath && event.project_path && path.resolve(event.project_path) !== path.resolve(projectPath)) return false;
      if (projectPath && !event.project_path && !taskId) return false;
      if (since && String(event.at || "") < since) return false;
      return true;
    });
    const { tools, tasks, models, usage, unpriced, historicalModels, toolCalls } = accumulate(events, rates);
    const toolRows = [...tools.values()]
      .map((item) => ({
        ...item,
        average_ms: item.calls ? Math.round(item.total_ms / item.calls) : 0,
        failure_rate: item.calls ? round(item.failures / item.calls, 4) : 0
      }))
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool))
      .slice(0, Math.max(1, Math.min(Number(limitTools) || 15, 200)));
    // Day boundaries are local ones: "today" is the developer's day, not UTC's.
    const period = (fromDays, toDays = null) => {
      const from = dayBoundary(now, fromDays);
      const to = toDays === null ? null : dayBoundary(now, toDays);
      const slice = events.filter((event) => withinWindow(event, from, to));
      const summary = accumulate(slice, rates);
      const totals = roundCosts(summary.usage);
      return {
        since: from.toISOString(),
        until: to ? to.toISOString() : null,
        events: slice.length,
        tool_calls: summary.toolCalls,
        usage_events: totals.events,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cache_read_tokens: totals.cache_read_tokens,
        cache_creation_tokens: totals.cache_creation_tokens,
        cost_usd: totals.cost_usd,
        reported_cost_usd: totals.reported_cost_usd,
        estimated_cost_usd: totals.estimated_cost_usd
      };
    };
    // The per-model breakdown leaves out the models whose prices cannot be
    // re-checked, unless the caller asks for them. Their cost stays in every
    // total — dropping it would make the total wrong in the other direction,
    // silently — and `usage.historical_cost_usd` says how much of it that is.
    const allModels = [...models.values()].map((item) => roundCosts(item))
      .sort((left, right) => right.cost_usd - left.cost_usd || left.model.localeCompare(right.model));
    const modelRows = includeHistoricalModels
      ? { models: allModels }
      : {
        models: allModels.filter((row) => row.price_basis !== "historical"),
        historical_models: allModels.filter((row) => row.price_basis === "historical")
      };
    return {
      ledger_path: this.filePath,
      events: events.length,
      filter: { project_path: projectPath || null, task_id: taskId || null, since: since || null },
      tool_calls: toolCalls,
      tools: toolRows,
      slowest_tools: [...tools.values()].sort((left, right) => right.max_ms - left.max_ms).slice(0, 5).map((item) => ({ tool: item.tool, max_ms: item.max_ms })),
      usage: roundCosts(usage),
      periods: { today: period(0), yesterday: period(1, 0), last_7_days: period(6) },
      ...modelRows,
      rates: {
        source: RATE_TABLE_SOURCE,
        priced_models: Object.keys(rates).length,
        unpriced_models: [...unpriced].sort(),
        historical_models: [...historicalModels].sort(),
        ...(historicalModels.size ? {
          notice: `${[...historicalModels].sort().join(", ")} ${historicalModels.size === 1 ? "is" : "are"} priced from rates ${RATE_TABLE_SOURCE.url} no longer lists: they were read while the model was current and are not re-verified. usage.historical_cost_usd is how much of the total rests on them.`
        } : {})
      },
      tasks: [...tasks.values()].map((item) => roundCosts(item))
        .sort((left, right) => right.cost_usd - left.cost_usd || right.tool_calls - left.tool_calls)
        .slice(0, 50)
    };
  }
}

/**
 * Pull the task id / project path hints out of tool arguments without storing
 * anything else from the call.
 *
 * @param {Record<string, unknown>} args
 * @returns {{ taskId: string, projectPath: string }}
 */
export function usageHintsFromArgs(args = {}) {
  return {
    taskId: typeof args?.task_id === "string" ? args.task_id : "",
    projectPath: typeof args?.project_path === "string" ? args.project_path : ""
  };
}

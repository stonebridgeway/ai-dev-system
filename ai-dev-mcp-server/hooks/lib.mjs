// Shared helpers for the AI Dev System agent hooks. Zero dependencies: these
// files are copied into a project's .ai-dev/hooks/ and run on the developer's
// machine by Claude Code / Cursor, possibly while the MCP server runs in Docker.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";

export const MAX_STDIN = 1024 * 1024;
export const PROFILES = ["minimal", "standard", "strict"];

export function log(message) {
  process.stderr.write(`${message}\n`);
}

export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let truncated = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (data.length >= MAX_STDIN) {
        truncated = true;
        return;
      }
      data += chunk.slice(0, MAX_STDIN - data.length);
    });
    process.stdin.on("end", () => resolve({ raw: data, truncated }));
    process.stdin.on("error", () => resolve({ raw: data, truncated }));
    setTimeout(() => resolve({ raw: data, truncated }), 2000).unref();
  });
}

/** Normalize Claude Code and Cursor payloads to one shape. */
export function normalizeInput(raw) {
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const toolInput = payload.tool_input ?? payload.args ?? {};
  return {
    payload,
    event: String(payload.hook_event_name || payload.hookName || ""),
    tool: String(payload.tool_name || payload.tool || ""),
    command: String(toolInput.command ?? payload.command ?? ""),
    filePath: String(toolInput.file_path ?? payload.file_path ?? payload.path ?? payload.file ?? ""),
    content: String(toolInput.content ?? toolInput.new_string ?? payload.new_text ?? payload.content ?? ""),
    edits: Array.isArray(toolInput.edits) ? toolInput.edits : [],
    transcriptPath: String(payload.transcript_path ?? payload.transcriptPath ?? ""),
    sessionId: String(payload.session_id ?? payload.conversation_id ?? process.env.CLAUDE_SESSION_ID ?? "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default",
    cwd: String(payload.cwd || process.cwd()),
    source: String(payload.source || "")
  };
}

export function isCursor() {
  return process.argv.includes("--cursor");
}

/** Block the tool call. Claude Code: exit 2 + stderr. Cursor: permission JSON. */
export function block(reason) {
  if (isCursor()) {
    process.stdout.write(`${JSON.stringify({ permission: "deny", userMessage: reason, agentMessage: reason })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Non-blocking note injected into the model's next turn. */
export function emitContext(eventName, text) {
  if (!text) return;
  if (isCursor()) {
    process.stdout.write(`${JSON.stringify({ additional_context: text })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })}\n`);
}

export function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function realpathOf(target) {
  try {
    // fs.realpathSync, not realpathSync.native: the server resolves roots with
    // fs.realpath (core/project-identity.mjs), and on Windows the native variant
    // also expands 8.3 short names (RUNNER~1 -> runneradmin). Two spellings of
    // one directory would key two different project ids, so the hook and the
    // server must resolve them the same way.
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}


function hashKey(key) {
  return crypto.createHash("sha256").update(process.platform === "win32" ? key.toLowerCase() : key).digest("hex").slice(0, 20);
}

export function projectRootOf(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return realpathOf(top || cwd);
}

/** Same normalization as the server's project identity: POSIX separators, case-folded on Windows. */
export function normalizePath(value) {
  const resolved = path.resolve(String(value ?? "")).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Compare two paths the way the platform does: Windows ignores case and separator style. */
export function samePath(left, right) {
  if (!left || !right) return false;
  return normalizePath(left) === normalizePath(right);
}

/** Repository-relative path with POSIX separators, whatever the platform. */
export function relativePosix(fromRoot, target) {
  return path.relative(fromRoot, target).replaceAll("\\", "/");
}

/** Same derivation as the server's resolveProjectIdentity (core/project-identity.mjs). */
export function projectIdOf(projectRoot, isGit = true) {
  return `project-${hashKey(`${isGit ? "git" : "filesystem"}:${normalizePath(projectRoot)}`)}`;
}

/**
 * Same derivation as the server's repositoryId (core/project-identity.mjs): the
 * clone's `--git-common-dir` (identical in every linked worktree) plus the
 * project's path inside its own worktree. Empty outside Git.
 */
export function repositoryIdOf(projectRoot) {
  const root = path.resolve(projectRoot);
  const commonDir = git(root, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return "";
  const canonicalCommonDir = realpathOf(path.isAbsolute(commonDir) ? commonDir : path.resolve(root, commonDir));
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  const relative = path.relative(realpathOf(toplevel || root), realpathOf(root)).replaceAll("\\", "/");
  const scope = !relative || relative.startsWith("..") ? "" : `#${relative}`;
  return `repository-${hashKey(`git-common:${normalizePath(canonicalCommonDir)}${scope}`)}`;
}

/**
 * Read order for the memory a repository shares across its worktrees: the
 * repository id first, then the project id records were written under before
 * repository ids existed. Writers use the first key and migrate the rest.
 */
export function memoryKeysOf(projectRoot, isGit = true) {
  const keys = [];
  const repository = isGit ? repositoryIdOf(projectRoot) : "";
  if (repository) keys.push(repository);
  const project = projectIdOf(projectRoot, isGit);
  if (!keys.includes(project)) keys.push(project);
  return keys;
}

export function stateRoot() {
  if (process.env.AI_DEV_STATE_ROOT) return path.resolve(process.env.AI_DEV_STATE_ROOT);
  const home = process.env.AI_DEV_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".ai-dev", "state");
}

/** Same sanitisation as the server's SessionStore.directoryFor. */
export function sessionsDirectory(key) {
  return path.join(stateRoot(), "sessions", String(key || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_"));
}

/**
 * Move handoffs a legacy key wrote into the first key's directory, so the
 * split between a worktree and its main checkout disappears on the first
 * capture. Best effort: readers merge every key anyway.
 */
export function migrateSessions(keys) {
  const [primary, ...legacy] = keys;
  if (!primary || !legacy.length) return;
  const target = sessionsDirectory(primary);
  for (const key of legacy) {
    const source = sessionsDirectory(key);
    let names = [];
    try {
      names = fs.readdirSync(source).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    if (!names.length) continue;
    fs.mkdirSync(target, { recursive: true });
    for (const name of names) {
      const destination = path.join(target, name);
      if (fs.existsSync(destination)) continue;
      try {
        fs.renameSync(path.join(source, name), destination);
      } catch {
        // Keep the legacy copy: every reader still merges both keys.
      }
    }
    try {
      fs.rmdirSync(source);
    } catch {
      // Records that could not move keep the directory alive.
    }
  }
}

export function readJson(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadPolicy(projectRoot) {
  const policy = readJson(path.join(projectRoot, ".ai-dev", "policy.json"), {}) || {};
  const patterns = readJson(path.join(projectRoot, ".ai-dev", "hooks", "patterns.json"), {}) || {};
  const envProfile = String(process.env.AI_DEV_HOOK_PROFILE || "").toLowerCase();
  const profile = PROFILES.includes(envProfile) ? envProfile : PROFILES.includes(policy.profile) ? policy.profile : "standard";
  return { ...policy, profile, patterns, rules: Array.isArray(policy.rules) ? policy.rules : [] };
}

export function hooksDisabled(hookId) {
  const flag = String(process.env.AI_DEV_HOOKS_ENABLED || "true").toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return true;
  const disabled = String(process.env.AI_DEV_DISABLED_HOOKS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return disabled.includes(hookId);
}

export function profileAllows(profile, allowed) {
  return allowed.includes(profile);
}

/** Bytes of the transcript tail scanned for the newest usage record. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Context windows we can tell apart without asking the API. */
export const CONTEXT_WINDOWS = { standard: 200_000, large: 1_000_000 };

/** Compaction advice knobs; every one is overridable from `.ai-dev/policy.json`. */
export const COMPACT_DEFAULTS = {
  tool_threshold: 50,
  tool_interval: 25,
  context_threshold: 0,
  context_thresholds: { standard: 160_000, large: 250_000 },
  context_window: 0,
  context_interval: 60_000
};

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Usage of the newest assistant message in a Claude Code transcript.
 *
 * The transcript is JSONL and append-only, so only its tail is read; the first
 * line of that tail is dropped because the slice starts mid-line. Only
 * assistant messages carry the usage of a real API call, and sidechain entries
 * (subagents) are billed against their own window, not this session's.
 *
 * @param {string} transcriptPath
 * @param {number} [tailBytes]
 * @returns {{ tokens: number, model: string, output_tokens: number } | null}
 */
export function latestAssistantUsage(transcriptPath, tailBytes = TRANSCRIPT_TAIL_BYTES) {
  if (!transcriptPath) return null;
  let text = "";
  let partialFirstLine = false;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - Math.max(1024, tailBytes));
      partialFirstLine = start > 0;
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n");
  if (partialFirstLine) lines.shift();
  for (const line of lines.reverse()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain === true) continue;
    const isAssistant = entry?.type === "assistant" || entry?.message?.role === "assistant" || entry?.role === "assistant";
    if (!isAssistant) continue;
    const usage = entry.message?.usage || entry.usage;
    if (!usage || typeof usage.input_tokens !== "number") continue;
    return {
      tokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      model: String(entry.message?.model || entry.model || ""),
      output_tokens: Number(usage.output_tokens) || 0
    };
  }
  return null;
}

/**
 * Resolve the model's context window. A configured value wins; otherwise a
 * large window is recognised from the model id suffix ("[1m]") or inferred from
 * a token count no standard window could hold.
 *
 * @param {string} model
 * @param {number} tokens
 * @param {number} [configured]
 * @returns {number}
 */
export function contextWindowFor(model, tokens, configured = 0) {
  const override = positiveNumber(configured, 0)
    || positiveNumber(process.env.AI_DEV_CONTEXT_WINDOW_TOKENS, 0)
    || positiveNumber(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 0);
  if (override) return override;
  if (String(model).includes("[1m]")) return CONTEXT_WINDOWS.large;
  return tokens > CONTEXT_WINDOWS.standard ? CONTEXT_WINDOWS.large : CONTEXT_WINDOWS.standard;
}

/**
 * Compaction thresholds from `.ai-dev/policy.json`, defaults filled in.
 *
 * @param {object} [policy] - From {@link loadPolicy}.
 * @returns {typeof COMPACT_DEFAULTS}
 */
export function compactSettings(policy = {}) {
  const thresholds = policy.compact_context_thresholds ?? {};
  return {
    tool_threshold: positiveNumber(policy.compact_tool_threshold, COMPACT_DEFAULTS.tool_threshold),
    tool_interval: positiveNumber(policy.compact_tool_interval, COMPACT_DEFAULTS.tool_interval),
    // 0 keeps the window-derived threshold below; a positive value pins it.
    context_threshold: Math.max(0, Number(policy.compact_context_threshold) || 0),
    context_thresholds: {
      standard: positiveNumber(thresholds.standard, COMPACT_DEFAULTS.context_thresholds.standard),
      large: positiveNumber(thresholds.large, COMPACT_DEFAULTS.context_thresholds.large)
    },
    context_window: Math.max(0, Number(policy.compact_context_window) || 0),
    context_interval: positiveNumber(policy.compact_context_interval, COMPACT_DEFAULTS.context_interval)
  };
}

/**
 * The token count at which the advisor starts suggesting a compaction.
 *
 * @param {typeof COMPACT_DEFAULTS} settings - From {@link compactSettings}.
 * @param {number} window
 * @returns {number}
 */
export function contextThresholdFor(settings, window) {
  if (settings.context_threshold > 0) return settings.context_threshold;
  return window >= CONTEXT_WINDOWS.large ? settings.context_thresholds.large : settings.context_thresholds.standard;
}

export function compileRegex(source, flags = "i") {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * How long one policy-rule match may take, and the longest input it is given.
 *
 * A pattern that backtracks catastrophically cannot be interrupted on this
 * thread, and one such rule in `.ai-dev/policy.json` stalls the guard on every
 * Bash command and every file write: `(a|a)+$` against twenty-eight characters
 * takes 38.8 seconds (docs/ecc-upgrades/DEBTS.md, Д-16). The server refuses to
 * write such a rule, but nothing stops a hand edit, so the guard never trusts
 * the pattern either: it matches in a worker thread it can kill.
 *
 * The mirror of this in the server is src/core/regex-budget.mjs; the hook pack
 * is copied into other repositories and cannot import it.
 */
export const POLICY_MATCH_BUDGET_MS = 250;
// One deadline for the whole event on top of the per-rule budget. Thirty slow
// rules used to cost thirty budgets — 8.7 seconds measured, against a client
// that abandons a hook at ten (docs/ecc-upgrades/DEBTS.md, Д-22) — so the rules
// the deadline cuts off are reported as unchecked instead of being run.
export const POLICY_MATCH_DEADLINE_MS = 1000;
export const POLICY_MATCH_MAX_INPUT = 4096;

const MATCH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.postMessage({ ready: true });
for (const job of workerData.jobs) {
  let matched = null;
  try {
    matched = new RegExp(job.pattern, job.flags).test(job.haystack);
  } catch {
    matched = null;
  }
  parentPort.postMessage({ matched });
}
parentPort.postMessage({ done: true });
`;

function runMatchBatch(jobs, budgetMs) {
  return new Promise((resolve) => {
    const results = [];
    let settled = false;
    let timer = null;
    let worker = null;
    const finish = (timedOutAt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate();
      resolve({ results, timedOutAt });
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(results.length), budgetMs);
    };
    try {
      worker = new Worker(MATCH_WORKER_SOURCE, { eval: true, workerData: { jobs } });
    } catch {
      finish(-1);
      return;
    }
    worker.on("message", (message) => {
      if (message && message.ready) return arm();
      if (message && message.done) return finish(-1);
      results.push(message && typeof message.matched === "boolean" ? message.matched : null);
      return arm();
    });
    worker.on("error", () => finish(-1));
    worker.on("exit", () => finish(-1));
    arm();
  });
}

/**
 * Match `{ pattern, flags, haystack }` jobs, each under its own budget and all
 * of them under one deadline. Every job gets an answer:
 *
 * - `{ checked: true, matched: true | false }` — the job ran.
 * - `{ checked: true, matched: null }` — it outlived its own budget. The jobs
 *   behind it are run in a fresh worker, because killing the stuck one is the
 *   only way to stop it.
 * - `{ checked: false, matched: null }` — the deadline passed first, so it was
 *   never run. The guard says how many of those there were, in one line.
 *
 * @param {Array<{ pattern: string, flags?: string, haystack?: string }>} jobs
 * @param {{ budgetMs?: number, deadlineMs?: number }} [options]
 * @returns {Promise<Array<{ matched: boolean | null, checked: boolean }>>}
 */
export async function matchWithBudget(jobs, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : POLICY_MATCH_BUDGET_MS;
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : POLICY_MATCH_DEADLINE_MS;
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return [];
  const prepared = list.map((job) => ({
    pattern: String((job && job.pattern) || ""),
    flags: String((job && job.flags) || "i"),
    haystack: String((job && job.haystack) || "").slice(0, POLICY_MATCH_MAX_INPUT)
  }));
  const answers = new Array(prepared.length).fill(null);
  const startedAt = Date.now();
  let offset = 0;
  while (offset < prepared.length) {
    // What is left of the deadline is also the ceiling for the next job: the
    // last rule of an event may not overrun the event.
    const left = deadlineMs - (Date.now() - startedAt);
    if (left <= 0) break;
    const { results, timedOutAt } = await runMatchBatch(prepared.slice(offset), Math.min(budgetMs, left));
    for (let index = 0; index < results.length && offset + index < prepared.length; index += 1) {
      answers[offset + index] = { matched: results[index], checked: true };
    }
    const stuck = timedOutAt >= 0 ? offset + timedOutAt : offset + results.length;
    if (stuck >= prepared.length) break;
    answers[stuck] = { matched: null, checked: true };
    offset = stuck + 1;
  }
  return answers.map((answer) => answer || { matched: null, checked: false });
}

/** Split a shell command into segments on unquoted ; | & and newlines, stripping quotes. */
export function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  // Also inspect command substitutions and sh -c bodies.
  const nested = [];
  for (const segment of segments) {
    for (const match of segment.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push((match[1] || match[2] || "").trim());
    const wrapper = segment.match(/^(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\s+-c\s+(.+)$/);
    if (wrapper) nested.push(wrapper[1].trim());
  }
  return [...segments, ...nested.filter(Boolean)];
}

export function tokensOf(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

/** The task a project is working on right now, or null. Shared by stop-check and cost-capture. */
export function activeTaskFor(projectRoot) {
  const directory = path.join(stateRoot(), "tasks");
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names) {
    const record = readJson(path.join(directory, name));
    if (record && ["active", "verified"].includes(record.status) && samePath(record.project?.path, projectRoot)) return record;
  }
  return null;
}

/** The usage ledger the server reads (`src/core/usage-ledger.mjs`). */
export function usageLedgerPath() {
  return path.join(stateRoot(), "usage", "events.jsonl");
}

/** Same self-limiting as UsageLedger: 8 MB, then keep the newest 20 000 lines. */
export const USAGE_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const USAGE_LEDGER_KEEP_LINES = 20_000;

function pruneUsageLedger(target) {
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    return;
  }
  if (size <= USAGE_LEDGER_MAX_BYTES) return;
  try {
    const kept = fs.readFileSync(target, "utf8").split("\n").filter(Boolean).slice(-USAGE_LEDGER_KEEP_LINES);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${kept.join("\n")}\n`, "utf8");
    fs.renameSync(temp, target);
  } catch {
    // Pruning is best-effort: an oversized ledger still works.
  }
}

/**
 * Append events to the usage ledger. The hook writes the file directly rather
 * than calling `record_usage`, because the server may be running in Docker while
 * the hook runs on the developer's machine — and because a Stop hook must not
 * depend on an MCP round trip. Lines are appended with O_APPEND (one write per
 * call, no read-modify-write) so a concurrent server append cannot be clobbered.
 *
 * @param {object[]} events
 * @returns {boolean} Whether anything was written.
 */
export function appendUsageEvents(events) {
  const payload = (events || []).map((event) => `${JSON.stringify(event)}\n`).join("");
  if (!payload) return false;
  const target = usageLedgerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, payload, "utf8");
  pruneUsageLedger(target);
  return true;
}

/** How much transcript one cost-capture run reads; the rest waits for the next Stop. */
export const TRANSCRIPT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Sum `usage` over the assistant messages a transcript gained since `fromOffset`,
 * grouped by model.
 *
 * The transcript is append-only JSONL, so the byte offset of the last complete
 * line is a cursor: the next run starts there and the same message is never
 * billed twice. Only whole lines are consumed (a UTF-8 sequence never contains
 * `\n`, so cutting at a newline is safe), and at most one chunk per run.
 *
 * Sidechain entries are included: a subagent's tokens are billed to the same
 * account, even though they live in their own context window — which is why
 * `latestAssistantUsage`, whose question is "how full is this window", skips
 * them and this does not. Repeated `message.id`s within a chunk are counted
 * once: one API response can be written out as several transcript lines that
 * each carry the same usage record.
 *
 * @param {string} transcriptPath
 * @param {{ fromOffset?: number, chunkBytes?: number }} [options]
 * @returns {{ offset: number, messages: number, models: object[] }}
 */
export function sumAssistantUsage(transcriptPath, { fromOffset = 0, chunkBytes = TRANSCRIPT_CHUNK_BYTES } = {}) {
  const empty = { offset: Math.max(0, Number(fromOffset) || 0), messages: 0, models: [] };
  if (!transcriptPath) return empty;
  let text = "";
  let start = empty.offset;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      // A transcript that shrank is a different transcript (a fresh file under a
      // reused session id): read it from the top rather than skipping its start.
      if (size < start) start = 0;
      if (size === start) return { ...empty, offset: start };
      const length = Math.min(size - start, Math.max(1024, chunkBytes));
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0) return { ...empty, offset: start };
      const consumed = buffer.subarray(0, lastNewline + 1);
      text = consumed.toString("utf8");
      start += consumed.length;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return empty;
  }
  const models = new Map();
  const seen = new Set();
  let messages = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const isAssistant = entry?.type === "assistant" || entry?.message?.role === "assistant" || entry?.role === "assistant";
    if (!isAssistant) continue;
    const usage = entry.message?.usage || entry.usage;
    if (!usage || typeof usage !== "object") continue;
    const id = entry.message?.id || entry.id || "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const model = String(entry.message?.model || entry.model || "unknown");
    const row = models.get(model) ?? { model, messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    row.messages += 1;
    row.input_tokens += Number(usage.input_tokens) || 0;
    row.output_tokens += Number(usage.output_tokens) || 0;
    row.cache_read_tokens += Number(usage.cache_read_input_tokens) || 0;
    row.cache_creation_tokens += Number(usage.cache_creation_input_tokens) || 0;
    models.set(model, row);
    messages += 1;
  }
  return {
    offset: start,
    messages,
    models: [...models.values()].filter((row) => row.input_tokens || row.output_tokens || row.cache_read_tokens || row.cache_creation_tokens)
  };
}

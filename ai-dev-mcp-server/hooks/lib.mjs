// Shared helpers for the AI Dev System agent hooks. Zero dependencies: these
// files are copied into a project's .ai-dev/hooks/ and run on the developer's
// machine by Claude Code / Cursor, possibly while the MCP server runs in Docker.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

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
  // The server resolves roots with the asynchronous fs.realpath
  // (core/project-identity.mjs), which is libuv's — the same resolution as
  // realpathSync.native, and on Windows that expands 8.3 short names
  // (RUNNER~1 -> runneradmin) and junctions where the JavaScript realpathSync
  // does not. Using the JavaScript one here keyed the hook's memory under an id
  // the server never looks up: CI on windows-latest measured two different
  // project ids for one directory. The plain sync call stays as the fallback,
  // for the paths the native one refuses.
  try {
    return fs.realpathSync.native(target);
  } catch {
    /* fall through */
  }
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}


function hashKey(key) {
  return crypto.createHash("sha256").update(process.platform === "win32" ? key.toLowerCase() : key).digest("hex").slice(0, 20);
}

/** The Git root of `cwd`, when it may stand for a project; "" otherwise. */
function gitRootOf(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return "";
  // A dotfiles clone in `~` answers `--show-toplevel` with the home directory
  // for every project below it, which is the server's `rawGitRoot` fallback and
  // is gated there the same way.
  const root = realpathOf(top);
  return isProjectBoundaryCandidate(root, { homeDir: canonicalUserHome() }) ? root : "";
}

/**
 * The workspace a hook fired in `cwd` works in: the Git root, or `cwd` outside
 * Git. Its `.ai-dev/policy.json` and `hooks/patterns.json` are the ones
 * `install_agent_hooks` wrote, `git status` paths are relative to it, its
 * `node_modules/.bin` holds the formatter. In a package of a monorepo this is
 * the repository, not the package.
 */
export function projectRootOf(cwd) {
  return gitRootOf(cwd) || realpathOf(cwd);
}

/**
 * The project the server would name for `cwd` — derived as its
 * resolveProjectIdentity derives it: the nearest project boundary at or above
 * `cwd` first, the Git root only when there is none, then `cwd` itself. The
 * memory a hook reads and writes is keyed by it, so that a session in
 * `<repo>/apps/web` meets the memory the server keeps for `apps/web`.
 * For everything else the hooks use
 * {@link projectRootOf}.
 */
export function identityRootOf(cwd) {
  const canonical = realpathOf(cwd);
  const boundary = projectBoundaryOf(canonical);
  if (boundary) return realpathOf(boundary);
  return gitRootOf(cwd) || canonical;
}

/** Same normalization as the server's project identity: POSIX separators, case-folded on Windows. */
export function normalizePath(value) {
  return comparablePath(value, process.platform);
}

/**
 * Normalise a path for comparison the way a given platform does: POSIX
 * separators, no trailing slash, case-folded on Windows. The platform is a
 * parameter so the branch a machine will never take is still testable — and so
 * a Windows layout can be decided on a POSIX host.
 */
function comparablePath(value, platform) {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const resolved = impl.resolve(String(value ?? "")).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The user's home directory, as the platform spells it: `USERPROFILE` on
 * Windows, `HOME` elsewhere, each falling back to the other. Empty when neither
 * is set, and the home rule below then does not apply at all.
 *
 * `AI_DEV_HOME` is deliberately not read here: it moves the runtime tree, not
 * the user, and pointing the runtime somewhere else must not change which
 * directories can be projects. Same definition as the server's
 * `userHomeDirectory` (core/project-identity.mjs).
 */
export function userHomeDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const value = platform === "win32" ? (env.USERPROFILE || env.HOME) : (env.HOME || env.USERPROFILE);
  return String(value || "").trim();
}

/**
 * Whether a directory carrying a marker may be read as a project boundary,
 * decided exactly as the server decides it (core/project-identity.mjs).
 *
 * The walk used to run to the root of the filesystem and stop at the first
 * marker, so a single `package.json` in `~` — and anyone who has once run npm
 * from their home directory has one — made every project below it collapse
 * onto one memory key: the session handoffs, instincts and context of one
 * project served to an agent working in another, silently.
 * So a marker sitting in the home directory itself, or
 * anywhere above it, is not a boundary. Below the home directory, and outside
 * it entirely (`/srv/app`, `C:\work\app`), nothing changes.
 *
 * Pass canonical (realpath) values, as the walk does, so a home reached through
 * a symlink still compares equal to the walked path.
 */
export function isProjectBoundaryCandidate(directory, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? userHomeDirectory({ platform, env: options.env });
  if (!homeDir) return true;
  const candidate = comparablePath(directory, platform);
  const home = comparablePath(homeDir, platform);
  return candidate !== home && !home.startsWith(`${candidate}/`);
}

/** The user's home directory as the walk reads paths: canonical, or "". */
function canonicalUserHome() {
  const home = userHomeDirectory();
  return home ? realpathOf(home) : "";
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

/**
 * The markers the server treats as a project boundary
 * (core/project-identity.mjs). Duplicated here on purpose: this file is copied
 * into other repositories and cannot import the server.
 */
const BOUNDARY_MARKERS = [
  ".ai-dev",
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json"
];

/**
 * The nearest directory at or above `start` that says it is a project, exactly
 * as the server decides it. A hook fired from a subdirectory otherwise keyed
 * its memory to that subdirectory while the server keyed it to the project.
 */
function projectBoundaryOf(start) {
  // Canonical, because the walk below reads canonical paths. macOS reaches its
  // temp directory through /var/folders, a symlink to /private/var, so the
  // configured root and the walked path spelled the same directory differently
  // and the comparison never matched — putting the runtime directory back in
  // the marker list and every project below it back under one memory key.
  // Measured on macOS CI, and reproduced on Linux with a symlinked home.
  const runtimeRoot = normalizePath(realpathOf(runtimeStateRoot()));
  const homeDir = canonicalUserHome();
  let current = path.resolve(start);
  while (true) {
    // Once the walk reaches the home directory every remaining ancestor is
    // above it too, so there is nothing left that may be a boundary: the start
    // directory stands for itself.
    if (!isProjectBoundaryCandidate(current, { homeDir })) return "";
    for (const marker of BOUNDARY_MARKERS) {
      const markerPath = path.join(current, marker);
      if (marker === ".ai-dev" && normalizePath(markerPath) === runtimeRoot) continue;
      if (fs.existsSync(markerPath)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

/**
 * Same derivation as the server's resolveProjectIdentity (core/project-identity.mjs):
 * canonical path first, then the nearest project boundary at or above it, then
 * the hash.
 *
 * Both halves were missing here. Without the canonical path a hook writing
 * through a symlink — or through the spelling Windows hands out for a temporary
 * directory — keyed its memory under an id the server never looks up; without
 * the boundary walk a hook fired inside a subdirectory of a project keyed it to
 * the subdirectory. CI on windows-latest measured the first; the second is the
 * same divergence one directory further down.
 */
export function projectIdOf(projectRoot, isGit = true) {
  const canonical = realpathOf(projectRoot);
  const root = projectBoundaryOf(canonical) || canonical;
  return `project-${hashKey(`${isGit ? "git" : "filesystem"}:${normalizePath(realpathOf(root))}`)}`;
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
  return path.join(runtimeStateRoot(), "state");
}

/**
 * The runtime tree itself — `AI_DEV_HOME`, else `<home>/.ai-dev` — which is what
 * the server's `resolveRuntimeStateRoot` returns (src/core/runtime-home.mjs).
 *
 * `AI_DEV_HOME` names the runtime folder itself; 2.x appended `.ai-dev` to it
 * on both sides. The one
 * value that keeps the 2.x meaning is the home directory itself: taken at its
 * word it would scatter the runtime tree across the home.
 *
 * `stateRoot()` is one level below it, and comparing that against a candidate
 * `<dir>/.ai-dev` never matched — so the runtime directory was read as a
 * project boundary. On Windows the temp directory lives inside the user
 * profile, so the walk from any project there stopped at `<home>` and every
 * project on the machine shared one memory key. Measured: two sibling
 * directories under a home carrying `.ai-dev` both hashed to
 * `project-e24ca70e5358e2931b79` in the hook while the server told them apart.
 *
 * The server does not honour `AI_DEV_STATE_ROOT` here either: that variable
 * moves where state is written, not which directory is the runtime tree.
 *
 * @returns {string}
 */
export function runtimeStateRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return explicitRuntimeHome() || recordedRuntimeHome() || path.join(home, ".ai-dev");
}

/** The file beside the hooks that names the server's runtime folder. */
export const RUNTIME_HOME_FILE = ".ai-dev-home";

/**
 * The runtime folder of the server that installed these hooks, when
 * `AI_DEV_HOME` named one: `install_agent_hooks` records it beside them, kept
 * out of git like `.node-path`. A client started from the Dock or the Start
 * menu runs its hooks without the shell's variables, while its server has
 * `AI_DEV_HOME` from the client's config — without the record the two
 * kept their state in different places. The server
 * reads no such file: its environment carries the variable. In the hooks it
 * comes after `AI_DEV_HOME` and before `~/.ai-dev`, as the server's copy has
 * nothing to put between them.
 *
 * @returns {string}
 */
export function recordedRuntimeHome() {
  try {
    const value = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), RUNTIME_HOME_FILE), "utf8").trim();
    return value && path.isAbsolute(value) ? path.resolve(value) : "";
  } catch {
    return "";
  }
}

/** Same as the server's `sameDirectory`: through symlinks, and case-blind on Windows and macOS. */
export function sameDirectory(left, right, { platform = process.platform, realpath = realpathOf } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const canonical = (value) => {
    const resolved = paths.resolve(realpath(paths.resolve(value)));
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

/** Same as the server's `explicitRuntimeHome`: `AI_DEV_HOME`, unless it names the home itself. */
export function explicitRuntimeHome(options = {}) {
  const raw = String(process.env.AI_DEV_HOME ?? "").trim();
  if (!raw) return "";
  const homes = [process.env.USERPROFILE, process.env.HOME, os.homedir()].filter(Boolean);
  return homes.some((home) => sameDirectory(home, raw, options)) ? "" : path.resolve(raw);
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
 * takes 38.8 seconds. The server refuses to
 * write such a rule, but nothing stops a hand edit, so the guard never trusts
 * the pattern either: it matches in a worker thread it can kill.
 *
 * The mirror of this in the server is src/core/regex-budget.mjs; the hook pack
 * is copied into other repositories and cannot import it.
 */
export const POLICY_MATCH_BUDGET_MS = 250;
// One deadline for the whole event on top of the per-rule budget. Thirty slow
// rules used to cost thirty budgets — 8.7 seconds measured, against a client
// that abandons a hook at ten — so the rules
// the deadline cuts off are reported as unchecked instead of being run.
export const POLICY_MATCH_DEADLINE_MS = 1000;
// How long the match threads of one event may take to start, all together. Startup is the machine's cost, not a
// rule's: charged to the first rule, it let a forbidden command through 27 times in 30 under 32 busy loops on 4
// cores, blaming a pattern that had never run. The deadline above counts matching only.
export const POLICY_MATCH_START_MS = 3000;
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

// Why a worker failed, in words that are never empty: a worker that throws `new Error("")` has failed all the same.
// The server's copy reads a failure with this same expression, so both say the same of one.
function failureReason(cause) {
  return String((cause && cause.message) || cause || "").trim() || "it gave no reason";
}

// Until the worker says `ready` it is only starting: that has its own ceiling, `startMs`, and charges no rule.
// A worker that fails instead — it cannot be created, or errors or exits — comes back `failed`, its reason in
// `error`: that is not a slow start, and the job it was on is answered as run, as the server's copy does.
// The flag tells the two apart, never the reason's text.
function runMatchBatch(jobs, budgetMs, startMs) {
  return new Promise((resolve) => {
    const results = [];
    const created = Date.now();
    let startupMs = null;
    let settled = false;
    let timer = null;
    let worker = null;
    const finish = (timedOutAt, failed = false, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate();
      resolve({ results, timedOutAt, failed, error, startupMs: startupMs === null ? Date.now() - created : startupMs, notStarted: startupMs === null });
    };
    const fail = (cause) => finish(-1, true, failureReason(cause));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(results.length), budgetMs);
    };
    try {
      worker = new Worker(MATCH_WORKER_SOURCE, { eval: true, workerData: { jobs } });
    } catch (error) {
      fail(error);
      return;
    }
    worker.on("message", (message) => {
      if (message && message.ready) {
        startupMs = Date.now() - created;
        return arm();
      }
      if (message && message.done) return finish(-1);
      results.push(message && typeof message.matched === "boolean" ? message.matched : null);
      return arm();
    });
    worker.on("error", fail);
    worker.on("exit", () => fail("the match worker exited before it answered"));
    timer = setTimeout(() => finish(-1), startMs);
  });
}

/**
 * Match `{ pattern, flags, haystack }` jobs, each under its own budget and all
 * of them under one deadline. Every job gets an answer:
 *
 * - `{ checked: true, matched: true | false }` — the job ran.
 * - `{ checked: true, matched: null }` — it outlived its own budget. The jobs
 *   behind it are run in a fresh worker, because killing the stuck one is the
 *   only way to stop it. With `error`, the worker failed on it instead of
 *   timing out, and the jobs behind it get a fresh worker the same way — or,
 *   when it failed before it was ready, every job left gets that error.
 * - `{ checked: false, matched: null, not_run }` — never run: the deadline
 *   passed first (`not_run: "deadline"`), or no thread could start for it in
 *   time (`not_run: "start"` — the machine is too busy). The guard says how
 *   many of those there were, in one line.
 *
 * The deadline counts the time the rules run, not the time threads take to
 * start; that has its own allowance, `startMs`.
 *
 * @param {Array<{ pattern: string, flags?: string, haystack?: string }>} jobs
 * @param {{ budgetMs?: number, deadlineMs?: number, startMs?: number }} [options]
 * @returns {Promise<Array<{ matched: boolean | null, checked: boolean, error?: string, not_run?: "deadline" | "start" }>>}
 */
export async function matchWithBudget(jobs, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : POLICY_MATCH_BUDGET_MS;
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : POLICY_MATCH_DEADLINE_MS;
  const startMs = Number.isFinite(options.startMs) && options.startMs > 0 ? options.startMs : POLICY_MATCH_START_MS;
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return [];
  const prepared = list.map((job) => ({
    pattern: String((job && job.pattern) || ""),
    flags: String((job && job.flags) || "i"),
    haystack: String((job && job.haystack) || "").slice(0, POLICY_MATCH_MAX_INPUT)
  }));
  const answers = new Array(prepared.length).fill(null);
  let matching = 0;
  let starting = 0;
  let notRun = "deadline";
  let offset = 0;
  while (offset < prepared.length) {
    // What is left of the deadline is also the ceiling for the next job: the
    // last rule of an event may not overrun the event.
    const left = deadlineMs - matching;
    if (left <= 0) break;
    if (startMs - starting <= 0) {
      notRun = "start";
      break;
    }
    const began = Date.now();
    const { results, timedOutAt, failed, error, startupMs, notStarted } = await runMatchBatch(prepared.slice(offset), Math.min(budgetMs, left), startMs - starting);
    starting += startupMs;
    matching += Math.max(0, Date.now() - began - startupMs);
    if (notStarted && !failed) {
      notRun = "start";
      break;
    }
    if (notStarted) {
      // A worker that failed before it was ready ran none of these rules, and the next one would fail the same way:
      // every rule left is answered with its error, instead of a thread made and lost per rule.
      for (let index = offset; index < prepared.length; index += 1) answers[index] = { matched: null, checked: true, error };
      break;
    }
    for (let index = 0; index < results.length && offset + index < prepared.length; index += 1) {
      answers[offset + index] = { matched: results[index], checked: true };
    }
    const stuck = timedOutAt >= 0 ? offset + timedOutAt : offset + results.length;
    if (stuck >= prepared.length) break;
    answers[stuck] = timedOutAt < 0 && failed ? { matched: null, checked: true, error } : { matched: null, checked: true };
    offset = stuck + 1;
  }
  return answers.map((answer) => answer || { matched: null, checked: false, not_run: notRun });
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
/** Whether `directory` is `root` or lies below it, compared the way the platform compares paths. */
export function isWithin(directory, root) {
  if (!directory || !root) return false;
  const inner = normalizePath(directory);
  const outer = normalizePath(root);
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The open tasks (active or verified) whose project holds `directory`, the
 * nearest project first: a task begun for the repository covers a session in
 * one of its packages, and a task begun for the package does too.
 *
 * @param {string} directory - Usually {@link identityRootOf} the hook's `cwd`.
 * @returns {object[]}
 */
export function openTasksFor(directory) {
  const folder = path.join(stateRoot(), "tasks");
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = [];
  for (const name of names) {
    const record = readJson(path.join(folder, name));
    if (record && ["active", "verified"].includes(record.status) && isWithin(directory, record.project?.path)) tasks.push(record);
  }
  return tasks.sort((left, right) => normalizePath(right.project.path).length - normalizePath(left.project.path).length
    || String(right.updated_at).localeCompare(String(left.updated_at)));
}

/** The task a hook in `directory` works under: the nearest open one, or null. */
export function activeTaskFor(directory) {
  return openTasksFor(directory)[0] ?? null;
}

/** The usage ledger the server reads (`src/core/usage-ledger.mjs`). */
export function usageLedgerPath() {
  return path.join(stateRoot(), "usage", "events.jsonl");
}

/*
 * Cross-process file locks — a synchronous copy of src/core/file-lock.mjs.
 *
 * The usage ledger is written by every MCP server process and by these hooks
 * at once, so an append or a prune that does not hold the lock loses somebody's
 * lines. The protocol must stay identical to the
 * server's: the lock is `<target>.lock`, created exclusively
 * and holding `{ pid, host, token, acquired_at }`; it is stale when its process
 * is gone (same host), when it is older than LOCK_STALE_MS, or when it has no
 * readable holder for EMPTY_LOCK_GRACE_MS; a stale lock is broken under
 * `<target>.lock.break`, and only if it is still the file judged stale (same
 * identity, same holder); release deletes the lock only if it still carries this
 * holder's token.
 */
export const LOCK_SUFFIX = ".lock";
export const LOCK_STALE_MS = 30_000;
export const EMPTY_LOCK_GRACE_MS = 2_000;
export const BREAK_LOCK_STALE_MS = 5_000;
/** A hook must not hold the agent up for long; giving up costs one ledger line. */
export const HOOK_LOCK_TIMEOUT_MS = 5_000;
const LOCK_MAX_BACKOFF_MS = 50;
const LOCK_TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function lockPathFor(filePath) {
  return `${path.resolve(filePath)}${LOCK_SUFFIX}`;
}

// A process's state letter from /proc/<pid>/stat; "" when it is not there; null where there is no /proc.
export function procStateLetter(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) || null;
  } catch (error) {
    return error?.code === "ENOENT" && fs.existsSync("/proc/self/stat") ? "" : null;
  }
}

// Running, or there and unknown: a process that has exited and waits to be collected (a zombie, which kill(pid, 0)
// still answers for) is not, where /proc tells — the server's file-lock.mjs judges it the same. A /proc
// that does not show the process kill has just found hides it (hidepid): there, and alive.
export function processAlive(pid, { platform = process.platform, proc = procStateLetter } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  if (platform === "win32") return true;
  const letter = proc(pid);
  return letter !== "Z" && letter !== "X";
}

export function lockIsLive(observed, { now = Date.now(), staleMs = LOCK_STALE_MS, emptyGraceMs = EMPTY_LOCK_GRACE_MS, host = os.hostname(), alive = processAlive } = {}) {
  if (observed?.unreadable) return true;
  const holder = observed?.holder;
  if (!holder || typeof holder !== "object") {
    return now - Number(observed?.mtimeMs || 0) < emptyGraceMs;
  }
  if (now - Number(holder.acquired_at || 0) >= staleMs) return false;
  if (holder.host && holder.host !== host) return true;
  return alive(Number(holder.pid));
}

export function readLockSync(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (LOCK_TRANSIENT_CODES.has(error?.code)) return { holder: null, mtimeMs: Date.now(), id: "", unreadable: true };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const text = fs.readFileSync(fd, "utf8");
    let holder = null;
    try {
      holder = JSON.parse(text);
    } catch {
      holder = null;
    }
    return { holder, mtimeMs: Number(stat.mtimeMs), id: `${stat.dev}:${stat.ino}` };
  } finally {
    fs.closeSync(fd);
  }
}

export function sameLock(left, right) {
  if (!left || !right || !left.id || left.id !== right.id) return false;
  const leftToken = left.holder?.token ?? null;
  if (leftToken !== (right.holder?.token ?? null)) return false;
  return leftToken !== null || left.mtimeMs === right.mtimeMs;
}

export function breakStaleLockSync(lockPath, observed, { staleMs = LOCK_STALE_MS } = {}) {
  const breaker = `${lockPath}.break`;
  try {
    fs.closeSync(fs.openSync(breaker, "wx", 0o600));
  } catch (error) {
    if (error?.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(breaker).mtimeMs >= BREAK_LOCK_STALE_MS) fs.rmSync(breaker, { force: true });
      } catch {
        // The other breaker finished meanwhile.
      }
      return false;
    }
    if (error?.code === "ENOENT" || LOCK_TRANSIENT_CODES.has(error?.code)) return false;
    throw error;
  }
  try {
    const current = readLockSync(lockPath);
    if (!sameLock(current, observed) || lockIsLive(current, { staleMs })) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } finally {
    try {
      fs.rmSync(breaker, { force: true });
    } catch {
      // Left behind, it is cleared as stale by the next breaker.
    }
  }
}

function releaseLockSync(lockPath, token) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current = readLockSync(lockPath);
      if (current?.unreadable) throw Object.assign(new Error("lock busy"), { code: "EBUSY" });
      if (current?.holder?.token === token) fs.rmSync(lockPath, { force: true });
      return;
    } catch (error) {
      if (!LOCK_TRANSIENT_CODES.has(error?.code)) throw error;
      sleepSync(10 * (attempt + 1));
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireFileLockSync(filePath, { timeoutMs = HOOK_LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = lockPathFor(filePath);
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, acquired_at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => releaseLockSync(lockPath, token);
    } catch (error) {
      if (error?.code === "ENOENT") {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (error?.code !== "EEXIST" && !(process.platform === "win32" && LOCK_TRANSIENT_CODES.has(error?.code))) throw error;
    }
    const observed = readLockSync(lockPath);
    if (observed && !lockIsLive(observed, { staleMs })) {
      if (breakStaleLockSync(lockPath, observed, { staleMs })) continue;
    }
    if (Date.now() >= deadline) {
      const owner = observed?.holder?.pid ? ` (held by pid ${observed.holder.pid})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the lock ${lockPath}${owner}.`);
    }
    sleepSync(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
  }
}

export function withFileLockSync(filePath, operation, options = {}) {
  const release = acquireFileLockSync(filePath, options);
  try {
    return operation();
  } finally {
    release();
  }
}

/** Cut a trailing partial line — a record a killed writer never finished — off a JSONL file. */
export function truncateTornTailSync(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r+");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const bytesRead = fs.readSync(fd, chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        fs.ftruncateSync(fd, start + newline + 1);
        return size - (start + newline + 1);
      }
      end = start;
    }
    fs.ftruncateSync(fd, 0);
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/** Same self-limiting as UsageLedger: 8 MB, then keep the newest 20 000 lines. */
export const USAGE_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const USAGE_LEDGER_KEEP_LINES = 20_000;

/** Prune under the ledger's lock — the caller holds it. */
function pruneUsageLedgerLocked(target) {
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    return;
  }
  if (size <= USAGE_LEDGER_MAX_BYTES) return;
  try {
    const kept = fs.readFileSync(target, "utf8").split("\n").filter(Boolean).slice(-USAGE_LEDGER_KEEP_LINES);
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
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
 * depend on an MCP round trip. The append is one O_APPEND write under the same
 * cross-process lock the server's `appendJsonLines` takes, after cutting off a
 * record a killed writer left without its newline.
 *
 * @param {object[]} events
 * @returns {boolean} Whether anything was written.
 */
export function appendUsageEvents(events) {
  const payload = (events || []).map((event) => `${JSON.stringify(event)}\n`).join("");
  if (!payload) return false;
  const target = usageLedgerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  withFileLockSync(target, () => {
    truncateTornTailSync(target);
    fs.appendFileSync(target, payload, "utf8");
    pruneUsageLedgerLocked(target);
  });
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
    const row = models.get(model) ?? { model, messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cache_creation_1h_tokens: 0 };
    row.messages += 1;
    row.input_tokens += Number(usage.input_tokens) || 0;
    row.output_tokens += Number(usage.output_tokens) || 0;
    row.cache_read_tokens += Number(usage.cache_read_input_tokens) || 0;
    row.cache_creation_tokens += Number(usage.cache_creation_input_tokens) || 0;
    // `cache_creation_input_tokens` covers both TTLs; the hour-long share is
    // billed at 2x input rather than 1.25x, so it is carried separately.
    row.cache_creation_1h_tokens += Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0;
    models.set(model, row);
    messages += 1;
  }
  return {
    offset: start,
    messages,
    models: [...models.values()].filter((row) => row.input_tokens || row.output_tokens || row.cache_read_tokens || row.cache_creation_tokens)
  };
}

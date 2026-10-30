/**
 * The environment a daemon session runs in: its own client's.
 *
 * One daemon serves every AI client of a user (`src/daemon.mjs`), but clients
 * do not share an environment. A terminal's PATH holds the user's gitleaks or a
 * virtualenv that an app started from the Dock lacks; one client goes through a
 * proxy and another does not. In 2.x every client ran a server of its own, and
 * a tool found the programs and the network its client had. The daemon keeps
 * that: the bridge sends its environment once the daemon has proven itself
 * (`daemon-channel.mjs`), and everything a session's messages set off — the
 * tools, the processes they start, the downloads they make — reads that
 * environment through `process.env`. Work of the daemon's own, outside any
 * session, reads the environment it was started with.
 *
 * What clients of one daemon cannot set differently is what the server reads
 * once, when it loads, or shares between sessions: where its data is, which
 * model it loads. Those variables are part of the daemon's build
 * (`daemonWideEnvironment`), and a client that sets them otherwise is served by
 * a daemon of its own.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { inspect } from "node:util";
import { resolveInstallLayout } from "./install-layout.mjs";

/**
 * The variables a daemon reads once or shares between its sessions: two
 * clients that set any of them differently are served by two daemons.
 */
export const DAEMON_WIDE_VARIABLES = Object.freeze([
  // Where the data is: the runtime home, the vault, the state, the index, the artifacts.
  "AI_DEV_HOME",
  "HOME",
  "USERPROFILE",
  "AI_DEV_VAULT_ROOT",
  "AI_DEV_VAULT",
  "AI_DEV_STATE_ROOT",
  "AI_DEV_SEARCH_INDEX_DIR",
  "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_RECEIPTS_ROOT",
  // The model every session shares, and how it runs.
  "BGE_M3_ONNX_DIR",
  "BGE_M3_MODEL_DIR",
  "BGE_M3_DEVICE",
  "AI_DEV_MODEL_MANIFEST",
  "AI_DEV_DENSE_BACKEND",
  // The server's flavour.
  "AI_DEV_RUNTIME"
]);

const DAEMON_WIDE = new Set(DAEMON_WIDE_VARIABLES);

/**
 * AI Dev's own variables that are not the daemon's to share: each session
 * reads them from its own client's environment, the daemon's lifetime comes
 * from the client that started it, and the rest belong to the hooks, the
 * Docker launchers and the installers, and never reach the server. Any other
 * `AI_DEV_*` or `BGE_*` name counts as daemon-wide, so a variable added later
 * splits the daemon rather than leaks between clients until it is listed here.
 */
export const NOT_DAEMON_WIDE = Object.freeze({
  session: Object.freeze([
    "AI_DEV_PROFILES",
    // How much a tool answers: the summary, or the whole record (`response-budget.mjs`).
    "AI_DEV_RESPONSE_MODE",
    "AI_DEV_OFFLINE",
    "AI_DEV_MODEL_MIRROR",
    "AI_DEV_PYTHON",
    "AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT",
    // Which variables the settings file filled in (`settings.mjs`).
    "AI_DEV_SETTINGS_APPLIED",
    // Read only to tell their users that 3.0 removed the Python backend.
    "BGE_M3_PYTHON",
    "BGE_M3_PYTHON_REVISION",
    "AI_DEV_EMBEDDINGS_PYTHON",
    "AI_DEV_PYTHON_BASE"
  ]),
  lifecycle: Object.freeze(["AI_DEV_DAEMON", "AI_DEV_DAEMON_START_TIMEOUT_MS", "AI_DEV_IDLE_TIMEOUT_MS"]),
  hooks: Object.freeze([
    "AI_DEV_CONTEXT_WINDOW_TOKENS",
    "AI_DEV_DISABLED_HOOKS",
    "AI_DEV_FACT_FORCE",
    "AI_DEV_FACT_FORCE_EXEMPT",
    "AI_DEV_HOOKS_ENABLED",
    "AI_DEV_HOOK_PROFILE",
    "AI_DEV_OSV_API",
    "AI_DEV_SESSION_START_MAX_CHARS",
    "AI_DEV_SUPPLY_CHAIN"
  ]),
  launchers: Object.freeze([
    "AI_DEV_IMAGE",
    "AI_DEV_PROJECT_PATH",
    "AI_DEV_MODEL_PATH",
    "AI_DEV_DATA_VOLUME",
    "AI_DEV_DOCKER_NETWORK",
    "AI_DEV_RUNTIME_CONTAINER",
    "AI_DEV_MCP_LAUNCHER",
    "AI_DEV_MCP_BEARER_TOKEN",
    "AI_DEV_NODE",
    "AI_DEV_DEBUG_LOG",
    "AI_DEV_VERSION",
    "AI_DEV_BOOTSTRAP_NODE_IMAGE",
    "AI_DEV_INSTALLER_IMAGE",
    "AI_DEV_INSTALLER_LAUNCHER"
  ]),
  // The desktop app's own: where its server is, its test hooks, its developer
  // tools, the runtime it ships and its updates. A client never sets them, so
  // the app would get a daemon of its own.
  desktop: Object.freeze(["AI_DEV_SERVER_ROOT", "AI_DEV_DESKTOP_TEST", "AI_DEV_DESKTOP_DEVTOOLS", "AI_DEV_DESKTOP_NO_SANDBOX", "AI_DEV_DESKTOP_BUNDLE", "AI_DEV_DESKTOP_UPDATES"]),
  // Build tooling: the Windows installer's signer (desktop/scripts/runtime-bundle.mjs) among them.
  tooling: Object.freeze([
    "AI_DEV_SIGN_AZURE_ENDPOINT",
    "AI_DEV_SIGN_AZURE_ACCOUNT",
    "AI_DEV_SIGN_AZURE_PROFILE",
    "AI_DEV_SIGN_PUBLISHER",
    "AI_DEV_FAKE_BACKEND",
    "AI_DEV_MCP_SERVER_PATH",
    "AI_DEV_SOURCE_VAULT_ROOT",
    "AI_DEV_SYSTEM_ROOT",
    "AI_DEV_TEST_LAUNCHER",
    "AI_DEV_TEST_SH"
  ])
});

const NOT_DAEMON_WIDE_NAMES = new Set(Object.values(NOT_DAEMON_WIDE).flat());

/**
 * Variables that hold a path. The bridge resolves them against its own working
 * directory before anything else sees them: the daemon runs in another one,
 * and a relative `AI_DEV_HOME` meant one folder to the client and another to
 * the daemon it started.
 */
const PATH_VARIABLES = new Set([
  "AI_DEV_HOME",
  "HOME",
  "USERPROFILE",
  "AI_DEV_VAULT_ROOT",
  "AI_DEV_STATE_ROOT",
  "AI_DEV_SEARCH_INDEX_DIR",
  "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_ARTIFACT_ROOT",
  "AI_DEV_ARCHIFY_RECEIPTS_ROOT",
  "AI_DEV_MODEL_MANIFEST",
  "BGE_M3_ONNX_DIR",
  "BGE_M3_MODEL_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR"
]);

/** A variable's name as the system compares it: Windows ignores case. */
const foldName = (name, platform) => (platform === "win32" ? name.toUpperCase() : name);

/**
 * Whether `name` is the spelling a child process gets when an environment
 * object holds two spellings of one name on Windows: Node's `spawn` keeps the
 * first in sorted order. An upper-case spelling sorts
 * before every other.
 */
const spawnKeeps = (name, held) => held === undefined || name < held;

/**
 * Whether two clients must set `name` alike to share a daemon.
 *
 * @param {string} name
 * @param {{ platform?: string }} [options]
 * @returns {boolean}
 */
export function isDaemonWide(name, { platform = process.platform } = {}) {
  const key = foldName(String(name), platform);
  if (DAEMON_WIDE.has(key)) return true;
  return /^(?:AI_DEV|BGE)_/.test(key) && !NOT_DAEMON_WIDE_NAMES.has(key);
}

/**
 * The daemon-wide variables `env` sets, sorted by name; a blank value counts
 * as unset, as the server reads it. On Windows the names are upper-cased.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ platform?: string }} [options]
 * @returns {Array<[string, string]>}
 */
export function daemonWideEnvironment(env, { platform = process.platform } = {}) {
  const found = new Map();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null || !String(value).trim()) continue;
    if (!isDaemonWide(name, { platform })) continue;
    const key = foldName(name, platform);
    if (spawnKeeps(name, found.get(key)?.[0])) found.set(key, [name, String(value)]);
  }
  return [...found].map(([key, [, value]]) => [key, value]).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The variables `daemonIdentity` resolves to a place rather than comparing as written. */
const RESOLVED_VARIABLES = new Set([
  "AI_DEV_HOME", "HOME", "USERPROFILE", "AI_DEV_VAULT_ROOT", "AI_DEV_VAULT", "AI_DEV_STATE_ROOT", "AI_DEV_SEARCH_INDEX_DIR",
  "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT", "AI_DEV_ARCHIFY_ARTIFACT_ROOT", "AI_DEV_ARCHIFY_RECEIPTS_ROOT",
  "BGE_M3_ONNX_DIR", "BGE_M3_MODEL_DIR", "AI_DEV_MODEL_MANIFEST", "AI_DEV_DENSE_BACKEND", "BGE_M3_DEVICE", "AI_DEV_RUNTIME"
]);

/**
 * A path with its deepest existing folder resolved through links and the rest
 * appended as written: the answer stays the same when the rest is created, so
 * a runtime home under a link (`/var` on macOS, a moved home, an 8.3 name) is
 * one folder before the bridge makes it and after.
 */
function realPrefix(resolved, paths) {
  const rest = [];
  let current = resolved;
  for (;;) {
    try {
      return paths.join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = paths.dirname(current);
      if (parent === current) return resolved;
      rest.push(paths.basename(current));
      current = parent;
    }
  }
}

/**
 * A folder as the platform compares folders: through links, with one kind of
 * separator, no trailing one, and on Windows without case. The daemon's build
 * and the search index's owner (`search-index-owner.mjs`) compare folders so.
 *
 * @param {string} value
 * @param {string} [platform]
 * @returns {string}
 */
export function canonicalFolder(value, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let resolved = paths.resolve(String(value ?? ""));
  if (platform === process.platform) resolved = realPrefix(resolved, paths);
  const plain = resolved.replaceAll("\\", "/").replace(/(.)\/+$/, "$1");
  return platform === "win32" ? plain.toLowerCase() : plain;
}

/**
 * What a daemon's clients must have in common, by name: where the data is —
 * resolved as the server resolves it, so two spellings of one folder are one
 * — the switches it reads once, and the Node it runs on. Any other `AI_DEV_*`
 * or `BGE_*` variable is compared as written.
 *
 * The home folder is read as the server reads it for project identity
 * (`userHomeDirectory` in `project-identity.mjs`): `USERPROFILE` before `HOME`
 * on Windows, the other way round elsewhere — so Git Bash's `HOME` beside a
 * GUI client's `USERPROFILE` is one home, not two.
 *
 * @param {{ serverRoot: string, env?: NodeJS.ProcessEnv, platform?: string, execPath?: string }} options
 * @returns {Record<string, string>} each entry named by what a person sets to change it
 */
export function daemonIdentity({ serverRoot, env = process.env, platform = process.platform, execPath = process.execPath }) {
  // On Windows a name ignores case, as `process.env` does there: the bridge
  // hands a plain copy, the daemon its own environment, and both must read
  // `Ai_Dev_Vault_Root` as the vault.
  const view = platform === "win32" ? environmentObject(env, { platform }) : env;
  const read = (name) => String(view?.[name] ?? "").trim();
  const folder = (value) => (value ? canonicalFolder(value, platform) : "");
  const layout = resolveInstallLayout({ serverRoot, env: view });
  const runtime = layout.runtimeRoot;
  const under = (name, ...segments) => folder(read(name) || path.join(runtime, ...segments));
  const home = platform === "win32" ? read("USERPROFILE") || read("HOME") : read("HOME") || read("USERPROFILE");
  // The runtime tree and the protected project root read `USERPROFILE` first
  // everywhere (`resolveUserHome`); where that is another folder than the home
  // — WSL passing the Windows profile on — it is a part of its own.
  const profile = folder(read("USERPROFILE") || read("HOME"));
  const identity = {
    "the home folder": folder(home),
    ...(profile !== folder(home) ? { USERPROFILE: profile } : {}),
    AI_DEV_HOME: folder(runtime),
    AI_DEV_VAULT_ROOT: folder(layout.contentRoot),
    AI_DEV_STATE_ROOT: under("AI_DEV_STATE_ROOT", "state"),
    AI_DEV_SEARCH_INDEX_DIR: under("AI_DEV_SEARCH_INDEX_DIR", "cache", "search-index"),
    AI_DEV_FRONTEND_QA_ARTIFACT_ROOT: under("AI_DEV_FRONTEND_QA_ARTIFACT_ROOT", "artifacts", "frontend-qa"),
    AI_DEV_ARCHIFY_ARTIFACT_ROOT: under("AI_DEV_ARCHIFY_ARTIFACT_ROOT", "artifacts", "archify"),
    AI_DEV_ARCHIFY_RECEIPTS_ROOT: under("AI_DEV_ARCHIFY_RECEIPTS_ROOT", "state", "archify-receipts"),
    BGE_M3_ONNX_DIR: under("BGE_M3_ONNX_DIR", "models", "bge-m3-onnx"),
    BGE_M3_MODEL_DIR: under("BGE_M3_MODEL_DIR", "models", "bge-m3"),
    AI_DEV_MODEL_MANIFEST: folder(read("AI_DEV_MODEL_MANIFEST")),
    AI_DEV_DENSE_BACKEND: read("AI_DEV_DENSE_BACKEND").toLowerCase(),
    BGE_M3_DEVICE: read("BGE_M3_DEVICE") || "cpu",
    AI_DEV_RUNTIME: read("AI_DEV_RUNTIME").toLowerCase() === "docker" ? "docker" : "",
    "the Node executable": folder(execPath)
  };
  for (const [name, value] of daemonWideEnvironment(view, { platform })) {
    if (!RESOLVED_VARIABLES.has(name)) identity[name] = value;
  }
  return identity;
}

/**
 * A copy of `env` with every path variable made absolute against `cwd`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ cwd?: string, platform?: string }} [options]
 * @returns {Record<string, string>}
 */
export function absolutePathVariables(env, { cwd = process.cwd(), platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const copy = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    copy[name] = PATH_VARIABLES.has(foldName(name, platform)) && text.trim() && !paths.isAbsolute(text) ? paths.resolve(cwd, text) : text;
  }
  return copy;
}

/**
 * An environment object as `process.env` is one: string values, an assignment
 * stored as a string, and on Windows names that ignore case, so a session's
 * `Path` is found as `PATH`.
 *
 * @param {Record<string, unknown>} variables
 * @param {{ platform?: string }} [options]
 * @returns {Record<string, string>}
 */
export function environmentObject(variables, { platform = process.platform } = {}) {
  const fold = (name) => foldName(name, platform);
  const entries = new Map();
  for (const [name, value] of Object.entries(variables ?? {})) {
    if (value === undefined || value === null) continue;
    if (spawnKeeps(name, entries.get(fold(name))?.[0])) entries.set(fold(name), [name, String(value)]);
  }
  const own = (name) => typeof name === "string" && entries.has(fold(name));
  const store = (name, value) => {
    const key = fold(name);
    entries.set(key, [entries.get(key)?.[0] ?? name, String(value)]);
    return true;
  };
  // `util.inspect` looks at a proxy's target, not through its traps: the
  // target itself says how to show what the environment holds.
  const shown = { [inspect.custom]: (depth, options, inspectValue) => inspectValue(Object.fromEntries([...entries.values()]), options) };
  return new Proxy(shown, {
    get: (target, name) => (own(name) ? entries.get(fold(name))[1] : Reflect.get(target, name)),
    set: (target, name, value) => (typeof name === "string" ? store(name, value) : Reflect.set(target, name, value)),
    has: (target, name) => own(name) || Reflect.has(target, name),
    deleteProperty: (target, name) => {
      if (typeof name === "string") entries.delete(fold(name));
      return true;
    },
    ownKeys: () => [...entries.values()].map(([name]) => name),
    getOwnPropertyDescriptor: (target, name) => (own(name)
      ? { value: entries.get(fold(name))[1], writable: true, enumerable: true, configurable: true }
      : undefined),
    defineProperty: (target, name, descriptor) => (typeof name === "string" && "value" in descriptor ? store(name, descriptor.value) : false),
    // An environment is never sealed: a frozen one would make every listing of it throw.
    preventExtensions: () => false
  });
}

const sessions = new AsyncLocalStorage();

/**
 * Run `operation` for a session: until it and everything it sets off are done,
 * `process.env` is `environment` — once {@link scopeProcessEnvironment} has
 * made it so in this process.
 *
 * @template T
 * @param {Record<string, string>} environment - from {@link environmentObject}
 * @param {() => T} operation
 * @returns {T}
 */
export function runInSession(environment, operation) {
  return sessions.run(environment, operation);
}

/** The environment of the session this code runs for, or null outside any session. */
export const currentSessionEnvironment = () => sessions.getStore() ?? null;

const scoped = new WeakSet();

/**
 * Make `target.env` the environment of the session the running code belongs
 * to, and the process's own outside any session. Done once, by the daemon,
 * before it loads the server; a process without sessions is never changed.
 *
 * Reading, writing, listing and spreading `process.env` all go to the
 * session's environment, and so does a child process started without an
 * `env` of its own. What reads the system's environment directly — native
 * code, a worker thread's copy, `os.tmpdir()` on macOS and Linux (on Windows
 * it reads `process.env.TEMP`, so the session's) — sees the daemon's.
 *
 * Two things a session cannot change: `structuredClone(process.env)` throws,
 * as for any proxy (spread it first); and a module evaluated for the first
 * time inside a session keeps what it read from `process.env` then, for every
 * session after — a module reads per call what belongs to a session.
 *
 * @param {{ env: NodeJS.ProcessEnv }} [target]
 */
export function scopeProcessEnvironment(target = process) {
  if (scoped.has(target)) return;
  scoped.add(target);
  const own = target.env;
  const current = () => sessions.getStore() ?? own;
  // `util.inspect` looks at a proxy's target, not through its traps.
  const shown = { [inspect.custom]: (depth, options, inspectValue) => inspectValue({ ...current() }, options) };
  target.env = new Proxy(shown, {
    get: (_, name) => (name === inspect.custom ? shown[inspect.custom] : Reflect.get(current(), name)),
    set: (_, name, value) => Reflect.set(current(), name, value),
    has: (_, name) => Reflect.has(current(), name),
    deleteProperty: (_, name) => Reflect.deleteProperty(current(), name),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_, name) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), name);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    defineProperty: (_, name, descriptor) => Reflect.defineProperty(current(), name, descriptor),
    // As the real one: `Object.freeze(process.env)` fails instead of leaving a
    // proxy every later listing of the environment would throw on.
    preventExtensions: () => false
  });
}

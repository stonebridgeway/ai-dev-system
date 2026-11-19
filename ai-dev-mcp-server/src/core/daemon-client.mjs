/**
 * The client side of the daemon: find the one serving this build, start one
 * when there is none, and ask the daemons of this runtime home for their
 * status or to stop. Used by the `ai-dev mcp` bridge and by `ai-dev daemon`.
 *
 * A daemon is started detached and without a window (`windowsHide`), with its
 * output in `logs/daemon.log`, so it outlives the client that started it and
 * serves the next one warm.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ChannelError, addressListening, buildDifferences, controlRequest, describeBuild, nothingListens, openChannel, readDaemonInfo, removeDaemonInfo } from "./daemon-channel.mjs";
import { EMPTY_LOCK_GRACE_MS, processAlive, processState, tryAcquireFileLock } from "./file-lock.mjs";
import { DAEMON_DESCRIPTOR_NAME, RETIRED_DAEMON_NAME, daemonInfoPath, daemonLogPath, runtimeDir } from "./runtime-paths.mjs";
import { absolutePathVariables } from "./session-env.mjs";
import { applySettingsToEnvironment } from "./settings.mjs";

/** How long a client waits for a daemon it started. A first start fills the vault and loads the tools. */
export const DEFAULT_START_TIMEOUT_MS = 20_000;

/** The log is set aside once it passes this, so it never grows without bound; the daemon does the same as it runs. */
const LOG_ROTATE_BYTES = 1024 * 1024;

/** A daemon's lock is abandoned when it has not been refreshed this long (`src/daemon.mjs`). */
const DAEMON_LOCK_STALE_MS = 60_000;

/**
 * How long after a started daemon stepped aside — another of this build was
 * starting — the client starts one again, if none has shown up: the other may
 * have died between creating the lock and filling it in, and its empty lock is
 * abandoned once its grace has passed.
 */
const RESTART_AFTER_MS = EMPTY_LOCK_GRACE_MS + 500;

/** How many daemons one client starts at most while it waits. */
const MAX_STARTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The environment of `given` as a daemon for it sees it: relative paths made
 * absolute, and the settings file applied as every CLI command applies it —
 * the daemon applies it to its own too. So the build is the same on both
 * sides, and a session started from here, the desktop app's, has the mirror
 * and the model folder the settings name.
 *
 * @param {NodeJS.ProcessEnv} given
 * @param {{ platform?: string }} [options] - On Windows a variable's name ignores case.
 * @returns {Record<string, string>} a copy
 */
export function daemonEnvironment(given, { platform = process.platform } = {}) {
  const env = absolutePathVariables(given);
  applySettingsToEnvironment(env, { platform });
  return env;
}

/** A message for the middle of a sentence: without the full stop it ends with. */
const clause = (message) => String(message ?? "").trim().replace(/\.+$/, "");

/**
 * `AI_DEV_DAEMON_START_TIMEOUT_MS`, or the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function startTimeoutMs(env = process.env) {
  const value = Number(String(env.AI_DEV_DAEMON_START_TIMEOUT_MS ?? "").trim() || Number.NaN);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_START_TIMEOUT_MS;
}

/**
 * Whether `AI_DEV_DAEMON` turns the daemon off: `0`, `off`, `false` or `no`.
 * Then `ai-dev mcp` serves in its own process, as 2.x did.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function daemonDisabled(env = process.env) {
  return ["0", "off", "false", "no"].includes(String(env.AI_DEV_DAEMON ?? "").trim().toLowerCase());
}

/**
 * The log a started daemon writes to, opened for appending. A large one is set
 * aside first — copied, then cut to nothing, as the daemon itself does — so a
 * daemon already writing to it goes on writing to the same file. It is the log
 * of the runtime home `env` names.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function openLog(env) {
  const file = daemonLogPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) {
      fs.copyFileSync(file, `${file}.1`);
      fs.truncateSync(file, 0);
    }
  } catch {
    // No log yet.
  }
  return fs.openSync(file, "a", 0o600);
}

/**
 * The last lines of the daemon's log: what it said before it failed to start.
 *
 * @param {number} [count]
 * @param {NodeJS.ProcessEnv} [env] - The environment the daemon was started in.
 * @returns {Promise<string>}
 */
export async function logTail(count = 4, env = process.env) {
  const file = daemonLogPath(env);
  try {
    const text = await fsp.readFile(file, "utf8");
    const lines = text.trimEnd().split(/\r?\n/).slice(-count);
    return lines.length ? `Its log (${file}) ends with: ${lines.join(" | ")}` : "";
  } catch {
    return "";
  }
}

/**
 * Start a daemon in the background.
 *
 * @param {{ cliPath: string, serverRoot: string, env: NodeJS.ProcessEnv, spawnImpl?: typeof spawn }} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDaemon({ cliPath, serverRoot, env, spawnImpl = spawn, execPath = process.execPath }) {
  const log = openLog(env);
  try {
    const child = spawnImpl(execPath, [cliPath, "daemon", "run"], {
      cwd: serverRoot,
      env,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", log, log]
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
}

/** A channel to the running daemon `info` describes, when it serves `build`; null when there is none to reach. */
async function reach(info, options, build) {
  if (!info || !processAlive(info.pid)) return null;
  let channel;
  try {
    channel = await openChannel(info, options);
  } catch {
    return null;
  }
  if (channel.welcome.build === build.id) return channel;
  channel.socket.destroy();
  return null;
}

/**
 * A channel to the daemon of this build: the one running, or one started now.
 *
 * Each build — the code, its version, the daemon-wide variables — has a
 * daemon of its own, so a client never waits on, or replaces, the daemon of
 * another copy of the code or another vault. For an
 * MCP session the channel carries `env` to the daemon: the session runs in it.
 *
 * @param {object} options
 * @param {string} options.serverRoot
 * @param {string} options.cliPath
 * @param {string} options.version
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {"mcp" | "control"} [options.mode]
 * @param {string | null} [options.profiles] - The session's; not given, the ones its environment
 *   names once the settings are applied — as `ai-dev mcp` has them.
 * @param {number} [options.timeoutMs]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {number} [options.restartAfterMs] - for tests
 * @param {string} [options.execPath] - The Node the daemon runs on, and its build counts: the caller's own
 *   when the caller is that Node, the Node the clients run when it is not (the desktop app).
 * @param {boolean} [options.start] - Start a daemon when none serves this build; false fails with code
 *   `ENOTRUNNING` instead.
 * @returns {Promise<{ socket: import("node:net").Socket, welcome: Record<string, any>, rest: Buffer, info: object, build: object, started: boolean }>}
 *   `started` is true only when this call started the daemon that answered.
 */
export async function connectDaemon({ serverRoot, cliPath, version, env: given = process.env, mode = "mcp", profiles = null, timeoutMs = startTimeoutMs(given), spawnImpl = spawn, restartAfterMs = RESTART_AFTER_MS, execPath = process.execPath, start: startOne = true }) {
  // The daemon runs in another folder than its caller: a relative path in the
  // environment means, for it too, what it means here; and it runs with the
  // settings applied.
  const env = daemonEnvironment(given);
  // The build includes the Node the daemon runs on: a caller that is not
  // that Node — the desktop app is Electron — names it (`execPath`).
  const build = await describeBuild({ serverRoot, version, env, execPath });
  // The daemon's runtime home is the one `env` names, which need not be this
  // process's: the desktop app reaches the daemon of the environment it shows.
  const descriptor = daemonInfoPath(build.id, env);
  const options = { mode, profiles: mode === "mcp" ? profiles ?? String(env.AI_DEV_PROFILES ?? "") : profiles, environment: env, timeoutMs: 3_000 };
  const running = await readDaemonInfo(descriptor);
  const channel = await reach(running, options, build);
  if (channel) return { ...channel, info: running, build, started: false };
  if (!startOne) throw new ChannelError("The ai-dev daemon is not running.", { code: "ENOTRUNNING" });

  let child;
  let exited = null;
  let starts = 0;
  const start = () => {
    child = spawnDaemon({ cliPath, serverRoot, env, spawnImpl, execPath });
    starts += 1;
    exited = null;
    child.once("exit", (code, signal) => {
      exited = { code, signal, at: Date.now() };
    });
    child.once("error", (error) => {
      exited = { error, at: Date.now() };
    });
  };
  start();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(50);
    const info = await readDaemonInfo(descriptor);
    const found = await reach(info, options, build);
    if (found) return { ...found, info, build, started: info.pid === child.pid };
    if (exited && (exited.error || exited.code !== 0)) {
      const why = exited.error ? clause(exited.error.message) : `it exited with ${exited.code ?? exited.signal}`;
      throw new ChannelError(`The daemon did not start: ${why}. ${await logTail(4, env)}`.trim(), { code: "ESTART" });
    }
    // Exit 0 is a daemon that found another of this build serving, or
    // starting: the wait goes on for that one — and when it never shows up,
    // another start takes over its abandoned lock.
    if (exited && Date.now() - exited.at >= restartAfterMs && starts < MAX_STARTS) start();
  }
  throw new ChannelError(`The daemon did not start within ${Math.round(timeoutMs / 1000)} s. ${await logTail(4, env)}`.trim(), { code: "ETIMEDOUT" });
}

/**
 * Remove the descriptor or retired record of a daemon that is gone — its
 * process ended, or its lock went stale because nothing refreshes it — and
 * only then: taking the file's lock proves no daemon holds it, whatever
 * process now has its pid. A daemon hung past its
 * lock's life still takes connections at its address: its record stays, and
 * `stop` asks it like any other.
 */
async function removeStale(file, info) {
  if (await addressListening(info.address)) return false;
  // run/ may have gone meanwhile — a runtime home deleted, a daemon leaving
  // took its empty folder — and then there is nothing left to remove: the
  // lock makes no folder.
  const taken = await tryAcquireFileLock(file, { staleMs: DAEMON_LOCK_STALE_MS, makeDirectory: false });
  if (!taken.release) return false;
  try {
    return await removeDaemonInfo(file, info.pid);
  } finally {
    await taken.release();
  }
}

/**
 * Every daemon of this runtime home, as each says of itself: those that serve
 * a build, and the retired ones finishing their sessions. One that cannot be
 * reached comes with the reason, and with `clean` its descriptor is removed
 * when its daemon is gone.
 *
 * @param {{ clean?: boolean, env?: NodeJS.ProcessEnv }} [options] - `env` names the runtime home.
 * @returns {Promise<Array<{ file: string, info: object, retired: boolean, status?: object, unreachable?: string, gone?: boolean, removed?: boolean }>>}
 *   `gone`: its process is not running, and only its descriptor is left.
 */
export async function listDaemons({ clean = false, env = process.env } = {}) {
  const directory = runtimeDir(env);
  let names;
  try {
    names = await fsp.readdir(directory);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    const retired = RETIRED_DAEMON_NAME.test(name);
    if (!retired && !DAEMON_DESCRIPTOR_NAME.test(name)) continue;
    const file = path.join(directory, name);
    const info = await readDaemonInfo(file);
    if (!info) continue;
    let status = null;
    let unreachable = "";
    let answering = false;
    const gone = !processAlive(info.pid);
    if (gone) {
      unreachable = `pid ${info.pid} is not running`;
    } else {
      try {
        status = await controlRequest(info, "status");
      } catch (error) {
        unreachable = clause(error.message);
        // A handshake that never came is a connection taken: a hung daemon,
        // not a gone one — and one probe fewer in its full queue.
        answering = !nothingListens(error);
      }
    }
    if (status) {
      found.push({ file, info, retired, status });
      continue;
    }
    const removed = clean && !answering ? await removeStale(file, info).catch(() => false) : false;
    found.push({ file, info, retired, unreachable, gone, removed });
  }
  return found;
}

/** What `status` says of a daemon that is not this build's own. */
function summary(entry, build) {
  const { info, status, retired } = entry;
  return {
    pid: info.pid,
    version: status?.version ?? info.version,
    build: info.build,
    sessions: status?.sessions ?? info.sessions ?? 0,
    clients: status?.clients ?? [],
    rss_bytes: status?.rss_bytes,
    uptime_s: status?.uptime_s,
    retired: retired || Boolean(status?.retired),
    ...(retired || status?.retired ? { retired_reason: status?.retired_reason ?? info.retired_reason } : {}),
    differences: buildDifferences(build, info.build_parts),
    ...(entry.unreachable ? { unreachable: entry.unreachable, gone: Boolean(entry.gone) } : {})
  };
}

/**
 * What the daemon of this build says about itself — or why there is none —
 * and what the other daemons of this runtime home are: another build's, or
 * retired, each with why it is not this one.
 *
 * @param {{ serverRoot: string, version: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function daemonStatus({ serverRoot, version, env: given = process.env }) {
  const env = daemonEnvironment(given);
  const build = await describeBuild({ serverRoot, version, env });
  const daemons = await listDaemons({ env });
  const mine = daemons.find((entry) => !entry.retired && entry.status && entry.info.build === build.id);
  const stale = mine ? null : daemons.find((entry) => !entry.retired && !entry.status && entry.info.build === build.id);
  // Every other daemon is shown, a retired one that does not answer too: it
  // still has sessions, and `stop` is told why it cannot reach it.
  const others = daemons.filter((entry) => entry !== mine && entry !== stale).map((entry) => summary(entry, build));
  if (mine) return { running: true, ...mine.status, ok: undefined, current: true, others };
  return {
    running: false,
    build: build.id,
    info: daemonInfoPath(build.id, env),
    ...(stale ? { stale: true, pid: stale.info.pid, reason: stale.unreachable } : {}),
    others
  };
}

/**
 * Stop every daemon of this runtime home: a control request, the same on
 * every system — Windows has no signal to send — then a wait for its process
 * to go. The descriptor of a daemon already gone is removed on the way.
 *
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, state?: typeof processState }} [options] - `env` names the
 *   runtime home; `state` tells how a pid stands (a test's stand-in for this platform's).
 * @returns {Promise<{ daemons: Array<{ pid: number, build: string, retired: boolean, stopped: boolean, sessions?: number, reason?: string, removed?: boolean }> }>}
 */
export async function stopDaemons({ timeoutMs = 10_000, env = process.env, state: stateOf = processState } = {}) {
  const results = [];
  for (const entry of await listDaemons({ clean: true, env: absolutePathVariables(env) })) {
    const { info, retired } = entry;
    const base = { pid: info.pid, build: info.build, retired };
    if (entry.removed || entry.gone) {
      results.push({ ...base, stopped: true, gone: true });
      continue;
    }
    // A daemon that did not answer `status` may still take `stop`: the answer
    // it could not give is not the request it cannot take.
    let answer;
    try {
      answer = await controlRequest(info, "stop");
    } catch (error) {
      results.push({ ...base, stopped: false, reason: clause(error.message) });
      continue;
    }
    const deadline = Date.now() + timeoutMs;
    // A daemon that has exited may wait to be collected by the program that started it. Where only `ps` tells
    // the two apart, it is asked twice a second and once more at the end, not at every look.
    let state = stateOf(info.pid);
    for (let look = 1; (state === "running" || state === "unknown") && Date.now() < deadline; look += 1) {
      await sleep(50);
      state = stateOf(info.pid, { ask: look % 10 === 0 });
    }
    if (state === "unknown") state = stateOf(info.pid, { ask: true });
    const stopped = state === "gone" || state === "exited";
    const reason = state === "unknown"
      ? "its process is still there: it runs, or it has exited and the program that started it has not collected it yet"
      : "it is still running";
    results.push({ ...base, stopped, sessions: answer.sessions ?? 0, ...(stopped ? {} : { reason }) });
  }
  return { daemons: results };
}

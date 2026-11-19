#!/usr/bin/env node
/**
 * The daemon: one warm server for every AI client of this user.
 *
 * Each client still starts a process of its own — `ai-dev mcp`, which is what
 * its config names — but that process is a bridge: it hands the client's
 * stdio to this daemon over a local socket (`src/core/daemon-bridge.mjs`).
 * The search index, the skill registry and the embedding model are loaded
 * once, here, and the state the tools write has one writer.
 *
 * What it does on its own:
 *
 * - serves one build — the code, its version and the daemon-wide variables
 *   (`describeBuild`) — and holds that build's lock, so a build has one daemon
 *   per runtime home; a client of another build, another copy of the code or
 *   another vault, is served by a daemon of its own;
 * - listens on a random address and publishes it, with a secret, in
 *   `run/daemon-<build>.json` (mode 0600); every connection proves it holds the
 *   secret before it is served (`src/core/daemon-channel.mjs`);
 * - runs each session in its own client's environment (`session-env.mjs`);
 * - keeps the session count in its descriptor live, answers `status`, `stop`
 *   and `retire` on a control connection, and logs what it does to stderr —
 *   `logs/daemon.log` when a bridge started it, set aside past 1 MB;
 * - asks the daemon of code it replaced in place — a `git pull` — to retire:
 *   that one takes no new session, finishes the ones it has, and is listed in
 *   `run/retired-<pid>.json` until it exits;
 * - exits after `AI_DEV_IDLE_TIMEOUT_MS` without a session (30 minutes), and
 *   retires when its descriptor is gone or names another daemon.
 *
 * Until 3.0 the daemon had no client at all, died on a socket path over 107
 * bytes and always said `sessions: 0`; its Windows pipe
 * had a name anyone could take first.
 */
import { fstatSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ChannelError,
  addressListening,
  DAEMON_PROTOCOL,
  acceptHandshake,
  controlRequest,
  describeBuild,
  isSupersededBy,
  newSecret,
  readDaemonInfo,
  readDaemonInfoState,
  readLine,
  removeDaemonInfo,
  writeDaemonInfo,
  writeLine
} from "./core/daemon-channel.mjs";
import { MAX_IDLE_TIMEOUT_MS, idleTimeoutMs } from "./core/daemon-idle.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";
import { breakStaleLock, lockPathFor, tryAcquireFileLock } from "./core/file-lock.mjs";
import { prepareRuntimeHome } from "./core/runtime-home-migration.mjs";
import {
  DAEMON_DESCRIPTOR_NAME,
  daemonAddressCandidates,
  daemonInfoPath,
  daemonLogPath,
  foldersUpTo,
  prepareSocketDirectory,
  retiredDaemonPath,
  runtimeDir,
  tightenFolder
} from "./core/runtime-paths.mjs";
import { markServingDaemon } from "./core/serving-process.mjs";
import { environmentObject, runInSession, scopeProcessEnvironment } from "./core/session-env.mjs";
import { SocketServerTransport } from "./transport/socket.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(await fs.readFile(path.join(serverRoot, "package.json"), "utf8")).version;

/**
 * The lock goes stale when its holder has not refreshed it for this long. The
 * daemon refreshes it every {@link LOCK_HEARTBEAT_MS}, so a busy daemon keeps
 * it, and one that hangs — or whose pid the system gave to another program —
 * loses it within a minute.
 */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;

/** A holder this young may still be starting: it is not expected to answer yet. */
const LOCK_STARTUP_GRACE_MS = 60_000;

/** How long a live holder past its start may go without answering before its lock is taken over. */
const UNANSWERED_TAKEOVER_MS = 10_000;

/** How often the daemon checks its descriptor and the size of its log. */
const WATCH_INTERVAL_MS = 5_000;

/** The log is set aside, as `daemon.log.1`, once it passes this. */
export const LOG_ROTATE_BYTES = 1024 * 1024;

/** What a client says of itself is shown, never trusted to be short. */
const CLIENT_LABEL_CHARS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPipe = (address) => address.startsWith("\\\\.\\pipe\\");
const label = (value) => String(value ?? "").slice(0, CLIENT_LABEL_CHARS);

/** A line for the daemon's log. */
function writeLog(line) {
  process.stderr.write(`${new Date().toISOString()} daemon ${process.pid}: ${line}\n`);
}

/**
 * The log file this daemon writes to — when its stderr is the runtime's
 * `daemon.log`, as a bridge starts it — or null when it writes elsewhere, to
 * the terminal of `ai-dev daemon run`.
 */
function ownLogFile() {
  try {
    const written = fstatSync(2);
    const file = statSync(daemonLogPath());
    return written.dev === file.dev && written.ino === file.ino ? daemonLogPath() : null;
  } catch {
    return null;
  }
}

/** Whether the daemon `info` describes answers on its address. */
async function answers(info) {
  try {
    return (await controlRequest(info, "ping", { timeoutMs: 2_000 })).ok === true;
  } catch {
    return false;
  }
}

/** Whether it answers within `ms`, asked again every second. */
async function answersWithin(info, ms) {
  const deadline = Date.now() + ms;
  do {
    if (await answers(info)) return true;
    await sleep(1_000);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Take this build's lock, by the protocol every lock of AI Dev follows
 * (`file-lock.mjs`): created exclusively, so of two daemons starting at once
 * one has it; an abandoned one — its process gone, or silent past
 * {@link LOCK_STALE_MS} — broken under the protocol's own mutex and only while
 * it is still the lock judged abandoned; one being created this very moment,
 * still empty, left to its maker. A holder that is
 * alive but has answered nobody for {@link UNANSWERED_TAKEOVER_MS} past its
 * start — its socket removed, its listener dead — is taken over too. Its
 * process is left alone either way: a pid in a file is not proof enough to
 * kill anything.
 *
 * @returns {Promise<{ lock?: { release: () => Promise<void>, holds: () => Promise<boolean> }, holder?: number, serving?: boolean }>}
 */
async function acquireLock({ descriptor, log }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const taken = await tryAcquireFileLock(descriptor, { staleMs: LOCK_STALE_MS, heartbeatMs: LOCK_HEARTBEAT_MS, record: { started_at: Date.now() }, directoryMode: 0o700 });
    if (taken.release) return { lock: taken };
    const { observed } = taken;
    if (!observed) continue;
    const holder = Number(observed.holder?.pid) || 0;
    const { state, info } = await readDaemonInfoState(descriptor);
    if (info?.pid === holder && await answers(info)) return { holder, serving: true };
    const startedAt = Number(observed.holder?.started_at) || Number(observed.mtimeMs) || 0;
    if (!holder || state === "unreadable" || Date.now() - startedAt < LOCK_STARTUP_GRACE_MS) return { holder, serving: false };
    if (info?.pid === holder && await answersWithin(info, UNANSWERED_TAKEOVER_MS)) return { holder, serving: true };
    log(`taking the lock over from pid ${holder}: it is alive, but no daemon has answered for it`);
    if (!(await breakStaleLock(lockPathFor(descriptor), observed, { force: true }))) return { holder, serving: false };
  }
  return { holder: 0, serving: false };
}

/**
 * Bind `listener` to an address: the umask keeps the socket this user's from
 * the moment it exists, and the chmod says so again.
 */
function listenOn(listener, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    listener.once("error", onError);
    // `listen` binds a path synchronously, so the umask is back before any
    // other code of this process creates a file.
    const previous = process.platform === "win32" ? null : process.umask(0o077);
    try {
      listener.listen(address, () => {
        listener.off("error", onError);
        resolve();
      });
    } finally {
      if (previous !== null) process.umask(previous);
    }
  });
}

/**
 * Listen on the first candidate address that works: a directory that is too
 * long, not this user's, or on a file system without sockets (a WSL mount, a
 * network share) passes the turn to the next one.
 */
async function listenSomewhere(listener, log) {
  const candidates = daemonAddressCandidates();
  let lastError = new Error("No directory leaves room for the daemon's socket.");
  for (const { address, directory } of candidates) {
    try {
      if (directory) await prepareSocketDirectory(directory);
      await listenOn(listener, address);
      if (directory) await fs.chmod(address, 0o600);
      return address;
    } catch (error) {
      lastError = error;
      log(`cannot listen at ${address}: ${error.message}`);
    }
  }
  throw lastError;
}

/**
 * Serve MCP to every client of this build that connects, until stopped or idle.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [options]
 * @returns {Promise<boolean>} false when a daemon of this build already serves, or is starting
 */
export async function runDaemon({ env = process.env, log = writeLog } = {}) {
  await prepareRuntimeHome({ env, log: (line) => log(line.replace(/^ai-dev: /, "")) });
  const build = await describeBuild({ serverRoot, version: VERSION, env });
  const descriptor = daemonInfoPath(build.id);
  await fs.mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  // The journal says what is true of run/, not what was attempted; a
  // look that fails says nothing of its mode.
  const tightened = await tightenFolder(runtimeDir()).catch((error) => ({ state: "left", why: `it cannot be checked (${error?.code ?? error?.message ?? error})` }));
  if (tightened.state === "tightened") log(`${runtimeDir()} was open to other users; it is 0700 now`);
  else if (tightened.state === "open") log(`${runtimeDir()} is open to other users and stays so: ${tightened.why}`);
  else if (tightened.state === "left" && tightened.why && process.platform !== "win32") log(`${runtimeDir()}: its mode is left as it is, ${tightened.why}`);
  const taken = await acquireLock({ descriptor, log });
  if (!taken.lock) {
    log(`another daemon (pid ${taken.holder || "unknown"}) ${taken.serving ? "serves" : "is starting for"} this build in ${runtimeDir()}; this one is not needed`);
    return false;
  }
  const { lock } = taken;

  // From here on, what a session's messages set off reads that session's
  // client's environment; the daemon's own work reads the one it started with.
  scopeProcessEnvironment();

  // The tools, the index and the seed sync load while the socket already
  // takes connections; a session waits for them, a status request does not.
  let serverLoaded = false;
  const serverModule = import("./server.mjs").then((module) => {
    serverLoaded = true;
    return module;
  });
  serverModule.catch((error) => log(`the server failed to load: ${error.stack ?? error.message}`));

  const secret = newSecret();
  const requestedIdle = Number(String(env.AI_DEV_IDLE_TIMEOUT_MS ?? "").trim());
  const idleTimeout = idleTimeoutMs(env);
  const logFile = ownLogFile();
  const startedAt = new Date();
  const sockets = new Set();
  const clients = new Map();
  let sessions = 0;
  let served = 0;
  let retired = null;
  let retiredLock = null;
  // The highest folder this daemon made again for its retired record, if any.
  let madeFolder = "";
  let stopping = false;
  // Set once the daemon leaves: nothing it publishes after that may outlive it.
  let finishing = false;
  let idleTimer = null;
  let watch = null;
  let address = "";

  const buildParts = { version: build.version, root: build.root, source: build.source, environment: build.environment };
  const describe = () => ({
    protocol: DAEMON_PROTOCOL,
    pid: process.pid,
    version: VERSION,
    build: build.id,
    build_parts: buildParts,
    address,
    secret,
    started_at: startedAt.toISOString(),
    sessions,
    server_root: serverRoot,
    log: logFile,
    idle_timeout_ms: idleTimeout,
    ...(retired ? { retired: true, retired_at: retired.at, retired_reason: retired.reason } : {})
  });

  // The descriptor while serving, the retired record after: each written
  // whole, one at a time, never after the daemon began to stop.
  // The lock on a retired daemon's record, taken before the record is written.
  // A daemon hung past the lock's life (a debugger, SIGSTOP, swap) finds it
  // broken and its record cleared when it wakes, and takes it again before it
  // lists itself: a record nobody holds is one `stop` may clear.
  // Its folder is made private as the run folder
  // always is, even where the runtime home was deleted meanwhile.
  const holdRetiredRecord = async () => {
    if (await retiredLock?.holds().catch(() => false)) return true;
    await retiredLock?.release().catch(() => undefined);
    retiredLock = null;
    // A folder made again here — the runtime home was deleted under this
    // daemon — goes when the daemon does, if it is still empty.
    // Each folder made again is the start of the same path to run/: the
    // shortest is the highest. The record's lock makes the folder
    // itself when it went again in between, and says which.
    const run = path.dirname(retiredDaemonPath(process.pid));
    const made = await fs.mkdir(run, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const taken = await tryAcquireFileLock(retiredDaemonPath(process.pid), { staleMs: LOCK_STALE_MS, heartbeatMs: LOCK_HEARTBEAT_MS, directoryMode: 0o700 }).catch(() => ({}));
    for (const folder of [made, taken.madeFolder]) {
      if (folder && (!madeFolder || path.toNamespacedPath(folder).length < path.toNamespacedPath(madeFolder).length)) madeFolder = folder;
    }
    retiredLock = taken.release ? taken : null;
    return Boolean(retiredLock);
  };

  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing
      .then(async () => {
        if (stopping || finishing) return undefined;
        if (!retired) return writeDaemonInfo(descriptor, describe());
        if (!(await holdRetiredRecord())) return undefined;
        return writeDaemonInfo(retiredDaemonPath(process.pid), describe());
      })
      .catch((error) => log(`could not update ${retired ? retiredDaemonPath(process.pid) : descriptor}: ${error.message}`));
    return publishing;
  };

  const status = () => ({
    pid: process.pid,
    version: VERSION,
    build: build.id,
    build_parts: buildParts,
    address,
    started_at: startedAt.toISOString(),
    uptime_s: Math.round((Date.now() - startedAt.getTime()) / 1000),
    sessions,
    sessions_served: served,
    clients: [...clients.values()],
    rss_bytes: process.memoryUsage.rss(),
    idle_timeout_ms: idleTimeout,
    retired: Boolean(retired),
    ...(retired ? { retired_at: retired.at, retired_reason: retired.reason } : {}),
    server_root: serverRoot,
    log: logFile
  });

  // The descriptor goes while the lock is still this daemon's, so a successor
  // — which needs the lock to publish — can never lose its descriptor to it.
  const releaseDescriptor = async () => {
    await publishing;
    if (await lock.holds()) await removeDaemonInfo(descriptor, process.pid).catch(() => undefined);
    await lock.release().catch(() => undefined);
  };

  const finish = async (reason) => {
    if (finishing) return;
    finishing = true;
    if (serverLoaded) {
      const { shutdownBgeWorkers } = await import("./mcp-stdio.mjs");
      await Promise.resolve(shutdownBgeWorkers()).catch(() => undefined);
    }
    await publishing;
    await fs.rm(retiredDaemonPath(process.pid), { force: true }).catch(() => undefined);
    await retiredLock?.release().catch(() => undefined);
    if (address && !isPipe(address)) await fs.rm(address, { force: true }).catch(() => undefined);
    // Empty folders only: a neighbour's files keep theirs (`rmdir` refuses).
    // On Windows `mkdir` named the folder in the `\\?\` namespace.
    for (const folder of foldersUpTo(runtimeDir(), madeFolder)) await fs.rmdir(folder).catch(() => undefined);
    log(`exits: ${reason}`);
    process.exit(0);
  };

  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    clearInterval(watch);
    log(`stopping: ${reason}; ${sessions} session(s) end with it`);
    listener.close();
    for (const socket of sockets) socket.destroy();
    await releaseDescriptor();
    await finish(reason);
  };

  // A retired daemon takes no new session. It gives up its descriptor and its
  // lock at once, so a successor can start, lists itself in
  // `run/retired-<pid>.json`, finishes the sessions it has, and still answers
  // `status` and `stop` on its address. It holds a lock on that record as it
  // held one on its descriptor, so a record it left behind — killed, or gone
  // with the machine — is told apart from a live one whatever later has its
  // pid.
  const retire = async (reason) => {
    if (retired || stopping) return;
    retired = { at: new Date().toISOString(), reason };
    clearTimeout(idleTimer);
    log(`retiring: ${reason}; ${sessions} session(s) stay until their clients close them`);
    await releaseDescriptor();
    if (sessions === 0) {
      await finish(`retired: ${reason}`);
      return;
    }
    await publish();
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (retired || stopping || sessions > 0 || idleTimeout <= 0) return;
    idleTimer = setTimeout(() => shutdown(`no session for ${Math.round(idleTimeout / 1000)} s`), idleTimeout);
    idleTimer.unref?.();
  };

  const control = async (socket, rest) => {
    const { message } = await readLine(socket, { buffered: rest });
    const reply = async (value) => {
      await writeLine(socket, value).catch(() => undefined);
      socket.end();
    };
    switch (message.control) {
      case "ping":
        return reply({ ok: true });
      case "status":
        return reply({ ok: true, ...status() });
      case "stop":
        await reply({ ok: true, stopping: true, sessions });
        return shutdown("asked to stop");
      case "retire":
        await reply({ ok: true, retiring: true, sessions });
        return retire("the code it runs was replaced, and a daemon of the new code serves now");
      default:
        return reply({ ok: false, error: `Unknown control request: ${JSON.stringify(message.control ?? null)}.` });
    }
  };

  const serve = async (socket) => {
    const accepted = await acceptHandshake(socket, {
      secret,
      pid: process.pid,
      version: VERSION,
      build: build.id,
      welcome: async ({ mode, profiles }) => {
        if (mode !== "mcp") return {};
        if (retired || stopping) throw new ChannelError(`This daemon ${stopping ? "is stopping" : "has retired"} and takes no new session.`, { code: "ERETIRED" });
        return (await serverModule).sessionToolCounts(profiles);
      }
    });
    if (accepted.mode === "control") return control(socket, accepted.rest);
    const { createAiDevServer } = await serverModule;
    if (socket.destroyed) return undefined;
    const environment = environmentObject(accepted.environment);
    const id = ++served;
    sessions += 1;
    sockets.add(socket);
    clearTimeout(idleTimer);
    publish();
    const server = createAiDevServer({ profiles: accepted.profiles });
    server.onerror = (error) => log(`session ${id}: ${error.message}`);
    server.oninitialized = () => {
      const client = server.getClientVersion();
      clients.set(socket, { session: id, name: label(client?.name), version: label(client?.version), since: new Date().toISOString() });
      log(`session ${id} opened: ${label(client?.name) || "a client"} ${label(client?.version)}`.trim());
    };
    socket.once("close", () => {
      sessions = Math.max(0, sessions - 1);
      sockets.delete(socket);
      clients.delete(socket);
      server.close().catch(() => undefined);
      log(`session ${id} closed; ${sessions} open`);
      if (stopping) return;
      if (retired && sessions === 0) {
        finish("retired, and its last session closed");
        return;
      }
      publish();
      armIdle();
    });
    // Everything this session's messages set off reads its own client's environment.
    await server.connect(new SocketServerTransport(socket, { buffered: accepted.rest, scope: (deliver) => runInSession(environment, deliver) }));
    return undefined;
  };

  const listener = net.createServer((socket) => {
    socket.on("error", () => undefined);
    if (stopping) {
      socket.destroy();
      return;
    }
    serve(socket).catch((error) => {
      log(`refused a connection: ${error.message}`);
      socket.destroy();
    });
  });

  // A dead daemon's socket outlives it, and nothing else would remove it. One
  // whose lock was taken over may still be alive, though — it will retire and
  // answer `status` and `stop` on that socket — and
  // what tells the two apart is the socket itself: a live one, even hung,
  // takes connections, whoever has the pid now.
  const previous = await readDaemonInfo(descriptor);
  if (previous && previous.pid !== process.pid && !isPipe(previous.address) && !(await addressListening(previous.address))) {
    await fs.rm(previous.address, { force: true }).catch(() => undefined);
  }
  try {
    address = await listenSomewhere(listener, log);
    await writeDaemonInfo(descriptor, describe());
    // `system_status` says which process answers it, and how busy it is.
    markServingDaemon({ build: build.id, startedAt: startedAt.toISOString(), idleTimeoutMs: idleTimeout, sessions: () => sessions, retired: () => retired });
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
  const idleNote = idleTimeout <= 0 ? "none" : `${Math.round(idleTimeout / 1000)} s${requestedIdle > MAX_IDLE_TIMEOUT_MS ? " (AI_DEV_IDLE_TIMEOUT_MS asks for more than a timer holds)" : ""}`;
  log(`listening at ${address} — ai-dev ${VERSION}, build ${build.id}, idle timeout ${idleNote}`);

  // The daemon of the code this one replaced in place steps aside; daemons of
  // other builds serve clients of their own and are left alone.
  for (const name of await fs.readdir(runtimeDir()).catch(() => [])) {
    const match = DAEMON_DESCRIPTOR_NAME.exec(name);
    if (!match || match[1] === build.id) continue;
    const other = await readDaemonInfo(path.join(runtimeDir(), name));
    if (!other || !isSupersededBy(build, other.build_parts)) continue;
    const answer = await controlRequest(other, "retire").catch(() => null);
    if (answer?.ok) log(`the daemon of the code this one replaced (pid ${other.pid}) retires; ${answer.sessions ?? 0} session(s) stay with it until they close`);
  }

  // A long-lived daemon sets its own log aside: copied, then cut to nothing, so
  // every daemon writing to it — each holds it open for appending — goes on
  // writing to the same file.
  const rotateLog = async () => {
    if (!logFile || ownLogFile() !== logFile) return;
    const size = (await fs.stat(logFile).catch(() => null))?.size ?? 0;
    if (size <= LOG_ROTATE_BYTES) return;
    await fs.copyFile(logFile, `${logFile}.1`);
    await fs.truncate(logFile, 0);
    log(`set the log aside as ${path.basename(logFile)}.1 (${size} bytes)`);
  };

  // A descriptor that is gone, or names another daemon, on two looks in a row
  // means this one was replaced or its runtime home removed: it steps aside
  // instead of serving on an address nobody can find. One look is not enough:
  // Windows refuses a file for a moment while it is renamed over or scanned.
  let strikes = 0;
  watch = setInterval(async () => {
    await rotateLog().catch(() => undefined);
    if (stopping || finishing) return;
    if (retired) {
      // A record taken away while this daemon lives — counted gone while it
      // hung, its runtime home wiped — is published again, so `status` and
      // `stop` find it.
      const { state, info } = await readDaemonInfoState(retiredDaemonPath(process.pid));
      const lost = state === "missing" || state === "invalid" || (state === "ok" && info.pid !== process.pid);
      if (lost || !(await retiredLock?.holds().catch(() => false))) await publish();
      return;
    }
    const { state, info } = await readDaemonInfoState(descriptor);
    const replaced = state === "missing" || (state === "ok" && info.pid !== process.pid);
    strikes = replaced ? strikes + 1 : 0;
    if (strikes >= 2) retire(state === "missing" ? "its descriptor is gone" : `its descriptor names pid ${info.pid} now`);
  }, WATCH_INTERVAL_MS);
  watch.unref();

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  armIdle();
  return true;
}

if (await isDirectExecution(import.meta.url)) {
  await runDaemon();
}

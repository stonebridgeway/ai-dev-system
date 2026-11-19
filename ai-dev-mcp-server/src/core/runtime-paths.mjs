import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/**
 * The private, per-user state directory the standalone program runs from.
 *
 * Everything the daemon writes lives below it: its lock, the descriptor other
 * processes read to find it, and — when the path is short enough — its socket.
 *
 * @param {NodeJS.ProcessEnv} [env] - Whose home: a client starting a daemon
 *   for another environment than its own names it (`daemon-transport.mjs`).
 * @returns {string} absolute path
 */
export function aiDevHome(env = process.env) {
  return path.resolve(resolveRuntimeStateRoot("", env));
}

/** Directory for live runtime artefacts (lock, daemon descriptor, usually the socket). */
export const runtimeDir = (env) => path.join(aiDevHome(env), "run");

/** Directory for runtime logs. */
export const logsDir = (env) => path.join(aiDevHome(env), "logs");

/**
 * The descriptor the daemon of one build publishes: pid, version, address,
 * secret, sessions. Each build has its own, so clients that need different
 * daemons — another copy of the code, another vault — each find theirs instead
 * of replacing each other's. Its lock is beside it,
 * `<descriptor>.lock`, as `file-lock.mjs` names locks.
 *
 * @param {string} build - the build's id, 16 hex digits
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export const daemonInfoPath = (build, env) => path.join(runtimeDir(env), `daemon-${build}.json`);

/** A descriptor's file name; the first group is the build. */
export const DAEMON_DESCRIPTOR_NAME = /^daemon-([0-9a-f]{16})\.json$/;

/**
 * What a retired daemon publishes while it finishes the sessions it has: the
 * descriptor it gave up, so `ai-dev daemon status` can show it and
 * `ai-dev daemon stop` can stop it.
 *
 * @param {number} pid
 * @returns {string}
 */
export const retiredDaemonPath = (pid) => path.join(runtimeDir(), `retired-${pid}.json`);

/** A retired daemon's file name; the first group is its pid. */
export const RETIRED_DAEMON_NAME = /^retired-(\d+)\.json$/;

/** Where the daemon writes what it does, when a bridge started it. */
export const daemonLogPath = (env) => path.join(logsDir(env), "daemon.log");

/** Per-user client configuration (trusted projects, and what else accrues). */
export const clientConfigPath = () => path.join(aiDevHome(), "config.json");

/** Root of persisted task state. */
export const tasksStateRoot = () => path.join(aiDevHome(), "state");

/**
 * The longest socket path used. `sockaddr_un` holds 108 bytes on Linux and 104
 * on macOS, terminating NUL included, and libuv cuts a longer path short
 * without a word: `listen` then makes a socket under a truncated name and the
 * daemon dies on the next call that names the real one.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * A new, unguessable name for one daemon's socket or pipe.
 *
 * Every daemon start draws its own, and its descriptor says which it is. A fixed
 * name — `\\.\pipe\ai-dev-<user>` until 3.0 — is one any local process can
 * create first and so receive every client's connection.
 *
 * @param {Buffer} [bytes]
 * @returns {string}
 */
export function randomDaemonName(bytes = crypto.randomBytes(12)) {
  return `ai-dev-${bytes.toString("hex")}`;
}

/**
 * The directories a daemon's Unix socket may live in, in order of preference:
 * the runtime's own `run/`, then `$XDG_RUNTIME_DIR/ai-dev`, then
 * `/tmp/ai-dev-<uid>`. The second and third are there for a runtime home whose
 * path leaves too little room for a socket name: a OneDrive profile, a CI
 * workspace, a container volume.
 *
 * @param {{ runDir?: string, env?: NodeJS.ProcessEnv, uid?: number, tmp?: string }} [options]
 * @returns {string[]}
 */
export function socketDirectoryCandidates({ runDir = runtimeDir(), env = process.env, uid = process.getuid?.() ?? 0, tmp = "/tmp" } = {}) {
  const candidates = [runDir];
  const xdg = String(env.XDG_RUNTIME_DIR ?? "").trim();
  if (xdg && path.isAbsolute(xdg)) candidates.push(path.join(xdg, "ai-dev"));
  candidates.push(path.join(tmp, `ai-dev-${uid}`));
  return candidates;
}

/**
 * Where a new daemon may listen: a named pipe on Windows; elsewhere, a socket
 * in each candidate directory whose full path fits {@link MAX_SOCKET_PATH_BYTES}
 * — counted in bytes, so a home spelled in Cyrillic is measured as the kernel
 * measures it. The daemon takes the first one it can prepare and bind.
 *
 * @param {{ platform?: string, name?: string, runDir?: string, env?: NodeJS.ProcessEnv, uid?: number, tmp?: string }} [options]
 * @returns {Array<{ address: string, directory: string | null }>}
 */
export function daemonAddressCandidates({ platform = process.platform, name = randomDaemonName(), ...where } = {}) {
  if (platform === "win32") return [{ address: `\\\\.\\pipe\\${name}`, directory: null }];
  return socketDirectoryCandidates(where)
    .map((directory) => ({ address: path.join(directory, `${name}.sock`), directory }))
    .filter(({ address }) => Buffer.byteLength(address) <= MAX_SOCKET_PATH_BYTES);
}

/**
 * Make a socket's directory, and make sure it is this user's alone: a plain
 * directory, not a link, owned by this uid, with no access for group or
 * others. `/tmp/ai-dev-<uid>` can be created by anyone before the daemon gets
 * there; a directory that is not ours is refused rather than used, and so is
 * one a file system leaves open after chmod.
 *
 * @param {string} directory
 * @param {{ uid?: number }} [options]
 * @returns {Promise<void>}
 */
export async function prepareSocketDirectory(directory, { uid = process.getuid?.() } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Checked and changed through one handle that never followed a link.
  let handle;
  try {
    handle = await fs.open(directory, FOLDER_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw new Error(`${directory} is not a plain directory.`);
    const owner = await foreignOwner(directory, uid, error);
    if (owner !== undefined) throw new Error(`${directory} belongs to uid ${owner}, not to this user (${uid}).`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error(`${directory} is not a plain directory.`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${directory} belongs to uid ${stat.uid}, not to this user (${uid}).`);
    if ((stat.mode & 0o077) !== 0) {
      await handle.chmod(0o700);
      if (((await handle.stat()).mode & 0o077) !== 0) throw new Error(`${directory} stays open to other users: its file system keeps the mode it has.`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Open a folder itself, never a link in its place: what is checked is what is
 * changed. Windows has neither flag, and nothing here
 * opens a folder there: a pipe needs none, and modes do not guard folders.
 */
const FOLDER_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * The owner of a folder this user may not open, when it is someone else: a
 * private folder of another user's refuses the open itself, and the refusal
 * should say whose it is.
 *
 * @returns {Promise<number | undefined>}
 */
async function foreignOwner(directory, uid, error) {
  if (uid === undefined || (error?.code !== "EACCES" && error?.code !== "EPERM")) return undefined;
  const stat = await fs.lstat(directory).catch(() => null);
  return stat && stat.uid !== uid ? stat.uid : undefined;
}

/**
 * Make a folder of this user's private when group or others can get into it:
 * the daemon's run folder, as an older version's lock race or the 2.x
 * layout's migration left it. The folder is opened
 * without following a link, checked and changed through that handle, and
 * checked again — a file system that takes the change and keeps its mode
 * says so.
 *
 * @param {string} directory
 * @param {{ uid?: number, platform?: string }} [options]
 * @returns {Promise<{ state: "private" | "tightened" | "open" | "left", why?: string }>}
 *   `private`: it already was; `tightened`: it is now; `open`: it stays open
 *   to others, `why` says why; `left`: not a plain folder of this user's — a
 *   link, another user's, gone — or Windows, where modes do not guard folders.
 */
export async function tightenFolder(directory, { uid = process.getuid?.(), platform = process.platform } = {}) {
  if (platform === "win32") return { state: "left", why: "modes do not guard folders on Windows" };
  let handle;
  try {
    handle = await fs.open(directory, FOLDER_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") return { state: "left", why: "it is not a plain folder (a link?)" };
    const owner = await foreignOwner(directory, uid, error);
    return { state: "left", why: owner === undefined ? `it cannot be opened (${error?.code ?? error})` : `it belongs to uid ${owner}` };
  }
  try {
    const before = await handle.stat();
    if (!before.isDirectory()) return { state: "left", why: "it is not a folder" };
    if (uid !== undefined && before.uid !== uid) return { state: "left", why: `it belongs to uid ${before.uid}` };
    if ((before.mode & 0o077) === 0) return { state: "private" };
    try {
      await handle.chmod(0o700);
    } catch (error) {
      return { state: "open", why: `its mode cannot be changed (${error?.code ?? error})` };
    }
    const after = await handle.stat();
    return (after.mode & 0o077) === 0 ? { state: "tightened" } : { state: "open", why: "its file system keeps the mode it has" };
  } finally {
    await handle.close();
  }
}

/**
 * The folders from `start` up to `top`, both included — what a daemon
 * leaving removes when they are empty — or none when `top` is not `start` or
 * one of its parents. `top` is as `fs.mkdir` returned it, on Windows in the
 * `\\?\` namespace, so both are compared that way.
 *
 * @param {string} start
 * @param {string} top
 * @param {{ pathApi?: typeof path }} [options]
 * @returns {string[]}
 */
export function foldersUpTo(start, top, { pathApi = path } = {}) {
  if (!start || !top) return [];
  const target = pathApi.toNamespacedPath(top);
  const folders = [];
  for (let folder = start; ; folder = pathApi.dirname(folder)) {
    const spelled = pathApi.toNamespacedPath(folder);
    if (spelled !== target && !spelled.startsWith(`${target}${pathApi.sep}`)) return [];
    folders.push(folder);
    if (spelled === target) return folders;
    if (pathApi.dirname(folder) === folder) return [];
  }
}

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process file locks for the files several processes write at once.
 *
 * Every MCP client starts its own server process, and the agent hooks run as
 * processes of their own, so the in-process queue in `atomic-files.mjs` cannot
 * order their writes: three writers appending 200 lines each kept about 210 of
 * the 600. A lock file beside the target serialises
 * them. `hooks/lib.mjs` carries a synchronous copy of this protocol — the hooks
 * run in other people's repositories without this package — and the two must
 * stay interchangeable: same lock path, same holder record, same staleness rule
 * (AGENTS.md, rule 3).
 *
 * The protocol:
 * - the lock is `<target>.lock`, created with `wx` (exclusive) and holding
 *   `{ pid, host, token, acquired_at }`;
 * - a holder is stale when its process is gone (same host) or the lock is older
 *   than {@link LOCK_STALE_MS} — locks are held for milliseconds, so that bound
 *   only ever fires for an abandoned one, including one whose pid was reused;
 * - a lock with no readable holder — its writer was killed between creating it
 *   and filling it in — is stale after {@link EMPTY_LOCK_GRACE_MS};
 * - a stale lock is broken under a second, short-lived lock, `<target>.lock.break`,
 *   and only if it is still the very file judged stale — same file identity,
 *   same holder — so two processes breaking one abandoned lock cannot remove each
 *   other's fresh one, and nothing is ever renamed away and put back;
 * - release deletes the lock only if it still carries this holder's token;
 * - a holder that keeps a lock for long (the search-index rebuild) refreshes
 *   `acquired_at` while it holds it, so a short staleness bound can tell an
 *   abandoned lock from a busy one even across hosts, where the pid cannot be
 *   checked — a container killed mid-rebuild leaves a lock that every other
 *   container sharing the volume would otherwise wait out;
 * - a process that exits — `process.exit` on SIGTERM included — removes the
 *   locks it still holds on the way out.
 */

/** Suffix of the lock file that sits beside the file it guards. */
export const LOCK_SUFFIX = ".lock";

/** A lock held longer than this is abandoned, whoever holds it. */
export const LOCK_STALE_MS = 30_000;

/**
 * How long a lock with no readable holder counts as live. Creating the lock and
 * writing its holder are two system calls; a writer killed between them leaves
 * an empty lock nobody can attribute, and one that has been empty this long was
 * left by exactly that.
 */
export const EMPTY_LOCK_GRACE_MS = 2_000;

/**
 * How long a writer waits for a live holder before giving up — longer than a
 * lock takes to go stale, so a lock abandoned by a process whose pid was reused
 * (quick on Windows) delays a write rather than failing it.
 */
export const LOCK_TIMEOUT_MS = 45_000;

/** A breaker holds `<lock>.break` for milliseconds; one this old was abandoned mid-break. */
export const BREAK_LOCK_STALE_MS = 5_000;

/**
 * Errors Windows answers for a file another process is creating, deleting or
 * holding open: the lock is in use, not broken.
 */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

const MAX_BACKOFF_MS = 50;

/** Locks this process holds, lock path → token, for the exit handler. */
const held = new Map();
let exitHandlerInstalled = false;

/**
 * Remove, synchronously, every lock this process still holds. `process.exit`
 * runs no `finally`, so a signal handler that exits would otherwise leave them
 * behind for others to wait out.
 */
function releaseHeldLocksSync() {
  for (const [lockPath, token] of held) {
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8"))?.token === token) rmSync(lockPath, { force: true });
    } catch {
      // Gone already, or not readable: nothing of ours to remove.
    }
  }
  held.clear();
}

function holdLock(lockPath, token) {
  held.set(lockPath, token);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once("exit", releaseHeldLocksSync);
  }
}

/**
 * Prove a held lock alive: rewrite its holder with a new `acquired_at`, through
 * a descriptor on the very file this holder created, and only while it still
 * carries this holder's token — never over a lock someone else has taken since.
 */
async function refreshLock(lockPath, token, id) {
  let handle;
  try {
    handle = await fs.open(lockPath, "r+");
  } catch {
    return;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (`${stat.dev}:${stat.ino}` !== id) return;
    const holder = JSON.parse(await handle.readFile("utf8"));
    if (holder?.token !== token) return;
    // Written over the old holder, then cut to length: never an empty file in
    // between for another process to read. The new record is as long as the
    // old one but for the rare extra digit, and one small write is read whole.
    const text = JSON.stringify({ ...holder, acquired_at: Date.now() });
    await handle.write(text, 0, "utf8");
    await handle.truncate(Buffer.byteLength(text));
  } catch {
    // Unreadable for a moment, or gone: the next beat tries again.
  } finally {
    // A network file system can report a deferred write error here; nothing
    // waits for a beat, so a throw would end the process.
    await handle.close().catch(() => {});
  }
}

/**
 * Path of the lock file guarding `filePath`.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function lockPathFor(filePath) {
  return `${path.resolve(filePath)}${LOCK_SUFFIX}`;
}

/**
 * A process's state letter from `/proc/<pid>/stat` (`R`, `S`, `Z` …); "" when
 * the process is not there; null where there is no `/proc` to read.
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function procStateLetter(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The name in parentheses may hold spaces and ")": the state follows the last one.
    return stat.charAt(stat.lastIndexOf(")") + 2) || null;
  } catch (error) {
    return error?.code === "ENOENT" && existsSync("/proc/self/stat") ? "" : null;
  }
}

/**
 * A process's state letter from `ps` (macOS and the BSDs have no `/proc`); ""
 * when `ps` knows no such process; null when `ps` could not be asked.
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function psStateLetter(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, shell: false, windowsHide: true });
  if (result.error || result.signal) return null;
  return result.status === 0 ? result.stdout.trim().charAt(0) : "";
}

/**
 * How the process with this pid stands on this machine:
 *
 * - "gone" — there is none;
 * - "exited" — it has exited, and the process that started it has not collected
 *   it yet: a zombie, which `kill(pid, 0)` still answers for. A daemon started by
 *   a program whose event loop is held up stays one until the loop runs;
 * - "running";
 * - "unknown" — it is there, and nothing here tells whether it still runs:
 *   no `/proc`, and `ps` was not asked (`ask`) or could not answer; or they
 *   do not show the process `kill` has just found — a `/proc` mounted with
 *   `hidepid` hides someone else's, and one that exited in between is caught
 *   by `kill` at the next look.
 *
 * `EPERM` means the process exists and belongs to someone else. Windows has no
 * zombies: a process that has exited is gone to `kill(pid, 0)`.
 *
 * @param {number} pid
 * @param {{ ask?: boolean, platform?: string, proc?: (pid: number) => string | null, ps?: (pid: number) => string | null }} [options]
 * @returns {"gone" | "exited" | "running" | "unknown"}
 */
export function processState(pid, { ask = false, platform = process.platform, proc = procStateLetter, ps = psStateLetter } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return "gone";
  }
  if (platform === "win32") return "running";
  let letter = proc(pid);
  if (letter === null && ask) letter = ps(pid);
  if (letter === null || letter === "") return "unknown";
  return letter === "Z" || letter === "X" ? "exited" : "running";
}

/**
 * Whether a process with this pid is running on this machine: one that has
 * exited and waits to be collected is not, where `/proc` tells; one
 * that belongs to someone else (`EPERM`) still counts.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function processAlive(pid) {
  const state = processState(pid);
  return state === "running" || state === "unknown";
}

/**
 * Is the lock described by `holder` still owned by a live writer?
 *
 * An unreadable or half-written holder (the creator is between `open` and
 * `write`, or was killed there) is judged by the lock file's own age against
 * {@link EMPTY_LOCK_GRACE_MS} instead.
 *
 * @param {{ holder: object|null, mtimeMs: number }} observed
 * @param {{ now?: number, staleMs?: number, emptyGraceMs?: number, host?: string, alive?: (pid: number) => boolean }} [options]
 * @returns {boolean}
 */
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

/**
 * What the lock file says and which file it is, read through one descriptor so
 * the identity and the holder belong to the same file.
 *
 * @param {string} lockPath
 * @returns {Promise<{ holder: object|null, mtimeMs: number, id: string, unreadable?: boolean } | null>} null when there is no lock
 */
export async function readLock(lockPath) {
  let handle;
  try {
    handle = await fs.open(lockPath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (TRANSIENT_CODES.has(error?.code)) return { holder: null, mtimeMs: Date.now(), id: "", unreadable: true };
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const text = await handle.readFile("utf8");
    let holder = null;
    try {
      holder = JSON.parse(text);
    } catch {
      holder = null;
    }
    return { holder, mtimeMs: Number(stat.mtimeMs), id: `${stat.dev}:${stat.ino}` };
  } finally {
    await handle.close();
  }
}

/** The same lock file holding the same holder: identity, token, and for an empty holder its mtime. */
export function sameLock(left, right) {
  if (!left || !right || !left.id || left.id !== right.id) return false;
  const leftToken = left.holder?.token ?? null;
  if (leftToken !== (right.holder?.token ?? null)) return false;
  return leftToken !== null || left.mtimeMs === right.mtimeMs;
}

/**
 * Remove an abandoned lock without ever removing a fresh one.
 *
 * Breakers take `<lock>.break` first, so only one at a time decides. Under it
 * the lock is read again and removed only if it is still the file judged stale
 * and still stale; a lock that was released and taken again in between is a
 * different file and stays. A breaker killed mid-break leaves `<lock>.break`
 * behind, and the next breaker clears it after {@link BREAK_LOCK_STALE_MS}.
 *
 * `force` removes the observed lock even while its holder counts as live — for
 * a holder known to be stuck, such as a daemon that keeps its lock but answers
 * nobody; it is still removed only if it is the very lock observed.
 *
 * @param {string} lockPath
 * @param {{ holder: object|null, mtimeMs: number, id: string }} observed - the lock as judged stale
 * @param {{ staleMs?: number, force?: boolean }} [options]
 * @returns {Promise<boolean>} whether the lock was removed
 */
export async function breakStaleLock(lockPath, observed, { staleMs = LOCK_STALE_MS, force = false } = {}) {
  const breaker = `${lockPath}.break`;
  try {
    await (await fs.open(breaker, "wx", 0o600)).close();
  } catch (error) {
    if (error?.code === "EEXIST") {
      const left = await fs.stat(breaker).catch(() => null);
      if (left && Date.now() - left.mtimeMs >= BREAK_LOCK_STALE_MS) await fs.rm(breaker, { force: true });
      return false;
    }
    if (error?.code === "ENOENT" || TRANSIENT_CODES.has(error?.code)) return false;
    throw error;
  }
  try {
    const current = await readLock(lockPath);
    if (!sameLock(current, observed) || (!force && lockIsLive(current, { staleMs }))) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await fs.rm(breaker, { force: true }).catch(() => undefined);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create the lock file, exclusively, holding this process's holder record; or
 * null when it already exists. The lock comes back with its release, a check
 * that it is still this holder's, and — with `heartbeatMs` — a beat that keeps
 * proving it alive. A folder made for it is handed to `madeFolder` at once,
 * whether the lock is then taken or not.
 */
async function createLock(lockPath, { record = {}, heartbeatMs = 0, directoryMode, makeDirectory = true, madeFolder = () => {} } = {}) {
  const token = crypto.randomUUID();
  let handle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code === "ENOENT" && attempt === 0 && makeDirectory) {
        // A folder made here gets the mode its owner asked for: the locks the
        // daemon takes in run/ make it 0700.
        madeFolder(await fs.mkdir(path.dirname(lockPath), { recursive: true, ...(directoryMode === undefined ? {} : { mode: directoryMode }) }));
        continue;
      }
      // Windows answers EPERM for a lock file another process is deleting.
      if (error?.code === "EEXIST" || (process.platform === "win32" && TRANSIENT_CODES.has(error?.code))) return null;
      throw error;
    }
  }
  let id;
  try {
    await handle.writeFile(JSON.stringify({ ...record, pid: process.pid, host: os.hostname(), token, acquired_at: Date.now() }));
    const stat = await handle.stat({ bigint: true });
    id = `${stat.dev}:${stat.ino}`;
  } finally {
    await handle.close();
  }
  holdLock(lockPath, token);
  const beat = heartbeatMs > 0 ? setInterval(() => refreshLock(lockPath, token, id).catch(() => {}), heartbeatMs) : null;
  beat?.unref?.();
  return {
    token,
    async holds() {
      const current = await readLock(lockPath).catch(() => null);
      return current?.id === id && current?.holder?.token === token;
    },
    async release() {
      if (beat) clearInterval(beat);
      try {
        await releaseLock(lockPath, token);
      } finally {
        // Only once the file is gone: an exit in the middle of the release
        // still finds the lock to remove.
        if (held.get(lockPath) === token) held.delete(lockPath);
      }
    }
  };
}

/**
 * Take the lock for `filePath` now, or say who holds it — for a lock held as
 * long as a process lives, such as the daemon's, rather than for one write. An
 * abandoned lock is broken first, as {@link acquireFileLock} does; a live one is
 * reported, never waited for.
 *
 * @param {string} filePath - The file the lock guards (not the lock itself).
 * @param {{ staleMs?: number, heartbeatMs?: number, record?: Record<string, unknown>, directoryMode?: number, makeDirectory?: boolean }} [options] - `record`
 *   adds fields to the holder; the protocol's own fields are always this process's. `directoryMode`: the mode of a
 *   folder the lock has to make. `makeDirectory: false`: a missing folder is not made; there is no lock then.
 * @returns {Promise<{ release: () => Promise<void>, holds: () => Promise<boolean>, token: string, madeFolder?: string } | { observed: object | null, madeFolder?: string }>}
 *   `madeFolder`: the highest folder the tries made for the lock, as `fs.mkdir` names it (on Windows in the `\\?\`
 *   namespace) — also when another process took the lock first.
 */
export async function tryAcquireFileLock(filePath, { staleMs = LOCK_STALE_MS, heartbeatMs = 0, record = {}, directoryMode, makeDirectory = true } = {}) {
  const lockPath = lockPathFor(filePath);
  let observed = null;
  let made;
  // Each folder made is the start of the same path to the lock: the shortest is the highest.
  const madeFolder = (folder) => {
    if (folder && (!made || folder.length < made.length)) made = folder;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let taken;
    try {
      taken = await createLock(lockPath, { record, heartbeatMs, directoryMode, makeDirectory, madeFolder });
    } catch (error) {
      // The folder is gone and the caller wants none made: nothing to lock.
      if (!makeDirectory && error?.code === "ENOENT") return { observed: null };
      throw error;
    }
    if (taken) return Object.assign(taken, { madeFolder: made });
    observed = await readLock(lockPath);
    if (!observed) continue;
    if (lockIsLive(observed, { staleMs }) || !(await breakStaleLock(lockPath, observed, { staleMs }))) return { observed, madeFolder: made };
  }
  return { observed, madeFolder: made };
}

/**
 * Take the lock for `filePath`, waiting for a live holder and breaking an
 * abandoned one.
 *
 * @param {string} filePath - The file the lock guards (not the lock itself).
 * @param {{ timeoutMs?: number, staleMs?: number, heartbeatMs?: number }} [options] - `heartbeatMs`
 *   refreshes the holder that often while the lock is held; it has to be well under `staleMs`.
 * @returns {Promise<() => Promise<void>>} release
 */
export async function acquireFileLock(filePath, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, heartbeatMs = 0 } = {}) {
  const lockPath = lockPathFor(filePath);
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    const taken = await createLock(lockPath, { heartbeatMs });
    if (taken) return taken.release;
    const observed = await readLock(lockPath);
    if (observed && !lockIsLive(observed, { staleMs })) {
      if (await breakStaleLock(lockPath, observed, { staleMs })) continue;
    }
    if (Date.now() >= deadline) {
      const owner = observed?.holder?.pid ? ` (held by pid ${observed.holder.pid})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the lock ${lockPath}${owner}.`);
    }
    await sleep(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Delete the lock if it is still ours. Windows can refuse for a moment while
 * another process reads it, so a refusal is retried; a lock that cannot be
 * removed at all goes stale and is broken by the next writer.
 */
async function releaseLock(lockPath, token) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current = await readLock(lockPath);
      if (current?.unreadable) throw Object.assign(new Error("lock busy"), { code: "EBUSY" });
      if (current?.holder?.token === token) await fs.rm(lockPath, { force: true });
      return;
    } catch (error) {
      if (!TRANSIENT_CODES.has(error?.code)) throw error;
      await sleep(10 * (attempt + 1));
    }
  }
}

/**
 * Run `operation` while holding the cross-process lock for `filePath`.
 *
 * Not re-entrant: an operation must not take the same lock again.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(filePath, operation, options = {}) {
  const release = await acquireFileLock(filePath, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

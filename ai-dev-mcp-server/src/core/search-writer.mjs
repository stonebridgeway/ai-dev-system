/**
 * Taking the search index for writing, and handing it back, without stopping
 * anyone: the cross-process rebuild lock, SQLite's write lock waited for
 * between turns of the event loop, the checkpoint after a full rewrite, and a
 * damaged file set aside.
 *
 * `search-store.mjs` writes the index; this is what keeps several writers —
 * other clients' servers, a 2.x server's Python helper, another container on
 * the same volume — from stepping on each other or waiting each other out.
 */
import fs from "node:fs";
import { acquireFileLock, lockPathFor } from "./file-lock.mjs";
import { BUSY_TIMEOUT_MS, isBusyError } from "./search-sqlite.mjs";

/** How long a rebuild waits for another one, unless the environment says otherwise. */
export const DEFAULT_REBUILD_LOCK_TIMEOUT_SECONDS = 600;

/**
 * A rebuild lock not refreshed for this long is abandoned, whatever host or pid
 * it names. The holder refreshes it every {@link REBUILD_LOCK_HEARTBEAT_MS}, so
 * a rebuild of any length keeps it; a holder killed mid-rebuild — a container
 * on a shared volume, whose pid nobody else can check — frees it within a
 * minute instead of the half hour a fixed bound had to allow for.
 */
export const REBUILD_LOCK_STALE_MS = 60_000;

/** How often a rebuild proves its lock alive. */
export const REBUILD_LOCK_HEARTBEAT_MS = 10_000;

/**
 * The rebuild lock's wait, from `AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT` in
 * seconds; a value that is not a number leaves the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} milliseconds
 */
export function rebuildLockTimeoutMs(env = process.env) {
  const raw = env.AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT;
  const seconds = raw === undefined || String(raw).trim() === "" ? Number.NaN : Number(raw);
  return Math.max(0, Number.isNaN(seconds) ? DEFAULT_REBUILD_LOCK_TIMEOUT_SECONDS : seconds) * 1000;
}

/**
 * Run `operation` holding the index's rebuild lock, across processes.
 *
 * @template T
 * @param {string} indexPath
 * @param {() => Promise<T>} operation
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<T>}
 */
export async function withRebuildLock(indexPath, operation, { env = process.env } = {}) {
  let release;
  try {
    release = await acquireFileLock(indexPath, {
      timeoutMs: rebuildLockTimeoutMs(env),
      staleMs: REBUILD_LOCK_STALE_MS,
      heartbeatMs: REBUILD_LOCK_HEARTBEAT_MS
    });
  } catch (error) {
    if (!/^Timed out/.test(String(error?.message))) throw error;
    throw new Error(`Timed out waiting for search-index rebuild lock: ${lockPathFor(indexPath)}`, { cause: error });
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Pauses between attempts at setting a damaged index aside while another process has it open. */
export const SET_ASIDE_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200];

/** What Windows answers for a file another process has open: wait, do not give up. */
const IN_USE = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Set a file that is not a database aside, with its WAL files, so a new one
 * can take its place.
 *
 * On Windows SQLite opens the file without delete sharing, so while any other
 * process has it open — another client's server between two searches — the
 * rename is refused. Every reader lets go of the file when it is idle or finds
 * it damaged (`createIndexReader`), so the attempts are spread over a few
 * seconds; a file still held after them is reported for what it is.
 *
 * @param {string} indexPath
 * @param {{ fsImpl?: typeof fs, delays?: number[] }} [options]
 * @returns {Promise<void>}
 */
export async function setAside(indexPath, { fsImpl = fs, delays = SET_ASIDE_DELAYS_MS } = {}) {
  const target = `${indexPath}.corrupt`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (fsImpl.existsSync(indexPath)) {
        fsImpl.rmSync(target, { force: true });
        fsImpl.renameSync(indexPath, target);
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) fsImpl.rmSync(`${indexPath}${suffix}`, { force: true });
      return;
    } catch (error) {
      if (!IN_USE.has(error?.code)) throw error;
      if (attempt >= delays.length) {
        throw new Error(
          `The search index ${indexPath} is damaged and another process still has it open (${error.code}), `
          + "so it cannot be replaced yet. It is replaced on a later search, once that process lets go of it; "
          + "closing the other AI clients frees it now.",
          { cause: error }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * Take the write lock without stopping the event loop. `busy_timeout` makes
 * SQLite wait inside the call, and `node:sqlite` is synchronous: a writer from
 * another process holding the file for seconds froze this whole server for
 * them. So the wait is ours, between turns of the loop, for as long as
 * `busy_timeout` would have waited.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ timeoutMs?: number }} [options]
 */
export async function beginImmediate(db, { timeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = 20;
  db.exec("PRAGMA busy_timeout = 0");
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!isBusyError(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 250);
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

/**
 * Fold the WAL back into the file after a full rewrite, so it does not stay
 * the size of the whole index. Best effort, and without waiting: a TRUNCATE
 * checkpoint waits for every reader on an older snapshot — a hybrid search or
 * a galaxy export in another client — and with `busy_timeout` it waited inside
 * the call, freezing this server for as long as that reader read. With no busy
 * wait it does what it can and leaves the rest to SQLite's own checkpoints.
 */
export function checkpoint(db) {
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    // Busy readers, or no WAL: the next checkpoint does it.
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch {
      // A connection that cannot take a pragma is closed next anyway.
    }
  }
}

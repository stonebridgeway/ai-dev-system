/**
 * `node:sqlite` for the search index: loading it, knowing whether it can hold
 * the index at all, and opening the file so that several processes share it.
 *
 * - The module is there unflagged from Node 22.13, but its SQLite is built
 *   without FTS5 until 22.16 (and on 23.x), and the index is an FTS5 table. So
 *   support is measured, not inferred from the version, and where it is
 *   missing search says which Node it needs.
 * - Loading the module prints "ExperimentalWarning: SQLite is an experimental
 *   feature" on every server start. That one warning is swallowed while the
 *   module loads; every other warning is left alone.
 * - Every connection waits for a lock (`busy_timeout`) instead of failing,
 *   reads retry on a busy file as the Python helper did, and the writer puts
 *   the file in WAL mode so a rebuild in one process never blocks a search in
 *   another.
 */
import fs from "node:fs";
import path from "node:path";

/** How long a statement waits for another connection's lock. */
export const BUSY_TIMEOUT_MS = 10_000;

/** Pauses between attempts at a read that found the file busy, as `search_cli.py` had them. */
export const READ_RETRY_DELAYS_MS = [150, 350, 750];

/** A read connection unused this long is closed, so the file is not held open between searches. */
export const READER_IDLE_MS = 5_000;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

let sqliteModule;
let support;

/** Whether a warning being emitted is the one `node:sqlite` prints on load. */
function isSqliteExperimentalWarning(warning, rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type ?? warning?.name;
  const message = typeof warning === "string" ? warning : warning?.message;
  return type === "ExperimentalWarning" && /^SQLite is an experimental feature/.test(String(message ?? ""));
}

/**
 * The `node:sqlite` module, or null where this Node has none.
 *
 * @returns {typeof import("node:sqlite") | null}
 */
export function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest)) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    sqliteModule = process.getBuiltinModule?.("node:sqlite") ?? null;
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqliteModule;
}

/**
 * Whether this Node can hold the search index: `node:sqlite` present, and its
 * SQLite built with FTS5. Measured once per process.
 *
 * @returns {{ available: boolean, version: string, reason: string }}
 */
export function sqliteSupport() {
  if (support) return support;
  const sqlite = loadSqlite();
  if (!sqlite) {
    support = { available: false, version: "", reason: `Node ${process.version} has no node:sqlite; the search index needs Node 22.16+ or 24+.` };
    return support;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(":memory:");
    const { version } = db.prepare("SELECT sqlite_version() AS version").get();
    try {
      db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
      support = { available: true, version, reason: "" };
    } catch {
      support = {
        available: false,
        version,
        reason: `Node ${process.version} bundles SQLite ${version} without FTS5; the search index needs Node 22.16+ or 24+.`
      };
    }
  } catch (error) {
    support = { available: false, version: "", reason: `node:sqlite failed to open a database: ${error?.message ?? error}` };
  } finally {
    db?.close();
  }
  return support;
}

/** The primary SQLite result code of an error from `node:sqlite`, or 0. */
function resultCode(error) {
  return Number(error?.errcode) & 0xff;
}

/** A lock held by another connection: worth waiting for. */
export function isBusyError(error) {
  const code = resultCode(error);
  return code === SQLITE_BUSY || code === SQLITE_LOCKED || /\b(database is locked|database table is locked|busy)\b/i.test(String(error?.message ?? ""));
}

/** A file that is not, or is no longer, a readable SQLite database. */
export function isCorruptError(error) {
  const code = resultCode(error);
  return code === SQLITE_CORRUPT || code === SQLITE_NOTADB || /file is not a database|disk image is malformed/i.test(String(error?.message ?? ""));
}

/**
 * Open a database file with a busy timeout. The parent directory is created;
 * the file is too, when it does not exist yet — callers that only read check
 * for it first.
 *
 * @param {string} filePath
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openDatabase(filePath) {
  const sqlite = loadSqlite();
  if (!sqliteSupport().available) throw new Error(sqliteSupport().reason);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new sqlite.DatabaseSync(filePath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One read connection to a file, reopened when the file it was opened on has
 * been deleted or replaced, and closed while there is no file, after
 * `idleMs` without a read, and on finding the file damaged. On Windows an open
 * SQLite file cannot be renamed or deleted by anyone, so a connection kept
 * open for good by one client's server would stop every other client from
 * replacing a damaged index.
 *
 * @param {string} filePath
 * @param {{ delays?: number[], idleMs?: number }} [options] - Pauses between attempts at a busy read; idle time before closing.
 * @returns {{ read: <T>(fn: (db: import("node:sqlite").DatabaseSync) => T) => Promise<T|null>, close: () => void, isOpen: () => boolean }}
 */
export function createIndexReader(filePath, { delays = READ_RETRY_DELAYS_MS, idleMs = READER_IDLE_MS } = {}) {
  let db = null;
  let identity = "";
  let idle = null;

  function close() {
    if (idle) clearTimeout(idle);
    idle = null;
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    db = null;
    identity = "";
  }

  function closeWhenIdle() {
    if (idle) clearTimeout(idle);
    idle = db ? setTimeout(close, idleMs) : null;
    idle?.unref?.();
  }

  function connection() {
    let stat;
    try {
      stat = fs.statSync(filePath, { bigint: true });
    } catch {
      close();
      return null;
    }
    const current = `${stat.dev}:${stat.ino}`;
    if (db && current === identity) return db;
    close();
    db = openDatabase(filePath);
    identity = current;
    return db;
  }

  /**
   * Run a synchronous read; null when the file does not exist. A busy file is
   * retried after each of `delays`; anything else is thrown, and a file busy
   * through every attempt is an error, never an empty answer.
   */
  async function read(fn) {
    let lastError;
    try {
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try {
          const db = connection();
          return db ? fn(db) : null;
        } catch (error) {
          if (isCorruptError(error)) close();
          if (!isBusyError(error)) throw error;
          lastError = error;
          if (attempt < delays.length) await sleep(delays[attempt]);
        }
      }
    } finally {
      // After any read, a failed one too: an ordinary SQL error used to keep
      // the file open for good.
      closeWhenIdle();
    }
    throw new Error(`SQLite index remained busy after ${delays.length + 1} attempts: ${filePath}`, { cause: lastError });
  }

  return { read, close, isOpen: () => db !== null };
}

/** Whether a table (or view) exists. */
export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name));
}

/** The column names of a table. */
export function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

// `ignoreBOM` keeps a leading U+FEFF, as Python keeps it in the text it stored.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A text column read whole. `node:sqlite` cuts a TEXT value at its first NUL,
 * so free text is selected `CAST(... AS BLOB)` and
 * decoded here.
 *
 * @param {Uint8Array|string|null} value
 * @returns {string}
 */
export function wholeText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : UTF8.decode(value);
}

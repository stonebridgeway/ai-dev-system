/**
 * The last lines of AI Dev's logs, for `logs_tail` and the desktop app's log
 * view. A log is read from its end, so a large one costs what is shown.
 *
 * Only the logs in the runtime home's `logs` folder can be named, by file
 * name: `daemon` is `daemon.log`, `daemon.1` the part the daemon set aside
 * when the log passed 1 MB.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** The most lines one answer carries. */
export const MAX_TAIL_LINES = 1000;

/** Read at most this much from a log's end, whatever its lines' length. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;

/**
 * How a log is opened when links are refused: never through a link put in
 * its place (where the system has the flag), and never waiting on a FIFO put
 * there — the open returns, and the file is then seen not to be one.
 */
const OWN_FILE_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Why a name in the logs folder is not read, by what it is. */
function notALog(file, why) {
  return new Error(`${path.basename(file)} ${why}: only the logs folder's own files are read.`);
}

/** What a file that is not a plain one is, in words. */
function kindOf(stat) {
  if (stat.isSymbolicLink()) return "is a link";
  if (stat.isDirectory()) return "is a folder";
  return "is not a plain file (a FIFO, a socket or a device)";
}

/** A log name: a file name in the logs folder, with or without `.log`. */
const LOG_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The file a log name stands for, or an error that says what may be named.
 *
 * @param {string} logsFolder
 * @param {string} [name] - `daemon` (the default), `daemon.1`, or another
 *   `*.log` file's name in the folder.
 * @returns {{ log: string, file: string }}
 */
export function resolveLogFile(logsFolder, name = "daemon") {
  const wanted = String(name ?? "").trim() || "daemon";
  if (!LOG_NAME.test(wanted) || wanted.includes("..")) {
    throw new Error(`"${wanted}" is not a log name: name a file in ${logsFolder}, such as daemon or daemon.1.`);
  }
  const rotated = /^(.*)\.(\d+)$/.exec(wanted);
  const base = rotated ? rotated[1] : wanted;
  const fileName = base.endsWith(".log")
    ? `${base}${rotated ? `.${rotated[2]}` : ""}`
    : `${base}.log${rotated ? `.${rotated[2]}` : ""}`;
  return { log: wanted, file: path.join(logsFolder, fileName) };
}

/**
 * The last `lines` lines of a file.
 *
 * @param {string} file
 * @param {{ lines?: number, links?: boolean }} [options] - `links: false` refuses a file that is a link,
 *   or that has another name elsewhere (a hard link).
 * @returns {Promise<{ exists: boolean, size: number, lines: string[], truncated: boolean }>}
 *   `truncated`: the file holds earlier lines than these.
 */
export async function tailLines(file, { lines = 200, links = true } = {}) {
  const wanted = Math.max(1, Math.min(MAX_TAIL_LINES, Math.trunc(Number(lines)) || 200));
  let seen = null;
  if (!links) {
    // A link in the logs folder would read whatever it points at.
    seen = await fs.lstat(file, { bigint: true }).catch(() => null);
    if (seen && !seen.isFile()) throw notALog(file, kindOf(seen));
  }
  let handle;
  try {
    handle = await fs.open(file, links ? "r" : OWN_FILE_FLAGS);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, size: 0, lines: [], truncated: false };
    if (!links && (error?.code === "ELOOP" || error?.code === "EMLINK")) throw notALog(file, "is a link");
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!links) {
      if (!stat.isFile()) throw notALog(file, kindOf(stat));
      // A hard link is a second name for a file elsewhere, as good as a link.
      if (stat.nlink > 1n) throw notALog(file, "has another name elsewhere (a hard link)");
      // What is open is the file lstat looked at: where the system has no
      // O_NOFOLLOW — Windows — a link put in its place since opens its target.
      if (seen && (stat.ino !== seen.ino || stat.dev !== seen.dev)) throw notALog(file, "was replaced while it was opened");
    }
    const size = Number(stat.size);
    let position = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;
    // One newline more than the lines wanted: the first line read may be cut.
    while (position > 0 && newlines <= wanted && size - position < MAX_TAIL_BYTES) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
      buffer = Buffer.concat([chunk, buffer]);
    }
    // Decoded whole, so a character cut by a chunk's edge lands in the line
    // that is dropped below as cut, never in one that is shown.
    const all = buffer.toString("utf8").split(/\r?\n/);
    if (all.at(-1) === "") all.pop();
    if (position > 0) all.shift();
    return { exists: true, size, lines: all.slice(-wanted), truncated: position > 0 || all.length > wanted };
  } finally {
    await handle.close();
  }
}

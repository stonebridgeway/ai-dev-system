/**
 * How much room is left where a download is about to write, and whether it
 * should start at all.
 *
 * The macOS acceptance run filled a disk to about 3 GB free and started the
 * model download: the write rate fell from roughly 45 MB/min to roughly
 * 1 MB/min and nothing said a word. From the outside
 * that is the same picture as a stalled CDN — a progress line that
 * barely moves, no error — so the user cannot tell a full disk from a dead
 * source, and the two are fixed by opposite actions.
 *
 * Hence two lines rather than one. Below the first, the download is refused
 * before it starts, with both numbers in the sentence. Above it but inside the
 * second, the download runs and says once that the disk is tight, so slowness
 * that follows has a named cause.
 *
 * `statfs` is a parameter, so both lines are tested without filling a disk.
 */
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Room a download is not allowed to take, however much it wants.
 *
 * A download that leaves the filesystem with nothing has not succeeded: the
 * next thing to write — the search index, a log, the editor's own state — fails
 * instead, somewhere the download is no longer there to be blamed for it.
 */
export const DISK_RESERVE_BYTES = 512 * 1024 * 1024;

/**
 * Below this much room left over, writing is slow enough to be mistaken for a
 * dead network, so it is worth a sentence.
 *
 * The one machine that hit this had about 3 GB free, so the line sits above
 * that: a threshold under what has already been observed would not have fired
 * on the run that found the defect.
 */
export const DISK_TIGHT_HEADROOM_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * A byte count as a person would say it.
 *
 * Three significant figures at most: the decision this feeds is "is there room
 * or not", and "601 MB" answers it where "630,712,320 bytes" has to be read
 * twice.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/**
 * Bytes available to this user on the filesystem that holds `target`.
 *
 * `bavail` rather than `bfree`: the blocks reserved for root are not ours, and
 * on a machine with a quota the two differ by a lot — this container reports
 * 263 GB free and 32 GB available.
 *
 * The target directory usually does not exist yet on a first install, so the
 * walk goes up to the nearest ancestor that does. Anything else that goes
 * wrong returns `null`, which every caller reads as "no opinion": a filesystem
 * that will not describe itself must not stop a download that would have
 * worked.
 *
 * @param {string} target
 * @param {{ statfs?: (path: string) => Promise<{ bavail: number, bsize: number }> }} [options]
 * @returns {Promise<number|null>} Bytes available, or null when it cannot be measured.
 */
export async function freeSpaceFor(target, { statfs = fsp.statfs } = {}) {
  let directory = path.resolve(String(target));
  for (;;) {
    try {
      const stats = await statfs(directory);
      const available = Number(stats?.bavail) * Number(stats?.bsize);
      return Number.isFinite(available) && available >= 0 ? available : null;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
}

/**
 * Decide what to do about a download of `needed` bytes with `free` available.
 *
 * Returns a verdict rather than throwing or printing, so the same judgement can
 * be tested directly and so the caller decides which of its two channels — an
 * error or a line of output — the sentence belongs in.
 *
 * `atLeast` marks a total assembled from sizes some of which nobody would
 * state: the number is then a floor, and the wording says so instead of
 * claiming a precision it does not have.
 *
 * @param {object} options
 * @param {number|null} options.free
 * @param {number} options.needed
 * @param {string} [options.where] - Named in the message; a path, usually.
 * @param {number} [options.reserve]
 * @param {number} [options.headroom]
 * @param {boolean} [options.atLeast]
 * @returns {{ verdict: "unknown"|"ok"|"tight"|"refuse", message: string|null }}
 */
export function judgeDiskSpace({
  free,
  needed,
  where = "",
  reserve = DISK_RESERVE_BYTES,
  headroom = DISK_TIGHT_HEADROOM_BYTES,
  atLeast = false
} = {}) {
  if (!Number.isFinite(free) || !Number.isFinite(needed) || needed <= 0) {
    return { verdict: "unknown", message: null };
  }
  const place = where ? ` in ${where}` : "";
  const size = `${atLeast ? "at least " : ""}${formatBytes(needed)}`;
  if (free < needed + reserve) {
    return {
      verdict: "refuse",
      message: `Not enough free space${place}: this download needs ${size} and ${formatBytes(free)} is available`
        + ` (${formatBytes(reserve)} of any disk is left alone, so a download cannot take the last of it).`
        + ` Free up ${formatBytes(needed + reserve - free)} and run the command again —`
        + " files that already match are skipped, so nothing is fetched twice."
    };
  }
  if (free - needed < headroom) {
    return {
      verdict: "tight",
      message: `${formatBytes(free)} free${place} and this download takes ${size}.`
        + " Writing to a nearly full disk gets slow — a machine with about 3 GB free wrote at roughly"
        + " 1 MB/min where an empty one wrote at 45. If the download crawls from here, that is the reason,"
        + " not the network."
    };
  }
  return { verdict: "ok", message: null };
}

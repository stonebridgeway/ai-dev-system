/**
 * Fetching the pinned BGE-M3 export: resumable, through mirrors and proxies,
 * with progress and cancel, and refusing anything that is not byte for byte
 * what the manifest says.
 *
 * Every file streams through a sha256 tap into `<file>.part` and takes its
 * real name only once the digest matches. A half-written 600 MB weights file
 * that looks finished is the failure worth a rename: it is indistinguishable
 * from a good one until the model fails to load, hours later.
 *
 * ## Resuming
 *
 * A broken transfer keeps its `.part`, and the next run asks for the rest with
 * `Range` instead of starting over — the Windows acceptance run lost 510 MB of
 * 542 to one stalled connection and fetched them all again. Bytes on disk are
 * only worth continuing if they are known to be
 * the start of the right file, so every `.part` has a `.part.json` beside it
 * naming the revision and the sha256 it is a prefix of; a `.part` without one,
 * or with another revision's, is deleted rather than trusted. The existing
 * bytes are hashed again before the request, so the digest at the end covers
 * every byte of the file, whichever run wrote it — and a resumed file that does
 * not match is fetched once more from the beginning before the source is
 * blamed.
 *
 * ## Sources
 *
 * `AI_DEV_MODEL_MIRROR` first, then `HF_ENDPOINT`, then the manifest's own
 * sources. Both variables name a Hugging Face endpoint (`https://hf-mirror.com`)
 * and the file is read from `<endpoint>/<export>/resolve/<revision>/<file>`,
 * as every Hugging Face client reads it. A source that fails — an HTTP error, a
 * reset, a stall, wrong bytes — hands over to the next one, which continues the
 * same `.part`: the bytes are pinned by digest, not by where they came from.
 *
 * Requests go through `http-download.mjs`, which honours `HTTPS_PROXY`,
 * `HTTP_PROXY` and `NO_PROXY` without `NODE_USE_ENV_PROXY`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { freeSpaceFor, formatBytes, judgeDiskSpace } from "./disk-space.mjs";
import { sha256File } from "./dense-manifest.mjs";
import { openUrl, readSnippet, redactCredentials } from "./http-download.mjs";
import { hint } from "./install-layout.mjs";

/**
 * No byte has arrived for this long, so the transfer is dead.
 *
 * A stalled CDN is not a slow one: the Windows acceptance run watched a
 * connection send 510 MB of 542 and then nothing, with no error and no end.
 * The timer is re-armed by every chunk, so a slow link
 * is not cut off; only a silent one is. It covers connecting too.
 */
export const DOWNLOAD_STALL_MS = 60_000;

/** How long a 2.x `<file>.<pid>.part` is left alone before it is swept. */
export const ORPHAN_PART_MAX_AGE_MS = 60 * 60_000;

/** Progress is reported at most this often, plus at every file boundary. */
export const PROGRESS_INTERVAL_MS = 250;

/** The bytes of an unfinished file. */
export const PART_SUFFIX = ".part";

/** What an unfinished file is the start of: revision, sha256, size. */
export const PART_META_SUFFIX = ".part.json";

/** The ways round a network that will not hand the model over. */
export const BLOCKED_DOWNLOAD_ADVICE = "If this network blocks the download, set AI_DEV_MODEL_MIRROR to a Hugging Face mirror "
  + "or HTTPS_PROXY to a proxy that reaches it, or copy the model from a machine that has it: "
  + `\`${hint("npm run model -- import <folder or .zip>")}\`.`;

const PART_FORMAT = 1;

/** Weight of the newest sample in the smoothed speed. */
const SPEED_SMOOTHING = 0.3;

/**
 * A failure the next source cannot fix: a full disk, a cancel. Every other
 * reason one source fails is a reason to try the next.
 *
 * @param {string} message
 * @param {object} [fields]
 * @returns {Error}
 */
function finalError(message, fields = {}) {
  return Object.assign(new Error(message), { final: true }, fields);
}

/**
 * What to say when the disk fills up in the middle of a transfer.
 *
 * @param {string} target
 * @returns {string}
 */
export function describeOutOfSpace(target) {
  return `${path.basename(target)}: the disk filled up while it was being written to ${path.dirname(target)}. `
    + "Free up space and run the command again — what was written is kept, and it continues from there.";
}

/**
 * The sources to try, in order, each a base URL that a file's relative path is
 * appended to.
 *
 * @param {object} manifest
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function modelSources(manifest, env = process.env) {
  const sources = [];
  const add = (value) => {
    const base = String(value ?? "").trim().replace(/\/+$/, "");
    if (base && !sources.includes(base)) sources.push(base);
  };
  for (const name of ["AI_DEV_MODEL_MIRROR", "HF_ENDPOINT"]) {
    const endpoint = String(env[name] ?? "").trim();
    if (!endpoint) continue;
    let url = null;
    try {
      url = new URL(endpoint);
    } catch {
      // Said below with the variable's name.
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new Error(`${name}=${redactCredentials(endpoint)} is not an http(s) address. Set it to a Hugging Face endpoint, such as https://hf-mirror.com.`);
    }
    add(`${endpoint.replace(/\/+$/, "")}/${manifest.export}/resolve/${manifest.revision}`);
  }
  for (const source of manifest.sources ?? []) add(source);
  return sources;
}

/** One file's address at one source. */
const fileUrl = (source, relative) => `${String(source).replace(/\/$/, "")}/${relative}`;

/** A source as a person would recognise it: its host, without the path. */
function sourceName(source) {
  try {
    return new URL(source).host;
  } catch {
    return String(source);
  }
}

/**
 * Write all of `chunk`: a write may take fewer bytes than offered, and the
 * running hash covers every byte of the stream, so a short write left
 * unfinished would name wrong bytes on disk as verified.
 */
export async function writeAll(handle, chunk) {
  let written = 0;
  while (written < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.length - written);
    if (!(bytesWritten > 0)) throw Object.assign(new Error("the disk took no bytes"), { code: "EIO" });
    written += bytesWritten;
  }
}

/** What a failed write means, in words a person can act on. */
const WRITE_FAILURES = Object.freeze({
  EDQUOT: "this account's disk quota is used up",
  EFBIG: "the file is larger than this system or file system allows",
  EROFS: "the file system is read-only",
  EACCES: "this account may not write there",
  EPERM: "this account may not write there",
  EIO: "the disk reported an input/output error"
});

/**
 * A disk that would not take the file, said as that and not as a broken
 * connection — a quota, a read-only mount and a folder without rights all
 * used to read "the connection … closed".
 *
 * @param {Error & { code?: string }} error
 * @param {{ relative: string, target: string, kept: number|null }} where
 * @returns {Error} Final: another source would fail the same way.
 */
export function describeWriteFailure(error, { relative, target, kept }) {
  const reason = WRITE_FAILURES[error?.code] ?? String(error?.message ?? error);
  return finalError(`Could not write ${relative} into ${path.dirname(target)}: ${reason}${error?.code ? ` (${error.code})` : ""}.`
    + (kept ? ` ${formatBytes(kept)} of it are kept; once that is fixed, running the install again continues from there.`
      : " Once that is fixed, run the install again."),
  { code: error?.code, writeFailed: true });
}

/** Run a step that touches the disk, marking what it throws as the disk's. */
async function onDisk(step) {
  try {
    return await step();
  } catch (error) {
    throw Object.assign(error, { writeFailed: true });
  }
}

/** Size of a file, or null when there is none. */
async function fileSize(file) {
  try {
    const stats = await fsp.stat(file);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/**
 * What the `.part` beside `target` is, if it can be trusted at all.
 *
 * @param {string} target
 * @returns {Promise<object|null>}
 */
export async function readPartMeta(target) {
  try {
    const meta = JSON.parse(await fsp.readFile(`${target}${PART_META_SUFFIX}`, "utf8"));
    return meta && meta.format === PART_FORMAT ? meta : null;
  } catch {
    return null;
  }
}

async function writePartMeta(target, meta) {
  const file = `${target}${PART_META_SUFFIX}`;
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({ format: PART_FORMAT, ...meta, updated_at: new Date().toISOString() })}\n`);
  await fsp.rename(temporary, file);
}

/** Forget an unfinished file: its bytes and what they were. */
export async function discardPart(target) {
  await fsp.rm(`${target}${PART_SUFFIX}`, { force: true });
  await fsp.rm(`${target}${PART_META_SUFFIX}`, { force: true });
}

/**
 * How many bytes of `target` are already on disk and worth continuing from.
 *
 * @param {string} target
 * @param {{ revision: string, sha256: string }} expected
 * @returns {Promise<{ bytes: number, size: number|null }>}
 */
export async function usablePart(target, { revision, sha256 }) {
  const bytes = await fileSize(`${target}${PART_SUFFIX}`);
  if (bytes === null) return { bytes: 0, size: null };
  const meta = await readPartMeta(target);
  const size = Number.isFinite(meta?.size) && meta.size > 0 ? meta.size : null;
  if (!meta || meta.revision !== revision || meta.sha256 !== sha256 || (size !== null && bytes > size)) {
    return { bytes: 0, size: null, stale: true };
  }
  return { bytes, size };
}

/**
 * Delete 2.x `.part` files for this target left behind by runs that are gone.
 *
 * 2.x named them `<file>.<pid>.part` and removed them in a `finally` that a
 * killed process never reaches. Nothing writes that
 * name any more; the age guard stays for a 2.x install running right now.
 *
 * @param {string} target - The final path, not the temporary one.
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {Promise<string[]>} The files removed.
 */
export async function sweepOrphanParts(target, { now = Date.now(), maxAgeMs = ORPHAN_PART_MAX_AGE_MS } = {}) {
  const directory = path.dirname(target);
  const pattern = new RegExp(`^${path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.part$`);
  const removed = [];
  for (const entry of await fsp.readdir(directory).catch(() => [])) {
    if (!pattern.test(entry)) continue;
    const full = path.join(directory, entry);
    const stats = await fsp.stat(full).catch(() => null);
    if (!stats || now - stats.mtimeMs <= maxAgeMs) continue;
    await fsp.rm(full, { force: true }).catch(() => undefined);
    removed.push(entry);
  }
  return removed;
}

/** A `Content-Range` — `bytes start-end/total`, or a 416's unsatisfied form — as numbers. */
function parseContentRange(value) {
  const text = String(value ?? "").trim();
  const unsatisfied = text.match(/^bytes\s+\*\/(\d+)$/i);
  if (unsatisfied) return { start: null, end: null, total: Number(unsatisfied[1]) };
  const match = text.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) };
}

/**
 * Progress for the whole download: bytes on disk out of the total, the speed
 * of what this run fetched, and what that leaves.
 *
 * @param {object} options
 * @param {(event: object) => void} [options.onProgress]
 * @param {number|null} options.total - Bytes of every pending file, or null when a size is unknown.
 * @param {number} options.filesTotal
 * @param {() => number} [options.now]
 */
function createProgress({ onProgress, total, filesTotal, now = Date.now }) {
  const state = { done: 0, current: 0, downloaded: 0, speed: 0, filesDone: 0, file: "", source: "" };
  let lastAt = now();
  let lastDownloaded = 0;
  const emit = (phase, force) => {
    if (!onProgress) return;
    const at = now();
    if (!force && at - lastAt < PROGRESS_INTERVAL_MS) return;
    const elapsed = (at - lastAt) / 1000;
    if (elapsed > 0 && state.downloaded > lastDownloaded) {
      const sample = (state.downloaded - lastDownloaded) / elapsed;
      state.speed = state.speed ? (state.speed * (1 - SPEED_SMOOTHING)) + (sample * SPEED_SMOOTHING) : sample;
    }
    lastAt = at;
    lastDownloaded = state.downloaded;
    const bytes = state.done + state.current;
    onProgress({
      phase,
      file: state.file,
      filesDone: state.filesDone,
      filesTotal,
      bytes,
      total,
      downloaded: state.downloaded,
      speed: Math.round(state.speed),
      etaSeconds: total !== null && state.speed > 0 ? Math.max(0, Math.round((total - bytes) / state.speed)) : null,
      source: state.source
    });
  };
  return {
    start(file, source, have) {
      Object.assign(state, { file, source, current: have });
      emit("downloading", true);
    },
    restart() {
      state.current = 0;
    },
    chunk(length) {
      state.current += length;
      state.downloaded += length;
      emit("downloading", false);
    },
    finish(size) {
      state.done += size;
      state.current = 0;
      state.filesDone += 1;
      emit("downloading", true);
    },
    end() {
      emit("done", true);
    },
    get downloaded() {
      return state.downloaded;
    }
  };
}

/**
 * Bring one file to `target` from one source, continuing its `.part` if there
 * is one to continue.
 *
 * @returns {Promise<{ size: number, resumedFrom: number }>}
 */
async function fetchFile({ url, target, relative, expected, revision, env, signal, stallMs, statfs, progress, request, log }) {
  const part = `${target}${PART_SUFFIX}`;
  await onDisk(() => fsp.mkdir(path.dirname(target), { recursive: true }));
  await sweepOrphanParts(target);
  const existing = await usablePart(target, { revision, sha256: expected });
  if (existing.stale) {
    log(`${relative}: discarding a partial download that belongs to another revision`);
    await discardPart(target);
  }
  let offset = existing.bytes;
  let size = existing.size;
  const hash = crypto.createHash("sha256");
  if (offset > 0) {
    for await (const chunk of fs.createReadStream(part, { start: 0, end: offset - 1 })) hash.update(chunk);
  }

  const stall = new AbortController();
  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), stallMs);
  };
  const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  let resumedFrom = offset;
  let response = null;
  armStallTimer();
  try {
    if (offset > 0 && size !== null && offset === size) {
      // Every byte arrived and the rename did not: nothing to ask for.
      return await finish();
    }
    response = await request(url, { headers: offset > 0 ? { range: `bytes=${offset}-` } : {}, env, signal: combined });
    let total = null;
    if (offset > 0 && response.status === 416) {
      const range = parseContentRange(response.headers["content-range"]);
      response.body.resume();
      if (range?.total === offset) return await finish();
      await discardPart(target);
      throw Object.assign(new Error(`${relative}: the source has no bytes past ${offset}; starting over.`), { restart: true });
    }
    if (offset > 0 && response.status === 206) {
      const range = parseContentRange(response.headers["content-range"]);
      if (!range || range.start !== offset) {
        response.body.destroy();
        await discardPart(target);
        throw Object.assign(new Error(`${relative}: the source answered a different range than asked for; starting over.`), { restart: true });
      }
      total = range.total;
    } else if (response.status === 200) {
      if (offset > 0) {
        log(`${relative}: ${sourceName(url)} does not resume downloads; starting this file over`);
        offset = 0;
        resumedFrom = 0;
      }
      const declared = Number(response.headers["content-length"]);
      total = Number.isFinite(declared) && declared > 0 ? declared : null;
    } else {
      const snippet = await readSnippet(response.body);
      throw new Error(`${redactCredentials(url)} returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`);
    }
    if (total !== null && size !== null && total !== size) {
      log(`${relative}: the source says ${total} bytes where the partial download expected ${size}`);
    }
    if (total !== null) size = total;
    // Checked against what this response will write, before a byte of it
    // lands — on a host that answers no HEAD this is the only check there is.
    if (size !== null) {
      const room = judgeDiskSpace({ free: await freeSpaceFor(path.dirname(target), { statfs }), needed: size - offset, where: path.dirname(target) });
      if (room.verdict === "refuse") {
        response.body.destroy();
        throw finalError(room.message, { outOfSpace: true });
      }
    }
    await onDisk(() => writePartMeta(target, { revision, sha256: expected, size, source: redactCredentials(url) }));
    const restarted = offset === 0;
    const running = restarted ? crypto.createHash("sha256") : hash;
    progress.start(relative, sourceName(url), offset);
    // One awaited write per chunk rather than a pipeline: when the connection
    // breaks, every byte that was hashed is on disk, and a pipeline tearing
    // down its file stream would drop what it still had buffered.
    const out = await onDisk(() => fsp.open(part, restarted ? "w" : "a"));
    let received = 0;
    try {
      for await (const chunk of response.body) {
        armStallTimer();
        running.update(chunk);
        await onDisk(() => writeAll(out, chunk));
        received += chunk.length;
        progress.chunk(chunk.length);
      }
    } catch (error) {
      if (signal?.aborted || stall.signal.aborted || error?.code === "ENOSPC" || error?.writeFailed) throw error;
      const wanted = size === null ? null : size - offset;
      // Rounded alike, a few bytes short would read as all of it.
      const expectedBytes = wanted === null ? "" : formatBytes(received) === formatBytes(wanted)
        ? `, ${wanted - received} bytes short of ${formatBytes(wanted)}` : ` of ${formatBytes(wanted)}`;
      throw new Error(`the connection to ${sourceName(url)} closed after ${formatBytes(received)}${expectedBytes}.`);
    } finally {
      await out.close();
    }
    return await finish(running);
  } catch (error) {
    if (signal?.aborted) {
      const kept = await fileSize(part);
      throw finalError(
        `Download cancelled.${kept ? ` ${formatBytes(kept)} of ${relative} are kept; running the install again continues from there.` : ""}`,
        { cancelled: true, name: "AbortError" }
      );
    }
    if (stall.signal.aborted) {
      throw Object.assign(new Error(`${relative}: no data for ${Math.round(stallMs / 1000)}s from ${sourceName(url)}. `
        + "The source accepted the connection and then stopped sending."), { stalled: true });
    }
    if (error?.code === "ENOSPC") throw finalError(describeOutOfSpace(target), { outOfSpace: true });
    // The disk, not the network: another source would fail the same way.
    if (error?.writeFailed && !error.final) throw describeWriteFailure(error, { relative, target, kept: await fileSize(part) });
    throw error;
  } finally {
    clearTimeout(stallTimer);
    // A response left unread — the disk refused the file, the range was
    // wrong — would hold its connection open until the host gave up on it.
    if (response && !response.body.readableEnded) response.body.destroy();
  }

  async function finish(running = null) {
    let digest;
    if (running) digest = running.digest("hex");
    else digest = await sha256File(part);
    if (digest !== expected) {
      await discardPart(target);
      // Said with both digests: a truncated transfer and an upstream that moved
      // are told apart by comparing this hex with the manifest's source.
      throw Object.assign(new Error(`checksum mismatch for ${path.basename(target)}: got ${digest}, manifest says ${expected}`), {
        mismatch: true,
        resumed: resumedFrom > 0
      });
    }
    await fsp.rename(part, target);
    await fsp.rm(`${target}${PART_META_SUFFIX}`, { force: true });
    const bytes = await fileSize(target);
    progress.finish(bytes ?? 0);
    return { size: bytes ?? 0, resumedFrom };
  }
}

/**
 * Ask the sources how big a file is without fetching it. A host that answers
 * no HEAD leaves the size unknown, which costs the plan its precision and
 * nothing else: the GET says it again before the file is written.
 *
 * @returns {Promise<number|null>}
 */
async function probeSize({ relative, sources, env, request, signal, stallMs, silent }) {
  for (const source of sources) {
    if (silent.has(source)) continue;
    // The same window as a GET: a source, or a proxy, that takes the
    // connection and never answers held the install here for ever.
    const stall = new AbortController();
    const timer = setTimeout(() => stall.abort(), stallMs);
    try {
      const response = await request(fileUrl(source, relative), { method: "HEAD", env, signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal });
      response.body.resume();
      if (response.status < 200 || response.status >= 300) continue;
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > 0) return declared;
    } catch {
      if (signal?.aborted) return null;
      if (stall.signal.aborted) silent.add(source);
      // A source that will not answer a HEAD may still serve the file.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Download every file the manifest names that is not already correct on disk.
 *
 * Files whose digest already matches are skipped, unfinished ones are
 * continued, and the rest are fetched; then the manifest is written beside
 * them, so the directory can later name its own revision without re-hashing
 * hundreds of megabytes.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.targetDir
 * @param {Record<string, string|undefined>} [options.env] - Mirrors, proxies, `AI_DEV_OFFLINE`.
 * @param {(line: string) => void} [options.log]
 * @param {(event: object) => void} [options.onProgress] - `{ phase, file, filesDone, filesTotal, bytes, total, downloaded, speed, etaSeconds, source }`.
 * @param {AbortSignal} [options.signal] - Cancels; what was written is kept for the next run.
 * @param {(path: string) => Promise<object>} [options.statfs] - Seam for the free-space check.
 * @param {number} [options.stallMs]
 * @param {typeof openUrl} [options.request] - Seam for tests.
 * @returns {Promise<{ ready: boolean, dir: string, present: string[], missing: string[], mismatched: string[], digests: Record<string, string>, downloaded: number, bytes: number, resumed: number }>}
 */
export async function downloadDenseModel({
  manifest,
  targetDir,
  env = process.env,
  log = (line) => process.stderr.write(`${line}\n`),
  onProgress,
  signal,
  statfs = fsp.statfs,
  stallMs = DOWNLOAD_STALL_MS,
  request = openUrl
} = {}) {
  if (String(env.AI_DEV_OFFLINE ?? "") === "1") {
    throw new Error("AI_DEV_OFFLINE=1 prevents downloads. Copy the model from a machine that has it: "
      + `\`${hint("npm run model -- import <folder or .zip>")}\`.`);
  }
  const sources = modelSources(manifest, env);
  if (!sources.length) throw new Error("Dense model manifest lists no sources to download from.");
  const resolved = path.resolve(String(targetDir));
  const digests = {};
  const pending = [];
  for (const [relative, digest] of Object.entries(manifest.files)) {
    if (signal?.aborted) throw finalError("Download cancelled.", { cancelled: true, name: "AbortError" });
    if (await sha256File(path.join(resolved, relative)) === digest) {
      digests[relative] = digest;
      continue;
    }
    pending.push({ relative, digest, target: path.join(resolved, relative) });
  }

  // Sizes once, before anything is fetched: the free-space check and the
  // progress total both need them. A source that went silent is asked last
  // from then on, so one dead mirror costs one wait, not one per file.
  const silent = new Set();
  let total = 0;
  let unknown = 0;
  let needed = 0;
  for (const file of pending) {
    const part = await usablePart(file.target, { revision: manifest.revision, sha256: file.digest });
    file.size = part.size ?? await probeSize({ relative: file.relative, sources, env, request, signal, stallMs, silent });
    if (file.size === null) {
      unknown += 1;
      continue;
    }
    total += file.size;
    needed += file.size - Math.min(part.bytes, file.size);
  }
  if (pending.length) {
    const room = judgeDiskSpace({ free: await freeSpaceFor(resolved, { statfs }), needed, where: resolved, atLeast: unknown > 0 });
    if (room.verdict === "refuse") throw finalError(room.message, { outOfSpace: true });
    if (room.message) log(room.message);
  }

  const progress = createProgress({ onProgress, total: unknown ? null : total, filesTotal: pending.length });
  let resumed = 0;
  for (const file of pending) {
    let lastError = null;
    const failures = [];
    for (const source of [...sources.filter((entry) => !silent.has(entry)), ...sources.filter((entry) => silent.has(entry))]) {
      const url = fileUrl(source, file.relative);
      try {
        let outcome;
        try {
          outcome = await fetchFile({ url, target: file.target, relative: file.relative, expected: file.digest, revision: manifest.revision, env, signal, stallMs, statfs, progress, request, log });
        } catch (error) {
          // Bytes from an earlier run that do not add up are blamed on that run
          // first: the same source is asked once more, from the beginning.
          if (!(error?.restart || (error?.mismatch && error?.resumed))) throw error;
          log(error.mismatch ? `${file.relative}: the continued file did not match; fetching it again from the start` : error.message);
          progress.restart();
          outcome = await fetchFile({ url, target: file.target, relative: file.relative, expected: file.digest, revision: manifest.revision, env, signal, stallMs, statfs, progress, request, log });
        }
        if (outcome.resumedFrom > 0) resumed += 1;
        digests[file.relative] = file.digest;
        lastError = null;
        break;
      } catch (error) {
        if (error?.final) throw error;
        if (error?.stalled) silent.add(source);
        lastError = error;
        failures.push({ source, error });
        progress.restart();
        log(`source failed for ${file.relative}: ${error.message}`);
      }
    }
    if (lastError) {
      const kept = await fileSize(`${file.target}${PART_SUFFIX}`);
      // Every source's answer, by its host, when there were several: the last
      // one alone would hide a mirror that served other bytes.
      const said = (error) => String(error.message).trim().replace(/[.!?]$/, "");
      const reason = failures.length > 1 ? failures.map((entry) => `${sourceName(entry.source)}: ${said(entry.error)}`).join("; ") : said(lastError);
      const mismatched = failures.find((entry) => entry.error?.mismatch);
      // A mirror of the person's choosing, not the manifest's own source, is the one to point elsewhere.
      const mirror = mismatched && !(manifest.sources ?? []).includes(mismatched.source);
      // Kept bytes mean a source answered, so running again is the advice; a
      // source that answered with other bytes is not a mirror of this
      // revision; nothing at all means no source could be reached from here.
      throw new Error(`Could not fetch ${file.relative}: ${reason}.`
        + (kept ? ` ${formatBytes(kept)} of it are kept; running the install again continues from there.`
          : mismatched ? (!mirror ? "" : ` ${sourceName(mismatched.source)} is not a mirror of ${manifest.export} at revision ${String(manifest.revision).slice(0, 12)}: `
            + `point AI_DEV_MODEL_MIRROR at one that is, or copy the model from a machine that has it: \`${hint("npm run model -- import <folder or .zip>")}\`.`)
            : ` ${BLOCKED_DOWNLOAD_ADVICE}`));
    }
  }
  progress.end();
  await fsp.mkdir(resolved, { recursive: true });
  await fsp.writeFile(path.join(resolved, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const present = Object.keys(manifest.files).filter((relative) => digests[relative]);
  return {
    ready: present.length === Object.keys(manifest.files).length,
    dir: resolved,
    present,
    missing: Object.keys(manifest.files).filter((relative) => !digests[relative]),
    mismatched: [],
    digests,
    downloaded: pending.length,
    bytes: progress.downloaded,
    resumed
  };
}

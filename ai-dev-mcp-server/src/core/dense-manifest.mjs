/**
 * The pinned BGE-M3 export: what it is, which files it is made of, and whether
 * the copy on this disk is the one the manifest describes.
 *
 * The dense half of hybrid search used to arrive through a Python virtualenv, a
 * CPU build of torch and `snapshot_download("BAAI/bge-m3")` with no revision —
 * four things that can each fail on a user's machine, and one that can change
 * upstream without anyone noticing. A manifest replaces
 * all four: a fixed revision, a fixed dtype, and a sha256 for every file, so
 * "the model is installed" is a question with a checkable answer rather than a
 * guess from a directory listing.
 *
 * Nothing here downloads (that is `dense-download.mjs`) and nothing here infers
 * (that is `dense-onnx.mjs`). Hashing is injected so the verification logic can
 * be tested without writing 600 MB of fixtures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** Fields a manifest cannot be read without. */
const REQUIRED_FIELDS = Object.freeze(["model", "export", "revision", "dtype", "dimensions", "files"]);

/** Where the shipped manifest lives, relative to this module. */
export const DENSE_MANIFEST_PATH = fileURLToPath(new URL("../../models/bge-m3.manifest.json", import.meta.url));

/**
 * Read one manifest object out of its JSON text, refusing anything incomplete.
 *
 * A manifest with a missing `revision` or an empty `files` map would verify
 * every directory as ready, which is the one failure mode that matters here:
 * the check exists to say no. So each absence is named rather than defaulted.
 *
 * @param {string|object} raw - JSON text, or an already-parsed object.
 * @returns {object} Frozen manifest.
 */
export function parseDenseManifest(raw) {
  let value;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Dense model manifest is not valid JSON: ${error.message}`);
    }
  } else {
    value = raw;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dense model manifest must be a JSON object.");
  }
  const missing = REQUIRED_FIELDS.filter((field) => value[field] === undefined || value[field] === null || value[field] === "");
  if (missing.length) {
    throw new Error(`Dense model manifest is missing: ${missing.join(", ")}.`);
  }
  const files = value.files;
  if (typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) {
    throw new Error("Dense model manifest lists no files.");
  }
  for (const [relative, digest] of Object.entries(files)) {
    if (!/^[0-9a-f]{64}$/i.test(String(digest))) {
      throw new Error(`Dense model manifest has no sha256 for ${relative}.`);
    }
    // Names are joined onto a model directory that `remove` deletes from: a
    // name that climbs out of it, or starts at a root, is not a model file.
    if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)
      || relative.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error(`Dense model manifest names a file outside its directory: ${relative}.`);
    }
  }
  const dimensions = Number(value.dimensions);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Dense model manifest has a nonsense dimension count: ${value.dimensions}.`);
  }
  return Object.freeze({
    ...value,
    dimensions,
    files: Object.freeze({ ...files }),
    sources: Object.freeze([...(value.sources ?? [])])
  });
}

/**
 * The manifest in force: the shipped one, or the file `AI_DEV_MODEL_MANIFEST`
 * names — another export or dtype pinned the same way, or the five-kilobyte
 * stand-in the tests build (`synthetic-model.mjs`), so the server, setup and
 * `npm run model` run end to end on a machine without the real weights. The
 * index records each vector's revision and dtype, so a different manifest
 * never mixes its vectors with another's.
 *
 * `createRequire` rather than `fs` so the JSON travels with the package the way
 * every other shipped asset does, and so a syntactically broken manifest fails
 * at the same point a broken module would.
 *
 * @param {string} [manifestPath]
 * @returns {object}
 */
export function readDenseManifest(manifestPath = process.env.AI_DEV_MODEL_MANIFEST || DENSE_MANIFEST_PATH) {
  const require = createRequire(import.meta.url);
  return parseDenseManifest(require(manifestPath));
}

/**
 * The sha256 of one file, or `null` when it is not there.
 *
 * Streamed, because the weights file is hundreds of megabytes and reading it
 * into a buffer to hash it would cost more memory than loading the model.
 *
 * @param {string} file
 * @returns {Promise<string|null>} Lowercase hex, or null for a missing file.
 */
export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  try {
    await pipeline(fs.createReadStream(file), hash);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
    throw error;
  }
  return hash.digest("hex");
}

/**
 * What a file is on disk without reading it: size, modification and change
 * times in nanoseconds, and its inode (the file ID on Windows), as strings.
 *
 * @param {string} file
 * @returns {Promise<{ size: string, mtime: string, ctime: string, ino: string }|null>} Null when it is not a file.
 */
export async function fileIdentity(file) {
  try {
    const stats = await fsp.stat(file, { bigint: true });
    if (!stats.isFile()) return null;
    return { size: String(stats.size), mtime: String(stats.mtimeNs), ctime: String(stats.ctimeNs), ino: String(stats.ino) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) return null;
    throw error;
  }
}

const sameIdentity = (left, right) => ["size", "mtime", "ctime", "ino"].every((key) => String(left?.[key]) === String(right?.[key]));

/**
 * Where the verification record for one model directory is kept.
 *
 * Beside the cache rather than beside the weights: in a container the model
 * directory is a read-only mount, and the record must still be writable.
 *
 * @param {string} stampDir
 * @param {string} modelDir
 * @returns {string}
 */
export function verifiedStampPath(stampDir, modelDir) {
  const key = crypto.createHash("sha256").update(path.resolve(String(modelDir))).digest("hex").slice(0, 16);
  return path.join(path.resolve(String(stampDir)), `verified-${key}.json`);
}

async function readVerifiedStamp(stampFile) {
  try {
    const stamp = JSON.parse(await fsp.readFile(stampFile, "utf8"));
    return stamp?.format === 1 && stamp.files && typeof stamp.files === "object" ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * Record, beside the cache, which files of `dir` were found to hash right and
 * what they looked like then. Best effort: a record that cannot be written
 * costs the next check a hash, nothing more.
 *
 * @param {string} stampFile
 * @param {{ dir: string, manifest: object, files: Record<string, { sha256: string, size: string, mtime: string, ctime: string, ino: string }> }} record
 * @returns {Promise<void>}
 */
export async function writeVerifiedStamp(stampFile, { dir, manifest, files }) {
  const body = { format: 1, dir: path.resolve(String(dir)), revision: manifest.revision, dtype: manifest.dtype, files };
  const temporary = `${stampFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(stampFile), { recursive: true });
    await fsp.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
    await fsp.rename(temporary, stampFile);
  } catch {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Record files just checked some other way — the download hashed every byte
 * on its way in — so the next check trusts them without reading them again.
 *
 * @param {{ stampFile: string, dir: string, manifest: object, verified: string[] }} options
 * @returns {Promise<void>}
 */
export async function stampVerifiedFiles({ stampFile, dir, manifest, verified }) {
  if (!stampFile) return;
  const resolved = path.resolve(String(dir));
  const previous = await readVerifiedStamp(stampFile);
  const files = previous?.dir === resolved ? { ...previous.files } : {};
  for (const relative of Object.keys(files)) if (!Object.hasOwn(manifest.files, relative)) delete files[relative];
  for (const relative of verified) {
    const identity = await fileIdentity(path.join(resolved, relative));
    if (identity) files[relative] = { sha256: String(manifest.files[relative]).toLowerCase(), ...identity };
  }
  await writeVerifiedStamp(stampFile, { dir: resolved, manifest, files });
}

/**
 * The manifest's files that are not there at all, by a look that reads none of
 * them: of a model this user cannot read, the ones that are missing as well.
 * A file it may not even look at is not counted.
 *
 * @param {{ manifest: object, dir: string }} input
 * @returns {Promise<string[]>}
 */
export async function filesNotThere({ manifest, dir }) {
  const resolved = path.resolve(String(dir || ""));
  const gone = [];
  for (const relative of Object.keys(manifest.files ?? {})) {
    const error = await fsp.lstat(path.join(resolved, relative)).then(() => null, (failure) => failure);
    if (error?.code === "ENOENT") gone.push(relative);
  }
  return gone;
}

/**
 * Check a model directory against a manifest, file by file.
 *
 * Absent and wrong are reported apart on purpose: a missing file means the
 * download never finished, a mismatched one means the bytes on disk are not the
 * pinned export — an interrupted write, a hand-edited directory, or an upstream
 * that moved. The first is "run setup again", the second is not, and the doctor
 * says so differently.
 *
 * With `trustStamp`, a file whose size, times and inode are what they were when
 * it last hashed right is taken as verified without being read: the server asks
 * this on every hybrid search, and reading 570 MB to answer was a second a
 * minute. Any change to the file — rewritten, touched,
 * renamed over — and it is hashed again. `model verify` and `dense:doctor`
 * hash everything regardless.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.dir - Model directory.
 * @param {(file: string) => Promise<string|null>} [options.hashFile] - Injected for tests.
 * @param {string} [options.stampFile] - Where the record of verified files is kept; none, no record.
 * @param {boolean} [options.trustStamp] - Skip reading files the record vouches for.
 * @returns {Promise<{ ready: boolean, dir: string, model: string, revision: string, dtype: string,
 *   dimensions: number, missing: string[], mismatched: string[], present: string[], hashed: string[] }>}
 */
export async function verifyDenseModelDirectory({ manifest, dir, hashFile = sha256File, stampFile = "", trustStamp = false }) {
  const resolved = path.resolve(String(dir || ""));
  const stamp = stampFile ? await readVerifiedStamp(stampFile) : null;
  const recorded = stamp?.dir === resolved ? stamp.files : {};
  const missing = [];
  const mismatched = [];
  const present = [];
  const hashed = [];
  const verified = {};
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.join(resolved, relative);
    const expected = String(digest).toLowerCase();
    const before = stampFile ? await fileIdentity(file) : null;
    const entry = recorded[relative];
    if (trustStamp && before && entry?.sha256 === expected && sameIdentity(entry, before)) {
      present.push(relative);
      verified[relative] = entry;
      continue;
    }
    const actual = await hashFile(file);
    hashed.push(relative);
    if (actual === null) missing.push(relative);
    else if (actual.toLowerCase() !== expected) mismatched.push(relative);
    else {
      present.push(relative);
      const after = stampFile ? await fileIdentity(file) : null;
      // Changed while it was being read: right now, but not worth vouching for.
      if (before && after && sameIdentity(before, after)) verified[relative] = { sha256: expected, ...after };
    }
  }
  if (stampFile && JSON.stringify(verified) !== JSON.stringify(recorded)) {
    await writeVerifiedStamp(stampFile, { dir: resolved, manifest, files: verified });
  }
  return {
    ready: missing.length === 0 && mismatched.length === 0,
    dir: resolved,
    model: manifest.model,
    revision: manifest.revision,
    dtype: manifest.dtype,
    dimensions: manifest.dimensions,
    missing,
    mismatched,
    present,
    hashed
  };
}

/**
 * Say in one sentence what a verification result means.
 *
 * @param {{ ready: boolean, missing: string[], mismatched: string[], dir: string }} status
 * @returns {string}
 */
export function describeDenseModelDirectory(status) {
  if (status.ready) return `Model files verified in ${status.dir}.`;
  if (status.mismatched.length) {
    return `Model files in ${status.dir} do not match the manifest: ${status.mismatched.join(", ")}. `
      + "Delete the directory and download it again — these are not the pinned export.";
  }
  return `Model files are missing from ${status.dir}: ${status.missing.join(", ")}.`;
}

/**
 * The identity a dense vector carries so a later run can tell whether it is
 * still comparable to the ones being produced now.
 *
 * Two exports of the same model do not produce comparable vectors, and neither
 * do two dtypes of the same export: an int8 ONNX vector and an fp32 torch
 * vector for the same sentence differ far more than two sentences do. Keying
 * the cached vectors on the model name alone — which is what the index used to
 * do — meant switching backends silently mixed two vector spaces in one
 * ranking. Everything that can change the numbers goes in the key.
 *
 * @param {object} manifest
 * @param {string} backend - "onnx", the one backend since 3.0; a 2.x index may also hold "python".
 * @returns {{ backend: string, model: string, revision: string, dtype: string, dimensions: number }}
 */
export function denseVectorProvenance(manifest, backend) {
  return {
    backend: String(backend),
    model: String(manifest.model),
    revision: String(manifest.revision),
    dtype: String(manifest.dtype),
    dimensions: Number(manifest.dimensions)
  };
}

/**
 * Whether two provenances describe the same vector space.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {boolean}
 */
export function sameDenseProvenance(left, right) {
  if (!left || !right) return false;
  return ["backend", "model", "revision", "dtype"].every((key) => String(left[key]) === String(right[key]))
    && Number(left.dimensions) === Number(right.dimensions);
}

/**
 * The manifest copy written beside the weights when they were downloaded.
 *
 * It is what lets a directory say which revision it holds without re-hashing
 * hundreds of megabytes, and what the doctor reads before it decides to.
 *
 * @param {string} dir
 * @returns {Promise<object|null>}
 */
export async function readInstalledDenseManifest(dir) {
  try {
    return parseDenseManifest(await fsp.readFile(path.join(path.resolve(dir), "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The local model as one thing a person installs, checks, copies in and
 * removes: the commands behind `ai-dev model`, the `--model` step of setup,
 * the dense runtime's "is it there" and, later, the interface's model screen.
 *
 * Before this the model was a download inside setup and nothing else. A
 * machine that could not reach huggingface.co had no way in; a broken copy had
 * no way out but deleting a directory by hand; and "is it installed" was
 * answered by hashing 570 MB.
 *
 * - `install` downloads through `dense-download.mjs`: resumable, mirrors,
 *   proxies, progress and cancel;
 * - `import` copies from a folder or a `.zip` another machine made, checking
 *   every file against the manifest on the way in;
 * - `verify` hashes every file, `status` trusts the record a previous check
 *   left (size, times, inode) and hashes only what changed;
 * - `remove` deletes the files the manifest names and nothing else.
 *
 * All four that write take a lock beside the model directory, so two of them —
 * two terminals, setup and the interface — cannot interleave in one directory.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { discardPart, downloadDenseModel, modelSources, PART_META_SUFFIX, PART_SUFFIX, usablePart } from "./dense-download.mjs";
import { fileIdentity, filesNotThere, readInstalledDenseManifest, stampVerifiedFiles, verifiedStampPath, verifyDenseModelDirectory } from "./dense-manifest.mjs";
import { formatBytes } from "./disk-space.mjs";
import { redactCredentials } from "./http-download.mjs";
import { acquireFileLock } from "./file-lock.mjs";
import { looksLikeZip, openZipEntry, readZipEntries } from "./model-archive.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";
import { hint, runtimeRepairHint } from "./install-layout.mjs";

/** How long an operation waits for another one on the same directory before saying so. */
export const MODEL_LOCK_TIMEOUT_MS = 1_500;

/** Directories `import` looks through for a model before giving up. */
const IMPORT_SEARCH_LIMIT = 2_000;

/** How deep below the named folder `import` looks. */
const IMPORT_SEARCH_DEPTH = 4;

/**
 * Where verification records are kept: the runtime's cache, which is writable
 * even where the model directory is a read-only mount.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function defaultStampDir(env = process.env) {
  return path.join(resolveRuntimeStateRoot("", env), "cache", "dense-model");
}

const PLATFORM_NAMES = Object.freeze({ "darwin-x64": "Intel Mac", "darwin-arm64": "Apple Silicon Mac", "win32-x64": "64-bit Windows", "win32-arm64": "Windows on ARM", "linux-x64": "64-bit Linux", "linux-arm64": "ARM64 Linux" });

/**
 * Whether the ONNX runtime has a native build for this machine.
 *
 * onnxruntime-node ships one prebuilt binding per platform and architecture
 * and nothing else; where there is none, the model cannot load and no command
 * builds one. 1.30 dropped Intel Macs. The answer is
 * read from the installed package, not from a list, so a version that adds a
 * build changes it without a code change.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {string} [options.packageRoot] - onnxruntime-node's folder; found when not given.
 * @returns {{ supported: boolean, platform: string, version: string, reason: string }}
 */
export function denseRuntimeSupport({ platform = process.platform, arch = process.arch, packageRoot = "" } = {}) {
  const label = `${platform}-${arch}`;
  const name = PLATFORM_NAMES[label] ? ` (${PLATFORM_NAMES[label]})` : "";
  let root = packageRoot;
  try {
    root ||= path.dirname(createRequire(import.meta.url).resolve("onnxruntime-node/package.json"));
  } catch {
    return { supported: false, platform: label, version: "", reason: `onnxruntime-node is not installed; ${runtimeRepairHint()}.` };
  }
  let version = "";
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "";
  } catch {
    // The binding decides; the version only names it.
  }
  const binaries = path.join(root, "bin");
  const builds = fs.existsSync(binaries) ? fs.readdirSync(binaries) : [];
  if (builds.some((napi) => fs.existsSync(path.join(binaries, napi, platform, arch, "onnxruntime_binding.node")))) {
    return { supported: true, platform: label, version, reason: "" };
  }
  return {
    supported: false,
    platform: label,
    version,
    reason: `onnxruntime-node ${version} has no build for ${label}${name}, so the local model cannot run on this machine. `
      + "Keyword and sparse search work without it; dense search needs another machine or the Docker image."
  };
}

/** Why a lock file could not be created beside the model folder. */
const LOCK_FAILURES = Object.freeze({
  EACCES: "this account may not write in the folder above it",
  EPERM: "this account may not write in the folder above it",
  EROFS: "it is on a read-only file system",
  ENOTDIR: "a part of the path is a file, not a folder"
});

/**
 * Run `operation` holding the lock for `dir`, or say who holds it.
 *
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withModelLock(dir, operation) {
  let release;
  try {
    release = await acquireFileLock(path.resolve(dir), { timeoutMs: MODEL_LOCK_TIMEOUT_MS, heartbeatMs: 10_000 });
  } catch (error) {
    // Only a lock someone holds is "another operation"; a folder that cannot
    // be written beside is said as that.
    if (error?.code) {
      const reason = LOCK_FAILURES[error.code] ?? String(error.message ?? error);
      throw new Error(`Cannot work in ${path.resolve(dir)}: ${reason} (${error.code}). `
        + "Point --dir or BGE_M3_ONNX_DIR at a folder this account can write.");
    }
    const holder = String(error?.message ?? "").match(/held by pid (\d+)/)?.[1];
    throw new Error(`Another model operation is working in ${path.resolve(dir)}${holder ? ` (pid ${holder})` : ""}. `
      + "Wait for it to finish; one that was killed lets go within 30 s.");
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * Where the model stands, without reading the weights unless they changed.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.dir
 * @param {string} [options.stampDir]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {ReturnType<typeof denseRuntimeSupport>} [options.support]
 * @param {typeof verifyDenseModelDirectory} [options.verify]
 * @returns {Promise<object>} With `unreadable`, why, when this user could not read the model at all.
 */
export async function modelStatus({ manifest, dir, stampDir = defaultStampDir(), env = process.env, support = denseRuntimeSupport(), verify = verifyDenseModelDirectory }) {
  const resolved = path.resolve(dir);
  let verification;
  try {
    verification = await verify({ manifest, dir: resolved, stampFile: verifiedStampPath(stampDir, resolved), trustStamp: true });
  } catch (error) {
    // A model this user cannot read — a host's folder 0700, files 0600 — is one
    // that is not installed, and why: not an error that stops `setup`, `model
    // status` or the app's status screen. Only
    // a system call's: a fault of the code still throws.
    if (typeof error?.syscall !== "string") throw error;
    const missing = await filesNotThere({ manifest, dir: resolved });
    verification = { ready: false, present: [], missing, mismatched: [], hashed: [], unreadable: error.message };
  }
  const partial = [];
  for (const [relative, digest] of verification.unreadable ? [] : Object.entries(manifest.files)) {
    if (verification.present.includes(relative)) continue;
    const part = await usablePart(path.join(resolved, relative), { revision: manifest.revision, sha256: digest });
    if (part.bytes > 0) partial.push({ file: relative, bytes: part.bytes, size: part.size });
  }
  let sources = [];
  let sourcesError = "";
  try {
    // Shown and printed as JSON: a mirror's password stays out.
    sources = modelSources(manifest, env).map(redactCredentials);
  } catch (error) {
    sourcesError = error.message;
  }
  const onDisk = await readInstalledDenseManifest(resolved);
  return {
    installed: verification.ready,
    dir: resolved,
    model: manifest.model,
    export: manifest.export,
    revision: manifest.revision,
    dtype: manifest.dtype,
    dimensions: manifest.dimensions,
    present: verification.present,
    missing: verification.missing,
    mismatched: verification.mismatched,
    partial,
    // Files this answer had to read, because they changed since the last
    // check or were never checked; usually none.
    hashed: verification.hashed,
    ...(verification.unreadable ? { unreadable: verification.unreadable } : {}),
    installed_revision: onDisk?.revision ?? "",
    supported: support.supported,
    support_reason: support.reason,
    platform: support.platform,
    sources,
    sources_error: sourcesError
  };
}

/**
 * Hash every file, with progress, and record what hashed right.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.dir
 * @param {string} [options.stampDir]
 * @param {(event: object) => void} [options.onProgress] - `{ phase: "verifying", file, bytes, total }`.
 * @param {AbortSignal} [options.signal] - Stops between two reads.
 * @returns {Promise<object>} As `verifyDenseModelDirectory`.
 */
export async function verifyModel({ manifest, dir, stampDir = defaultStampDir(), onProgress, signal }) {
  const resolved = path.resolve(dir);
  let total = 0;
  for (const relative of Object.keys(manifest.files)) total += Number((await fileIdentity(path.join(resolved, relative)))?.size ?? 0);
  let done = 0;
  const hashFile = async (file) => {
    const hash = crypto.createHash("sha256");
    const relative = path.relative(resolved, file).split(path.sep).join("/");
    try {
      for await (const chunk of fs.createReadStream(file)) {
        signal?.throwIfAborted();
        hash.update(chunk);
        done += chunk.length;
        onProgress?.({ phase: "verifying", file: relative, bytes: done, total });
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
      throw error;
    }
    return hash.digest("hex");
  };
  return verifyDenseModelDirectory({ manifest, dir: resolved, hashFile, stampFile: verifiedStampPath(stampDir, resolved), trustStamp: false });
}

/**
 * Download what is missing, continuing what was started, and record it.
 *
 * @param {object} options - As `downloadDenseModel`, plus `stampDir`.
 * @returns {Promise<object>} The download's result.
 */
export async function installModel({ manifest, dir, stampDir = defaultStampDir(), ...download }) {
  const resolved = path.resolve(dir);
  return withModelLock(resolved, async () => {
    const result = await downloadDenseModel({ ...download, manifest, targetDir: resolved });
    await stampVerifiedFiles({ stampFile: verifiedStampPath(stampDir, resolved), dir: resolved, manifest, verified: result.present });
    return result;
  });
}

/** Whether a path is a regular file (following links, as an HF cache needs). */
async function isFile(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Folders under `source` that hold every file the manifest names, best first:
 * one named for the pinned revision (an HF cache's `snapshots/<revision>`)
 * before the others.
 */
async function folderCandidates(source, manifest) {
  const wanted = Object.keys(manifest.files);
  const found = [];
  const queue = [{ dir: source, depth: 0 }];
  const seen = new Set();
  let closest = { dir: source, count: -1 };
  while (queue.length && seen.size < IMPORT_SEARCH_LIMIT) {
    const { dir, depth } = queue.shift();
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let count = 0;
    for (const relative of wanted) if (await isFile(path.join(dir, ...relative.split("/")))) count += 1;
    if (count === wanted.length) found.push(dir);
    else if (count > closest.count) closest = { dir, count };
    if (depth >= IMPORT_SEARCH_DEPTH) continue;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  found.sort((a, b) => Number(b.includes(manifest.revision)) - Number(a.includes(manifest.revision)));
  return { found, closest };
}

/** Prefixes inside an archive under which every manifest file is an entry, best first. */
function archiveCandidates(entries, manifest) {
  const wanted = Object.keys(manifest.files);
  const prefixes = new Set();
  for (const name of entries.keys()) {
    for (const relative of wanted) {
      if (name === relative || name.endsWith(`/${relative}`)) prefixes.add(name.slice(0, name.length - relative.length));
    }
  }
  const complete = [...prefixes].filter((prefix) => wanted.every((relative) => entries.has(`${prefix}${relative}`)));
  return complete.sort((a, b) => Number(b.includes(manifest.revision)) - Number(a.includes(manifest.revision)) || a.length - b.length);
}

/**
 * Copy one stream into `target` through a sha256 check: the bytes take the
 * name only if they are the pinned file.
 *
 * @returns {Promise<{ ok: boolean, digest: string, bytes: number }>}
 */
async function copyChecked(stream, target, expected, onChunk) {
  const temporary = `${target}.import-${process.pid}${PART_SUFFIX}`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const out = await fsp.open(temporary, "w");
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      await out.write(chunk);
      bytes += chunk.length;
      onChunk(chunk.length);
    }
  } catch (error) {
    await out.close();
    await fsp.rm(temporary, { force: true });
    throw error.code === "ENOSPC" ? new Error(`${path.basename(target)}: the disk filled up while it was being copied to ${path.dirname(target)}.`) : error;
  }
  await out.close();
  const digest = hash.digest("hex");
  if (digest !== expected) {
    await fsp.rm(temporary, { force: true });
    return { ok: false, digest, bytes };
  }
  await fsp.rename(temporary, target);
  return { ok: true, digest, bytes };
}

/**
 * Copy the model in from a folder or a `.zip` made on another machine.
 *
 * The source may be the model folder itself, any folder above it (the
 * `models/` folder of another install, a Hugging Face cache), or an archive of
 * either. Every file is checked against the manifest on the way in; a file the
 * source has in more than one place is taken from the first copy that matches.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.source
 * @param {string} options.dir
 * @param {string} [options.stampDir]
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onProgress] - `{ phase: "importing", file, bytes, total }`.
 * @returns {Promise<{ ready: boolean, dir: string, source: string, copied: string[], skipped: string[], from: string }>}
 */
export async function importModel({ manifest, source, dir, stampDir = defaultStampDir(), signal, onProgress }) {
  const origin = path.resolve(String(source ?? ""));
  if (!String(source ?? "").trim()) throw new Error("Say where to import from: a folder holding the model, or a .zip of one.");
  const stats = await fsp.stat(origin).catch(() => null);
  if (!stats) throw new Error(`${origin} does not exist.`);
  const resolved = path.resolve(dir);
  return withModelLock(resolved, async () => {
    let candidates;
    if (stats.isDirectory()) {
      const { found, closest } = await folderCandidates(origin, manifest);
      if (!found.length) {
        const missing = [];
        for (const relative of Object.keys(manifest.files)) if (!await isFile(path.join(closest.dir, ...relative.split("/")))) missing.push(relative);
        throw new Error(`No folder under ${origin} holds the whole model. The closest, ${closest.dir}, lacks ${missing.join(", ")}.`);
      }
      if (found.length === 1 && path.resolve(found[0]) === resolved) {
        const verification = await verifyModel({ manifest, dir: resolved, stampDir, onProgress, signal });
        if (!verification.ready) {
          // Nothing to copy from: the source is the folder being checked.
          throw new Error(`${origin} is the model folder itself, and ${[...verification.missing, ...verification.mismatched].join(", ")} in it `
            + "is not the pinned file; there is no other copy here to take it from. Import from another copy, or "
            + `\`${hint("npm run model -- install")}\` fetches it.`);
        }
        return { ready: true, dir: resolved, source: origin, copied: [], skipped: verification.present, from: resolved, mismatched: [] };
      }
      candidates = found.map((folder) => ({
        label: folder,
        size: async (relative) => Number((await fileIdentity(path.join(folder, ...relative.split("/"))))?.size ?? 0),
        open: async (relative) => fs.createReadStream(path.join(folder, ...relative.split("/")))
      }));
    } else if (stats.isFile() && await looksLikeZip(origin)) {
      const entries = await readZipEntries(origin);
      const prefixes = archiveCandidates(entries, manifest);
      if (!prefixes.length) {
        throw new Error(`${origin} does not hold the whole model: it needs ${Object.keys(manifest.files).join(", ")}, in one folder.`);
      }
      candidates = prefixes.map((prefix) => ({
        label: `${origin}${prefix ? `:${prefix}` : ""}`,
        size: async (relative) => entries.get(`${prefix}${relative}`).size,
        open: (relative) => openZipEntry(origin, entries.get(`${prefix}${relative}`))
      }));
    } else {
      throw new Error(`${origin} is neither a folder nor a .zip archive.`);
    }

    const pending = [];
    const skipped = [];
    const verification = await verifyDenseModelDirectory({ manifest, dir: resolved, stampFile: verifiedStampPath(stampDir, resolved), trustStamp: true });
    for (const relative of Object.keys(manifest.files)) {
      if (verification.present.includes(relative)) skipped.push(relative);
      else pending.push(relative);
    }
    let total = 0;
    for (const relative of pending) total += await candidates[0].size(relative);
    let done = 0;
    const copied = [];
    let from = candidates[0].label;
    for (const relative of pending) {
      const target = path.join(resolved, ...relative.split("/"));
      const expected = String(manifest.files[relative]).toLowerCase();
      let outcome = null;
      for (const candidate of candidates) {
        if (signal?.aborted) throw Object.assign(new Error("Import cancelled; files already copied are kept."), { name: "AbortError", cancelled: true });
        const before = done;
        outcome = await copyChecked(await candidate.open(relative), target, expected, (length) => {
          done += length;
          if (signal?.aborted) throw Object.assign(new Error("Import cancelled; files already copied are kept."), { name: "AbortError", cancelled: true });
          onProgress?.({ phase: "importing", file: relative, bytes: done, total });
        });
        if (outcome.ok) {
          from = candidate.label;
          break;
        }
        done = before;
      }
      if (!outcome?.ok) {
        throw new Error(`${relative} in ${origin} is not the pinned file: its sha256 is ${outcome.digest}, the manifest says ${expected}. `
          + `Nothing was copied over it; ${copied.length} other file(s) were.`);
      }
      await discardPart(target);
      copied.push(relative);
    }
    await fsp.writeFile(path.join(resolved, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await stampVerifiedFiles({ stampFile: verifiedStampPath(stampDir, resolved), dir: resolved, manifest, verified: [...skipped, ...copied] });
    return { ready: true, dir: resolved, source: origin, copied, skipped, from, mismatched: [] };
  });
}

/**
 * Whether a folder holds anything of this model: a file whose sha256 the
 * manifest pins, or a download of one that stopped partway.
 */
async function holdsModelFiles({ manifest, dir, stampDir }) {
  for (const relative of Object.keys(manifest.files)) {
    if ((await usablePart(path.join(dir, ...relative.split("/")), { revision: manifest.revision, sha256: manifest.files[relative] })).bytes > 0) return true;
  }
  const verification = await verifyDenseModelDirectory({ manifest, dir, stampFile: verifiedStampPath(stampDir, dir), trustStamp: true });
  return verification.present.length > 0;
}

/**
 * Delete the model: the files the manifest names, their unfinished downloads
 * and the record of their check. Anything else in the folder is left, and
 * said, because the folder can be one a person chose with `BGE_M3_ONNX_DIR`.
 *
 * @param {object} options
 * @param {object} options.manifest
 * @param {string} options.dir
 * @param {string} [options.stampDir]
 * @returns {Promise<{ dir: string, removed: string[], freed: number, kept: string[] }>}
 */
export async function removeModel({ manifest, dir, stampDir = defaultStampDir() }) {
  const resolved = path.resolve(dir);
  return withModelLock(resolved, async () => {
    // Names alone are not enough: `config.json` and `manifest.json` are
    // common, and a --dir pointed at the wrong folder deleted another
    // program's.
    if (!fs.existsSync(resolved)) return { dir: resolved, removed: [], freed: 0, freed_text: formatBytes(0), kept: [] };
    const ours = await readInstalledDenseManifest(resolved);
    if (!ours && !await holdsModelFiles({ manifest, dir: resolved, stampDir })) {
      throw new Error(`${resolved} does not look like the model's folder: it has no manifest.json from an install or an import, `
        + "no file the manifest pins and no download of one that stopped partway. Nothing was removed.");
    }
    const removed = [];
    let freed = 0;
    const names = [...Object.keys(manifest.files), ...(ours ? ["manifest.json"] : [])];
    for (const relative of names) {
      const target = path.join(resolved, ...relative.split("/"));
      const folder = path.dirname(target);
      const base = path.basename(target);
      const siblings = await fsp.readdir(folder).catch(() => []);
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const legacy = new RegExp(`^${escaped}\\.(?:(?:\\d+|import-\\d+)\\.part|part\\.json\\.\\d+\\.tmp)$`);
      const doomed = [base, `${base}${PART_SUFFIX}`, `${base}${PART_META_SUFFIX}`, ...siblings.filter((name) => legacy.test(name))];
      for (const name of new Set(doomed)) {
        const file = path.join(folder, name);
        const size = Number((await fileIdentity(file))?.size ?? -1);
        if (size < 0) continue;
        await fsp.rm(file, { force: true });
        removed.push(path.relative(resolved, file).split(path.sep).join("/"));
        freed += size;
      }
    }
    await fsp.rm(verifiedStampPath(stampDir, resolved), { force: true });
    const folders = [...new Set(names.map((relative) => path.dirname(path.join(resolved, ...relative.split("/")))))]
      .sort((a, b) => b.length - a.length);
    for (const folder of [...folders, resolved]) await fsp.rmdir(folder).catch(() => {});
    const kept = [];
    const walk = async (folder) => {
      for (const entry of await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else kept.push(path.relative(resolved, full).split(path.sep).join("/"));
      }
    };
    await walk(resolved);
    return { dir: resolved, removed, freed, freed_text: formatBytes(freed), kept };
  });
}

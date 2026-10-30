/**
 * A backup of AI Dev's data as one `.zip`, and the way back.
 *
 * 2.x backed up and restored with two PowerShell scripts that only worked
 * inside the owner's full vault: run from a clone they stopped at their first
 * check, and `ai-dev backup` refused every system but Windows.
 * This runs wherever Node does and keeps what an
 * install of any layout writes: the content root the server writes into (a
 * vault, the user vault of a package install, a clone's seed folder) and the
 * runtime's `state/` — tasks, sessions, the usage ledger, instincts, the
 * client-config record — with the sha256 of every file in the manifest.
 * Indexes, caches, models and dependencies are rebuilt, not backed up.
 *
 * No dependency: `node:zlib` deflates and sums, the format around it is a few
 * fixed-size records, and `model-archive.mjs` reads it back.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { flushFile, renameOver } from "./atomic-files.mjs";
import { openZipEntry, readZipEntries } from "./model-archive.mjs";
import { isApprovedVendoredDependencyPath } from "./public-distribution.mjs";

export const BACKUP_MANIFEST = "BACKUP-MANIFEST.json";
export const BACKUP_FORMAT = "ai-dev-backup";

/**
 * Never data: dependencies, VCS, caches a tool rebuilds, and the indexes. The
 * one exception is the vendored tree a skill runs from (Archify's), which the
 * seed ships and nothing reinstalls: a restored vault without it would keep
 * it missing, since the seed sync takes a shipped file that is gone for one the
 * user deleted.
 */
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"]);
const SKIP_FILES = /(?:\.sqlite(?:-(?:shm|wal))?|\.pyc|\.lock)$/i;
const SKIP_PATHS = [/^\.obsidian\/cache\//];

/**
 * The largest 32-bit field. The value itself means "see the ZIP64 record", so a
 * size, offset or count reaching it needs ZIP64; a single entry that
 * large needs ZIP64 sizes in its local header, which a backup of notes and
 * state does not have.
 */
const ENTRY_LIMIT = 0xffff_ffff;
const COUNT_LIMIT = 0xffff;

/**
 * Whether the end of the archive needs the ZIP64 records: a count, size or
 * offset that does not fit its field — or fills it, since the all-ones value
 * itself sends a reader to the ZIP64 record.
 *
 * @param {number} count
 * @param {number} directoryOffset
 * @param {number} directorySize
 * @returns {boolean}
 */
export function zip64Needed(count, directoryOffset, directorySize) {
  return count >= COUNT_LIMIT || directoryOffset >= ENTRY_LIMIT || directorySize >= ENTRY_LIMIT;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const DESCRIPTOR = 0x08074b50;
const END = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const UTF8_AND_DESCRIPTOR = 0x0808;
const DEFLATED = 8;
/** "Made by" Unix, so the external attributes carry the file's mode for any unzip. */
const MADE_BY_UNIX = (3 << 8) | 45;

function dosTime(date) {
  // Seven bits of year from 1980: a file dated after 2107 (a wrong clock, an
  // unpacked archive) is stamped 2107 rather than ending the backup.
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * Writes a ZIP file entry by entry, each deflated as it streams past: data
 * descriptors carry the sizes, ZIP64 records the offsets once the archive
 * passes 4 GiB or 65 535 entries.
 */
export class ZipWriter {
  /** @param {fsp.FileHandle} handle */
  constructor(handle) {
    this.handle = handle;
    this.offset = 0;
    this.entries = [];
  }

  async write(buffer) {
    await this.handle.write(buffer);
    this.offset += buffer.length;
  }

  /**
   * @param {string} name - Forward slashes, no leading slash.
   * @param {import("node:stream").Readable} source
   * @param {Date} modified
   * @param {number} [mode] - Unix permission bits, kept in the central directory.
   * @returns {Promise<{ size: number, sha256: string }>}
   */
  async add(name, source, modified, mode = 0o644) {
    const nameBytes = Buffer.from(name, "utf8");
    const offset = this.offset;
    const { time, date } = dosTime(modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(45, 4);
    header.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    header.writeUInt16LE(DEFLATED, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([header, nameBytes]));

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const hash = crypto.createHash("sha256");
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      }
    });
    const sink = new Writable({
      write: (chunk, _encoding, done) => {
        this.write(chunk).then(() => {
          compressed += chunk.length;
          done();
        }, done);
      }
    });
    await pipeline(source, counter, zlib.createDeflateRaw(), sink);
    if (size >= ENTRY_LIMIT || compressed >= ENTRY_LIMIT) throw new Error(`${name} is 4 GiB or more, which a backup entry cannot hold.`);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ nameBytes, time, date, crc: crc >>> 0, compressed, size, offset, mode: mode & 0o7777 });
    return { size, sha256: hash.digest("hex") };
  }

  async finish() {
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      const wideOffset = entry.offset >= ENTRY_LIMIT;
      const extra = wideOffset ? Buffer.alloc(12) : Buffer.alloc(0);
      if (wideOffset) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.offset), 4);
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(MADE_BY_UNIX, 4);
      record.writeUInt16LE(45, 6);
      record.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
      record.writeUInt16LE(DEFLATED, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
      record.writeUInt32LE(wideOffset ? 0xffff_ffff : entry.offset, 42);
      await this.write(Buffer.concat([record, entry.nameBytes, extra]));
    }
    const directorySize = this.offset - directoryOffset;
    const count = this.entries.length;
    const wide = zip64Needed(count, directoryOffset, directorySize);
    if (wide) {
      const zip64End = Buffer.alloc(56);
      zip64End.writeUInt32LE(ZIP64_END, 0);
      zip64End.writeBigUInt64LE(44n, 4);
      zip64End.writeUInt16LE(45, 12);
      zip64End.writeUInt16LE(45, 14);
      zip64End.writeBigUInt64LE(BigInt(count), 24);
      zip64End.writeBigUInt64LE(BigInt(count), 32);
      zip64End.writeBigUInt64LE(BigInt(directorySize), 40);
      zip64End.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR, 0);
      locator.writeBigUInt64LE(BigInt(this.offset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([zip64End, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(wide ? 0xffff : count, 8);
    end.writeUInt16LE(wide ? 0xffff : count, 10);
    end.writeUInt32LE(wide ? 0xffff_ffff : directorySize, 12);
    end.writeUInt32LE(wide ? 0xffff_ffff : directoryOffset, 16);
    await this.write(end);
  }
}

/**
 * Every file under `root` a backup keeps, in a stable order. Links are not
 * followed: a Docker vault links its `09-mcp` helpers to the app, and the app
 * is not data.
 */
async function collectFiles(root, prefix, found, skipped) {
  async function walk(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path: `${prefix}/${relative}`, reason: "a link" });
      } else if (entry.isDirectory()) {
        const keep = !SKIP_DIRECTORIES.has(entry.name) || isApprovedVendoredDependencyPath(relative);
        if (keep && !SKIP_PATHS.some((pattern) => pattern.test(`${relative}/`))) await walk(full);
      } else if (entry.isFile() && !SKIP_FILES.test(entry.name) && !SKIP_PATHS.some((pattern) => pattern.test(relative))) {
        found.push({ name: `${prefix}/${relative}`, file: full });
      }
    }
  }
  await walk(root);
}

/** `ai-dev-system_<UTC time>_<label>.zip`, as the 2.x script named it. */
export function backupFileName(label, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
  const safe = String(label ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
  return `ai-dev-system_${stamp}_${safe}.zip`;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Write a backup archive and its `.sha256` beside it.
 *
 * @param {object} input
 * @param {string} input.contentRoot - The vault, or what stands for it.
 * @param {string} input.runtimeRoot - `~/.ai-dev`, or `AI_DEV_HOME`.
 * @param {string} [input.stateRoot] - Where the server keeps its state: `AI_DEV_STATE_ROOT`, else `<runtime>/state`.
 * @param {string} input.destination - The folder the archive goes into.
 * @param {string} [input.label]
 * @param {string} [input.layout] - Recorded in the manifest.
 * @param {Date} [input.now]
 * @returns {Promise<{ archive: string, sha256: string, files: number, bytes: number, skipped: Array<{ path: string, reason: string }> }>}
 */
export async function createBackup({ contentRoot, runtimeRoot, stateRoot = path.join(runtimeRoot, "state"), destination, label = "manual", layout = "", now = new Date() }) {
  const found = [];
  const skipped = [];
  await collectFiles(contentRoot, "vault", found, skipped);
  await collectFiles(stateRoot, "runtime/state", found, skipped);
  await fsp.mkdir(destination, { recursive: true });
  const archive = path.join(destination, backupFileName(label, now));
  const temp = `${archive}.${process.pid}.tmp`;
  const handle = await fsp.open(temp, "wx", 0o600);
  const files = [];
  let bytes = 0;
  try {
    const zip = new ZipWriter(handle);
    for (const item of found) {
      let stat;
      try {
        stat = await fsp.stat(item.file);
      } catch (error) {
        // Gone between the listing and now: a session file a client rotated.
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (stat.size >= ENTRY_LIMIT) {
        skipped.push({ path: item.name, reason: "4 GiB or more" });
        continue;
      }
      const mode = stat.mode & 0o777;
      const { size, sha256 } = await zip.add(item.name, fs.createReadStream(item.file), stat.mtime, mode);
      files.push({ path: item.name, bytes: size, sha256, mode });
      bytes += size;
    }
    const manifest = {
      format: BACKUP_FORMAT,
      schema_version: 2,
      created_at: now.toISOString(),
      label: path.basename(archive, ".zip").split("_").slice(2).join("_"),
      layout,
      content_root: contentRoot,
      runtime_root: runtimeRoot,
      state_root: stateRoot,
      total_files: files.length,
      total_bytes: bytes,
      files
    };
    await zip.add(BACKUP_MANIFEST, fsReadable(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)), now, 0o600);
    await zip.finish();
    await flushFile(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  await renameOver(temp, archive);
  const sha256 = await sha256File(archive);
  await fsp.writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`, { mode: 0o600 });
  return { archive, sha256, files: files.length, bytes, skipped };
}

function fsReadable(buffer) {
  return (async function* chunks() {
    yield buffer;
  })();
}

async function readEntryText(archive, entry) {
  const chunks = [];
  for await (const chunk of await openZipEntry(archive, entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Where an archive name lands under `root`, or null when it would leave it:
 * an absolute name, a drive letter, a `..` segment.
 */
export function landingPath(root, name) {
  if (!name || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..")) return null;
  const target = path.resolve(root, ...name.split(/[\\/]/));
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null;
}

/**
 * Put a backup back.
 *
 * An archive this module wrote goes back where its parts belong — `vault/`
 * into the content root, `runtime/state/` into the state folder — or, with
 * `target`, under that folder as it is laid out in the archive. One the 2.x
 * script wrote is a whole vault and needs `target`. The archive is checked
 * against its `.sha256` when there is one, and nothing is written over an
 * existing file unless `overwrite` says so — checked for all of them first.
 *
 * All or nothing: every file is unpacked beside where it goes and
 * checked against its sha256 in the manifest before the first one is put in
 * place; then each replaced file is set aside, and a failure while putting
 * them in place puts the set-aside ones back.
 *
 * @param {object} input
 * @param {string} input.archive
 * @param {string} [input.contentRoot]
 * @param {string} [input.runtimeRoot]
 * @param {string} [input.stateRoot] - Defaults to `<runtimeRoot>/state`.
 * @param {string} [input.target]
 * @param {boolean} [input.overwrite]
 * @returns {Promise<{ restored: number, schema: number, places: string[] }>}
 */
export async function restoreBackup({ archive, contentRoot, runtimeRoot, stateRoot = runtimeRoot ? path.join(runtimeRoot, "state") : "", target = "", overwrite = false }) {
  const sidecar = `${archive}.sha256`;
  const expected = await fsp.readFile(sidecar, "utf8").then((text) => text.trim().split(/\s+/)[0].toLowerCase(), () => "");
  if (expected && expected !== await sha256File(archive)) {
    throw new Error(`${archive} does not match ${path.basename(sidecar)}: the archive is damaged or was changed; nothing was restored.`);
  }
  const entries = await readZipEntries(archive);
  const manifestEntry = entries.get(BACKUP_MANIFEST);
  if (!manifestEntry) throw new Error(`${archive} has no ${BACKUP_MANIFEST}: it is not an AI Dev backup.`);
  const manifest = JSON.parse(await readEntryText(archive, manifestEntry));
  const ours = manifest?.format === BACKUP_FORMAT;
  if (!ours && !target) {
    throw new Error(`${archive} was made by the 2.x backup script and holds a whole vault: name an empty folder to restore it into (--to).`);
  }
  const plan = [];
  if (ours) {
    for (const file of manifest.files ?? []) {
      const name = String(file.path ?? "");
      const [root, rest] = target
        ? [target, name]
        : name.startsWith("vault/") ? [contentRoot, name.slice("vault/".length)]
          : name.startsWith("runtime/state/") ? [stateRoot, name.slice("runtime/state/".length)]
            : [null, ""];
      const landing = root ? landingPath(root, rest) : null;
      const entry = entries.get(name);
      if (!landing || !entry) throw new Error(`${archive}: the entry ${JSON.stringify(name)} cannot be restored (outside its folder, or missing from the archive).`);
      plan.push({ entry, landing, sha256: String(file.sha256 ?? ""), mode: Number.isInteger(file.mode) ? file.mode & 0o777 : null });
    }
  } else {
    for (const entry of entries.values()) {
      if (entry.name === BACKUP_MANIFEST) continue;
      const landing = landingPath(target, entry.name);
      if (!landing) throw new Error(`${archive}: the entry ${JSON.stringify(entry.name)} would land outside ${target}.`);
      plan.push({ entry, landing, sha256: "", mode: null });
    }
  }
  if (!overwrite) {
    const existing = [];
    for (const item of plan) {
      if (await fsp.lstat(item.landing).then(() => true, () => false)) existing.push(item.landing);
    }
    if (existing.length) {
      throw new Error(`${existing.length} file(s) would be written over, the first ${existing[0]}; nothing was restored. `
        + "Restore into an empty folder (--to), or pass --overwrite to replace them.");
    }
  }

  const tag = `${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
  try {
    // 1. Everything unpacked and checked, nothing in place yet.
    for (const item of plan) {
      await fsp.mkdir(path.dirname(item.landing), { recursive: true });
      item.temp = `${item.landing}.${tag}.restore`;
      const hash = crypto.createHash("sha256");
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        }
      });
      await pipeline(await openZipEntry(archive, item.entry), counter, fs.createWriteStream(item.temp, { flags: "wx" }));
      if (item.sha256 && hash.digest("hex") !== item.sha256) {
        throw new Error(`${item.entry.name} in ${archive} does not match its sha256 in the manifest; nothing was restored.`);
      }
      if (item.mode !== null) await fsp.chmod(item.temp, item.mode);
    }
  } catch (error) {
    await Promise.all(plan.filter((item) => item.temp).map((item) => fsp.rm(item.temp, { force: true })));
    throw error;
  }
  // 2. In place, each replaced file set aside until all are.
  const done = [];
  try {
    for (const item of plan) {
      if (await fsp.lstat(item.landing).then(() => true, () => false)) {
        item.aside = `${item.landing}.${tag}.restore-old`;
        await renameOver(item.landing, item.aside);
      }
      await renameOver(item.temp, item.landing);
      item.temp = "";
      done.push(item);
    }
  } catch (error) {
    for (const item of done.reverse()) {
      if (item.aside) await renameOver(item.aside, item.landing).catch(() => undefined);
      else await fsp.rm(item.landing, { force: true }).catch(() => undefined);
    }
    for (const item of plan) {
      if (item.temp) await fsp.rm(item.temp, { force: true }).catch(() => undefined);
      if (item.aside && !done.includes(item)) await renameOver(item.aside, item.landing).catch(() => undefined);
    }
    throw new Error(`${error.message} Nothing was restored: the files already put back were returned as they were.`);
  }
  await Promise.all(plan.filter((item) => item.aside).map((item) => fsp.rm(item.aside, { force: true })));
  const places = ours && !target ? [contentRoot, stateRoot] : [target];
  return { restored: plan.length, schema: ours ? 2 : 1, places };
}

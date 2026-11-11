/**
 * Reading a model out of a `.zip` without unpacking it first.
 *
 * `model import` takes a folder or an archive: the machine that has no route
 * to huggingface.co gets the model from one that has, and a zip is how files
 * travel between machines. Unpacking 600 MB to a temporary folder only to copy
 * it again would need twice the disk the model does, so each wanted entry is
 * streamed straight from the archive into the model directory, through the
 * same sha256 check a download goes through.
 *
 * The reader covers what archivers write for a model: stored and Deflate
 * entries, ZIP64 for archives and entries over 4 GB, data descriptors, UTF-8
 * names. Encrypted entries and other compression methods are refused by name.
 * No dependency: `node:zlib` inflates, and the format around it is a few
 * fixed-size records.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The end-of-central-directory record is within this many bytes of the end. */
const EOCD_SEARCH = 22 + 0xffff;

/** Whether a file starts like a zip archive. */
export async function looksLikeZip(file) {
  const handle = await fsp.open(file, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head.readUInt32LE(0) === LOCAL;
  } finally {
    await handle.close();
  }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

const big = (buffer, offset) => Number(buffer.readBigUInt64LE(offset));

/** Where the central directory is, and how many entries it holds. */
async function locateDirectory(handle, size, file) {
  const tailLength = Math.min(size, EOCD_SEARCH);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let at = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      at = index;
      break;
    }
  }
  if (at < 0) throw new Error(`${file} is not a zip archive (no end-of-directory record).`);
  let entries = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = at - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR) {
      throw new Error(`${file} says it is a ZIP64 archive, and its ZIP64 record is missing.`);
    }
    const record = await readAt(handle, big(tail, locatorAt + 8), 56);
    if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD) {
      throw new Error(`${file}: its ZIP64 end-of-directory record is damaged.`);
    }
    entries = big(record, 32);
    directorySize = big(record, 40);
    directoryOffset = big(record, 48);
  }
  return { entries, directorySize, directoryOffset };
}

/** The ZIP64 extra field's values, in the order the format puts them. */
function zip64Values(extra, wanted) {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (id === 0x0001) {
      const values = {};
      let position = offset + 4;
      for (const key of ["size", "compressedSize", "localHeaderOffset"]) {
        if (!wanted[key]) continue;
        values[key] = big(extra, position);
        position += 8;
      }
      return values;
    }
    offset += 4 + length;
  }
  return {};
}

/**
 * Every file entry of an archive, by name.
 *
 * @param {string} file
 * @returns {Promise<Map<string, { name: string, method: number, encrypted: boolean, size: number, compressedSize: number, localHeaderOffset: number }>>}
 */
export async function readZipEntries(file) {
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    const { entries, directorySize, directoryOffset } = await locateDirectory(handle, size, file);
    // A directory the file cannot hold is a damaged — or crafted — archive,
    // not a buffer to allocate.
    if (directoryOffset + directorySize > size) {
      throw new Error(`${file}: its central directory says it is ${directorySize} bytes at ${directoryOffset}, past the end of a ${size}-byte file.`);
    }
    const directory = await readAt(handle, directoryOffset, directorySize);
    const result = new Map();
    let offset = 0;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL) {
        throw new Error(`${file}: its central directory is damaged at entry ${index + 1} of ${entries}.`);
      }
      const flags = directory.readUInt16LE(offset + 8);
      const method = directory.readUInt16LE(offset + 10);
      let compressedSize = directory.readUInt32LE(offset + 20);
      let entrySize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      let localHeaderOffset = directory.readUInt32LE(offset + 42);
      // Windows archivers write `\` between folders; the names only ever
      // select manifest files, so reading it as `/` opens no way out.
      const name = directory.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
      const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      const wide = zip64Values(extra, {
        size: entrySize === 0xffffffff,
        compressedSize: compressedSize === 0xffffffff,
        localHeaderOffset: localHeaderOffset === 0xffffffff
      });
      entrySize = wide.size ?? entrySize;
      compressedSize = wide.compressedSize ?? compressedSize;
      localHeaderOffset = wide.localHeaderOffset ?? localHeaderOffset;
      if (!name.endsWith("/")) {
        result.set(name, { name, method, encrypted: Boolean(flags & 1), size: entrySize, compressedSize, localHeaderOffset });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return result;
  } finally {
    await handle.close();
  }
}

/**
 * The bytes of one entry, as a stream: read from the archive, inflated when
 * the entry is deflated.
 *
 * @param {string} file
 * @param {{ name: string, method: number, encrypted: boolean, compressedSize: number, localHeaderOffset: number }} entry
 * @returns {Promise<import("node:stream").Readable>}
 */
export async function openZipEntry(file, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} in ${file} is encrypted; make the archive without a password.`);
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`${entry.name} in ${file} is compressed with method ${entry.method}, which this reader does not support; `
      + "make the archive with ordinary Deflate or with no compression.");
  }
  const handle = await fsp.open(file, "r");
  let header;
  try {
    header = await readAt(handle, entry.localHeaderOffset, 30);
  } finally {
    await handle.close();
  }
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) {
    throw new Error(`${entry.name} in ${file}: its local header is damaged.`);
  }
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.compressedSize === 0) return Readable.from([]);
  const raw = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === STORED) return raw;
  const inflate = zlib.createInflateRaw();
  raw.on("error", (error) => inflate.destroy(error));
  return raw.pipe(inflate);
}

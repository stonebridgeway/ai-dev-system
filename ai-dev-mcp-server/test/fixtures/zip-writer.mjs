/**
 * A zip archive written by hand, for the tests of the reader in
 * `src/core/model-archive.mjs`: stored and deflated entries, folders, and the
 * ZIP64 form — sizes and offsets moved to extra fields, the end record
 * pointing at a ZIP64 one — which an archiver uses past 4 GB and which a test
 * can force on a few bytes.
 */
import zlib from "node:zlib";

const u16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
};
const u64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

/**
 * @param {Array<{ name: string, data?: Buffer|string, method?: number, flags?: number }>} entries - `method` 0 stores, 8 deflates (the default); any other number is written as is.
 * @param {{ zip64?: boolean, comment?: string }} [options]
 * @returns {Buffer}
 */
export function makeZip(entries, { zip64 = false, comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const flags = (entry.flags ?? 0) | 0x0800;
    const wide = zip64 ? Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(stored.length), u64(offset)]) : Buffer.alloc(0);
    const local = Buffer.concat([
      u32(0x04034b50), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x5121), u32(crc),
      u32(zip64 ? 0xffffffff : stored.length), u32(zip64 ? 0xffffffff : data.length),
      u16(name.length), u16(zip64 ? 20 : 0), name,
      zip64 ? Buffer.concat([u16(0x0001), u16(16), u64(data.length), u64(stored.length)]) : Buffer.alloc(0),
      stored
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(zip64 ? 45 : 20), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x5121), u32(crc),
      u32(zip64 ? 0xffffffff : stored.length), u32(zip64 ? 0xffffffff : data.length),
      u16(name.length), u16(wide.length), u16(0), u16(0), u16(0), u32(0),
      u32(zip64 ? 0xffffffff : offset), name, wide
    ]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(entries.length), u64(entries.length), u64(directory.length), u64(offset)
    ]);
    tail.push(record, Buffer.concat([u32(0x07064b50), u32(0), u64(offset + directory.length), u32(1)]));
  }
  const text = Buffer.from(comment, "utf8");
  tail.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(zip64 ? 0xffff : entries.length), u16(zip64 ? 0xffff : entries.length),
    u32(zip64 ? 0xffffffff : directory.length), u32(zip64 ? 0xffffffff : offset),
    u16(text.length), text
  ]));
  return Buffer.concat([...locals, directory, ...tail]);
}

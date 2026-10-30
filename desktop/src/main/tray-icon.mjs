/**
 * The tray icon, drawn here rather than shipped: a filled circle in the
 * colour of the daemon's state on a transparent square, as PNG bytes that
 * Electron's `nativeImage.createFromBuffer` reads. No image file is committed
 * (the repository keeps binaries out), and every colour is one function call.
 */
import zlib from "node:zlib";

/** The colour of each state the tray shows, as RGB. */
export const TRAY_COLOURS = Object.freeze({
  ok: [46, 160, 67],
  degraded: [210, 153, 34],
  failed: [207, 34, 46],
  offline: [140, 149, 159]
});

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A PNG of `size` × `size` pixels: a circle of `rgb`, its edge smoothed over
 * one pixel, on transparency. Up to 1024: the build draws the macOS app's icon
 * at that size, which its `.icns` is made from.
 *
 * @param {[number, number, number]} rgb
 * @param {number} [size]
 * @returns {Buffer}
 */
export function circlePng(rgb, size = 32) {
  if (!Number.isInteger(size) || size < 8 || size > 1024) throw new RangeError("size must be a whole number from 8 to 1024.");
  const [red, green, blue] = rgb;
  const centre = size / 2;
  const radius = size / 2 - 1;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const coverage = Math.max(0, Math.min(1, radius - distance + 0.5));
      const at = 1 + x * 4;
      row[at] = red;
      row[at + 1] = green;
      row[at + 2] = blue;
      row[at + 3] = Math.round(coverage * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * The tray's state from a `system_status` answer, or `offline` without one.
 *
 * @param {{ status?: string } | null | undefined} status
 * @returns {"ok" | "degraded" | "failed" | "offline"}
 */
export function trayState(status) {
  const value = status?.status;
  return value === "ok" || value === "degraded" || value === "failed" ? value : "offline";
}

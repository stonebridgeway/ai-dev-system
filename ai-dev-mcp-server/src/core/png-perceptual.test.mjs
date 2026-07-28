import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  findNearDuplicateImages,
  perceptualHashDistance,
  pngDifferenceHash
} from "./png-perceptual.mjs";

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
}

function png(pattern) {
  const width = 18;
  const height = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const value = pattern(x, y);
      row[1 + x * 3] = value;
      row[2 + x * 3] = value;
      row[3 + x * 3] = value;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test("PNG perceptual hash detects equivalent composition despite color shift", () => {
  const first = png((x) => x * 10);
  const shifted = png((x) => Math.min(255, 30 + x * 10));
  const different = png((_x, y) => y * 14);
  const firstHash = pngDifferenceHash(first);
  assert.equal(perceptualHashDistance(firstHash, pngDifferenceHash(shifted)), 0);
  assert.ok(perceptualHashDistance(firstHash, pngDifferenceHash(different)) > 6);
});

test("near duplicate analysis honors comparison groups", () => {
  const duplicates = findNearDuplicateImages([
    { id: "a", group: "desktop", perceptual_hash: "00000000000000000000000000000000" },
    { id: "b", group: "desktop", perceptual_hash: "00000000000000000000000000000001" },
    { id: "c", group: "mobile", perceptual_hash: "00000000000000000000000000000000" }
  ], {
    comparable: (left, right) => left.group === right.group
  });
  assert.deepEqual(duplicates.map((item) => [item.left_id, item.right_id]), [["a", "b"]]);
});

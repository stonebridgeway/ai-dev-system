import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { looksLikeZip, openZipEntry, readZipEntries } from "./model-archive.mjs";
import { makeZip } from "../../test/fixtures/zip-writer.mjs";

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-archive-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function bytesOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const WEIGHTS = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 31) % 251));

for (const zip64 of [false, true]) {
  test(`entries read back byte for byte from a ${zip64 ? "ZIP64" : "plain"} archive: stored, deflated and empty; folders skipped`, async (t) => {
    const file = path.join(await scratch(t), "model.zip");
    await fs.writeFile(file, makeZip([
      { name: "bge-m3-onnx/", method: 0 },
      { name: "bge-m3-onnx/config.json", data: "{\"model_type\":\"xlm-roberta\"}", method: 0 },
      { name: "bge-m3-onnx/onnx/model_int8.onnx", data: WEIGHTS },
      { name: "bge-m3-onnx/empty.txt", data: "", method: 0 },
      { name: "bge-m3-onnx/тест.json", data: "{}" }
    ], { zip64, comment: "made for a test" }));
    assert.equal(await looksLikeZip(file), true);
    const entries = await readZipEntries(file);
    assert.deepEqual([...entries.keys()], ["bge-m3-onnx/config.json", "bge-m3-onnx/onnx/model_int8.onnx", "bge-m3-onnx/empty.txt", "bge-m3-onnx/тест.json"]);
    const weights = entries.get("bge-m3-onnx/onnx/model_int8.onnx");
    assert.equal(weights.size, WEIGHTS.length);
    assert.ok(weights.compressedSize < WEIGHTS.length, "deflated");
    assert.deepEqual(await bytesOf(await openZipEntry(file, weights)), WEIGHTS);
    assert.equal((await bytesOf(await openZipEntry(file, entries.get("bge-m3-onnx/config.json")))).toString(), "{\"model_type\":\"xlm-roberta\"}");
    assert.equal((await bytesOf(await openZipEntry(file, entries.get("bge-m3-onnx/empty.txt")))).length, 0);
  });
}

test("encrypted entries and unknown compression are refused by name", async (t) => {
  const file = path.join(await scratch(t), "odd.zip");
  await fs.writeFile(file, makeZip([
    { name: "locked.bin", data: "secret", method: 0, flags: 1 },
    { name: "lzma.bin", data: "whatever", method: 14 }
  ]));
  const entries = await readZipEntries(file);
  await assert.rejects(openZipEntry(file, entries.get("locked.bin")), /locked\.bin in .* is encrypted; make the archive without a password\./);
  await assert.rejects(openZipEntry(file, entries.get("lzma.bin")), /compressed with method 14, which this reader does not support/);
});

test("a file that is not an archive, or a damaged one, says so instead of reading garbage", async (t) => {
  const dir = await scratch(t);
  const text = path.join(dir, "notes.txt");
  await fs.writeFile(text, "just text, long enough to have a tail to search".repeat(4));
  assert.equal(await looksLikeZip(text), false);
  await assert.rejects(readZipEntries(text), /is not a zip archive \(no end-of-directory record\)/);

  const good = makeZip([{ name: "a.json", data: "{}" }, { name: "b.json", data: "{}" }]);
  const damaged = path.join(dir, "damaged.zip");
  const directoryAt = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const broken = Buffer.from(good);
  broken.writeUInt32LE(0xdeadbeef, directoryAt);
  await fs.writeFile(damaged, broken);
  await assert.rejects(readZipEntries(damaged), /central directory is damaged at entry 2 of 2/);

  // A directory larger than the file: refused before a buffer is allocated for it.
  const huge = Buffer.from(good);
  huge.writeUInt32LE(0xfffffff0, good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 12);
  const crafted = path.join(dir, "crafted.zip");
  await fs.writeFile(crafted, huge);
  await assert.rejects(readZipEntries(crafted), /its central directory says it is 4294967280 bytes at \d+, past the end of a \d+-byte file/);

  const wide = makeZip([{ name: "a.json", data: "{}" }], { zip64: true });
  const noLocator = Buffer.from(wide);
  noLocator.writeUInt32LE(0, wide.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])));
  const missing = path.join(dir, "zip64.zip");
  await fs.writeFile(missing, noLocator);
  await assert.rejects(readZipEntries(missing), /says it is a ZIP64 archive, and its ZIP64 record is missing/);

  const localBroken = Buffer.from(good);
  localBroken.writeUInt32LE(0, 0);
  const local = path.join(dir, "local.zip");
  await fs.writeFile(local, localBroken);
  const entries = await readZipEntries(local);
  await assert.rejects(openZipEntry(local, entries.get("a.json")), /its local header is damaged/);
});

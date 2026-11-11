import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DENSE_MANIFEST_PATH,
  denseVectorProvenance,
  describeDenseModelDirectory,
  parseDenseManifest,
  readDenseManifest,
  readInstalledDenseManifest,
  sameDenseProvenance,
  sha256File,
  stampVerifiedFiles,
  verifiedStampPath,
  verifyDenseModelDirectory
} from "./dense-manifest.mjs";

const digestOf = (text) => crypto.createHash("sha256").update(text).digest("hex");

function fakeManifest(overrides = {}) {
  return {
    model: "BAAI/bge-m3",
    export: "Xenova/bge-m3",
    revision: "a".repeat(40),
    dtype: "int8",
    dimensions: 1024,
    pooling: "cls",
    sources: ["https://example.invalid/model"],
    files: { "config.json": digestOf("config"), "onnx/model_int8.onnx": digestOf("weights") },
    ...overrides
  };
}

async function stage(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-manifest-"));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return dir;
}

test("the shipped manifest parses and pins a revision, a dtype and five files", () => {
  const manifest = readDenseManifest();
  assert.equal(manifest.model, "BAAI/bge-m3");
  assert.equal(manifest.export, "Xenova/bge-m3");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.dtype, "int8");
  assert.equal(manifest.dimensions, 1024);
  assert.equal(manifest.pooling, "cls");
  assert.equal(Object.keys(manifest.files).length, 5);
  assert.ok(manifest.files["onnx/model_int8.onnx"], "the weights file the dtype names is in the manifest");
  assert.ok(DENSE_MANIFEST_PATH.endsWith(path.join("models", "bge-m3.manifest.json")));
});

test("the shipped manifest's sources carry the same revision the manifest pins", () => {
  const manifest = readDenseManifest();
  assert.ok(manifest.sources.length > 0);
  for (const source of manifest.sources) {
    assert.ok(
      source.includes(manifest.revision),
      `source ${source} must resolve the pinned revision, not a moving branch`
    );
  }
});

test("a manifest missing any field it is read for is refused by name", () => {
  for (const field of ["model", "export", "revision", "dtype", "dimensions", "files"]) {
    const broken = fakeManifest();
    delete broken[field];
    assert.throws(() => parseDenseManifest(broken), new RegExp(field), `missing ${field} must be named`);
  }
});

test("a manifest with no files, no hashes or a nonsense dimension count is refused", () => {
  assert.throws(() => parseDenseManifest(fakeManifest({ files: {} })), /lists no files/);
  assert.throws(
    () => parseDenseManifest(fakeManifest({ files: { "config.json": "not-a-digest" } })),
    /no sha256 for config\.json/
  );
  assert.throws(() => parseDenseManifest(fakeManifest({ dimensions: 0 })), /nonsense dimension/);
  assert.throws(() => parseDenseManifest(fakeManifest({ dimensions: 10.5 })), /nonsense dimension/);
  assert.throws(() => parseDenseManifest("{ not json"), /not valid JSON/);
  assert.throws(() => parseDenseManifest(["a"]), /must be a JSON object/);
  assert.throws(() => parseDenseManifest(null), /must be a JSON object/);
});

test("sha256File hashes a real file and answers null for one that is not there", async () => {
  const dir = await stage({ "config.json": "config" });
  assert.equal(await sha256File(path.join(dir, "config.json")), digestOf("config"));
  assert.equal(await sha256File(path.join(dir, "absent.json")), null);
  assert.equal(await sha256File(dir), null, "a directory is not a file, and is not a crash either");
});

test("a directory holding exactly the manifest's bytes verifies ready", async () => {
  const manifest = parseDenseManifest(fakeManifest());
  const dir = await stage({ "config.json": "config", "onnx/model_int8.onnx": "weights" });
  const status = await verifyDenseModelDirectory({ manifest, dir });
  assert.equal(status.ready, true);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.mismatched, []);
  assert.equal(status.present.length, 2);
  assert.equal(status.revision, manifest.revision);
  assert.match(describeDenseModelDirectory(status), /verified/);
});

test("missing files and wrong bytes are reported apart, because the fix differs", async () => {
  const manifest = parseDenseManifest(fakeManifest());
  const dir = await stage({ "config.json": "config", "onnx/model_int8.onnx": "tampered" });
  const status = await verifyDenseModelDirectory({ manifest, dir });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.mismatched, ["onnx/model_int8.onnx"]);
  assert.match(describeDenseModelDirectory(status), /do not match the manifest/);

  const empty = await stage({});
  const absent = await verifyDenseModelDirectory({ manifest, dir: empty });
  assert.deepEqual(absent.missing, ["config.json", "onnx/model_int8.onnx"]);
  assert.deepEqual(absent.mismatched, []);
  assert.match(describeDenseModelDirectory(absent), /missing/);
});

test("a file whose digest differs only in case still verifies", async () => {
  const manifest = parseDenseManifest(fakeManifest({
    files: { "config.json": digestOf("config").toUpperCase() }
  }));
  const dir = await stage({ "config.json": "config" });
  assert.equal((await verifyDenseModelDirectory({ manifest, dir })).ready, true);
});

test("provenance changes with the backend, the revision and the dtype", () => {
  const manifest = parseDenseManifest(fakeManifest());
  const onnx = denseVectorProvenance(manifest, "onnx");
  assert.deepEqual(onnx, {
    backend: "onnx",
    model: "BAAI/bge-m3",
    revision: manifest.revision,
    dtype: "int8",
    dimensions: 1024
  });
  assert.equal(sameDenseProvenance(onnx, denseVectorProvenance(manifest, "onnx")), true);
  // The same model through the other backend is a different vector space.
  assert.equal(sameDenseProvenance(onnx, denseVectorProvenance(manifest, "python")), false);
  assert.equal(sameDenseProvenance(onnx, denseVectorProvenance(parseDenseManifest(fakeManifest({ dtype: "fp32" })), "onnx")), false);
  assert.equal(sameDenseProvenance(onnx, denseVectorProvenance(parseDenseManifest(fakeManifest({ revision: "b".repeat(40) })), "onnx")), false);
  assert.equal(sameDenseProvenance(onnx, { ...onnx, dimensions: 768 }), false);
  assert.equal(sameDenseProvenance(onnx, null), false);
  assert.equal(sameDenseProvenance(null, onnx), false);
});

test("the manifest written beside the weights is read back, and a missing one is not a throw", async () => {
  const manifest = parseDenseManifest(fakeManifest());
  const dir = await stage({ "manifest.json": JSON.stringify(manifest) });
  assert.equal((await readInstalledDenseManifest(dir)).revision, manifest.revision);
  assert.equal(await readInstalledDenseManifest(await stage({})), null);
  assert.equal(await readInstalledDenseManifest(await stage({ "manifest.json": "{ broken" })), null);
});

test("a file name that climbs out of the model directory is not a model file", () => {
  for (const name of ["../escape.json", "onnx/../../x", "/etc/passwd", "C:/x", "a\\b", "./config.json", "onnx//model", ""]) {
    assert.throws(() => parseDenseManifest(fakeManifest({ files: { [name]: digestOf("x") } })), /names a file outside its directory|lists no files/, name);
  }
});

test("a checked file is trusted while it is unchanged, and read again the moment it changes", async () => {
  const dir = await stage({ "config.json": "config", "onnx/model_int8.onnx": "weights" });
  const stampDir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-stamp-"));
  const stampFile = verifiedStampPath(stampDir, dir);
  const manifest = fakeManifest();
  const reads = [];
  const hashFile = async (file) => {
    reads.push(path.basename(file));
    return sha256File(file);
  };

  const first = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile, trustStamp: true });
  assert.equal(first.ready, true);
  assert.deepEqual(reads, ["config.json", "model_int8.onnx"], "nothing on record yet: both are read");
  reads.length = 0;
  const second = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile, trustStamp: true });
  assert.equal(second.ready, true);
  assert.deepEqual([reads, second.hashed], [[], []], "unchanged: nothing is read");

  // The same length, other bytes: what a size-only record would miss. The
  // time is moved on by hand: a coarse clock can give a write within the same
  // few milliseconds the old time, which a model file never sees and a test
  // can.
  const weights = path.join(dir, "onnx", "model_int8.onnx");
  await fs.writeFile(weights, "WEIGHTS");
  await fs.utimes(weights, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const third = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile, trustStamp: true });
  assert.deepEqual([third.ready, third.mismatched, reads], [false, ["onnx/model_int8.onnx"], ["model_int8.onnx"]]);
  reads.length = 0;
  await fs.writeFile(weights, "weights");
  await fs.utimes(weights, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  const fourth = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile, trustStamp: true });
  assert.deepEqual([fourth.ready, reads], [true, ["model_int8.onnx"]], "the wrong bytes were never vouched for");

  reads.length = 0;
  const full = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile });
  assert.deepEqual([full.ready, reads.length], [true, 2], "without trust everything is read, as `model verify` does");

  await fs.rm(path.join(dir, "config.json"));
  const gone = await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile, trustStamp: true });
  assert.deepEqual(gone.missing, ["config.json"], "a deleted file is missing, whatever the record says");
});

test("the record is per directory, survives an unwritable place, and can be written for files checked elsewhere", async () => {
  const dir = await stage({ "config.json": "config", "onnx/model_int8.onnx": "weights" });
  const other = await stage({ "config.json": "config", "onnx/model_int8.onnx": "weights" });
  const stampDir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-stamp-"));
  assert.notEqual(verifiedStampPath(stampDir, dir), verifiedStampPath(stampDir, other));
  const manifest = fakeManifest();
  await stampVerifiedFiles({ stampFile: verifiedStampPath(stampDir, dir), dir, manifest, verified: ["config.json", "onnx/model_int8.onnx"] });
  let reads = 0;
  const hashFile = async (file) => {
    reads += 1;
    return sha256File(file);
  };
  assert.equal((await verifyDenseModelDirectory({ manifest, dir, hashFile, stampFile: verifiedStampPath(stampDir, dir), trustStamp: true })).ready, true);
  assert.equal(reads, 0, "a download's own check counts");
  // Another directory's record is not this one's, even at the same path name.
  await fs.copyFile(verifiedStampPath(stampDir, dir), verifiedStampPath(stampDir, other));
  await verifyDenseModelDirectory({ manifest, dir: other, hashFile, stampFile: verifiedStampPath(stampDir, other), trustStamp: true });
  assert.equal(reads, 2);

  const blocked = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dense-stamp-")), "a-file");
  await fs.writeFile(blocked, "not a directory");
  const unwritable = await verifyDenseModelDirectory({ manifest, dir, stampFile: path.join(blocked, "stamp.json"), trustStamp: true });
  assert.equal(unwritable.ready, true, "no place for the record costs a hash, not an answer");
  await stampVerifiedFiles({ stampFile: "", dir, manifest, verified: ["config.json"] });
});

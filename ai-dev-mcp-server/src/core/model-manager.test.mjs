import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PART_META_SUFFIX, PART_SUFFIX } from "./dense-download.mjs";
import { parseDenseManifest } from "./dense-manifest.mjs";
import {
  defaultStampDir,
  denseRuntimeSupport,
  importModel,
  installModel,
  modelStatus,
  removeModel,
  verifyModel,
  withModelLock
} from "./model-manager.mjs";
import { syntheticManifest, syntheticModelFiles } from "./synthetic-model.mjs";
import { startModelHost } from "../../test/fixtures/model-host.mjs";
import { makeZip } from "../../test/fixtures/zip-writer.mjs";

const FILES = syntheticModelFiles();
const MANIFEST = parseDenseManifest(syntheticManifest(FILES));
const roomy = async () => ({ bsize: 4096, bavail: 1e9 });
const quiet = () => {};

async function scratch(t, prefix = "model-manager-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeModel(dir, files = FILES) {
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
}

/** A model directory, a place for its records, and the files' manifest. */
async function setup(t) {
  const root = await scratch(t);
  return { root, dir: path.join(root, "models", "bge-m3-onnx"), stampDir: path.join(root, "cache", "dense-model") };
}

test("a model this user cannot read is not installed, and says why; a fault of the code still throws", async (t) => {
  const { dir, stampDir } = await setup(t);
  await writeModel(dir);
  const denied = async () => {
    throw Object.assign(new Error("EACCES: permission denied, stat '/models/bge-m3-onnx/config.json'"), { code: "EACCES", syscall: "stat" });
  };
  const status = await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {}, verify: denied });
  assert.equal(status.installed, false);
  assert.equal(status.unreadable, "EACCES: permission denied, stat '/models/bge-m3-onnx/config.json'");
  assert.deepEqual([status.present, status.missing, status.mismatched, status.partial], [[], [], [], []], "its files are unseen, not missing");
  assert.equal("unreadable" in await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {} }), false, "a readable model has no such field");
  // A file not there at all is missing beside the unreadable one.
  const gone = Object.keys(MANIFEST.files)[0];
  await fs.rm(path.join(dir, ...gone.split("/")));
  assert.deepEqual((await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {}, verify: denied })).missing, [gone]);
  // A fault of the code throws, a string code of Node's own included.
  await assert.rejects(modelStatus({ manifest: MANIFEST, dir, stampDir, env: {}, verify: async () => { throw new TypeError("not a filesystem error"); } }), TypeError);
  await assert.rejects(modelStatus({ manifest: MANIFEST, dir, stampDir, env: {}, verify: async () => fs.stat(undefined) }), { code: "ERR_INVALID_ARG_TYPE" });
});

test("status before anything: not installed, every file missing, nothing read, sources listed", async (t) => {
  const { dir, stampDir } = await setup(t);
  const status = await modelStatus({ manifest: MANIFEST, dir, stampDir, env: { AI_DEV_MODEL_MIRROR: "https://hf-mirror.com" } });
  assert.equal(status.installed, false);
  assert.deepEqual(status.missing, Object.keys(FILES));
  assert.deepEqual([status.present, status.partial, status.mismatched], [[], [], []]);
  assert.equal(status.sources[0], `https://hf-mirror.com/${MANIFEST.export}/resolve/${MANIFEST.revision}`);
  assert.equal(typeof status.supported, "boolean");
  const broken = await modelStatus({ manifest: MANIFEST, dir, stampDir, env: { AI_DEV_MODEL_MIRROR: "nonsense" } });
  assert.match(broken.sources_error, /AI_DEV_MODEL_MIRROR=nonsense is not an http\(s\) address/);
  assert.ok(defaultStampDir({ AI_DEV_HOME: "/x/runtime" }).endsWith(path.join("runtime", "cache", "dense-model")));
});

test("install downloads, records, and the next status reads nothing; a broken one leaves a partial that status shows", async (t) => {
  const { dir, stampDir } = await setup(t);
  const dead = await startModelHost({ files: FILES, fail: new Map([["onnx/model_int8.onnx", 503]]) });
  const host = await startModelHost({ files: FILES });
  t.after(() => Promise.all([dead.close(), host.close()]));
  await assert.rejects(
    installModel({ manifest: parseDenseManifest({ ...MANIFEST, sources: [dead.base] }), dir, stampDir, env: {}, log: quiet, statfs: roomy }),
    /Could not fetch onnx\/model_int8\.onnx: .*HTTP 503/
  );
  // What a cut transfer leaves: the first kilobyte, and what it is the start of.
  const weights = path.join(dir, "onnx", "model_int8.onnx");
  await fs.writeFile(`${weights}${PART_SUFFIX}`, FILES["onnx/model_int8.onnx"].subarray(0, 1000));
  await fs.writeFile(`${weights}${PART_META_SUFFIX}`, JSON.stringify({
    format: 1, revision: MANIFEST.revision, sha256: MANIFEST.files["onnx/model_int8.onnx"], size: FILES["onnx/model_int8.onnx"].length
  }));
  const manifest = parseDenseManifest({ ...MANIFEST, sources: [host.base] });
  const half = await modelStatus({ manifest, dir, stampDir, env: {} });
  assert.equal(half.installed, false);
  assert.deepEqual(half.partial, [{ file: "onnx/model_int8.onnx", bytes: 1000, size: FILES["onnx/model_int8.onnx"].length }]);
  assert.deepEqual(half.present, ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"], "the files that did arrive count");

  const events = [];
  const result = await installModel({ manifest, dir, stampDir, env: {}, log: quiet, statfs: roomy, onProgress: (event) => events.push(event) });
  assert.equal(result.ready, true);
  assert.equal(result.resumed, 1);
  assert.equal(events.at(-1).phase, "done");
  const status = await modelStatus({ manifest, dir, stampDir, env: {} });
  assert.deepEqual([status.installed, status.hashed, status.partial], [true, [], []], "the download's own check is on record");
  assert.equal(status.installed_revision, MANIFEST.revision);
});

test("verify reads every file with progress, and catches a file changed behind the record", async (t) => {
  const { dir, stampDir } = await setup(t);
  await writeModel(dir);
  const events = [];
  const verified = await verifyModel({ manifest: MANIFEST, dir, stampDir, onProgress: (event) => events.push(event) });
  assert.equal(verified.ready, true);
  assert.equal(verified.hashed.length, Object.keys(FILES).length);
  const total = Object.values(FILES).reduce((sum, body) => sum + body.length, 0);
  assert.deepEqual([events.at(-1).bytes, events.at(-1).total], [total, total]);
  assert.ok(events.every((event) => event.phase === "verifying"));

  const weights = path.join(dir, "onnx", "model_int8.onnx");
  const changed = Buffer.from(FILES["onnx/model_int8.onnx"]);
  changed[changed.length - 1] ^= 0xff;
  await fs.writeFile(weights, changed);
  await fs.utimes(weights, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
  const status = await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {} });
  assert.deepEqual([status.installed, status.mismatched, status.hashed], [false, ["onnx/model_int8.onnx"], ["onnx/model_int8.onnx"]]);
});

test("import from the model folder, from a folder above it, and from a cache with two revisions in it", async (t) => {
  const { root, dir, stampDir } = await setup(t);
  const elsewhere = path.join(root, "usb", "models", "bge-m3-onnx");
  await writeModel(elsewhere);
  await fs.writeFile(path.join(elsewhere, "README.txt"), "copied from another machine");

  const events = [];
  const fromFolder = await importModel({ manifest: MANIFEST, source: elsewhere, dir, stampDir, onProgress: (event) => events.push(event) });
  assert.deepEqual([fromFolder.ready, fromFolder.copied.length, fromFolder.from], [true, 5, elsewhere]);
  for (const [relative, body] of Object.entries(FILES)) assert.deepEqual(await fs.readFile(path.join(dir, ...relative.split("/"))), body);
  await assert.rejects(fs.access(path.join(dir, "README.txt")), /ENOENT/, "only the model's files are copied");
  assert.equal(events.at(-1).bytes, events.at(-1).total);
  assert.deepEqual((await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {} })).hashed, [], "imported files are on record");
  const again = await importModel({ manifest: MANIFEST, source: path.join(root, "usb"), dir, stampDir });
  assert.deepEqual([again.copied, again.skipped.length], [[], 5], "what is already here is not copied twice");

  // A Hugging Face cache: two snapshots, one of them the wrong revision.
  const cache = path.join(root, "hf", "models--x--bge-m3", "snapshots");
  const wrong = { ...FILES, "onnx/model_int8.onnx": Buffer.from("an older export") };
  await writeModel(path.join(cache, "0000000000000000000000000000000000000000"), wrong);
  await writeModel(path.join(cache, MANIFEST.revision));
  const fresh = path.join(root, "fresh");
  const fromCache = await importModel({ manifest: MANIFEST, source: path.join(root, "hf"), dir: fresh, stampDir });
  assert.equal(fromCache.from, path.join(cache, MANIFEST.revision), "the folder named for the pinned revision first");
  assert.equal(fromCache.ready, true);

  const self = await importModel({ manifest: MANIFEST, source: dir, dir, stampDir });
  assert.deepEqual([self.ready, self.copied], [true, []], "importing a model folder into itself is a verify");
  // ... which fails, and says why, when a file in it is not the pinned one.
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx"), FILES["onnx/model_int8.onnx"].subarray(0, 100));
  await assert.rejects(importModel({ manifest: MANIFEST, source: dir, dir, stampDir }),
    /bge-m3-onnx is the model folder itself, and onnx\/model_int8\.onnx in it is not the pinned file; there is no other copy here/);
});

test("import from a zip, nested one folder deep, plain or ZIP64, with / or \\ between folders", async (t) => {
  // Windows archivers write `\`.
  const backslashed = await setup(t);
  const windowsZip = path.join(backslashed.root, "bge-m3.zip");
  await fs.writeFile(windowsZip, makeZip(Object.entries(FILES).map(([name, data]) => ({ name: `bge-m3-onnx\\${name.split("/").join("\\")}`, data }))));
  const fromWindows = await importModel({ manifest: MANIFEST, source: windowsZip, dir: backslashed.dir, stampDir: backslashed.stampDir });
  assert.deepEqual([fromWindows.ready, fromWindows.copied.length], [true, 5]);
  for (const zip64 of [false, true]) {
    const { root, dir, stampDir } = await setup(t);
    const archive = path.join(root, "bge-m3.zip");
    await fs.writeFile(archive, makeZip(Object.entries(FILES).map(([name, data]) => ({ name: `bge-m3-onnx/${name}`, data })), { zip64 }));
    const result = await importModel({ manifest: MANIFEST, source: archive, dir, stampDir });
    assert.deepEqual([result.ready, result.copied.length, result.from], [true, 5, `${archive}:bge-m3-onnx/`]);
    assert.equal((await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {} })).installed, true);
  }
});

test("import refuses wrong bytes without placing them, and says what is missing from an incomplete source", async (t) => {
  const { root, dir, stampDir } = await setup(t);
  const tampered = path.join(root, "tampered");
  await writeModel(tampered, { ...FILES, "onnx/model_int8.onnx": Buffer.from("not the model") });
  await assert.rejects(
    importModel({ manifest: MANIFEST, source: tampered, dir, stampDir }),
    /onnx\/model_int8\.onnx in .* is not the pinned file: its sha256 is [0-9a-f]{64}, the manifest says [0-9a-f]{64}\. Nothing was copied over it; \d+ other file\(s\) were\./
  );
  await assert.rejects(fs.access(path.join(dir, "onnx", "model_int8.onnx")), /ENOENT/);
  assert.deepEqual((await fs.readdir(path.join(dir, "onnx"))), [], "no temporary file left either");

  const partial = path.join(root, "partial");
  await writeModel(partial, { "config.json": FILES["config.json"], "tokenizer.json": FILES["tokenizer.json"] });
  await assert.rejects(importModel({ manifest: MANIFEST, source: partial, dir, stampDir }), /No folder under .* holds the whole model\. The closest, .*partial, lacks tokenizer_config\.json, special_tokens_map\.json, onnx\/model_int8\.onnx\./);

  const half = path.join(root, "half.zip");
  await fs.writeFile(half, makeZip([{ name: "config.json", data: FILES["config.json"] }]));
  await assert.rejects(importModel({ manifest: MANIFEST, source: half, dir, stampDir }), /does not hold the whole model/);
  const text = path.join(root, "notes.txt");
  await fs.writeFile(text, "hello");
  await assert.rejects(importModel({ manifest: MANIFEST, source: text, dir, stampDir }), /is neither a folder nor a \.zip archive/);
  await assert.rejects(importModel({ manifest: MANIFEST, source: path.join(root, "nowhere"), dir, stampDir }), /does not exist/);
  await assert.rejects(importModel({ manifest: MANIFEST, source: "", dir, stampDir }), /Say where to import from/);
});

test("a cancelled import keeps the files it finished and leaves no half-copied one", async (t) => {
  const { root, dir, stampDir } = await setup(t);
  const source = path.join(root, "source");
  await writeModel(source);
  const controller = new AbortController();
  const failure = await importModel({
    manifest: MANIFEST,
    source,
    dir,
    stampDir,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.file === "tokenizer.json") controller.abort();
    }
  }).then(() => null, (error) => error);
  assert.equal(failure?.cancelled, true);
  assert.match(failure.message, /Import cancelled; files already copied are kept\./);
  const left = (await fs.readdir(dir)).sort();
  assert.ok(left.includes("config.json"));
  assert.ok(!left.some((name) => name.includes(".part")), left.join(", "));
});

test("remove deletes the model, its partials and its record, and leaves anything else where it was", async (t) => {
  const { dir, stampDir } = await setup(t);
  await writeModel(dir);
  await verifyModel({ manifest: MANIFEST, dir, stampDir });
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(dir, "onnx", `model_int8.onnx${PART_SUFFIX}`), "partial");
  await fs.writeFile(path.join(dir, "onnx", `model_int8.onnx${PART_META_SUFFIX}`), "{}");
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx.4242.part"), "2.x leftover");
  await fs.writeFile(path.join(dir, "onnx", `model_int8.onnx${PART_META_SUFFIX}.4243.tmp`), "a killed write's record");
  await fs.writeFile(path.join(dir, "my-notes.md"), "mine");
  const result = await removeModel({ manifest: MANIFEST, dir, stampDir });
  assert.equal(result.removed.length, 10);
  assert.ok(result.freed > Object.values(FILES).reduce((sum, body) => sum + body.length, 0));
  assert.deepEqual(result.kept, ["my-notes.md"]);
  assert.deepEqual(await fs.readdir(dir), ["my-notes.md"], "onnx/ went with its files; the folder stays for what is not ours");
  assert.equal((await modelStatus({ manifest: MANIFEST, dir, stampDir, env: {} })).installed, false);

  await fs.rm(path.join(dir, "my-notes.md"));
  await writeModel(dir);
  await removeModel({ manifest: MANIFEST, dir, stampDir });
  await assert.rejects(fs.access(dir), /ENOENT/, "an emptied folder goes too");
  assert.deepEqual((await removeModel({ manifest: MANIFEST, dir, stampDir })).removed, [], "removing nothing is not an error");
});

test("remove refuses a folder that is not the model's, and leaves it whole", async (t) => {
  const { root, stampDir } = await setup(t);
  const app = path.join(root, "my-app");
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, "manifest.json"), JSON.stringify({ name: "my-app", version: "1.0.0" }));
  await fs.writeFile(path.join(app, "config.json"), JSON.stringify({ theme: "dark" }));
  await assert.rejects(removeModel({ manifest: MANIFEST, dir: app, stampDir }), /my-app does not look like the model's folder: .*Nothing was removed\./);
  assert.deepEqual((await fs.readdir(app)).sort(), ["config.json", "manifest.json"]);
  // A download that stopped partway is the model's, with nothing else to show for it.
  const stopped = path.join(root, "stopped");
  await fs.mkdir(path.join(stopped, "onnx"), { recursive: true });
  await fs.writeFile(path.join(stopped, "onnx", `model_int8.onnx${PART_SUFFIX}`), "partial");
  await fs.writeFile(path.join(stopped, "onnx", `model_int8.onnx${PART_META_SUFFIX}`), JSON.stringify({
    format: 1, revision: MANIFEST.revision, sha256: MANIFEST.files["onnx/model_int8.onnx"], size: FILES["onnx/model_int8.onnx"].length
  }));
  assert.deepEqual((await removeModel({ manifest: MANIFEST, dir: stopped, stampDir })).removed.sort(),
    [`onnx/model_int8.onnx${PART_SUFFIX}`, `onnx/model_int8.onnx${PART_META_SUFFIX}`].sort());
  // A copy of the model's files, without the manifest an install writes: recognised by their sha256.
  const copied = path.join(root, "copied");
  await writeModel(copied);
  assert.equal((await removeModel({ manifest: MANIFEST, dir: copied, stampDir })).removed.length, 5);
});

test("a lock that cannot be taken for another reason says that reason, not another operation", async (t) => {
  const { root } = await setup(t);
  const file = path.join(root, "not-a-folder");
  await fs.writeFile(file, "a file where a folder should be");
  await assert.rejects(withModelLock(path.join(file, "bge-m3-onnx"), async () => "ran"),
    (error) => /^Cannot work in .*bge-m3-onnx: .*\([A-Z]+\)\. Point --dir or BGE_M3_ONNX_DIR at a folder this account can write\.$/.test(error.message)
      && !/Another model operation/.test(error.message));
});

test("two operations on one directory do not interleave: the second is told who holds it", async (t) => {
  const { dir, stampDir } = await setup(t);
  let release;
  const holding = withModelLock(dir, () => new Promise((resolve) => {
    release = resolve;
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(removeModel({ manifest: MANIFEST, dir, stampDir }), new RegExp(`Another model operation is working in .*bge-m3-onnx \\(pid ${process.pid}\\)\\. Wait for it to finish`));
  release();
  await holding;
  assert.deepEqual((await removeModel({ manifest: MANIFEST, dir, stampDir })).removed, []);
});

test("the runtime's support is read from the installed binaries, and an Intel Mac is told so", async (t) => {
  const root = await scratch(t, "ort-");
  await fs.mkdir(path.join(root, "bin", "napi-v6", "darwin", "arm64"), { recursive: true });
  await fs.mkdir(path.join(root, "bin", "napi-v6", "linux", "x64"), { recursive: true });
  await fs.writeFile(path.join(root, "bin", "napi-v6", "darwin", "arm64", "onnxruntime_binding.node"), "");
  await fs.writeFile(path.join(root, "bin", "napi-v6", "linux", "x64", "onnxruntime_binding.node"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.30.0" }));
  assert.equal(denseRuntimeSupport({ platform: "linux", arch: "x64", packageRoot: root }).supported, true);
  assert.equal(denseRuntimeSupport({ platform: "darwin", arch: "arm64", packageRoot: root }).supported, true);
  const intel = denseRuntimeSupport({ platform: "darwin", arch: "x64", packageRoot: root });
  assert.equal(intel.supported, false);
  assert.match(intel.reason, /^onnxruntime-node 1\.30\.0 has no build for darwin-x64 \(Intel Mac\), so the local model cannot run on this machine\. Keyword and sparse search work without it/);
  assert.equal(denseRuntimeSupport({ platform: "freebsd", arch: "x64", packageRoot: path.join(root, "nowhere") }).supported, false);
  const here = denseRuntimeSupport();
  assert.equal(here.platform, `${process.platform}-${process.arch}`);
  assert.equal(here.supported, true, "the machine running the suite has a build");
});

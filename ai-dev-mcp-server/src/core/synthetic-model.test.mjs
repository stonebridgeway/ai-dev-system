import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createOnnxDenseRuntime } from "./dense-onnx.mjs";
import { parseDenseManifest, verifyDenseModelDirectory } from "./dense-manifest.mjs";
import { SYNTHETIC_TOPICS, syntheticManifest, syntheticModelFiles, writeSyntheticModel } from "./synthetic-model.mjs";

const WORKER = new URL("../workers/dense-onnx-worker.mjs", import.meta.url);
const dot = (left, right) => left.reduce((sum, value, index) => sum + (value * right[index]), 0);

test("the stand-in is the pinned export's five files, under 100 KB, the same on every call", () => {
  const files = syntheticModelFiles();
  const real = parseDenseManifest(JSON.parse(JSON.stringify({ ...syntheticManifest(files) })));
  assert.deepEqual(Object.keys(files).sort(), ["config.json", "onnx/model_int8.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"]);
  const total = Object.values(files).reduce((sum, body) => sum + body.length, 0);
  assert.ok(total < 100 * 1024, `${total} bytes`);
  assert.deepEqual(syntheticModelFiles(), files, "made from code, byte for byte the same each time");
  assert.equal(real.dimensions, 1024);
  assert.equal(real.dtype, "int8", "so transformers.js loads onnx/model_int8.onnx, as it does the real one");
  assert.match(real.revision, /^[0-9a-f]{40}$/);
  assert.equal(JSON.parse(files["config.json"]).model_type, "xlm-roberta");
  assert.equal(JSON.parse(files["tokenizer.json"]).model.type, "Unigram");
});

test("written to a folder, it verifies against its own manifest", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-model-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { manifest } = await writeSyntheticModel(path.join(dir, "bge-m3-onnx"));
  const status = await verifyDenseModelDirectory({ manifest: parseDenseManifest(manifest), dir: path.join(dir, "bge-m3-onnx") });
  assert.equal(status.ready, true);
});

test("through the real worker — transformers.js 4.3 and onnxruntime-node — it embeds: 1024 numbers, unit length, topics apart", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-model-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const modelDir = path.join(dir, "bge-m3-onnx");
  const { manifest } = await writeSyntheticModel(modelDir);
  const runtime = createOnnxDenseRuntime({
    modelDir,
    manifest,
    spawnWorker: ({ modelDir: folder, manifest: pinned }) => new Worker(WORKER, { workerData: { modelDir: folder, manifest: { ...pinned } } })
  });
  t.after(() => runtime.shutdown());
  const texts = ["Database query on a postgres table", "SQL storage and schema", "React button component", "deploy the docker container"];
  const answer = await runtime.embedTexts({ texts, batch_size: 2 });
  assert.equal(answer.backend, "onnx");
  assert.equal(answer.count, 4);
  assert.equal(answer.dimensions, 1024);
  for (const vector of answer.embeddings) assert.ok(Math.abs(Math.sqrt(dot(vector, vector)) - 1) < 1e-3);
  const [database, storage, react, docker] = answer.embeddings;
  assert.ok(dot(database, storage) > 0.9, "two database texts with no word in common are neighbours");
  assert.ok(dot(database, react) < 0.2 && dot(react, docker) < 0.2, "different topics are not");
  assert.ok(answer.load_seconds < 30);
  assert.equal(Object.keys(SYNTHETIC_TOPICS).length, 4);
});

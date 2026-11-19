/**
 * The one test that needs the weights.
 *
 * Everything else about the ONNX backend is covered against a stub, because a
 * 600 MB download cannot be a precondition of `npm run check`. This is the half
 * a stub cannot answer — that the pinned export, loaded through the real
 * runtime, actually produces a normalized 1024-dimension vector — so it skips
 * with a reason where the model is not installed, and runs in
 * `.github/workflows/dense-eval.yml`, which downloads it first.
 *
 * It is written as the acceptance criterion rather than as a smoke test: the
 * width, the norm, and that two different sentences are not the same vector.
 */
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createOnnxDenseRuntime, defaultOnnxModelDir } from "./dense-onnx.mjs";
import { readDenseManifest, verifyDenseModelDirectory } from "./dense-manifest.mjs";

const manifest = readDenseManifest();
const modelDir = defaultOnnxModelDir({ env: process.env });
const verified = await verifyDenseModelDirectory({ manifest, dir: modelDir });
const skip = verified.ready
  ? false
  : `the pinned export is not in ${modelDir} (${verified.missing.length} file(s) missing, `
    + `${verified.mismatched.length} mismatched). Run \`npm run setup -- --model\`.`;

test("the pinned export embeds text into normalized vectors of the promised width", { skip }, async (t) => {
  const runtime = createOnnxDenseRuntime({
    modelDir,
    manifest,
    spawnWorker: ({ modelDir: dir, manifest: pinned }) => new Worker(
      new URL("../workers/dense-onnx-worker.mjs", import.meta.url),
      { workerData: { modelDir: dir, manifest: { ...pinned } } }
    )
  });
  t.after(() => runtime.shutdown());

  const answer = await runtime.embedTexts({ texts: ["hybrid search", "гибридный поиск", "hybrid search"] });

  assert.equal(answer.backend, "onnx");
  assert.equal(answer.count, 3);
  assert.equal(answer.dimensions, manifest.dimensions);
  for (const vector of answer.embeddings) {
    assert.equal(vector.length, manifest.dimensions);
    const norm = Math.sqrt(vector.reduce((total, value) => total + (value * value), 0));
    assert.ok(Math.abs(norm - 1) < 0.01, `vectors must be normalized, this one has norm ${norm}`);
  }

  const [english, russian, again] = answer.embeddings;
  const dot = (left, right) => left.reduce((total, value, index) => total + (value * right[index]), 0);
  assert.ok(dot(english, again) > 0.999, "the same sentence embeds to the same vector");
  assert.ok(dot(english, russian) < 0.999, "two different sentences do not embed to one vector");
  // BGE-M3 is a multilingual model, and a translation pair is the case the
  // hybrid search was chosen for. This is a floor, not a quality measure — the
  // quality numbers come from `run_search_eval` in the dense-eval workflow.
  assert.ok(dot(english, russian) > 0.5, `a translation pair should be close, scored ${dot(english, russian)}`);
});

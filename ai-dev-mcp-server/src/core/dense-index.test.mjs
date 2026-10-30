import assert from "node:assert/strict";
import test from "node:test";
import { DENSE_PLAN_BATCH, denseCoverage, embedDensePlan } from "./dense-index.mjs";

const records = (count) => new Array(count).fill(0).map((_value, index) => ({
  id: `doc-${index}`,
  text: `passage ${index}`,
  content_hash: `hash-${index}`
}));

const vectorsFor = (texts) => ({ embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]) });

test("a plan is embedded in batches and paired back with its document ids", async () => {
  const seen = [];
  const vectors = await embedDensePlan({
    records: records(5),
    embed: async (texts) => {
      seen.push(texts.length);
      return vectorsFor(texts);
    },
    dimensions: 4,
    batchSize: 2
  });

  assert.deepEqual(seen, [2, 2, 1]);
  assert.equal(vectors.length, 5);
  assert.deepEqual(vectors[3], { id: "doc-3", content_hash: "hash-3", vector: [0.1, 0.2, 0.3, 0.4] });
});

test("progress is reported as the work lands", async () => {
  const progress = [];
  await embedDensePlan({
    records: records(5),
    embed: async (texts) => vectorsFor(texts),
    dimensions: 4,
    batchSize: 2,
    onProgress: (done, total) => progress.push(`${done}/${total}`)
  });
  assert.deepEqual(progress, ["2/5", "4/5", "5/5"]);
});

test("a backend that returns the wrong number of vectors is caught, not zipped short", async () => {
  await assert.rejects(
    () => embedDensePlan({
      records: records(3),
      embed: async () => ({ embeddings: [[1, 2, 3, 4]] }),
      dimensions: 4
    }),
    /returned 1 vectors for 3 passages/
  );
});

test("a vector of the wrong width is refused rather than silently scoring zero forever", async () => {
  // The helper's dot product answers 0.0 on a length mismatch, so a 768-wide
  // vector in a 1024-wide index is invisible rather than wrong-looking.
  await assert.rejects(
    () => embedDensePlan({
      records: records(1),
      embed: async () => ({ embeddings: [[1, 2, 3]] }),
      dimensions: 4
    }),
    /returned a 3 vector; the manifest says 4/
  );
  await assert.rejects(
    () => embedDensePlan({ records: records(1), embed: async () => ({ embeddings: [null] }), dimensions: 4 }),
    /non-array vector/
  );
});

test("a missing embeddings key is a mismatch, not an empty success", async () => {
  await assert.rejects(
    () => embedDensePlan({ records: records(1), embed: async () => ({}), dimensions: 4 }),
    /returned 0 vectors for 1 passages/
  );
});

test("the default batch size is the documented one", async () => {
  const seen = [];
  await embedDensePlan({
    records: records(DENSE_PLAN_BATCH + 1),
    embed: async (texts) => {
      seen.push(texts.length);
      return vectorsFor(texts);
    },
    dimensions: 4
  });
  assert.deepEqual(seen, [DENSE_PLAN_BATCH, 1]);
});

test("coverage counts the current model's vectors; another model's wait for --model", () => {
  const onnx = { backend: "onnx", revision: "4de1", dtype: "int8" };
  const python = { backend: "python", revision: "unpinned", dtype: "fp32" };
  const status = () => ({
    dense_documents: 365,
    dense_pending_documents: 0,
    dense_eligible_documents: 365,
    dense_models: [{ ...python, documents: 300 }, { ...onnx, documents: 65 }]
  });
  const mixed = denseCoverage(status(), onnx);
  assert.deepEqual([mixed.dense_documents, mixed.dense_pending_documents, mixed.dense_other_model_documents], [65, 300, 300]);
  const fromPython = denseCoverage({ ...status(), dense_models: [{ ...python, documents: 365 }] }, onnx);
  assert.deepEqual([fromPython.dense_documents, fromPython.dense_pending_documents, fromPython.dense_other_model_documents], [0, 365, 365]);
  const current = denseCoverage({ ...status(), dense_models: [{ ...onnx, documents: 360 }], dense_pending_documents: 5 }, onnx);
  assert.deepEqual([current.dense_documents, current.dense_pending_documents, current.dense_other_model_documents], [360, 5, 0]);
  const noEligibleKey = denseCoverage({ dense_documents: 10, dense_pending_documents: 2, dense_models: [{ ...python, documents: 10 }] }, onnx);
  assert.equal(noEligibleKey.dense_pending_documents, 12, "an index without the key: what it had plus what waited");
  const untouched = { dense_documents: 7, dense_pending_documents: 1 };
  assert.deepEqual(denseCoverage({ ...untouched }, onnx), untouched, "no per-model counts, nothing to say");
  assert.deepEqual(denseCoverage({ ...status() }, null), status(), "no model to compare with, nothing changed");
});

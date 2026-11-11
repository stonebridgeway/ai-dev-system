import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEmbeddingBackend } from "./embedding-health.mjs";

const ONNX = Object.freeze({ ready: true, dir: "/m/bge-m3-onnx", export: "Xenova/bge-m3", revision: "4de13258303883538bd53b696b452bf8099f0858", dtype: "int8", missing: [], mismatched: [] });

const payload = ({ available = true, onnx = ONNX, notes = [], partial = [], reason = "" } = {}) => ({
  model_dir: onnx.dir,
  partial,
  worker: { started: false },
  dense_backend: { backend: "onnx", available, reason, onnx, legacy: { notes, command: notes.length ? "npm run setup -- --model" : "" } }
});

test("a verified model is ok, and says which export and that no Python is involved", () => {
  const verdict = evaluateEmbeddingBackend(payload());
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.summary, "Dense search is ready through the ONNX backend (Xenova/bge-m3 @ 4de132583038, int8); no Python is involved.");
});

test("no model is skipped — optional — with the reason the runtime gave", () => {
  const reason = "Dense search is not installed: the model is not on this machine. Run `npm run setup -- --model` to download it.";
  const verdict = evaluateEmbeddingBackend(payload({ available: false, reason, onnx: { ...ONNX, ready: false, missing: ["config.json"] } }));
  assert.deepEqual([verdict.status, verdict.summary, verdict.details.optional], ["skipped", reason, true]);
  assert.equal(evaluateEmbeddingBackend({}).status, "skipped", "an empty payload is not a crash");
});

test("a download that stopped partway is skipped with what is kept and how to continue", () => {
  const verdict = evaluateEmbeddingBackend(payload({
    available: false,
    onnx: { ...ONNX, ready: false, missing: ["onnx/model_int8.onnx"] },
    partial: [{ file: "onnx/model_int8.onnx", bytes: 312 * 1024 * 1024, size: 568 * 1024 * 1024 }]
  }));
  assert.equal(verdict.status, "skipped");
  assert.match(verdict.summary, /a model download stopped partway \(312 MB of onnx\/model_int8\.onnx\)\. `npm run setup -- --model` continues it from there\./);
});

test("a model this user cannot read is said as that, not as a download to continue", () => {
  const reason = "Dense search is not ready: the model in /models/bge-m3-onnx cannot be read (EACCES: permission denied, open '/models/bge-m3-onnx/tokenizer.json'). The image runs as uid 1000: …";
  const verdict = evaluateEmbeddingBackend(payload({
    available: false,
    reason,
    onnx: { ...ONNX, ready: false, missing: ["config.json"], unreadable: "EACCES: permission denied, open '/models/bge-m3-onnx/tokenizer.json'" },
    partial: [{ file: "config.json", bytes: 100, size: 182 }]
  }));
  assert.deepEqual([verdict.status, verdict.summary], ["skipped", reason]);
});

test("a model check that could not be made is a warning with its fault, not a model to install", () => {
  const reason = "Dense search is not ready: the model in /models/bge-m3-onnx could not be checked (Cannot read properties of undefined (reading 'files')).";
  const verdict = evaluateEmbeddingBackend(payload({
    available: false,
    reason,
    onnx: { ...ONNX, ready: false, missing: [], unchecked: "Cannot read properties of undefined (reading 'files')" }
  }));
  assert.deepEqual([verdict.status, verdict.summary, verdict.details.optional], ["warn", reason, undefined]);
});

test("files that are there and wrong are a warning that names them and the fix", () => {
  const verdict = evaluateEmbeddingBackend(payload({ available: false, onnx: { ...ONNX, ready: false, mismatched: ["onnx/model_int8.onnx"] } }));
  assert.equal(verdict.status, "warn");
  assert.match(verdict.summary, /^The model files in \/m\/bge-m3-onnx do not match the manifest \(onnx\/model_int8\.onnx\)\. Run `npm run setup -- --model`: it fetches those files again\.$/);
  // In a container the host's folder at /models is a read-only mount: the fix is on the host…
  const mounted = evaluateEmbeddingBackend({ ...payload({ available: false, onnx: { ...ONNX, dir: "/models/bge-m3-onnx", ready: false, mismatched: ["tokenizer.json"] } }), in_container: true });
  assert.match(mounted.summary, /\(tokenizer\.json\)\. In this container, the folder is the host's, mounted read-only at \/models/);
  // …and the volume's own folder is fixed by installing into it.
  const inVolume = evaluateEmbeddingBackend({ ...payload({ available: false, onnx: { ...ONNX, ready: false, mismatched: ["tokenizer.json"] } }), in_container: true });
  assert.match(inVolume.summary, /\(tokenizer\.json\)\. In this container, install it once into the default volume, ai-dev-system-data,/);
  assert.doesNotMatch(mounted.summary, /npm run setup/);
  const mountedPartial = evaluateEmbeddingBackend({ ...payload({ available: false, onnx: { ...ONNX, ready: false, missing: ["onnx/model_int8.onnx"] } }),
    partial: [{ file: "onnx/model_int8.onnx", bytes: 1024, size: 2048 }], in_container: true });
  assert.match(mountedPartial.summary, /stopped partway \(1\.0 KB of onnx\/model_int8\.onnx\)\. In this container, install it once into the default volume, ai-dev-system-data,/);
});

test("anything left of the Python backend is a warning, ready or not, until it is cleaned up", () => {
  const notes = ["AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3.0 removed …"];
  const ready = evaluateEmbeddingBackend(payload({ notes }));
  assert.deepEqual([ready.status, ready.summary], ["warn", notes[0]]);
  const missing = evaluateEmbeddingBackend(payload({ notes, available: false, reason: "Dense search is not installed." }));
  assert.equal(missing.summary, `${notes[0]} Dense search is not installed.`);
  assert.deepEqual(missing.details.legacy, notes);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  MAX_EMBED_TEXT_LENGTH,
  MAX_EMBED_TEXTS,
  MAX_ONNX_BATCH,
  batchTexts,
  cleanEmbedTexts,
  createOnnxDenseRuntime,
  defaultOnnxModelDir,
  holdsFiles,
  roundVector
} from "./dense-onnx.mjs";

const MANIFEST = Object.freeze({
  model: "BAAI/bge-m3",
  export: "Xenova/bge-m3",
  revision: "a".repeat(40),
  dtype: "int8",
  dimensions: 4,
  pooling: "cls"
});

/**
 * A worker-thread-shaped stub: it answers `embed` with deterministic vectors,
 * and can be told to fail to load, to die, or to say nothing at all.
 */
function stubWorker({ ready = true, readyError = "", answer = null, silent = false } = {}) {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.terminated = 0;
  worker.postMessage = (message) => {
    worker.sent.push(message);
    if (silent) return;
    queueMicrotask(() => {
      const reply = answer
        ? answer(message)
        : {
          id: message.id,
          ok: true,
          embeddings: message.texts.map((text) => [text.length, 0, 0, 1])
        };
      if (reply) worker.emit("message", reply);
    });
  };
  worker.terminate = async () => {
    worker.terminated += 1;
  };
  queueMicrotask(() => {
    worker.emit("message", ready
      ? { type: "ready", ok: true, load_seconds: 1.5 }
      : { type: "ready", ok: false, error: readyError || "model not found" });
  });
  return worker;
}

function runtimeWith(options = {}, extra = {}) {
  const workers = [];
  const runtime = createOnnxDenseRuntime({
    modelDir: "/models/bge-m3-onnx",
    manifest: MANIFEST,
    spawnWorker: () => {
      const worker = stubWorker(options);
      workers.push(worker);
      return worker;
    },
    ...extra
  });
  return { runtime, workers };
}

test("vectors are rounded to the precision the index stores", () => {
  assert.deepEqual(roundVector([0.123456789, -0.987654321], 6), [0.123457, -0.987654]);
  assert.deepEqual(roundVector(Float32Array.from([0.5]), 2), [0.5]);
  assert.deepEqual(roundVector([], 6), []);
});

test("texts are split into batches, clamped to the ceiling", () => {
  assert.deepEqual(batchTexts(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  assert.deepEqual(batchTexts(["a"], 0), [["a"]], "a nonsense size is at least one");
  assert.equal(batchTexts(new Array(100).fill("x"), 1000).length, Math.ceil(100 / MAX_ONNX_BATCH));
  assert.deepEqual(batchTexts([], 8), []);
});

test("embedding answers in the shape the Python backend answers in", async () => {
  const { runtime } = runtimeWith();
  const result = await runtime.embedTexts({ texts: ["hello", "worldly"] });

  assert.equal(result.ok, true);
  assert.equal(result.backend, "onnx");
  assert.equal(result.model, "BAAI/bge-m3");
  assert.equal(result.revision, MANIFEST.revision);
  assert.equal(result.dtype, "int8");
  assert.equal(result.count, 2);
  assert.equal(result.dimensions, 4);
  assert.equal(result.normalized, true);
  assert.equal(result.load_seconds, 1.5);
  assert.deepEqual(result.embeddings, [[5, 0, 0, 1], [7, 0, 0, 1]]);
  assert.equal(result.model_dir, path.resolve("/models/bge-m3-onnx"));
  await runtime.shutdown();
});

test("a long list crosses the thread in several batches, and one worker serves them all", async () => {
  const { runtime, workers } = runtimeWith();
  const texts = new Array(10).fill(0).map((_value, index) => "x".repeat(index + 1));

  const result = await runtime.embedTexts({ texts, batch_size: 4 });

  assert.equal(result.count, 10);
  assert.equal(workers.length, 1, "the model is loaded once, not once per batch");
  assert.deepEqual(workers[0].sent.map((message) => message.texts.length), [4, 4, 2]);
  await runtime.shutdown();
});

test("a prefix is applied, and include_embeddings:false answers with previews only", async () => {
  const { runtime, workers } = runtimeWith();
  const result = await runtime.embedTexts({ texts: ["abc"], prefix: "query: ", include_embeddings: false });

  assert.equal(workers[0].sent[0].texts[0], "query: abc");
  assert.equal(result.embeddings, undefined);
  assert.deepEqual(result.embedding_preview, [[10, 0, 0, 1]]);
  await runtime.shutdown();
});

test("blank input is refused before a worker is started", async () => {
  const { runtime, workers } = runtimeWith();
  await assert.rejects(() => runtime.embedTexts({ texts: ["  ", ""] }), /texts or text is required/);
  await assert.rejects(() => runtime.embedTexts({}), /texts or text is required/);
  assert.equal(workers.length, 0, "no model is loaded to answer a question with no text in it");
});

test("a single text is accepted the way the other backend accepts it", async () => {
  const { runtime } = runtimeWith();
  const result = await runtime.embedTexts({ text: "solo" });
  assert.equal(result.count, 1);
  await runtime.shutdown();
});

test("a worker that cannot load the model fails the caller with the worker's own reason", async () => {
  const { runtime } = runtimeWith({ ready: false, readyError: "no such file: onnx/model_int8.onnx" });
  await assert.rejects(
    () => runtime.embedTexts({ texts: ["hello"] }),
    /no such file: onnx\/model_int8\.onnx/
  );
  await runtime.shutdown();
});

test("a worker that dies mid-request rejects that request rather than hanging", async () => {
  const { runtime, workers } = runtimeWith({ silent: true });
  const pending = runtime.embedTexts({ texts: ["hello"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  workers[0].emit("exit", 9);
  await assert.rejects(() => pending, /exited with code 9/);
});

test("a worker that errors out rejects the request with the error", async () => {
  const { runtime, workers } = runtimeWith({ silent: true });
  const pending = runtime.embedTexts({ texts: ["hello"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  workers[0].emit("error", new Error("worker thread died"));
  await assert.rejects(() => pending, /worker thread died/);
});

test("a request the worker never answers times out with the budget in the message", async () => {
  const { runtime } = runtimeWith({ silent: true }, { timeoutMs: 25 });
  await assert.rejects(() => runtime.embedTexts({ texts: ["hello"] }), /timed out after 25ms/);
  await runtime.shutdown();
});

test("an error reply from the worker becomes the caller's error", async () => {
  const { runtime } = runtimeWith({ answer: (message) => ({ id: message.id, ok: false, error: "tokenizer missing" }) });
  await assert.rejects(() => runtime.embedTexts({ texts: ["hello"] }), /tokenizer missing/);
  await runtime.shutdown();
});

test("a reply for an unknown id is ignored rather than crashing the pool", async () => {
  const { runtime, workers } = runtimeWith();
  const result = runtime.embedTexts({ texts: ["hello"] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  workers[0].emit("message", { id: 4242, ok: true, embeddings: [[9, 9, 9, 9]] });
  assert.equal((await result).count, 1);
  await runtime.shutdown();
});

test("status reports the pinned identity, and whether the worker is up", async () => {
  const { runtime } = runtimeWith();
  const cold = runtime.status();
  assert.equal(cold.backend, "onnx");
  assert.equal(cold.revision, MANIFEST.revision);
  assert.equal(cold.dtype, "int8");
  assert.equal(cold.export, "Xenova/bge-m3");
  assert.equal(cold.worker.started, false);

  await runtime.embedTexts({ texts: ["hello"] });
  const warm = runtime.status();
  assert.equal(warm.worker.started, true);
  assert.equal(warm.worker.load_seconds, 1.5);

  await runtime.shutdown();
  assert.equal(runtime.status().worker.started, false);
});

test("shutdown terminates the worker, rejects what was in flight, and is safe twice", async () => {
  const { runtime, workers } = runtimeWith({ silent: true });
  const pending = runtime.embedTexts({ texts: ["hello"] });
  await new Promise((resolve) => setTimeout(resolve, 10));

  await runtime.shutdown();
  await assert.rejects(() => pending, /was shut down/);
  assert.equal(workers[0].terminated, 1);
  await runtime.shutdown();
  assert.equal(workers[0].terminated, 1, "shutting down twice terminates once");
});

test("a dead worker is replaced on the next call rather than remembered", async () => {
  const { runtime, workers } = runtimeWith();
  await runtime.embedTexts({ texts: ["hello"] });
  workers[0].emit("exit", 0);

  await runtime.embedTexts({ texts: ["again"] });
  assert.equal(workers.length, 2);
  await runtime.shutdown();
});

test("the onnx model directory is separate from the legacy one, and env overrides it", () => {
  assert.equal(
    defaultOnnxModelDir({ env: { BGE_M3_ONNX_DIR: "/custom/dir" } }),
    path.resolve("/custom/dir")
  );
  assert.equal(
    defaultOnnxModelDir({ env: {}, aiDevHome: "/home/person/.ai-dev" }),
    path.resolve("/home/person/.ai-dev/models/bge-m3-onnx")
  );
  const fromHome = defaultOnnxModelDir({ env: { HOME: "/home/person" } });
  assert.equal(fromHome, path.resolve("/home/person/.ai-dev/models/bge-m3-onnx"));
  assert.ok(
    !fromHome.endsWith(path.join("models", "bge-m3")),
    "the legacy directory holds different files for the same model and must not be shared"
  );
});

test("in the image the model is the one the host mounts at /models, else the one installed in the volume", () => {
  const docker = { AI_DEV_RUNTIME: "docker", AI_DEV_HOME: "/data/runtime-home/.ai-dev", HOME: "/data/runtime-home" };
  assert.equal(defaultOnnxModelDir({ env: docker, mounted: (folder) => folder === "/models/bge-m3-onnx" }), "/models/bge-m3-onnx");
  assert.equal(defaultOnnxModelDir({ env: docker, mounted: () => false }), path.resolve("/data/runtime-home/.ai-dev/models/bge-m3-onnx"));
  // Outside the image a /models folder is nobody's business.
  assert.equal(defaultOnnxModelDir({ env: { HOME: "/home/person" }, mounted: () => true }), path.resolve("/home/person/.ai-dev/models/bge-m3-onnx"));
  assert.equal(defaultOnnxModelDir({ env: { ...docker, BGE_M3_ONNX_DIR: "/x" }, mounted: () => true }), path.resolve("/x"));
});

test("a mounted model folder the image's user may not list or reach is a model there, not an empty mount", () => {
  const refused = (code) => () => {
    throw Object.assign(new Error(`${code}: scandir '/models/bge-m3-onnx'`), { code });
  };
  assert.equal(holdsFiles("/models/bge-m3-onnx", () => ["config.json"]), true);
  assert.equal(holdsFiles("/models/bge-m3-onnx", () => []), false, "the image's own empty /models");
  assert.equal(holdsFiles("/models/bge-m3-onnx", refused("ENOENT")), false, "nothing mounted");
  assert.equal(holdsFiles("/models/bge-m3-onnx", refused("ENOTDIR")), false);
  assert.equal(holdsFiles("/models/bge-m3-onnx", refused("EACCES")), true, "folders 0700 of another owner");
  assert.equal(holdsFiles("/models/bge-m3-onnx", refused("EPERM")), true);
  // A share that dropped is a mount this user cannot reach, not nothing mounted.
  for (const code of ["EIO", "ESTALE", "ENOTCONN", "EHOSTDOWN", "ETIMEDOUT", "ECONNABORTED", "ECONNRESET"]) assert.equal(holdsFiles("/models/bge-m3-onnx", refused(code)), true, code);
  // A link that loops, or no descriptor left to list with, is no model mounted: the volume's stays in use.
  for (const code of ["ELOOP", "EMFILE", "ENFILE", "EINVAL"]) assert.equal(holdsFiles("/models/bge-m3-onnx", refused(code)), false, code);
  const docker = { AI_DEV_RUNTIME: "docker", AI_DEV_HOME: "/data/runtime-home/.ai-dev", HOME: "/data/runtime-home" };
  assert.equal(defaultOnnxModelDir({ env: docker, mounted: (folder) => holdsFiles(folder, refused("EACCES")) }), "/models/bge-m3-onnx");
});

test("embed_texts input is cleaned, and an empty, oversized or overlong request is refused before the worker", () => {
  assert.deepEqual(cleanEmbedTexts({ text: "  hello  " }), ["hello"]);
  assert.deepEqual(cleanEmbedTexts({ texts: ["a", "  ", "", "b"] }), ["a", "b"]);
  assert.deepEqual(cleanEmbedTexts({ texts: ["a"], text: "ignored" }), ["a"]);
  for (const input of [undefined, {}, { texts: [] }, { texts: ["   "] }, { text: "" }, { text: 7 }]) {
    assert.throws(() => cleanEmbedTexts(input), /texts or text is required/);
  }
  assert.throws(() => cleanEmbedTexts({ texts: Array.from({ length: MAX_EMBED_TEXTS + 1 }, (_, index) => `t${index}`) }), /at most 32 texts per call/);
  assert.throws(() => cleanEmbedTexts({ text: "x".repeat(MAX_EMBED_TEXT_LENGTH + 1) }), /12000 characters or less/);
  assert.equal(cleanEmbedTexts({ text: "x".repeat(MAX_EMBED_TEXT_LENGTH) }).length, 1);
  assert.equal(cleanEmbedTexts({ texts: Array.from({ length: MAX_EMBED_TEXTS }, (_, index) => `t${index}`) }).length, 32);
});

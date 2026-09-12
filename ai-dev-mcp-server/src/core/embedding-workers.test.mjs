import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DENSE_DIMENSIONS,
  DENSE_MODEL,
  MAX_EMBED_TEXTS,
  MAX_EMBED_TEXT_LENGTH,
  cleanEmbedTexts,
  createEmbeddingRuntime
} from "./embedding-workers.mjs";

/**
 * A runtime whose Python is a stub. Every call is recorded; nothing is spawned,
 * so these tests do not depend on a model being installed.
 */
async function createFixture(t, { exists = () => true, execFile, python = "/venv/bin/python" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedding-workers-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = createEmbeddingRuntime({
    embedCliPath: "/vault/09-mcp/embeddings/bge_m3_embed.py",
    workerCliPath: "/vault/09-mcp/embeddings/bge_m3_worker.py",
    defaultModelDir: path.join(root, "models", "bge-m3"),
    searchIndexDir: path.join(root, "cache"),
    searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite"),
    vaultRoot: "/vault",
    pythonCommand: () => python,
    pathExists: async (target) => exists(target),
    fileStatus: async (target) => ({ exists: await exists(target), path: target }),
    execFile: execFile ?? (async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ embeddings: [[0.1, 0.2]], count: 1 }), stderr: "" };
    })
  });
  return { root, runtime, calls };
}

test("the backend reports the pinned model and its width", () => {
  assert.equal(DENSE_MODEL, "BAAI/bge-m3");
  assert.equal(DENSE_DIMENSIONS, 1024);
  assert.equal(MAX_EMBED_TEXTS, 32);
  assert.equal(MAX_EMBED_TEXT_LENGTH, 12000);
});

test("text cleaning accepts a single text or a list and drops the blanks", () => {
  assert.deepEqual(cleanEmbedTexts({ text: "  hello  " }), ["hello"]);
  assert.deepEqual(cleanEmbedTexts({ texts: ["a", "  ", "", "b"] }), ["a", "b"]);
  assert.deepEqual(cleanEmbedTexts({ texts: ["a"], text: "ignored" }), ["a"]);
});

test("an empty, oversized or overlong request is refused before any process starts", () => {
  for (const input of [{}, { texts: [] }, { texts: ["   "] }, { text: "" }, { text: 7 }]) {
    assert.throws(() => cleanEmbedTexts(input), /texts or text is required/);
  }
  assert.throws(
    () => cleanEmbedTexts({ texts: Array.from({ length: 33 }, (_, index) => `t${index}`) }),
    /at most 32 texts per call/
  );
  assert.throws(() => cleanEmbedTexts({ text: "x".repeat(12001) }), /12000 characters or less/);
  assert.equal(cleanEmbedTexts({ text: "x".repeat(12000) }).length, 1);
  assert.equal(cleanEmbedTexts({ texts: Array.from({ length: 32 }, (_, index) => `t${index}`) }).length, 32);
});

test("a missing helper or interpreter is named rather than guessed at", async (t) => {
  const { runtime: noHelper } = await createFixture(t, { exists: (target) => !target.endsWith("bge_m3_embed.py") });
  await assert.rejects(() => noHelper.embedTexts({ text: "x" }), /BGE-M3 helper not found/);

  const { runtime: noPython } = await createFixture(t, { exists: (target) => !target.includes("/venv/") });
  await assert.rejects(() => noPython.embedTexts({ text: "x" }), /BGE-M3 Python runtime not found/);
});

test("availability is checked before the request is validated", async (t) => {
  const { runtime } = await createFixture(t, { exists: () => false });
  await assert.rejects(() => runtime.embedTexts({ texts: [] }), /BGE-M3 helper not found/);
});

test("a one-shot embed writes its request, calls the helper, and cleans up", async (t) => {
  const { runtime, calls, root } = await createFixture(t);
  void root;
  const result = await runtime.embedTexts({ text: "hello", use_worker: false, device: "cuda" });
  assert.deepEqual(result.embeddings, [[0.1, 0.2]]);
  assert.equal(result.backend, "bge-m3-local");

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, "/venv/bin/python");
  assert.equal(call.args[0], "/vault/09-mcp/embeddings/bge_m3_embed.py");
  assert.equal(call.args[call.args.indexOf("--device") + 1], "cuda");
  // BGE_M3_MODEL_DIR wins over the runtime's default when it is set.
  assert.equal(call.args[call.args.indexOf("--model-dir") + 1], path.resolve(process.env.BGE_M3_MODEL_DIR));
  const requestPath = call.args[call.args.indexOf("--input-json") + 1];
  assert.ok(requestPath.startsWith(path.join(root, "cache")));
  assert.equal(await fs.access(requestPath).then(() => true, () => false), false);
});

test("the one-shot request carries the clamped knobs the helper expects", async (t) => {
  const seen = [];
  const { runtime } = await createFixture(t, {
    execFile: async (_command, args) => {
      const requestPath = args[args.indexOf("--input-json") + 1];
      seen.push(JSON.parse(await fs.readFile(requestPath, "utf8")));
      return { stdout: JSON.stringify({ embeddings: [[0.1]] }), stderr: "" };
    }
  });
  await runtime.embedTexts({
    texts: ["a", "b"], prefix: "passage: ", normalize: false,
    batch_size: 999, precision: 99, use_worker: false
  });
  assert.deepEqual(seen[0].texts, ["a", "b"]);
  assert.equal(seen[0].prefix, "passage: ");
  assert.equal(seen[0].normalize, false);
  assert.equal(seen[0].batch_size, 32);
  assert.equal(seen[0].precision, 10);
});

test("include_embeddings=false returns a preview instead of the vectors", async (t) => {
  const { runtime } = await createFixture(t, {
    execFile: async () => ({
      stdout: JSON.stringify({ embeddings: [Array.from({ length: 20 }, (_, index) => index)] }),
      stderr: ""
    })
  });
  const result = await runtime.embedTexts({ text: "hello", include_embeddings: false, use_worker: false });
  assert.equal("embeddings" in result, false);
  assert.deepEqual(result.embedding_preview, [[0, 1, 2, 3, 4, 5, 6, 7]]);
});

test("the request file is removed even when the helper fails", async (t) => {
  let requestPath = "";
  const { runtime } = await createFixture(t, {
    execFile: async (_command, args) => {
      requestPath = args[args.indexOf("--input-json") + 1];
      throw new Error("helper exploded");
    }
  });
  await assert.rejects(() => runtime.embedTexts({ text: "hello", use_worker: false }), /helper exploded/);
  assert.ok(requestPath);
  assert.equal(await fs.access(requestPath).then(() => true, () => false), false);
});

test("status describes the backend, its paths and the empty worker pool", async (t) => {
  const { runtime, root } = await createFixture(t);
  const status = await runtime.status({ device: "cuda" });
  assert.equal(status.backend, "bge-m3-local");
  assert.equal(status.dense_model, DENSE_MODEL);
  assert.equal(status.dense_dimensions, DENSE_DIMENSIONS);
  assert.equal(status.configured_device, "cuda");
  assert.equal(status.paths.vault_root, "/vault");
  assert.equal(status.paths.embeddings_python, "/venv/bin/python");
  assert.equal(status.paths.model_dir, path.resolve(process.env.BGE_M3_MODEL_DIR));
  assert.equal(
    (await runtime.status({ model_dir: path.join(root, "elsewhere") })).paths.model_dir,
    path.join(root, "elsewhere")
  );
  assert.deepEqual(Object.keys(status.availability), [
    "search_index", "embeddings_python", "embed_helper", "worker_helper",
    "model_dir", "model_file", "modules_file"
  ]);
  assert.deepEqual(status.workers, { count: 0, states: [] });
});

test("status reports unavailability rather than failing", async (t) => {
  const { runtime } = await createFixture(t, { exists: () => false });
  const status = await runtime.status();
  assert.equal(status.availability.model_dir.exists, false);
  assert.equal(status.availability.embed_helper.exists, false);
});

test("a worker request is refused when the worker helper is missing", async (t) => {
  const { runtime } = await createFixture(t, { exists: (target) => !target.endsWith("bge_m3_worker.py") });
  await assert.rejects(() => runtime.request({ texts: ["x"] }), /BGE-M3 worker not found/);
});

test("shutting down an empty pool is a no-op, not an error", async (t) => {
  const { runtime } = await createFixture(t);
  assert.doesNotThrow(() => runtime.shutdown());
  assert.equal((await runtime.status()).workers.count, 0);
});

/**
 * A stand-in for `bge_m3_worker.py`: the same newline-delimited JSON protocol,
 * run by node instead of python. It makes the worker pool testable without a
 * model, which is the whole reason the runtime takes its interpreter as a
 * dependency.
 */
const STUB_WORKER = `import process from "node:process";
const mode = process.env.STUB_WORKER_MODE || "ok";
if (mode === "die") process.exit(4);
process.stdout.write(JSON.stringify({ type: "ready", ok: mode !== "unready" }) + "\\n");
if (mode === "noise") process.stdout.write("not json at all\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "shutdown") process.exit(0);
    if (mode === "reject") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: "model refused" }) + "\\n");
      continue;
    }
    if (mode === "silent") continue;
    // An id nobody is waiting for must be ignored rather than crash the reader.
    process.stdout.write(JSON.stringify({ id: 9999, ok: true, stray: true }) + "\\n");
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, echo: request }) + "\\n");
  }
});
`;

/** A runtime whose worker is the node stub above. */
async function createWorkerFixture(t, { mode = "ok" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedding-worker-proto-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workerCliPath = path.join(root, "stub-worker.mjs");
  await fs.writeFile(workerCliPath, STUB_WORKER, "utf8");
  const previous = process.env.STUB_WORKER_MODE;
  process.env.STUB_WORKER_MODE = mode;
  const runtime = createEmbeddingRuntime({
    embedCliPath: workerCliPath,
    workerCliPath,
    defaultModelDir: path.join(root, "models"),
    searchIndexDir: path.join(root, "cache"),
    searchIndexPath: path.join(root, "cache", "i.sqlite"),
    vaultRoot: "/vault",
    pythonCommand: () => process.execPath,
    pathExists: async () => true,
    fileStatus: async (target) => ({ exists: true, path: target }),
    execFile: async () => ({ stdout: "{}", stderr: "" })
  });
  t.after(() => {
    runtime.shutdown();
    if (previous === undefined) delete process.env.STUB_WORKER_MODE;
    else process.env.STUB_WORKER_MODE = previous;
  });
  return { root, runtime, workerCliPath };
}

test("a worker request round-trips and reports the pool it started", async (t) => {
  const { runtime } = await createWorkerFixture(t);
  const answer = await runtime.request({ texts: ["hello"], prefix: "query: " }, { timeoutMs: 10000 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.echo.texts, ["hello"]);
  assert.equal(answer.echo.prefix, "query: ");
  assert.equal(answer.echo.method, "embed");
  assert.equal(answer.echo.normalize, true);

  const status = await runtime.status();
  assert.equal(status.workers.count, 1);
  assert.equal(status.workers.states[0].pending_requests, 0);
  assert.ok(Number.isInteger(status.workers.states[0].pid));
  assert.equal(status.workers.states[0].device, "cpu");
});

test("the same model and device reuse one worker; a different device starts another", async (t) => {
  const { runtime } = await createWorkerFixture(t);
  await runtime.request({ texts: ["a"] }, { timeoutMs: 10000 });
  await runtime.request({ texts: ["b"] }, { timeoutMs: 10000 });
  assert.equal((await runtime.status()).workers.count, 1);

  await runtime.request({ texts: ["c"], device: "cuda" }, { timeoutMs: 10000 });
  assert.equal((await runtime.status()).workers.count, 2);
});

test("worker knobs are clamped on the way out", async (t) => {
  const { runtime } = await createWorkerFixture(t);
  const answer = await runtime.request({
    texts: ["a"], batch_size: 9999, precision: 99, normalize: false, include_embeddings: false, method: "score"
  }, { timeoutMs: 10000 });
  assert.equal(answer.echo.batch_size, 64);
  assert.equal(answer.echo.precision, 10);
  assert.equal(answer.echo.normalize, false);
  assert.equal(answer.echo.include_embeddings, false);
  assert.equal(answer.echo.method, "score");
});

test("stray lines and unknown ids do not break the reader", async (t) => {
  const { runtime } = await createWorkerFixture(t, { mode: "noise" });
  const answer = await runtime.request({ texts: ["a"] }, { timeoutMs: 10000 });
  assert.equal(answer.ok, true);
});

test("a worker that refuses a request rejects it with its own message", async (t) => {
  const { runtime } = await createWorkerFixture(t, { mode: "reject" });
  await assert.rejects(() => runtime.request({ texts: ["a"] }, { timeoutMs: 10000 }), /model refused/);
});

test("a worker that dies takes its pending request down with a readable reason", async (t) => {
  const { runtime } = await createWorkerFixture(t, { mode: "die" });
  await assert.rejects(
    () => runtime.request({ texts: ["a"] }, { timeoutMs: 10000 }),
    /BGE-M3 worker exited with code 4/
  );
  assert.equal((await runtime.status()).workers.count, 0);
});

test("a silent worker times out rather than hanging forever", async (t) => {
  const { runtime } = await createWorkerFixture(t, { mode: "silent" });
  await assert.rejects(
    () => runtime.request({ texts: ["a"] }, { timeoutMs: 150 }),
    /BGE-M3 worker request timed out after 150ms/
  );
});

test("a worker whose ready message says otherwise is reported as not ready", async (t) => {
  const { runtime } = await createWorkerFixture(t, { mode: "unready" });
  await runtime.request({ texts: ["a"] }, { timeoutMs: 10000 });
  assert.equal((await runtime.status()).workers.states[0].ready, false);
});

test("embedTexts through the worker path returns what the worker answered", async (t) => {
  const { runtime } = await createWorkerFixture(t);
  const answer = await runtime.embedTexts({ text: "hello", timeout_ms: 10000 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.echo.texts, ["hello"]);
});

test("shutdown empties the pool", async (t) => {
  const { runtime } = await createWorkerFixture(t);
  await runtime.request({ texts: ["a"] }, { timeoutMs: 10000 });
  assert.equal((await runtime.status()).workers.count, 1);
  runtime.shutdown();
  assert.equal((await runtime.status()).workers.count, 0);
});

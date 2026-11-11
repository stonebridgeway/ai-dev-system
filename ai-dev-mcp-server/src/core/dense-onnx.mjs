/**
 * The ONNX dense backend: text in, a normalized 1024-dimension vector out, with
 * no Python anywhere in the path.
 *
 * This is the dense backend, and since 3.0 the only one: the legacy
 * Python pool reached the same contract through a virtualenv, a CPU build of
 * torch and `sentence-transformers`; this one reaches it through
 * `@huggingface/transformers` over `onnxruntime-node`, both ordinary npm
 * dependencies, so installing the model is a download and a checksum rather
 * than a build.
 *
 * ## Why a worker thread and not batches with `await`
 *
 * Because the alternative does not work, and the reason is in the dependency
 * rather than in the guess: `onnxruntime-node`'s own binding declaration calls
 * itself "a simple synchronized inference session object wrap", and its
 * `run(feeds, fetches, options)` returns the outputs directly, not a promise.
 * The JS layer wraps that call in `setImmediate`, which defers *when* the work
 * starts and changes nothing about where it runs: the whole inference occupies
 * the thread that calls it. Embedding a few thousand vault documents that way
 * would stop this process answering MCP requests for minutes at a time — the
 * stdio loop included — so the session is loaded and run on a `worker_thread`
 * and only the JSON crosses back.
 *
 * The worker is injected rather than constructed here, so every path this pool
 * has — a worker that never becomes ready, one that dies mid-request, a request
 * that times out, batching, shutdown — is tested against a stub, on a machine
 * with no weights on it. The real worker entry is `src/workers/dense-onnx-worker.mjs`.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DENSE_ONNX_BACKEND, DOCKER_MOUNTED_MODEL_DIR, SHARE_UNREACHABLE } from "./dense-backend.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** Most texts one worker message may carry, so a batch cannot grow unbounded. */
export const MAX_ONNX_BATCH = 32;

/** Most texts one `embed_texts` call may carry. */
export const MAX_EMBED_TEXTS = 32;

/** Longest single text one `embed_texts` call may carry. */
export const MAX_EMBED_TEXT_LENGTH = 12000;

/**
 * Validate and clean the texts of one `embed_texts` request: an MCP client
 * decides how much it sends, and a model in a worker thread is not the place
 * to find out it sent ten thousand.
 *
 * @param {{ texts?: string[], text?: string }} input
 * @returns {string[]}
 */
export function cleanEmbedTexts({ texts, text } = {}) {
  const inputTexts = Array.isArray(texts) ? texts : (typeof text === "string" && text ? [text] : []);
  const cleanTexts = inputTexts.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!cleanTexts.length) throw new Error("texts or text is required.");
  if (cleanTexts.length > MAX_EMBED_TEXTS) throw new Error(`embed_texts accepts at most ${MAX_EMBED_TEXTS} texts per call.`);
  for (const value of cleanTexts) {
    if (value.length > MAX_EMBED_TEXT_LENGTH) throw new Error(`Each text must be ${MAX_EMBED_TEXT_LENGTH} characters or less.`);
  }
  return cleanTexts;
}

/** How long one batch may take before the caller is told rather than left hanging. */
export const DEFAULT_ONNX_TIMEOUT_MS = 600_000;

/**
 * Round one vector to the precision the index stores — six places, as the 2.x
 * Python backend stored its own, so vectors from a 2.x index and from this one
 * are the same shape of number in the same JSON and the same sqlite blob.
 *
 * @param {ArrayLike<number>} values
 * @param {number} precision
 * @returns {number[]}
 */
export function roundVector(values, precision) {
  const factor = 10 ** precision;
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Math.round(Number(values[index]) * factor) / factor;
  }
  return result;
}

/**
 * Split texts into batches no larger than the model is asked to hold at once.
 *
 * @param {string[]} texts
 * @param {number} size
 * @returns {string[][]}
 */
export function batchTexts(texts, size) {
  const limit = Math.max(1, Math.min(Number(size) || 8, MAX_ONNX_BATCH));
  const batches = [];
  for (let index = 0; index < texts.length; index += limit) {
    batches.push(texts.slice(index, index + limit));
  }
  return batches;
}

/**
 * Create the ONNX embedding runtime.
 *
 * @param {object} deps
 * @param {string} deps.modelDir - Directory holding the verified export.
 * @param {object} deps.manifest - The parsed dense manifest.
 * @param {() => object} deps.spawnWorker - Makes a worker-thread-shaped object.
 * @param {number} [deps.timeoutMs]
 * @returns {{ embedTexts: Function, status: Function, shutdown: Function }}
 */
export function createOnnxDenseRuntime({
  modelDir,
  manifest,
  spawnWorker,
  timeoutMs = DEFAULT_ONNX_TIMEOUT_MS
}) {
  const resolvedModelDir = path.resolve(String(modelDir));
  let worker = null;
  let requestSeq = 0;
  let loadSeconds = 0;

  function rejectAll(state, message) {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    state.pending.clear();
  }

  /** The worker for this model directory, started on first use and reused after. */
  function getWorker() {
    if (worker && !worker.exited) return worker;
    const child = spawnWorker({ modelDir: resolvedModelDir, manifest });
    const state = { child, pending: new Map(), exited: false, ready: null, readyError: "" };
    // Resolved by the worker's first message, so every request waits for the
    // model to be loaded rather than racing it.
    state.ready = new Promise((resolve, reject) => {
      state.settleReady = { resolve, reject };
    });
    // A worker that never loads is a rejected promise nobody may have awaited
    // yet; without this an unhandled rejection would take the process down for
    // a cause the user is about to be told about properly.
    state.ready.catch(() => {});

    child.on("message", (message) => {
      if (message?.type === "ready") {
        if (message.ok) {
          loadSeconds = Number(message.load_seconds || 0);
          state.settleReady.resolve(message);
        } else {
          state.readyError = String(message.error || "").trim();
          state.settleReady.reject(new Error(state.readyError || "ONNX dense worker failed to load the model."));
        }
        return;
      }
      const pending = state.pending.get(message?.id);
      if (!pending) return;
      state.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === false) pending.reject(new Error(message.error || "ONNX dense worker request failed."));
      else pending.resolve(message);
    });
    child.on("error", (error) => {
      state.exited = true;
      worker = null;
      state.settleReady.reject(error);
      rejectAll(state, error.message);
    });
    child.on("exit", (code) => {
      state.exited = true;
      worker = null;
      const said = state.readyError ? ` ${state.readyError}` : "";
      state.settleReady.reject(new Error(`ONNX dense worker exited with code ${code}.${said}`));
      rejectAll(state, `ONNX dense worker exited with code ${code}.${said}`.trim());
    });

    worker = state;
    return state;
  }

  /** One request/response round trip against the worker. */
  async function request(payload) {
    const state = getWorker();
    await state.ready;
    const id = ++requestSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`ONNX dense worker request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      try {
        state.child.postMessage({ ...payload, id });
      } catch (error) {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Embed one set of texts, in batches, and answer in the shape 2.x answered
   * in, so callers and clients of `embed_texts` read it as they always did.
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async function embedTexts({
    texts,
    text,
    prefix = "",
    normalize = true,
    batch_size = 8,
    precision = 6,
    include_embeddings = true
  } = {}) {
    const inputTexts = Array.isArray(texts) ? texts : (typeof text === "string" && text ? [text] : []);
    const clean = inputTexts.map((value) => String(value ?? "").trim()).filter(Boolean);
    if (!clean.length) throw new Error("texts or text is required.");
    const withPrefix = prefix ? clean.map((value) => `${prefix}${value}`) : clean;
    const started = Date.now();
    const vectors = [];
    for (const batch of batchTexts(withPrefix, batch_size)) {
      const answer = await request({
        method: "embed",
        texts: batch,
        normalize: normalize !== false,
        precision: Math.max(2, Math.min(Number(precision) || 6, 10))
      });
      vectors.push(...(answer.embeddings ?? []));
    }
    const result = {
      ok: true,
      model: manifest.model,
      model_dir: resolvedModelDir,
      device: "cpu",
      count: vectors.length,
      dimensions: vectors.length ? vectors[0].length : 0,
      normalized: normalize !== false,
      load_seconds: loadSeconds,
      encode_seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      backend: DENSE_ONNX_BACKEND,
      revision: manifest.revision,
      dtype: manifest.dtype
    };
    if (include_embeddings) result.embeddings = vectors;
    else result.embedding_preview = vectors.map((row) => row.slice(0, 8));
    return result;
  }

  /** What this backend is and whether its worker is up. */
  function status() {
    return {
      backend: DENSE_ONNX_BACKEND,
      model: manifest.model,
      export: manifest.export,
      revision: manifest.revision,
      dtype: manifest.dtype,
      dimensions: manifest.dimensions,
      model_dir: resolvedModelDir,
      worker: worker && !worker.exited
        ? { started: true, pending_requests: worker.pending.size, load_seconds: loadSeconds }
        : { started: false, pending_requests: 0, load_seconds: 0 }
    };
  }

  /** Stop the worker. Best effort, as on process shutdown it always is. */
  async function shutdown() {
    const state = worker;
    worker = null;
    if (!state || state.exited) return;
    state.exited = true;
    rejectAll(state, "ONNX dense worker was shut down.");
    try {
      await state.child.terminate();
    } catch {
      // best effort on process shutdown
    }
  }

  return { embedTexts, status, shutdown };
}

export { DOCKER_MOUNTED_MODEL_DIR };

/**
 * The errors that say a folder is there and this user cannot read it (a host's
 * folders 0700) or cannot reach it (a share that dropped). Any other — not
 * there, a file, a link that loops, no descriptor left — is no model mounted.
 */
const THERE_UNREAD = new Set(["EACCES", "EPERM", ...SHARE_UNREACHABLE]);

/**
 * Whether a folder holds anything — what it holds unseen included, so a model
 * the host mounted unreadable is said as that, not passed over for the
 * volume's.
 *
 * @param {string} folder
 * @param {(folder: string) => string[]} [list]
 * @returns {boolean}
 */
export function holdsFiles(folder, list = readdirSync) {
  try {
    return list(folder).length > 0;
  } catch (error) {
    return THERE_UNREAD.has(error?.code);
  }
}

/**
 * Where the ONNX export lives: `BGE_M3_ONNX_DIR`, or `models/bge-m3-onnx` in the
 * runtime home. 2.x kept the Python backend's torch weights beside it in
 * `models/bge-m3`; that folder is never read and never written here.
 *
 * In the image the runtime home is in the volume, where `ai-dev model install`
 * puts the model once; a folder the host mounts at
 * `/models`, as the 2.x launchers do, is used first. The 2.x image named the
 * mount in its ENV, so a model could not be put in the volume at all.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.aiDevHome] - Runtime home, when the caller knows it.
 * @param {(folder: string) => boolean} [options.mounted] - Whether a folder holds anything ({@link holdsFiles}).
 * @returns {string}
 */
export function defaultOnnxModelDir({ env = process.env, aiDevHome = "", mounted = holdsFiles } = {}) {
  if (env.BGE_M3_ONNX_DIR) return path.resolve(env.BGE_M3_ONNX_DIR);
  if (String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() === "docker" && mounted(DOCKER_MOUNTED_MODEL_DIR)) return DOCKER_MOUNTED_MODEL_DIR;
  const home = aiDevHome || resolveRuntimeStateRoot("", env);
  return path.resolve(path.join(home, "models", "bge-m3-onnx"));
}

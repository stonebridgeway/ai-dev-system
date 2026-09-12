/**
 * The BGE-M3 embedding backend: a pool of long-lived Python workers, plus the
 * one-shot fallback for callers that do not want one.
 *
 * A worker is expensive to start — it loads a 1024-dimension model — so one is
 * kept per (model directory, device) pair and reused for every request, with
 * newline-delimited JSON over stdin/stdout. A worker that dies takes its pending
 * requests with it: each is rejected with the exit code and the tail of stderr,
 * so a missing model reads as a clear failure rather than a hang.
 *
 * Nothing here is pure, and nothing here knows about MCP. The scoring and
 * ranking that consume embeddings live in `src/core/search-runtime.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "./atomic-files.mjs";
import { stripBom } from "./text-format.mjs";

/** Model identity the backend reports, fixed by the pinned local model. */
export const DENSE_MODEL = "BAAI/bge-m3";

/** Vector width the pinned model produces. */
export const DENSE_DIMENSIONS = 1024;

/** Most texts one `embed_texts` call may carry. */
export const MAX_EMBED_TEXTS = 32;

/** Longest single text one call may carry. */
export const MAX_EMBED_TEXT_LENGTH = 12000;

function workerKey(modelDir, device) {
  return `${path.resolve(String(modelDir))}\x1f${String(device || "cpu")}`;
}

function rejectWorkerPending(state, message) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  state.pending.clear();
}

/**
 * Validate and clean the texts of one embedding request.
 *
 * @param {{ texts?: string[], text?: string }} input
 * @returns {string[]}
 */
export function cleanEmbedTexts({ texts, text }) {
  const inputTexts = Array.isArray(texts)
    ? texts
    : (typeof text === "string" && text ? [text] : []);
  const cleanTexts = inputTexts.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!cleanTexts.length) {
    throw new Error("texts or text is required.");
  }
  if (cleanTexts.length > MAX_EMBED_TEXTS) {
    throw new Error(`embed_texts accepts at most ${MAX_EMBED_TEXTS} texts per call.`);
  }
  for (const value of cleanTexts) {
    if (value.length > MAX_EMBED_TEXT_LENGTH) {
      throw new Error(`Each text must be ${MAX_EMBED_TEXT_LENGTH} characters or less.`);
    }
  }
  return cleanTexts;
}

/**
 * Create the embedding runtime.
 *
 * @param {object} deps
 * @param {string} deps.embedCliPath - `bge_m3_embed.py`.
 * @param {string} deps.workerCliPath - `bge_m3_worker.py`.
 * @param {string} deps.defaultModelDir
 * @param {string} deps.searchIndexDir - Scratch space for one-shot request files.
 * @param {string} deps.searchIndexPath - Reported by `status()`.
 * @param {string} deps.vaultRoot - Reported by `status()`.
 * @param {() => string} deps.pythonCommand - Resolves the embedding interpreter.
 * @param {(target: string) => Promise<boolean>} deps.pathExists
 * @param {(target: string) => Promise<object>} deps.fileStatus
 * @param {(command: string, args: string[], options: object) => Promise<{ stdout: string }>} deps.execFile
 * @returns {object} The runtime.
 */
export function createEmbeddingRuntime({
  embedCliPath,
  workerCliPath,
  defaultModelDir,
  searchIndexDir,
  searchIndexPath,
  vaultRoot,
  pythonCommand,
  pathExists,
  fileStatus,
  execFile
}) {
  const workers = new Map();
  let requestSeq = 0;

  const resolveModelDir = (value) => path.resolve(String(value || defaultModelDir));

  /**
   * The worker for one model/device pair, started on first use and reused after.
   */
  async function getWorker({
    model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    device = process.env.BGE_M3_DEVICE || "cpu"
  } = {}) {
    if (!(await pathExists(workerCliPath))) {
      throw new Error(`BGE-M3 worker not found: ${workerCliPath}`);
    }
    const python = pythonCommand();
    if (!(await pathExists(python))) {
      throw new Error(`BGE-M3 Python runtime not found: ${python}`);
    }

    const resolvedModelDir = resolveModelDir(model_dir);
    const selectedDevice = String(device || "cpu");
    const key = workerKey(resolvedModelDir, selectedDevice);
    const existing = workers.get(key);
    if (existing && !existing.exited) return existing;

    const child = spawn(python, [
      workerCliPath,
      "--model-dir",
      resolvedModelDir,
      "--device",
      selectedDevice
    ], { windowsHide: true });

    const state = {
      key,
      child,
      pending: new Map(),
      buffer: "",
      stderr: "",
      ready: false,
      ready_error: "",
      exited: false,
      model_dir: resolvedModelDir,
      device: selectedDevice
    };
    workers.set(key, state);

    child.stdout.on("data", (chunk) => {
      state.buffer += chunk.toString();
      let index;
      while ((index = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "ready") {
          state.ready = Boolean(message.ok);
          state.ready_message = message;
          // A worker that cannot start says why once, on stdout, before anything
          // is asked of it — "Model directory does not exist: …". Keep it: what
          // follows is an exit code and an empty stderr, and "BGE-M3 worker
          // exited with code 1" tells a person who has just installed the model
          // nothing at all.
          state.ready_error = state.ready ? "" : String(message.error ?? "").trim();
          continue;
        }
        const id = message.id;
        if (id === undefined || id === null || !state.pending.has(id)) continue;
        const pending = state.pending.get(id);
        state.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.ok === false) {
          pending.reject(new Error(message.error || "BGE-M3 worker request failed."));
        } else {
          pending.resolve(message);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      state.stderr = `${state.stderr}${chunk.toString()}`.slice(-8000);
    });
    child.on("error", (err) => {
      state.exited = true;
      rejectWorkerPending(state, err.message);
      workers.delete(key);
    });
    child.on("close", (code) => {
      state.exited = true;
      const said = [state.ready_error, state.stderr].filter(Boolean).join(" ").trim();
      rejectWorkerPending(state, `BGE-M3 worker exited with code ${code}. ${said}`.trim());
      workers.delete(key);
    });

    return state;
  }

  /** One request/response round trip against the worker for this model/device. */
  async function request(payload, { timeoutMs = 180000 } = {}) {
    const state = await getWorker({
      model_dir: payload.model_dir,
      device: payload.device
    });
    if (!state.child.stdin.writable) {
      throw new Error("BGE-M3 worker stdin is closed.");
    }
    const id = ++requestSeq;
    const message = {
      id,
      method: payload.method || "embed",
      texts: payload.texts,
      text: payload.text,
      prefix: payload.prefix || "",
      normalize: payload.normalize !== false,
      batch_size: Math.max(1, Math.min(Number(payload.batch_size) || 8, 64)),
      precision: Math.max(2, Math.min(Number(payload.precision) || 6, 10)),
      include_embeddings: payload.include_embeddings !== false
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`BGE-M3 worker request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      state.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (err) => {
        if (err) {
          state.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Ask every live worker to stop, then kill it. Best effort by design. */
  function shutdown() {
    for (const state of workers.values()) {
      try {
        if (!state.exited && state.child.stdin.writable) {
          state.child.stdin.write(`${JSON.stringify({ id: ++requestSeq, method: "shutdown" })}\n`);
        }
        state.child.kill();
      } catch {
        // best effort on process shutdown
      }
    }
    workers.clear();
  }

  /**
   * Embed one batch of texts, through the pooled worker by default and through a
   * one-shot process when `use_worker` is false.
   */
  async function embedTexts({
    texts,
    text,
    prefix = "",
    normalize = true,
    batch_size = 8,
    precision = 6,
    include_embeddings = true,
    model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    device = process.env.BGE_M3_DEVICE || "cpu",
    timeout_ms = 180000,
    use_worker = true
  } = {}) {
    if (!(await pathExists(embedCliPath))) {
      throw new Error(`BGE-M3 helper not found: ${embedCliPath}`);
    }

    const python = pythonCommand();
    if (!(await pathExists(python))) {
      throw new Error(`BGE-M3 Python runtime not found: ${python}`);
    }

    const cleanTexts = cleanEmbedTexts({ texts, text });
    const payload = {
      texts: cleanTexts,
      prefix: String(prefix ?? ""),
      normalize: Boolean(normalize),
      batch_size: Math.max(1, Math.min(Number(batch_size) || 8, 32)),
      precision: Math.max(2, Math.min(Number(precision) || 6, 10)),
      include_embeddings: Boolean(include_embeddings),
      model_dir,
      device
    };
    const timeoutMs = Math.max(30000, Math.min(Number(timeout_ms) || 180000, 600000));

    if (use_worker) {
      return request(payload, { timeoutMs });
    }

    const requestPath = path.join(searchIndexDir, `.bge-m3-request-${process.pid}-${Date.now()}.json`);
    await fs.mkdir(searchIndexDir, { recursive: true });
    await atomicWriteJson(requestPath, payload, { spaces: 0 });
    try {
      const output = await execFile(python, [
        embedCliPath,
        "--model-dir",
        resolveModelDir(model_dir),
        "--device",
        String(device || "cpu"),
        "embed",
        "--input-json",
        requestPath,
        "--precision",
        String(Math.max(2, Math.min(Number(precision) || 6, 10)))
      ], { timeoutMs });
      const parsed = JSON.parse(stripBom(output.stdout));
      if (!include_embeddings && parsed.embeddings) {
        parsed.embedding_preview = parsed.embeddings.map((row) => row.slice(0, 8));
        delete parsed.embeddings;
      }
      parsed.backend = "bge-m3-local";
      return parsed;
    } finally {
      await fs.rm(requestPath, { force: true }).catch(() => {});
    }
  }

  /** What the backend is, where its pieces are, and which of them exist. */
  async function status({
    model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    device = process.env.BGE_M3_DEVICE || "cpu"
  } = {}) {
    const resolvedModelDir = resolveModelDir(model_dir);
    const python = pythonCommand();
    const workerStates = [...workers.values()].map((state) => ({
      key: state.key,
      pid: state.child.pid,
      ready: Boolean(state.ready),
      ready_error: state.ready_error || "",
      exited: Boolean(state.exited),
      pending_requests: state.pending.size,
      model_dir: state.model_dir,
      device: state.device,
      stderr_tail: state.stderr || ""
    }));
    return {
      backend: "bge-m3-local",
      dense_model: DENSE_MODEL,
      dense_dimensions: DENSE_DIMENSIONS,
      configured_device: String(device || "cpu"),
      paths: {
        vault_root: vaultRoot,
        search_index: searchIndexPath,
        embeddings_python: python,
        embed_helper: embedCliPath,
        worker_helper: workerCliPath,
        model_dir: resolvedModelDir
      },
      availability: {
        search_index: await fileStatus(searchIndexPath),
        embeddings_python: await fileStatus(python),
        embed_helper: await fileStatus(embedCliPath),
        worker_helper: await fileStatus(workerCliPath),
        model_dir: await fileStatus(resolvedModelDir),
        model_file: await fileStatus(path.join(resolvedModelDir, "pytorch_model.bin")),
        modules_file: await fileStatus(path.join(resolvedModelDir, "modules.json"))
      },
      workers: {
        count: workerStates.length,
        states: workerStates
      }
    };
  }

  return { embedTexts, request, status, shutdown };
}

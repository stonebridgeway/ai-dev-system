/**
 * The one place that answers "can dense search run here, and with what".
 *
 * Everything dense goes through here: the query vector a hybrid search needs,
 * the passage vectors an index rebuild needs, `embed_texts`, the semantic
 * duplicate check, what `embedding_status` reports and what the health check
 * grades. One answer for all of them, or each decides differently and a user
 * gets several accounts of one machine — and two of them went to a Python pool
 * the selected backend never was.
 *
 * "Is the model there" is answered from the record the last check left beside
 * the cache: an unchanged file is not read again, so the answer costs a few
 * `stat` calls rather than hashing 570 MB a minute. It is still kept
 * for a minute, because a search asks it every time.
 */
import fs from "node:fs";
import path from "node:path";
import { DENSE_INSTALL_COMMAND, legacyDenseNotes, requestedDenseBackend, selectDenseBackend } from "./dense-backend.mjs";
import { usablePart } from "./dense-download.mjs";
import { denseVectorProvenance, filesNotThere, verifiedStampPath, verifyDenseModelDirectory } from "./dense-manifest.mjs";
import { denseRuntimeSupport } from "./model-manager.mjs";

/** How long a verification result stands before it is taken again. */
export const DENSE_PROBE_TTL_MS = 60_000;

/**
 * Create the dense runtime.
 *
 * @param {object} deps
 * @param {object} deps.manifest - The parsed dense manifest.
 * @param {string} deps.onnxModelDir
 * @param {object} deps.onnxRuntime - From `createOnnxDenseRuntime`.
 * @param {string} [deps.stampDir] - Where verification records are kept; none, every check hashes.
 * @param {string} [deps.legacyModelDir] - Where a 2.x install kept its torch weights.
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(options: object) => Promise<object>} [deps.verify] - Injected for tests.
 * @param {() => { supported: boolean, reason: string }} [deps.support] - Injected for tests.
 * @param {(target: string) => boolean} [deps.exists]
 * @param {() => number} [deps.now]
 * @returns {object}
 */
export function createDenseRuntime({
  manifest,
  onnxModelDir,
  onnxRuntime,
  stampDir = "",
  legacyModelDir = "",
  env = {},
  verify = verifyDenseModelDirectory,
  support = () => denseRuntimeSupport(),
  exists = fs.existsSync,
  now = () => Date.now()
}) {
  let probe = null;
  let probedAt = 0;
  let probedRecord = "";
  let supportAnswer = null;
  const stampFile = stampDir ? verifiedStampPath(stampDir, onnxModelDir) : "";

  /**
   * Verify the export, at most once a minute unless forced. Forced means
   * every file is read again, as `embedding_status {refresh: true}` asks.
   *
   * An install, import or remove rewrites the verification record, in this
   * process or another, and that ends the minute early: `setup -- --model`
   * asks before the download and embeds right after it, and a stale "not
   * installed" made the second step refuse.
   */
  async function onnxStatus({ refresh = false } = {}) {
    if (!refresh && probe && now() - probedAt < DENSE_PROBE_TTL_MS && await recordState() === probedRecord) return probe;
    try {
      probe = await verify({ manifest, dir: onnxModelDir, stampFile, trustStamp: !refresh });
    } catch (error) {
      // A model this process cannot read is a model that is not ready, and why:
      // not an error that takes the health check and `embedding_status` down.
      // Its files are not missing, only unseen;
      // those not there at all are. A fault of the code is a check that
      // could not be made, not a model that cannot be read.
      const message = String(error?.message ?? error);
      const missing = await filesNotThere({ manifest, dir: onnxModelDir }).catch(() => []);
      probe = typeof error?.syscall === "string"
        ? { ready: false, dir: path.resolve(onnxModelDir), present: [], missing, mismatched: [], unreadable: message }
        : { ready: false, dir: path.resolve(onnxModelDir), present: [], missing: [], mismatched: [], unchecked: message };
    }
    probedAt = now();
    probedRecord = await recordState();
    return probe;
  }

  /** Which verification record is on disk now, as a comparable string. */
  async function recordState() {
    if (!stampFile) return "";
    const stats = await fs.promises.stat(stampFile).catch(() => null);
    return stats ? `${stats.size}:${stats.mtimeMs}:${stats.ino}` : "none";
  }

  /**
   * Which backend runs, whether it can, and what its vectors would be.
   *
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function describe({ refresh = false } = {}) {
    const { requested, note } = requestedDenseBackend(env);
    supportAnswer ??= support();
    const onnx = await onnxStatus({ refresh });
    // A stat and a small JSON read per missing file, and only while the model
    // is not ready: what a stopped download left is what the sentence says. Not
    // of a model this user cannot read: that is what it says first.
    const partial = [];
    for (const relative of onnx.ready || onnx.unreadable ? [] : onnx.missing ?? []) {
      const part = await usablePart(path.join(path.resolve(onnxModelDir), relative), { revision: manifest.revision, sha256: manifest.files[relative] });
      if (part.bytes > 0) partial.push({ file: relative, bytes: part.bytes, size: part.size });
    }
    const choice = selectDenseBackend({
      requested,
      onnxReady: onnx.ready,
      supported: supportAnswer.supported,
      supportReason: supportAnswer.reason,
      inContainer: String(env.AI_DEV_RUNTIME ?? "") === "docker",
      files: { dir: onnx.dir, present: onnx.present, missing: onnx.missing, mismatched: onnx.mismatched, partial: partial.map((part) => part.file), unreadable: onnx.unreadable, unchecked: onnx.unchecked }
    });
    const legacyWeightsDir = legacyModelDir && exists(path.join(legacyModelDir, "pytorch_model.bin")) ? path.resolve(legacyModelDir) : "";
    const legacy = legacyDenseNotes(env, { legacyWeightsDir });
    return {
      ...choice,
      note,
      provenance: denseVectorProvenance(manifest, choice.backend),
      partial,
      onnx: {
        ready: onnx.ready,
        dir: onnx.dir,
        missing: onnx.missing,
        mismatched: onnx.mismatched,
        ...(onnx.unreadable ? { unreadable: onnx.unreadable } : {}),
        ...(onnx.unchecked ? { unchecked: onnx.unchecked } : {}),
        revision: manifest.revision,
        dtype: manifest.dtype,
        export: manifest.export
      },
      legacy: { notes: legacy, command: legacy.length ? DENSE_INSTALL_COMMAND : "" }
    };
  }

  /**
   * Embed through the model, or say why it cannot.
   *
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async function embed(payload) {
    const chosen = await describe();
    if (!chosen.available) throw new Error(chosen.reason);
    return onnxRuntime.embedTexts(payload);
  }

  /**
   * The `embedding_status` payload: the backend and why, the model folder,
   * downloads that stopped partway, the worker, and what is left of 2.x.
   * Loads no model.
   *
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function status({ refresh = false } = {}) {
    const { partial, ...selected } = await describe({ refresh: Boolean(refresh) });
    return {
      backend: selected.backend,
      dense_model: manifest.model,
      dense_dimensions: manifest.dimensions,
      dense_revision: manifest.revision,
      model_dir: path.resolve(onnxModelDir),
      installed: selected.onnx.ready,
      available: selected.available,
      reason: selected.reason,
      in_container: String(env.AI_DEV_RUNTIME ?? "") === "docker",
      partial,
      worker: onnxRuntime.status?.().worker ?? { started: false },
      dense_backend: selected
    };
  }

  /** Stop the worker. Best effort, as on process shutdown it always is. */
  async function shutdown() {
    await onnxRuntime.shutdown().catch(() => {});
  }

  return { describe, embed, onnxStatus, status, shutdown };
}

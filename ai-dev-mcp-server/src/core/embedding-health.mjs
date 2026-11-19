/**
 * The health check's verdict on dense search, from the `embedding_status`
 * payload.
 *
 * Four answers, because they send a person to four different places. Ready is
 * `ok`. Not installed is `skipped` — nobody has to have the model, and a
 * correct install without it is not unhealthy. Files
 * that are there and wrong are a `warn`, and so is anything left of the
 * removed Python backend: a 2.x setting that nothing reads any more is worth
 * a sentence and the command that replaces it, every time someone looks.
 * A machine the runtime has no build for is `skipped`
 * with that said plainly.
 */
import { containerModelAdvice } from "./dense-backend.mjs";
import { formatBytes } from "./disk-space.mjs";
import { hint } from "./install-layout.mjs";

/**
 * Grade the dense backend from an `embedding_status` payload.
 *
 * @param {{ dense_backend?: object, model_dir?: string, partial?: object[], worker?: object }} status
 * @returns {{ status: string, summary: string, details: object }}
 */
export function evaluateEmbeddingBackend(status = {}) {
  const selected = status.dense_backend ?? {};
  const onnx = selected.onnx ?? {};
  const legacy = selected.legacy?.notes ?? [];
  const partial = status.partial ?? [];
  const details = { backend: selected.backend ?? "onnx", onnx, model_dir: status.model_dir ?? onnx.dir, partial, worker: status.worker, legacy };
  if (legacy.length) {
    return {
      status: "warn",
      summary: [...legacy, selected.available ? "" : selected.reason].filter(Boolean).join(" "),
      details
    };
  }
  if (selected.available) {
    return {
      status: "ok",
      summary: `Dense search is ready through the ONNX backend (${onnx.export} @ ${String(onnx.revision).slice(0, 12)}, ${onnx.dtype}); no Python is involved.`,
      details
    };
  }
  // Inside a container the fix depends on the folder: a read-only mount from
  // the host is fixed there, the volume's by
  // installing into it with the network that one run needs.
  const inContainer = Boolean(status.in_container);
  if (onnx.mismatched?.length) {
    return {
      status: "warn",
      summary: `The model files in ${onnx.dir} do not match the manifest (${onnx.mismatched.join(", ")}). `
        + (inContainer ? `In this container, ${containerModelAdvice(onnx.dir)}` : `Run \`${hint("npm run setup -- --model")}\`: it fetches those files again.`),
      details
    };
  }
  // A check that could not be made is a fault to look at, not a model to install.
  if (onnx.unchecked) return { status: "warn", summary: selected.reason || `The model could not be checked: ${onnx.unchecked}`, details };
  // A model this user cannot read is said as that first: no download continues it.
  if (partial.length && !onnx.unreadable) {
    const started = partial.map((entry) => `${formatBytes(entry.bytes)} of ${entry.file}`).join(", ");
    return {
      status: "skipped",
      summary: `Dense search is not installed: a model download stopped partway (${started}). `
        + (inContainer ? `In this container, ${containerModelAdvice(onnx.dir)}` : `\`${hint("npm run setup -- --model")}\` continues it from there.`),
      details: { ...details, optional: true }
    };
  }
  return { status: "skipped", summary: selected.reason || "Dense search is not installed.", details: { ...details, optional: true } };
}

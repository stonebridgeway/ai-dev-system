/**
 * Embedding the vault's passages for the dense half of hybrid search.
 *
 * Planning, embedding and writing are three steps, each where it belongs:
 *
 *   1. `densePlan` (`search-store.mjs`) collects the documents and returns only
 *      the passages whose vectors are missing or stale for this model,
 *      revision and dtype;
 *   2. this module embeds them in batches through the ONNX model in a worker
 *      thread;
 *   3. `storeDenseVectors` writes each slice as it is done, and the closing
 *      rebuild keeps them — so a cancelled run keeps what it embedded.
 *
 * A document edited between (1) and (3) has a different content hash by then,
 * so the writer declines the stale vector and counts the document as pending
 * rather than storing a vector against text it no longer has. The next rebuild
 * picks it up. That is why the pending count is not forced to zero.
 */

/** Most passages to hand the backend in one call. */
export const DENSE_PLAN_BATCH = 16;

/** Passages embedded between two writes to the index: what a cancel or a crash can cost. */
export const DENSE_COMMIT_EVERY = 64;

/**
 * Turn a plan into vectors.
 *
 * @param {object} deps
 * @param {object[]} deps.records - `{ id, text, content_hash }` from `dense-plan`.
 * @param {(texts: string[]) => Promise<object>} deps.embed - The backend's `embedTexts`.
 * @param {number} deps.dimensions - What the manifest promises.
 * @param {number} [deps.batchSize]
 * @param {(done: number, total: number) => void} [deps.onProgress]
 * @param {AbortSignal} [deps.signal] - Checked before each batch.
 * @returns {Promise<object[]>} `{ id, content_hash, vector }`.
 */
export async function embedDensePlan({ records, embed, dimensions, batchSize = DENSE_PLAN_BATCH, onProgress, signal }) {
  const limit = Math.max(1, Number(batchSize) || DENSE_PLAN_BATCH);
  const vectors = [];
  for (let index = 0; index < records.length; index += limit) {
    if (signal?.aborted) throw Object.assign(new Error("Embedding cancelled."), { name: "AbortError", cancelled: true });
    const slice = records.slice(index, index + limit);
    const answer = await embed(slice.map((record) => record.text));
    const rows = answer?.embeddings ?? [];
    if (rows.length !== slice.length) {
      throw new Error(`Dense backend returned ${rows.length} vectors for ${slice.length} passages.`);
    }
    for (let offset = 0; offset < slice.length; offset += 1) {
      const vector = rows[offset];
      // A vector of the wrong width would be written into the index and then
      // silently score zero against every query, because the dense dot
      // product is 0.0 for a length mismatch. Refuse it here instead.
      if (!Array.isArray(vector) || vector.length !== dimensions) {
        throw new Error(
          `Dense backend returned a ${Array.isArray(vector) ? vector.length : "non-array"} vector; `
          + `the manifest says ${dimensions}.`
        );
      }
      vectors.push({ id: slice[offset].id, content_hash: slice[offset].content_hash, vector });
    }
    if (onProgress) onProgress(vectors.length, records.length);
  }
  return vectors;
}

/**
 * The index's dense coverage as the model that answers now sees it.
 *
 * Hybrid search compares only vectors of the model that embeds the question
 * (`backend/revision/dtype`), so a vector another model made — the 2.x Python
 * backend's, an older revision's — is a document still waiting for one, not a
 * document that has one. Counted that way, `setup -- --model` re-embeds them
 * instead of calling the step done.
 *
 * @param {object} status - `search_index_status`, with `dense_models` from the store.
 * @param {{ backend: string, revision: string, dtype: string }|null} provenance - The current model's.
 * @returns {object} The same status: `dense_documents` and `dense_pending_documents`
 *   for the current model, `dense_other_model_documents` for the rest.
 */
export function denseCoverage(status, provenance) {
  const models = Array.isArray(status?.dense_models) ? status.dense_models : null;
  if (!models || !provenance?.backend) return status;
  const same = (entry) => entry.backend === provenance.backend && entry.revision === provenance.revision && entry.dtype === provenance.dtype;
  const current = models.filter(same).reduce((sum, entry) => sum + entry.documents, 0);
  const other = models.filter((entry) => !same(entry)).reduce((sum, entry) => sum + entry.documents, 0);
  const eligible = Number(status.dense_eligible_documents) || Number(status.dense_documents || 0) + Number(status.dense_pending_documents || 0);
  status.dense_documents = current;
  status.dense_other_model_documents = other;
  status.dense_pending_documents = Math.max(0, eligible - current);
  return status;
}

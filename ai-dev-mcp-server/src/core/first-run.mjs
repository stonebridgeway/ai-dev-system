/**
 * What a fresh install still has to build before it is whole.
 *
 * A clone of this repository runs and answers immediately — the server starts,
 * the skills are there, the tools work. Five things, though, are built rather
 * than shipped, and until they are built the diagnostics say so and part of the
 * system answers with a refusal:
 *
 * - the skill registry, generated from the catalogue sources;
 * - the skill quality report, which the health check reads;
 * - the SQLite search index, which every search tool reads;
 * - the skill-routing benchmark report, which the health check grades;
 * - the Frontend QA runner's own dependencies and its browser.
 *
 * The order is not alphabetical: the quality report writes a dashboard note
 * into the vault, so building it after the index leaves the index stale the
 * moment the first run finishes.
 *
 * And one thing is downloaded rather than built: the BGE-M3 model, about
 * 600 MB, which is a decision a person makes rather than something a setup
 * command does behind their back. So the model step exists here too, and it
 * only ever runs when it is asked for by name.
 *
 * The weights on their own change nothing: documents are embedded during a
 * rebuild, not on the way past a query, so an install that downloaded the model
 * and stopped there had a working embedding backend and an index almost none of
 * whose documents had a vector — dense search answered from whatever had been
 * embedded before. Downloading the model and embedding with it are therefore
 * two steps behind the same flag — and the second needs the first: a vector
 * step that ran after a failed download only failed again, with advice to run
 * the command that had just failed.
 *
 * This module decides *what* to do from what is already on disk. Doing it —
 * calling the tools, downloading — is `scripts/first-run.mjs`, so the plan can
 * be read and tested without building anything.
 */

/** The steps, in the order a first run does them. */
export const FIRST_RUN_STEPS = Object.freeze([
  Object.freeze({
    id: "skill_registry",
    title: "Skill registry",
    detail: "Generated from the catalogue sources; routing and the skill tools read it.",
    optional: false
  }),
  Object.freeze({
    id: "skill_quality_report",
    title: "Skill quality report",
    detail: "Schema and structure over the whole catalogue; the health check reads the report it writes.",
    optional: false
  }),
  Object.freeze({
    id: "search_index",
    title: "Search index",
    detail: "SQLite FTS over notes, projects and skills; every search tool reads it.",
    optional: false
  }),
  Object.freeze({
    id: "routing_benchmark",
    title: "Skill-routing benchmark",
    detail: "Bilingual golden cases; the health check grades the report it writes.",
    optional: false
  }),
  Object.freeze({
    id: "frontend_qa",
    title: "Frontend QA dependencies",
    detail: "Playwright from the runner's lockfile and the Chromium build it wants. Needs the network.",
    optional: true,
    flag: "--frontend-qa"
  }),
  Object.freeze({
    id: "dense_model",
    title: "Local BGE-M3 model",
    // The pinned ONNX export, checked against the manifest, run through Node;
    // continued where a broken download stopped, through AI_DEV_MODEL_MIRROR
    // and HTTPS_PROXY when they are set.
    detail: "About 600 MB of checksum-verified ONNX weights for dense search; a broken download continues. No Python.",
    optional: true,
    flag: "--model"
  }),
  Object.freeze({
    id: "dense_index",
    title: "Dense vectors",
    detail: "Embeddings for the documents already indexed; the dense half of hybrid search reads them.",
    optional: true,
    flag: "--model",
    // Nothing to embed with until the model is there.
    requires: "dense_model"
  })
]);

/**
 * Which steps this machine needs, and why each one is or is not run.
 *
 * `present` is what already exists, keyed by step id; `stale` is what exists and
 * no longer matches what it was built from. A file being there is not the same
 * as it being current: on a real vault the search index and the routing
 * benchmark were skipped as "already built" and the diagnostic two lines later
 * called them stale, which is a setup command contradicting itself.
 *
 * `want` is what the caller asked for by flag; an optional step is never run
 * unasked, because none of them is cheap: two reach the network, one of those
 * downloads gigabytes, and the third embeds the whole index.
 *
 * @param {object} input
 * @param {Record<string, boolean>} input.present - Artefacts already on disk.
 * @param {Record<string, boolean>} [input.stale] - Of those, the ones out of date.
 * @param {Record<string, boolean>} [input.want] - Optional steps asked for.
 * @param {boolean} [input.force] - Rebuild what is already there.
 * @param {(step: { id: string, flag?: string }, state: "missing"|"present"|"stale") => string} [input.optionalReason] -
 *   What an optional step nobody asked for says: setup's flags by default; the image, which has none, says its own.
 * @param {string} [input.builtReason] - What a step already built says: setup's `--force` by default.
 * @returns {Array<{ id: string, title: string, detail: string, run: boolean, reason: string }>}
 */
export function planFirstRun({ present = {}, stale = {}, want = {}, force = false, optionalReason = setupReason, builtReason = "already built; --force rebuilds it" } = {}) {
  return FIRST_RUN_STEPS.map((step) => {
    const here = Boolean(present[step.id]);
    const outOfDate = here && Boolean(stale[step.id]);
    if (step.optional && !want[step.id]) {
      return { ...pick(step), run: false, reason: optionalReason(step, outOfDate ? "stale" : here ? "present" : "missing") };
    }
    if (here && !outOfDate && !force) {
      return { ...pick(step), run: false, reason: builtReason };
    }
    return {
      ...pick(step),
      run: true,
      reason: outOfDate ? "out of date" : here ? "rebuilding on request" : "missing"
    };
  });
}

/** An optional step `setup` was not asked for, in its own flags. */
export function setupReason(step, state) {
  if (state === "stale") return `out of date; ${step.flag} rebuilds it`;
  if (state === "present") return `already installed; ${step.flag} rebuilds it`;
  return `not installed — pass ${step.flag} to install it`;
}

/**
 * How much of the index the dense half of hybrid search can actually see.
 *
 * Zero and zero is not half-built, it is never built: an index rebuilt without
 * the model reports no vectors and nothing pending, and a line reading "0 with
 * a vector, 0 without" tells a reader their documents are covered when none of
 * them is.
 *
 * Vectors another model made — a 2.x index from the Python backend — are
 * named as such: hybrid search does not compare them, so they wait for
 * `--model` like documents with none.
 *
 * @param {{ current_document_count?: number, dense_documents?: number, dense_pending_documents?: number, dense_other_model_documents?: number }|null} status
 * @param {{ modelUnreadable?: boolean }} [options]
 * @returns {string}
 */
export function describeDenseCoverage(status, { modelUnreadable = false } = {}) {
  if (!status) return "No search index yet.";
  const documents = Number(status.current_document_count || 0);
  const dense = Number(status.dense_documents || 0);
  const pending = Number(status.dense_pending_documents || 0);
  const other = Number(status.dense_other_model_documents || 0);
  // --model does not embed with a model this user cannot read.
  if (!dense && !pending) return `Indexed: ${documents} document(s), none embedded yet (${modelUnreadable ? "the model cannot be read" : "--model embeds them"}).`;
  return `Indexed: ${documents} document(s), ${dense} with a dense vector, ${pending} waiting for one`
    + (other ? ` (${other} with a vector of another model, which hybrid search does not compare; ${modelUnreadable ? "a model this user can read embeds them again" : "--model embeds them again"}).` : ".");
}

function pick(step) {
  return { id: step.id, title: step.title, detail: step.detail, ...(step.requires ? { requires: step.requires } : {}) };
}

/**
 * The outcome of a run as the lines a person reads.
 *
 * Every step says what happened to it, including the ones that did not run:
 * a setup command that silently skips is how an install ends up half-built
 * without anyone noticing.
 *
 * @param {Array<{ id: string, title: string, run: boolean, reason: string, status?: string, detail?: string, error?: string, duration_ms?: number }>} results
 * @returns {string}
 */
export function renderFirstRunReport(results) {
  const lines = [];
  for (const item of results) {
    const status = item.status ?? (item.run ? "done" : "skipped");
    const mark = { done: "✓", skipped: "·", failed: "✗" }[status] ?? "·";
    const timing = Number.isFinite(item.duration_ms) && item.duration_ms > 0
      ? ` (${(item.duration_ms / 1000).toFixed(1)}s)`
      : "";
    lines.push(`${mark} ${item.title}${timing}: ${item.error || item.reason}`);
  }
  const failed = results.filter((item) => item.status === "failed");
  const done = results.filter((item) => item.status === "done");
  lines.push("");
  lines.push(`${done.length} built, ${results.length - done.length - failed.length} skipped, ${failed.length} failed.`);
  return lines.join("\n");
}

/**
 * What is still missing once a run is over, as an exit-worthy verdict.
 *
 * A skipped optional step is not a failure — nobody has to have the model — so
 * only a step that was attempted and failed counts.
 *
 * @param {Array<{ status?: string }>} results
 * @returns {boolean}
 */
export function firstRunSucceeded(results) {
  return !results.some((item) => item.status === "failed");
}

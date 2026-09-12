/**
 * What a fresh install still has to build before it is whole.
 *
 * A clone of this repository runs and answers immediately — the server starts,
 * the skills are there, the tools work. Four things, though, are built rather
 * than shipped, and until they are built the diagnostics say so and part of the
 * system answers with a refusal:
 *
 * - the skill registry, generated from the catalogue sources;
 * - the SQLite search index, which every search tool reads;
 * - the skill-routing benchmark report, which the health check grades;
 * - the Frontend QA runner's own dependencies.
 *
 * And one thing is downloaded rather than built: the BGE-M3 weights, 2.3 GB,
 * which is a decision a person makes rather than something a setup command does
 * behind their back. So the model step exists here too, and it only ever runs
 * when it is asked for by name.
 *
 * This module decides *what* to do from what is already on disk. Doing it —
 * calling the tools, spawning pip — is `scripts/first-run.mjs`, so the plan can
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
    detail: "Playwright and its runner, installed into frontend-qa/. Needs the network.",
    optional: true,
    flag: "--frontend-qa"
  }),
  Object.freeze({
    id: "dense_model",
    title: "Local BGE-M3 model",
    detail: "A Python environment plus 2.3 GB of weights, for dense search and reranking.",
    optional: true,
    flag: "--dense"
  })
]);

/**
 * Which steps this machine needs, and why each one is or is not run.
 *
 * `present` is what already exists, keyed by step id. `want` is what the caller
 * asked for by flag; an optional step is never run unasked, because both of
 * them reach the network and one of them downloads gigabytes.
 *
 * @param {object} input
 * @param {Record<string, boolean>} input.present - Artefacts already on disk.
 * @param {Record<string, boolean>} [input.want] - Optional steps asked for.
 * @param {boolean} [input.force] - Rebuild what is already there.
 * @returns {Array<{ id: string, title: string, detail: string, run: boolean, reason: string }>}
 */
export function planFirstRun({ present = {}, want = {}, force = false } = {}) {
  return FIRST_RUN_STEPS.map((step) => {
    const here = Boolean(present[step.id]);
    if (step.optional && !want[step.id]) {
      return {
        ...pick(step),
        run: false,
        reason: here
          ? `already installed; ${step.flag} rebuilds it`
          : `not installed — pass ${step.flag} to install it`
      };
    }
    if (here && !force) {
      return { ...pick(step), run: false, reason: "already built; --force rebuilds it" };
    }
    return {
      ...pick(step),
      run: true,
      reason: here ? "rebuilding on request" : "missing"
    };
  });
}

function pick(step) {
  return { id: step.id, title: step.title, detail: step.detail };
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

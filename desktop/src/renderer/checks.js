// The health checks as the Status screen tells them: a check's name in the
// page's words, what to do about it, and the order a person reads them in.
// No DOM and no IPC here, so a unit test runs it under Node.

const CHECK_WORDS = Object.freeze({ ui: "UI", ux: "UX", qa: "QA", fts: "FTS", mcp: "MCP" });

/** How many of a check's details are shown before the rest is counted. */
export const DETAIL_ROWS = 40;

/** Failing first — the critical ones before the rest — then warnings, the not set up, the ready. */
const ORDER = Object.freeze({ fail: 0, warn: 1, skipped: 2, ok: 3 });

/**
 * What to do about a check that is not ok: one piece of advice per check, or
 * per group of checks one step repairs.
 */
export const ADVICE = Object.freeze({
  search_index_file: "recommend.search_index",
  search_index_freshness: "recommend.search_index_freshness",
  embedding_backend: "recommend.dense_model",
  skill_registry: "recommend.skill_registry",
  skill_taxonomy: "recommend.skill_registry",
  skill_visual_graph: "recommend.skill_registry",
  skill_quality: "recommend.skill_registry",
  skill_routing_benchmark: "recommend.skill_registry",
  skill_cards: "recommend.skill_registry",
  required_notes: "recommend.required_notes",
  frontend_qa_environment: "recommend.frontend_qa",
  frontend_qa_runner: "recommend.frontend_qa",
  vault_root: "recommend.vault_root"
});

/** `frontend_qa_runner` → `Frontend QA runner`, as the dashboard writes it; the page's own words when it has them. */
export function checkTitle(name, t = null) {
  if (t) {
    const key = `check.${name}`;
    const text = t(key);
    if (text !== key) return text;
  }
  const title = String(name).split("_").filter(Boolean).map((word) => CHECK_WORDS[word] ?? word).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** What to do about a check that is not ok, in the page's language. */
export function recommendation(view, check) {
  if (check.status === "ok") return null;
  const specific = ADVICE[check.name];
  if (specific) return view.t(specific);
  return view.t(check.status === "fail" ? "recommend.default.fail" : check.status === "skipped" ? "recommend.default.skipped" : "recommend.default.warn");
}

/** The checks in the order a person reads them. */
export function orderedChecks(checks) {
  return [...checks].sort((left, right) => (ORDER[left.status] ?? 4) - (ORDER[right.status] ?? 4)
    || Number(right.critical === true) - Number(left.critical === true));
}

/**
 * The settings file's problems to list under the summary: those it does not
 * say already — each is said once.
 */
export function unsaidProblems(status) {
  const summary = String(status?.summary ?? "");
  return (status?.settings_problems ?? []).filter((problem) => !summary.includes(problem));
}

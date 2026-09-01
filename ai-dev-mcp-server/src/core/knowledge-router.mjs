const KNOWLEDGE_ROUTES = Object.freeze([
  {
    id: "refresh-project-memory",
    phrases: [
      "обнови память проекта",
      "обнови карту проекта",
      "пересобери память проекта",
      "пересобери контекст проекта",
      "refresh project memory",
      "update project memory",
      "refresh project brief",
      "refresh project map"
    ],
    paths: [
      "09-mcp/Project Registry And Map Refresh.md",
      "06-prompts/Auto Commands.md",
      "01-system/AI Dev Control Center.md",
      "09-mcp/MCP Server Plan.md"
    ],
    reason: "The query matches the project-memory refresh workflow."
  },
  {
    id: "format-project-for-ai",
    phrases: [
      "оформи проект для ии",
      "оформи проект под ии",
      "оформи репозиторий для ии",
      "подключи проект к агенту",
      "format project for ai",
      "make project agent ready",
      "make repository agent ready",
      "project handoff"
    ],
    paths: [
      "06-prompts/Auto Commands.md",
      "01-system/AI Dev Control Center.md",
      "05-project-templates/Project Bootstrap.md"
    ],
    reason: "The query matches the project-formatting workflow."
  },
  {
    id: "ui-ux-design-intelligence",
    phrases: [
      "создай продуктовую дизайн систему",
      "продуктовая дизайн система",
      "сгенерируй дизайн систему",
      "подбери палитру и типографику",
      "generate product specific design system",
      "product specific design system",
      "design system palette typography",
      "generate_ui_ux_design_system",
      "query_ui_ux_knowledge",
      "ui ux pro max"
    ],
    paths: [
      "09-mcp/UI UX Pro Max Integration.md",
      "03-skills-catalog/sources/external/ui-ux-pro-max/SKILL.md",
      "06-prompts/Auto Commands.md",
      "01-system/AI Dev Control Center.md"
    ],
    reason: "The query asks for the curated UI/UX design-intelligence workflow."
  }
]);

const SEARCH_PRESET_SIGNALS = Object.freeze([
  "preset_search",
  "list_search_presets",
  "explain_search"
]);

function normalizeIntent(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function routeSearchPresetDocs(normalized) {
  const exactSignals = SEARCH_PRESET_SIGNALS.filter((signal) => normalized.includes(signal));
  const naturalLanguageMatch = (
    normalized.includes("search presets")
    || normalized.includes("search profiles")
    || normalized.includes("профили поиска")
    || normalized.includes("пресеты поиска")
  );
  if (exactSignals.length < 2 && !naturalLanguageMatch) return null;
  return {
    id: "search-presets",
    paths: [
      "01-system/AI Dev Control Center.md",
      "09-mcp/ai-dev-mcp-server/README.md",
      "09-mcp/Semantic Search.md",
      "09-mcp/MCP Server Plan.md"
    ],
    reason: "The query asks for the search-preset control surface."
  };
}

/**
 * Deterministically map a natural-language query (RU/EN) to a curated set of
 * vault documents for known workflows (project-memory refresh, project
 * formatting, UI/UX design intelligence, search presets).
 *
 * @param {string} query - User request text.
 * @returns {{ id: string, paths: string[], reason: string } | null} Matched route, or `null`.
 */
export function routeKnowledgeDocuments(query) {
  const normalized = normalizeIntent(query);
  if (!normalized) return null;

  const searchPresetRoute = routeSearchPresetDocs(normalized);
  if (searchPresetRoute) return searchPresetRoute;

  return KNOWLEDGE_ROUTES.find((route) => (
    route.phrases.some((phrase) => normalized.includes(normalizeIntent(phrase)))
  )) || null;
}

/**
 * Re-order search results so that documents belonging to the matched knowledge
 * route float to the top, tagged with `retrieval_stage` / `routing_rule` /
 * `routing_reason`. Returns `results` unchanged when no route matches.
 *
 * @param {string} query - User request text.
 * @param {Array<{ path?: string }>} [results] - Ranked search hits.
 * @returns {Array<object>} Re-ordered results.
 */
export function prioritizeKnowledgeResults(query, results = []) {
  const route = routeKnowledgeDocuments(query);
  if (!route || !Array.isArray(results) || !results.length) return results;

  const remaining = [...results];
  const promoted = [];
  for (const routePath of route.paths) {
    const normalizedPath = routePath.replaceAll("\\", "/").toLowerCase();
    const index = remaining.findIndex((item) => (
      String(item.path || "").replaceAll("\\", "/").toLowerCase() === normalizedPath
    ));
    if (index < 0) continue;
    const [item] = remaining.splice(index, 1);
    promoted.push({
      ...item,
      retrieval_stage: "deterministic-knowledge-router",
      routing_rule: route.id,
      routing_reason: route.reason
    });
  }
  return [...promoted, ...remaining];
}

const STOP_WORDS = new Set([
  "and", "the", "for", "with", "from", "this", "that", "into", "как", "для", "или",
  "это", "при", "через", "нужно", "сделать", "найти", "проекта", "проект"
]);

const INTENT_DEFINITIONS = Object.freeze({
  frontend: [
    "frontend", "ui", "ux", "website", "landing", "layout", "responsive", "css",
    "component", "design", "интерфейс", "дизайн", "лендинг", "фронтенд", "экран"
  ],
  backend: [
    "backend", "api", "endpoint", "server", "service", "fastapi", "django", "express",
    "бэкенд", "апи", "эндпоинт", "сервер"
  ],
  database: ["database", "sql", "migration", "schema", "postgres", "redis", "база", "миграц"],
  devops: ["devops", "deploy", "docker", "kubernetes", "terraform", "ci", "cd", "vps", "деплой"],
  security: ["security", "auth", "vulnerability", "secret", "oauth", "безопас", "уязв"],
  debug: ["bug", "debug", "regression", "failing", "error", "stack trace", "баг", "ошиб", "регресс"],
  review: ["review", "findings", "severity", "ревью", "проверь код"],
  quality: ["quality", "test", "lint", "typecheck", "coverage", "gate", "качество", "тест"],
  project: ["project card", "project registry", "project path", "карточка проекта", "реестр проектов"],
  knowledge: ["documentation", "docs", "runbook", "architecture", "knowledge", "документац", "архитектур", "база знаний"]
});

const CONFLICTS = Object.freeze({
  frontend: new Set(["backend", "database", "devops"]),
  backend: new Set(["frontend"]),
  database: new Set(["frontend"]),
  devops: new Set(["frontend"])
});

let windows1251ReverseMap = null;

function cp1251ReverseMap() {
  if (windows1251ReverseMap) return windows1251ReverseMap;
  const decoder = new TextDecoder("windows-1251");
  windows1251ReverseMap = new Map();
  for (let byte = 0; byte <= 255; byte += 1) {
    windows1251ReverseMap.set(decoder.decode(Uint8Array.of(byte)), byte);
  }
  return windows1251ReverseMap;
}

/**
 * Best-effort repair of Cyrillic text that was decoded as Windows-1251 then
 * re-encoded as UTF-8 (classic `Ð /Ð¡` mojibake). Returns the input unchanged
 * unless the round-trip demonstrably reduces the mojibake markers.
 *
 * @param {string} value - Possibly mangled text.
 * @returns {string}
 */
export function repairSearchMojibake(value) {
  const input = String(value ?? "");
  const markers = input.match(/[РС]/g) ?? [];
  if (markers.length < 3) return input;
  const reverse = cp1251ReverseMap();
  const bytes = [];
  for (const character of input) {
    const byte = reverse.get(character);
    if (byte === undefined) return input;
    bytes.push(byte);
  }
  const repaired = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  if (repaired.includes("\uFFFD")) return input;
  const repairedMarkers = repaired.match(/[РС]/g) ?? [];
  return repairedMarkers.length < markers.length ? repaired : input;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

function tokens(value) {
  return [...new Set(normalize(value)
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))];
}

/**
 * Detect coarse topic intents (frontend, backend, database, devops, security,
 * debug, review, quality, project, knowledge) present in a query or document
 * text via RU/EN keyword lists.
 *
 * @param {string} value - Text to classify.
 * @returns {string[]} Matched intent names.
 */
export function inferSearchIntents(value) {
  const normalized = normalize(value);
  return Object.entries(INTENT_DEFINITIONS)
    .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
    .map(([intent]) => intent);
}

/**
 * True when a query is about the skill catalog itself (taxonomy / groups /
 * routing / registry) rather than an individual skill — it needs both a
 * skill subject term and a catalog-intent term.
 *
 * @param {string} value - Query text.
 * @returns {boolean}
 */
export function isSkillCatalogQuery(value) {
  const normalized = normalize(value);
  const hasSkillSubject = [
    "skill",
    "skills",
    "скилл",
    "навык"
  ].some((term) => normalized.includes(term));
  const hasCatalogIntent = [
    "taxonomy",
    "catalog",
    "registry",
    "skills map",
    "skill map",
    "skill group",
    "skill domain",
    "subgroup",
    "routing",
    "таксоном",
    "каталог",
    "реестр",
    "карт",
    "групп",
    "домен",
    "подгрупп",
    "маршрутиз"
  ].some((term) => normalized.includes(term));
  return hasSkillSubject && hasCatalogIntent;
}

function resultText(result) {
  return [
    result?.title,
    result?.path,
    result?.scope,
    result?.source,
    result?.categories,
    result?.preview
  ].map(normalize).join(" ");
}

function requestedScopeIntent(query, scope, preset) {
  const normalized = normalize(query);
  if (scope && scope !== "all") return scope;
  if (preset === "skills" || /\bskills?\b|скилл/.test(normalized)) return "skills";
  if (preset === "projects" || /project (card|registry|path)|карточк.*проект|реестр.*проект/.test(normalized)) return "projects";
  if (preset === "docs" || /\bdocs?\b|documentation|runbook|документац|инструкц/.test(normalized)) return "knowledge";
  return "";
}

function scopeCompatible(actual, expected) {
  if (!expected || expected === "all") return true;
  if (expected === "knowledge") return actual === "knowledge" || actual === "quality";
  return actual === expected;
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Re-score and re-order hybrid search results using lexical overlap, title/path
 * exact matches, intent alignment and conflicts, scope compatibility, source
 * curation, and golden-case hard negatives. Adds `rerank_*`, `original_*`,
 * `reranked_rank`, and overwrites `score` with the reranked value.
 *
 * @param {string} query - Search query.
 * @param {Array<object>} results - Ranked hybrid-search hits.
 * @param {{ scope?: string, preset?: string, hardNegativeRules?: Array<{ id?: string, query: string, patterns: object[] }> }} [options]
 * @returns {Array<object>} Reranked results, best first.
 */
export function rerankSearchResults(query, results, {
  scope = "all",
  preset = "",
  hardNegativeRules = []
} = {}) {
  const queryText = normalize(query);
  const queryTokens = tokens(queryText);
  const queryIntents = inferSearchIntents(queryText);
  const expectedScope = requestedScopeIntent(queryText, scope, preset);
  const catalogQuery = isSkillCatalogQuery(queryText);

  return (results ?? []).map((result, index) => {
    const text = resultText(result);
    const title = normalize(result.title);
    const path = normalize(result.path);
    const documentTokens = new Set(tokens(text));
    const matchedTokens = queryTokens.filter((token) => documentTokens.has(token));
    const coverage = queryTokens.length ? matchedTokens.length / queryTokens.length : 0;
    const titleMatches = queryTokens.filter((token) => title.includes(token)).length;
    const resultIntents = inferSearchIntents(text);
    const reasons = [];
    const hardNegatives = [];
    let adjustment = 0;

    if (queryText && (title === queryText || path.endsWith(`/${queryText}`))) {
      adjustment += 0.24;
      reasons.push("exact entity match");
    } else if (queryText.length >= 5 && (title.includes(queryText) || path.includes(queryText))) {
      adjustment += 0.16;
      reasons.push("exact phrase in title or path");
    }
    if (coverage > 0) {
      adjustment += Math.min(0.16, coverage * 0.16);
      reasons.push(`query token coverage ${Math.round(coverage * 100)}%`);
    }
    if (titleMatches > 0) {
      adjustment += Math.min(0.10, titleMatches * 0.025);
      reasons.push(`${titleMatches} query token(s) in title`);
    }
    if (catalogQuery) {
      const catalogTitles = [
        "skill taxonomy",
        "skills map",
        "skill routing",
        "skill registry",
        "skills catalog"
      ];
      const isCatalogSurface = catalogTitles.some((term) => title.includes(term))
        || /(?:^|\/)(?:skill-taxonomy|skills-map|skill-routing|skill-registry-rules|skills_catalog)\.md$/.test(path);
      const isIndividualSkill = (
        path.startsWith("sources/")
        || path.includes("/sources/")
        || path.startsWith("cards/")
        || path.includes("/cards/")
      );
      if (isCatalogSurface) {
        adjustment += 0.28;
        reasons.push("skill catalog metadata match");
      } else if (isIndividualSkill) {
        adjustment -= 0.10;
        hardNegatives.push("individual skill is secondary to catalog metadata");
      }
    }

    const alignedIntents = queryIntents.filter((intent) => resultIntents.includes(intent));
    if (alignedIntents.length) {
      adjustment += Math.min(0.14, alignedIntents.length * 0.07);
      reasons.push(`intent alignment: ${alignedIntents.join(", ")}`);
    }
    for (const queryIntent of queryIntents) {
      const conflicts = CONFLICTS[queryIntent] ?? new Set();
      const conflicting = resultIntents.filter((intent) => conflicts.has(intent));
      if (conflicting.length && !resultIntents.includes(queryIntent) && result.scope === "skills") {
        adjustment -= 0.24;
        hardNegatives.push(`${queryIntent} query conflicts with ${conflicting.join(", ")}-only skill`);
      }
    }

    if (!scopeCompatible(normalize(result.scope), expectedScope)) {
      adjustment -= 0.20;
      hardNegatives.push(`scope ${result.scope || "unknown"} does not match requested ${expectedScope}`);
    } else if (expectedScope) {
      adjustment += 0.05;
      reasons.push(`scope alignment: ${expectedScope}`);
    }

    if (result.scope === "skills" && result.source === "custom") {
      adjustment += 0.04;
      reasons.push("curated local skill");
    }
    if (result.scope === "skills" && result.source === "membrane" && !queryText.includes("membrane")) {
      adjustment -= 0.035;
      hardNegatives.push("generic upstream skill loses to curated local guidance");
    }

    for (const rule of hardNegativeRules) {
      const ruleTokens = tokens(rule.query);
      const overlap = ruleTokens.length
        ? ruleTokens.filter((token) => queryTokens.includes(token)).length / ruleTokens.length
        : 0;
      if (overlap < 0.6) continue;
      const matches = (rule.patterns ?? []).some((pattern) => {
        if (pattern.title && !title.includes(normalize(pattern.title))) return false;
        if (pattern.path && !path.includes(normalize(pattern.path))) return false;
        if (pattern.scope && normalize(result.scope) !== normalize(pattern.scope)) return false;
        if (pattern.source && !normalize(result.source).includes(normalize(pattern.source))) return false;
        if (pattern.text && !text.includes(normalize(pattern.text))) return false;
        return Boolean(pattern.title || pattern.path || pattern.scope || pattern.source || pattern.text);
      });
      if (matches) {
        adjustment -= 0.30;
        hardNegatives.push(`golden-case hard negative: ${rule.id || rule.query}`);
      }
    }

    const baseScore = Number(result.score) || 0;
    const rankPrior = Math.max(0, (50 - index) / 50) * 0.015;
    const rerankScore = baseScore + adjustment + rankPrior;
    return {
      ...result,
      original_rank: index + 1,
      original_score: baseScore,
      rerank_score: round(rerankScore),
      rerank_adjustment: round(adjustment + rankPrior),
      rerank_reasons: reasons,
      hard_negative: hardNegatives.length > 0,
      hard_negative_reasons: hardNegatives,
      score: round(rerankScore)
    };
  }).sort((left, right) => (
    right.rerank_score - left.rerank_score
    || left.original_rank - right.original_rank
  )).map((result, index) => ({
    ...result,
    reranked_rank: index + 1
  }));
}

/**
 * Convert golden search-eval cases into hard-negative rules for
 * {@link rerankSearchResults} (one rule per case that has a `must_not` list).
 *
 * @param {Array<{ id?: string, query: string, must_not?: object[] }>} [cases]
 * @returns {Array<{ id: string | undefined, query: string, patterns: object[] }>}
 */
export function hardNegativeRulesFromCases(cases = []) {
  return (cases ?? [])
    .filter((testCase) => Array.isArray(testCase.must_not) && testCase.must_not.length)
    .map((testCase) => ({
      id: testCase.id,
      query: testCase.query,
      patterns: testCase.must_not
    }));
}

/**
 * The sparse "semantic" vectors of the search index: hashed terms, aliases and
 * character n-grams, weighted by field, the 512 strongest kept and normalised.
 *
 * A port of `semantic_terms` and `build_semantic_vector` from
 * `search-index/search_cli.py`, and deliberately identical to them. Hybrid
 * search scores a query vector against the stored ones, so a writer that put a
 * term in another dimension, weighted a field differently or printed a weight
 * another way would move every hybrid ranking — and while hybrid search is
 * still the Python helper's, it would make a Node-built index answer
 * differently from the one 2.x built. `python-compat.mjs` supplies the parts of
 * the arithmetic where JavaScript and Python differ.
 */
import { blake2b } from "./blake2b.mjs";
import { encodeUtf8, pythonFloatRepr, pythonLog, pythonRound, pythonSum, sliceCodePoints } from "./python-compat.mjs";

/** Width of the hashed space; `meta.semantic_dimensions`. */
export const SEMANTIC_DIMENSIONS = 1024;

/** Features kept per document, the strongest by absolute weight. */
export const MAX_VECTOR_FEATURES = 512;

/** How each field counts, and how much of it is read. */
const FIELD_WEIGHTS = [
  ["title", 5, 2000],
  ["categories", 3, 2000],
  ["source", 2.5, 1000],
  ["path", 2, 4000],
  ["body", 1, 60000]
];

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "if", "in", "into", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "use", "with", "what", "when", "where",
  "which", "who", "why", "а", "без", "бы", "в", "во", "вот", "для", "до", "его", "ее", "если",
  "же", "за", "и", "из", "или", "к", "как", "ко", "ли", "на", "не", "но", "о", "об", "от", "по",
  "при", "с", "со", "так", "то", "у", "что", "это", "я"
]);

const SEMANTIC_ALIASES = [
  ["bug", [
    "bug", "bugs", "error", "errors", "failure", "failures", "exception", "regression", "broken",
    "debug", "fix", "issue", "баг", "ошибка", "ошибки", "сбой", "падает", "исправить", "починить",
    "регрессия"
  ]],
  ["feature", [
    "feature", "implementation", "implement", "build", "add behavior", "new behavior", "фича", "фичу",
    "функция", "реализовать", "добавить", "сделать"
  ]],
  ["review", [
    "review", "code review", "diff", "pull request", "pr", "audit", "ревью", "проверка", "проверь",
    "посмотри код"
  ]],
  ["quality", [
    "quality", "quality gate", "test", "tests", "lint", "typecheck", "coverage", "ci", "verification",
    "qa", "browser qa", "playwright", "accessibility", "overflow", "console error", "качество",
    "проверки", "тест", "тесты", "линт", "тайпчек"
  ]],
  ["frontend", [
    "frontend", "front-end", "ui", "ux", "interface", "responsive", "layout", "component", "design",
    "figma", "website", "landing", "редизайн", "дизайн", "интерфейс", "сайт", "лендинг", "верстка",
    "адаптив"
  ]],
  ["backend", [
    "backend", "api", "server", "database", "db", "sql", "postgres", "redis", "celery", "queue",
    "worker", "fastapi", "сервер", "бэкенд", "база данных", "очередь"
  ]],
  ["project", [
    "project", "repository", "repo", "workspace", "project map", "agents.md", "репозиторий", "проект",
    "карта проекта", "агент"
  ]],
  ["knowledge", [
    "knowledge", "docs", "documentation", "note", "notes", "obsidian", "vault", "база знаний",
    "документация", "заметка", "обсидиан"
  ]],
  ["skill", [
    "skill", "skills", "workflow", "runbook", "prompt", "routing", "скилл", "скиллы", "навык",
    "воркфлоу", "промпт"
  ]],
  ["skill_taxonomy", [
    "skill taxonomy", "skills map", "skill map", "skill groups", "skill domains", "skill subgroups",
    "related skills", "routing skills", "группы скиллов", "домены скиллов", "подгруппы скиллов",
    "связанные навыки", "маршрутизация навыков", "таксономия скиллов", "каталог скиллов"
  ]],
  ["mcp", [
    "mcp", "model context protocol", "server", "tool", "tools", "мцп", "мсп", "сервер", "тул", "тулсы",
    "инструмент"
  ]],
  ["semantic_search", [
    "semantic", "semantics", "embedding", "embeddings", "vector", "vectors", "hybrid search", "meaning",
    "similarity", "семантический", "семантика", "эмбеддинг", "эмбеддинги", "вектор", "вектора",
    "по смыслу", "гибридный поиск"
  ]],
  ["integration", [
    "integration", "integrate", "connector", "oauth", "webhook", "api integration", "интеграция",
    "коннектор", "вебхук"
  ]],
  ["database_migration", [
    "database migration", "schema migration", "alembic", "backfill", "rollback", "миграция базы",
    "миграцию базы", "миграция схемы", "схема базы", "бэкфил", "откат миграции"
  ]],
  ["api_contract", [
    "api contract", "openapi", "response schema", "request schema", "backward compatibility",
    "контракт api", "контракт апи", "схема ответа", "схема запроса", "обратная совместимость"
  ]],
  ["security", [
    "security", "threat model", "authorization", "authentication", "vulnerability", "xss", "csrf",
    "безопасность", "модель угроз", "авторизация", "аутентификация", "уязвимость"
  ]],
  ["secrets", [
    "secret", "credential", "dependency audit", "supply chain", "lockfile", "секрет", "учетные данные",
    "зависимости", "цепочка поставок", "утечка ключа"
  ]],
  ["devops", [
    "deployment", "release", "rollback", "ci/cd", "github actions", "деплой", "развертывание", "релиз",
    "откат", "сборочный пайплайн"
  ]],
  ["container", [
    "docker", "dockerfile", "compose", "container", "kubernetes", "helm", "докер", "контейнер",
    "кубернетес", "кубер", "хелм"
  ]],
  ["data_pipeline", [
    "data pipeline", "etl", "ingestion", "lineage", "data quality", "пайплайн данных", "загрузка данных",
    "импорт данных", "качество данных", "происхождение данных"
  ]],
  ["llm", [
    "llm", "rag", "embedding", "prompt", "tool calling", "structured output", "нейросеть", "эмбеддинг",
    "промпт", "вызов инструментов", "структурированный ответ"
  ]],
  ["landing_conversion", [
    "landing", "conversion", "cta", "hero", "pricing", "trust proof", "лендинг", "конверсия",
    "призыв к действию", "первый экран", "тарифы", "доверие"
  ]],
  ["accessibility", [
    "accessibility", "a11y", "wcag", "keyboard navigation", "screen reader", "доступность",
    "клавиатурная навигация", "скринридер", "читалка экрана"
  ]],
  ["gmail", ["gmail", "google mail", "email", "mail", "почта", "емейл"]],
  ["google_sheets", ["google sheets", "sheets", "spreadsheet", "таблица", "таблицы", "гугл таблицы"]],
  ["figma", ["figma", "figjam", "фигма"]],
  ["github", ["github", "git", "pull request", "pr", "issue", "actions", "ci"]],
];

/** One pattern per concept, any of its aliases: twice as fast as an `includes` per alias. */
const ALIAS_PATTERNS = SEMANTIC_ALIASES.map(([canonical, aliases]) => [
  canonical,
  new RegExp(aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"))
]);

const TOKEN = /[0-9A-Za-zА-Яа-яЁё_+#.-]+/g;
const TOKEN_SEPARATORS = /[_+#.-]+/;
const EDGE_PUNCTUATION = /^[_\-.+#]+|[_\-.+#]+$/g;

/** `normalize_token`: lower-cased, edge punctuation off, two letters or more, no stopword. */
function normalizeToken(token) {
  const normalized = token.toLowerCase().replace(EDGE_PUNCTUATION, "");
  if (normalized.length < 2 || STOPWORDS.has(normalized)) return "";
  return normalized;
}

/**
 * Words of a text as the index sees them: Latin and Cyrillic letters and digits,
 * split again on `_ + # . -`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeSemantic(text) {
  const tokens = [];
  for (const raw of text.toLowerCase().match(TOKEN) ?? []) {
    for (const part of raw.split(TOKEN_SEPARATORS)) {
      const token = normalizeToken(part);
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Every feature of a text, repeats included: its tokens, `alias:` features for
 * the concepts it mentions, character 3- and 4-grams of long tokens, and a
 * crude `-ing`/`-ed` stem.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function semanticTerms(text) {
  const lowered = text.toLowerCase();
  const tokens = tokenizeSemantic(lowered);
  const terms = [...tokens];
  for (const [canonical, pattern] of ALIAS_PATTERNS) {
    if (pattern.test(lowered)) terms.push(`alias:${canonical}`, canonical);
  }
  for (const token of tokens) {
    if (token.length >= 5) {
      const limit = Math.min(token.length, 24);
      for (const size of [3, 4]) {
        for (let index = 0; index < limit - size + 1; index += 1) terms.push(`ng:${token.slice(index, index + size)}`);
      }
    }
    if (token.endsWith("ing") && token.length > 5) terms.push(token.slice(0, -3));
    if (token.endsWith("ed") && token.length > 4) terms.push(token.slice(0, -2));
  }
  return terms;
}

const dimensionCache = new Map();
const DIMENSION_CACHE_LIMIT = 500_000;

/**
 * The dimension a feature lands in: Python's `blake2b(term, digest_size=8)` as
 * a big-endian integer, modulo {@link SEMANTIC_DIMENSIONS} — its last ten bits.
 *
 * @param {string} term
 * @returns {number}
 */
export function featureDimension(term) {
  let dimension = dimensionCache.get(term);
  if (dimension === undefined) {
    const digest = blake2b(encodeUtf8(term), 8);
    dimension = ((digest[6] & 0x03) << 8) | digest[7];
    if (dimensionCache.size >= DIMENSION_CACHE_LIMIT) dimensionCache.clear();
    dimensionCache.set(term, dimension);
  }
  return dimension;
}

/**
 * Add one field's features to `weights`: `base * (1 + ln(count))` per distinct
 * feature, in the order features first appear.
 *
 * @param {Map<number, number>} weights - Dimension to weight, in insertion order.
 * @param {string} text
 * @param {number} baseWeight
 * @param {number} maxChars - Code points of `text` read.
 */
export function addVectorFeatures(weights, text, baseWeight, maxChars) {
  if (!text) return;
  const counts = new Map();
  for (const term of semanticTerms(sliceCodePoints(text, maxChars))) counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [term, count] of counts) {
    if (!term) continue;
    const dimension = featureDimension(term);
    weights.set(dimension, (weights.get(dimension) ?? 0) + baseWeight * (1 + pythonLog(count)));
  }
}

/**
 * A document's sparse vector: the {@link MAX_VECTOR_FEATURES} strongest
 * dimensions, unit length, each weight rounded to eight places.
 *
 * @param {{ title?: string, categories?: string, source?: string, path?: string, body?: string }} doc
 * @returns {{ entries: Array<[number, number]>, norm: number }} entries in stored order; norm 1, or 0 for an empty vector
 */
export function buildSemanticVector(doc) {
  const weights = new Map();
  for (const [field, baseWeight, maxChars] of FIELD_WEIGHTS) addVectorFeatures(weights, doc[field] ?? "", baseWeight, maxChars);
  if (!weights.size) return { entries: [], norm: 0 };
  // A stable sort, strongest first: equal weights keep the order they appeared in.
  const selected = [...weights].sort((left, right) => Math.abs(right[1]) - Math.abs(left[1])).slice(0, MAX_VECTOR_FEATURES);
  const norm = Math.sqrt(pythonSum(selected.map(([, value]) => value * value)));
  if (norm <= 0) return { entries: [], norm: 0 };
  return { entries: selected.map(([dimension, value]) => [dimension, pythonRound(value / norm, 8)]), norm: 1 };
}

/**
 * The stored form, `json.dumps(vector, separators=(",", ":"))`: keys in stored
 * order (a JavaScript object would put integer-like keys in numeric order) and
 * weights printed as Python prints floats.
 *
 * @param {Array<[number, number]>} entries
 * @returns {string}
 */
export function semanticVectorJson(entries) {
  return `{${entries.map(([dimension, value]) => `"${dimension}":${pythonFloatRepr(value)}`).join(",")}}`;
}

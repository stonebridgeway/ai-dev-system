export const UI_UX_PRO_MAX_DOMAINS = Object.freeze([
  "style",
  "color",
  "chart",
  "landing",
  "product",
  "ux",
  "typography",
  "icons",
  "gsap",
  "react",
  "web",
  "google-fonts"
]);

export const UI_UX_PRO_MAX_STACKS = Object.freeze([
  "react",
  "nextjs",
  "vue",
  "svelte",
  "astro",
  "swiftui",
  "react-native",
  "flutter",
  "nuxtjs",
  "nuxt-ui",
  "html-tailwind",
  "shadcn",
  "jetpack-compose",
  "threejs",
  "angular",
  "laravel",
  "javafx",
  "wpf",
  "winui",
  "avalonia",
  "uno",
  "uwp"
]);

const domainSet = new Set(UI_UX_PRO_MAX_DOMAINS);
const stackSet = new Set(UI_UX_PRO_MAX_STACKS);
const RUSSIAN_QUERY_HINTS = Object.freeze([
  [/доступн/iu, "accessibility"],
  [/фокус/iu, "focus"],
  [/клавиат/iu, "keyboard"],
  [/контраст/iu, "contrast"],
  [/форм/iu, "form"],
  [/навигац/iu, "navigation"],
  [/кноп/iu, "button"],
  [/типограф/iu, "typography"],
  [/шрифт/iu, "font"],
  [/цвет/iu, "color"],
  [/палитр/iu, "palette"],
  [/график|диаграм/iu, "chart"],
  [/икон/iu, "icon"],
  [/анимац|движен/iu, "motion animation"],
  [/адаптив|отзывчив/iu, "responsive"],
  [/мобильн/iu, "mobile"],
  [/настольн|десктоп/iu, "desktop"],
  [/таблиц/iu, "table"],
  [/загрузк/iu, "loading"],
  [/пуст.*состоян/iu, "empty state"],
  [/ошибк/iu, "error state"],
  [/лендинг/iu, "landing page"],
  [/интернет.*магазин|электронн.*торгов/iu, "ecommerce"],
  [/маркетплейс/iu, "marketplace"],
  [/дашборд|панел.*аналит/iu, "analytics dashboard"],
  [/админ/iu, "admin dashboard"],
  [/портфолио/iu, "portfolio"],
  [/мобильн.*приложен/iu, "mobile app"],
  [/саас/iu, "SaaS"],
  [/финтех|финанс/iu, "fintech finance"],
  [/медицин|здоров/iu, "healthcare"],
  [/образован/iu, "education"],
  [/недвижим/iu, "real estate"],
  [/ресторан|доставк.*ед/iu, "food restaurant"],
  [/аналитик/iu, "analytics"],
  [/безопасн/iu, "security"],
  [/корпоратив|предприяти/iu, "enterprise"],
  [/профессион/iu, "professional"],
  [/минимал/iu, "minimal"],
  [/премиум|премиаль|дорог|люкс/iu, "premium luxury"],
  [/современн/iu, "modern"],
  [/сдержан|спокойн/iu, "restrained"],
  [/ярк/iu, "vibrant"],
  [/темн/iu, "dark"],
  [/светл/iu, "light"],
  [/брутал/iu, "brutalist"],
  [/плотн/iu, "dense"],
  [/просторн/iu, "spacious"],
  [/конверси/iu, "conversion"]
]);

export function expandUiUxQuery(query) {
  if (!/[а-яё]/iu.test(query)) return query;
  const hints = [];
  for (const [pattern, keywords] of RUSSIAN_QUERY_HINTS) {
    if (pattern.test(query)) hints.push(keywords);
  }
  return hints.length ? `${query} ${[...new Set(hints)].join(" ")}` : query;
}

function boundedText(value, label, { required = true, maxLength } = {}) {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new Error(`${label} is required.`);
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized && required) {
    throw new Error(`${label} is required.`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${label} cannot contain a null byte.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function optionalEnum(value, label, allowed) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }
  return normalized;
}

function clampedInteger(value, { fallback, min, max, label }) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a number.`);
  }
  return Math.max(min, Math.min(Math.round(numeric), max));
}

export function normalizeUiUxKnowledgeInput({
  query,
  domain = "",
  stack = "",
  max_results = 3
} = {}) {
  const normalizedDomain = optionalEnum(domain, "domain", domainSet);
  const normalizedStack = optionalEnum(stack, "stack", stackSet);
  if (normalizedDomain && normalizedStack) {
    throw new Error("Choose either domain or stack, not both.");
  }
  const normalizedQuery = boundedText(query, "query", { maxLength: 500 });
  return {
    query: normalizedQuery,
    search_query: expandUiUxQuery(normalizedQuery),
    domain: normalizedDomain,
    stack: normalizedStack,
    max_results: clampedInteger(max_results, {
      fallback: 3,
      min: 1,
      max: 10,
      label: "max_results"
    })
  };
}

export function normalizeUiUxDesignInput({
  query,
  project_name = "",
  variance,
  motion,
  density
} = {}) {
  const normalizedQuery = boundedText(query, "query", { maxLength: 500 });
  return {
    query: normalizedQuery,
    search_query: expandUiUxQuery(normalizedQuery),
    project_name: boundedText(project_name, "project_name", {
      required: false,
      maxLength: 120
    }),
    variance: clampedInteger(variance, {
      fallback: null,
      min: 1,
      max: 10,
      label: "variance"
    }),
    motion: clampedInteger(motion, {
      fallback: null,
      min: 1,
      max: 10,
      label: "motion"
    }),
    density: clampedInteger(density, {
      fallback: null,
      min: 1,
      max: 10,
      label: "density"
    })
  };
}

export function buildUiUxKnowledgeArgs(input = {}) {
  const normalized = normalizeUiUxKnowledgeInput(input);
  const args = ["--json", "--max-results", String(normalized.max_results)];
  if (normalized.domain) args.push("--domain", normalized.domain);
  if (normalized.stack) args.push("--stack", normalized.stack);
  args.push("--", normalized.search_query);
  return { normalized, args };
}

function buildDesignArgs(input, format) {
  const normalized = normalizeUiUxDesignInput(input);
  const args = ["--design-system"];
  if (format === "json") args.push("--json");
  else args.push("--format", "markdown");
  if (normalized.project_name) {
    args.push("--project-name", normalized.project_name);
  }
  for (const name of ["variance", "motion", "density"]) {
    if (normalized[name] !== null) args.push(`--${name}`, String(normalized[name]));
  }
  args.push("--", normalized.search_query);
  return { normalized, args };
}

export function buildUiUxDesignJsonArgs(input = {}) {
  return buildDesignArgs(input, "json");
}

export function buildUiUxDesignMarkdownArgs(input = {}) {
  return buildDesignArgs(input, "markdown");
}

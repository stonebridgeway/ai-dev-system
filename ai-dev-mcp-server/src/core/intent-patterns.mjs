const BOUNDARY_LEFT = "(?<![\\p{L}\\p{N}_])";
const BOUNDARY_RIGHT = "(?![\\p{L}\\p{N}_])";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create a Unicode-aware intent matcher. Words must be whole tokens; stems may
 * continue with letters for inflected Russian terms.
 */
export function intentPattern({ words = [], stems = [] } = {}) {
  const parts = [
    ...words.map((term) => escapeRegExp(term).replaceAll(" ", "\\s+")),
    ...stems.map((term) => `${escapeRegExp(term)}\\p{L}*`)
  ];
  return new RegExp(`${BOUNDARY_LEFT}(?:${parts.join("|")})${BOUNDARY_RIGHT}`, "iu");
}

export const INTENT = Object.freeze({
  visual: intentPattern({
    words: ["ui", "ux", "frontend", "design", "figma", "responsive", "landing", "website", "portfolio", "mockup", "image", "visual", "brand", "logo", "redesign"],
    stems: ["сайт", "дизайн", "интерфейс", "лендинг", "бренд", "логотип", "мокап"]
  }),
  frontend: intentPattern({
    words: ["frontend", "front-end", "ui", "ux", "react", "next.js", "vue", "svelte", "vite", "tailwind", "layout", "component", "screen", "css", "button", "form", "modal"],
    stems: ["интерфейс", "фронт", "верстк", "экран", "компонент", "кнопк", "форм", "модал"]
  }),
  backend: intentPattern({
    words: ["api", "backend", "database", "queue", "worker", "celery", "fastapi", "sqlalchemy", "postgres", "redis", "bot", "telegram", "llm", "vision", "server"],
    stems: ["бэкенд", "сервер", "бот", "очеред"]
  }),
  landing: intentPattern({
    words: ["landing", "landing page", "conversion", "cro", "cta", "hero", "pricing", "marketing page", "sales page", "lead gen", "leadgen", "lead-gen", "waitlist", "signup", "offer", "funnel", "copywriting"],
    stems: ["лендинг", "конверс", "оффер", "продающ", "заявк", "тариф", "прайс", "лид", "вейтлист", "подпис"]
  }),
  quality: intentPattern({
    words: ["test", "lint", "typecheck", "quality", "gate", "ci", "coverage", "ruff", "pytest"],
    stems: ["провер", "тест", "качеств", "линт", "тайпчек", "безопасн"]
  }),
  support: intentPattern({
    words: ["beta", "staging", "support", "maintain", "maintenance", "existing app", "admin panel", "dashboard", "responsive bug", "layout bug", "ui bug", "frontend bug", "small fix", "polish ticket"],
    stems: ["бета", "стейдж", "поддерж", "саппорт", "админ", "панел", "дашборд", "адаптив", "поправ", "почин", "баг"]
  })
});

const FRONTEND_PRODUCT_DIRECT_PATTERN = intentPattern({
  words: ["frontend product", "product interface", "design-first", "anti-slop", "visual direction", "design system", "landing page"],
  stems: ["ии-слоп"]
});

export const FRONTEND_REFERENCE_PATTERN = /(?:reference\s+factory|(?:no|without)\s+(?:an?\s+)?(?:external\s+)?reference|generate\s+(?:visual\s+)?references?|(?:референс[а-я]*\s+нет)|(?:нет\s+референс[а-я]*)|(?:сгенерир[а-я]*\s+[^\n]{0,32}референс[а-я]*))/iu;

const FRONTEND_PRODUCT_ACTION = /(?<![\p{L}\p{N}_])(?:build|create|implement|design|redesign|improve|upgrade|сделай|создай|создать|разработай|сверстай|улучши)(?![\p{L}\p{N}_])[\s\S]{0,48}(?<![\p{L}\p{N}_])(?:frontend|front-end|interface|landing|website|page|дизайн\p{L}*|интерфейс\p{L}*|сайт\p{L}*|лендинг\p{L}*)(?![\p{L}\p{N}_])/iu;

export const FRONTEND_PRODUCT_PATTERN = new RegExp(
  `(?:${FRONTEND_PRODUCT_DIRECT_PATTERN.source}|${FRONTEND_PRODUCT_ACTION.source})`,
  "iu"
);

export function taskHasFrontendProductIntent(value) {
  return FRONTEND_PRODUCT_PATTERN.test(value) || FRONTEND_PRODUCT_ACTION.test(value);
}

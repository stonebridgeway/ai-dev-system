// Every word the interface shows, in English and Russian.
// The main process reads the same table for the tray. A test checks both
// languages have the same keys and the same {placeholders}.

import { EN } from "./messages-en.js";
import { RU } from "./messages-ru.js";

export const LANGUAGES = Object.freeze(["en", "ru"]);

export const MESSAGES = Object.freeze({ en: EN, ru: RU });

/** The language to show: a stored choice when it is one of ours, else the system's. */
export function pickLanguage(stored, systemLocale) {
  if (LANGUAGES.includes(stored)) return stored;
  return String(systemLocale ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** A message in `language`, its {placeholders} filled; the key itself when there is none. */
export function translate(language, key, params = {}) {
  const table = MESSAGES[language] ?? MESSAGES.en;
  const text = table[key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

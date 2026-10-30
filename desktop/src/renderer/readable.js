// A tool's answer, readable: objects as lists of names and values, arrays as
// lists, long or multi-line text as Markdown (markdown.js), the rest as text.
// Built with `h` (dom.js), so it is text only; a unit test runs it with a fake.
import { renderMarkdown } from "./markdown.js";

/** How many items of an array are shown, and how deep objects are opened. */
export const READABLE_LIMITS = Object.freeze({ items: 50, depth: 4, inlineText: 160 });

/**
 * @param {unknown} value
 * @param {(tag: string, attributes?: object, ...children: unknown[]) => unknown} h
 * @param {(key: string, params?: object) => string} t
 * @param {number} [depth]
 */
export function readableValue(value, h, t, depth = 0) {
  if (value === null || value === undefined) return h("span", { className: "muted" }, t("console.nothing"));
  if (typeof value === "string") {
    if (!value) return h("span", { className: "muted" }, t("console.emptyText"));
    if (value.includes("\n") || value.length > READABLE_LIMITS.inlineText) {
      return h("div", { className: "markdown" }, renderMarkdown(value, h, { headingOffset: 3 }));
    }
    return value;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= READABLE_LIMITS.depth) return h("code", {}, JSON.stringify(value));
  if (Array.isArray(value)) {
    if (!value.length) return h("span", { className: "muted" }, t("console.emptyList"));
    const shown = value.slice(0, READABLE_LIMITS.items).map((item) => h("li", {}, readableValue(item, h, t, depth + 1)));
    const rest = value.length - READABLE_LIMITS.items;
    return h("ol", { className: "readable-list" }, shown, rest > 0 ? h("li", { className: "muted" }, t("console.more", { count: rest })) : null);
  }
  const entries = Object.entries(value);
  if (!entries.length) return h("span", { className: "muted" }, t("console.emptyObject"));
  return h("dl", { className: "readable" }, entries.map(([key, item]) => [h("dt", {}, key), h("dd", {}, readableValue(item, h, t, depth + 1))]));
}

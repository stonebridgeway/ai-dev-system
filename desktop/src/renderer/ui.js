// What every data screen shows the same way: loading, an empty state, an
// error with Try again, a table, and numbers, money and dates in the page's
// language. Text from the daemon is only ever set as text (dom.js).
import { h } from "./dom.js";

/** The line a screen shows while it waits for the daemon. */
export function loadingLine(view) {
  return h("p", { className: "muted loading", role: "status", dataset: { state: "loading" } }, view.t("common.loading"));
}

/** What a screen shows when there is nothing to show, and why. */
export function emptyState(text, ...more) {
  return h("div", { className: "empty", dataset: { state: "empty" } }, h("p", {}, text), more);
}

/** A failed call: what went wrong, and a button that tries again. */
export function errorState(view, error, retry) {
  return h("div", { className: "error-state", role: "alert", dataset: { state: "error" } },
    h("p", { className: "error" }, view.t("common.error", { message: error?.message ?? String(error) })),
    retry ? h("button", { type: "button", className: "secondary", dataset: { action: "retry" }, on: { click: retry } }, view.t("common.retry")) : null);
}

/**
 * A table: `columns` are `{ label, value: (row) => text | Node, numeric? }`.
 *
 * @param {Array<{ label: string, value: (row: any) => unknown, numeric?: boolean }>} columns
 * @param {Array<any>} rows
 * @param {{ caption?: string, name?: string }} [options]
 */
export function dataTable(columns, rows, { caption, name } = {}) {
  return h("div", { className: "table-wrap" }, h("table", { className: "data", dataset: name ? { table: name } : undefined },
    caption ? h("caption", {}, caption) : null,
    h("thead", {}, h("tr", {}, columns.map((column) => h("th", { scope: "col", className: column.numeric ? "numeric" : undefined }, column.label)))),
    h("tbody", {}, rows.map((row) => h("tr", {}, columns.map((column) => h("td", { className: column.numeric ? "numeric" : undefined }, column.value(row))))))));
}

const locale = (language) => (language === "ru" ? "ru-RU" : "en-US");

/** 12000 → "12,000" (en) or "12 000" (ru). */
export function formatNumber(value, language) {
  return new Intl.NumberFormat(locale(language), { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

/** 0.42 → "$0.42"; amounts under a cent keep four digits. */
export function formatMoney(value, language) {
  const amount = Number(value) || 0;
  const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(locale(language), { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/** An ISO time as a date and time in the page's language; the text itself when it is not one. */
export function formatDate(value, language) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return String(value ?? "");
  return new Intl.DateTimeFormat(locale(language), { dateStyle: "medium", timeStyle: "short" }).format(time);
}

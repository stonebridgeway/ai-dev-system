/**
 * Progress events — from the model download, a copy, a check, the embedding of
 * the documents — as the line a person watches.
 *
 * Before this the download printed "downloading model_int8.onnx" and then
 * nothing for ten minutes, which is what a stalled CDN looks like too.
 * In a terminal the line is rewritten in place;
 * into a log or a pipe it is printed at most every few seconds and whenever
 * the file or the phase changes, so CI output stays readable.
 */
import { formatBytes } from "./disk-space.mjs";

/** How often a line goes to a log that is not a terminal. */
export const LOG_PROGRESS_INTERVAL_MS = 5_000;

/**
 * A duration as a person would say it.
 *
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * One progress event as one line.
 *
 * @param {object} event - `{ phase, file?, bytes?, total?, speed?, etaSeconds?, done? }`.
 * @returns {string}
 */
export function describeProgress(event = {}) {
  const left = formatDuration(event.etaSeconds);
  const share = (done, whole) => (Number(whole) > 0 ? ` (${Math.floor((Number(done) / Number(whole)) * 100)}%)` : "");
  const of = (done, whole) => `${formatBytes(done)}${Number(whole) > 0 ? ` of ${formatBytes(whole)}` : ""}${share(done, whole)}`;
  switch (event.phase) {
    case "downloading":
      return [`${event.file || "model"}  ${of(event.bytes, event.total)}`, event.speed > 0 ? `${formatBytes(event.speed)}/s` : "", left ? `${left} left` : ""]
        .filter(Boolean).join(" · ");
    case "verifying":
      return `checking ${event.file || "model"}  ${of(event.bytes, event.total)}`;
    case "importing":
      return `copying ${event.file || "model"}  ${of(event.bytes, event.total)}`;
    case "indexing":
      return `indexing ${event.done ?? 0} of ${event.total ?? 0} document(s)${share(event.done ?? 0, event.total)}`;
    case "embedding":
      return [`embedding ${event.done ?? 0} of ${event.total ?? 0} document(s)${share(event.done ?? 0, event.total)}`, left ? `${left} left` : ""]
        .filter(Boolean).join(" · ");
    case "done":
      return `${formatBytes(event.bytes ?? 0)} in place`;
    default:
      return String(event.phase ?? "");
  }
}

/**
 * A printer of progress events.
 *
 * @param {object} [options]
 * @param {{ write: (text: string) => void, isTTY?: boolean, columns?: number }} [options.stream]
 * @param {string} [options.indent]
 * @param {() => number} [options.now]
 * @returns {((event: object) => void) & { end: () => void }}
 */
export function createProgressPrinter({ stream = process.stdout, indent = "   ", now = Date.now } = {}) {
  const live = Boolean(stream.isTTY);
  let shown = "";
  let lastAt = -Infinity;
  let lastKey = "";
  const print = (event) => {
    const line = `${indent}${describeProgress(event)}`;
    if (live) {
      const width = Math.max(20, (stream.columns || 100) - 1);
      const fitted = line.length > width ? `${line.slice(0, width - 1)}…` : line;
      stream.write(`\r${fitted.padEnd(Math.max(shown.length, fitted.length))}`);
      shown = fitted;
      return;
    }
    const key = `${event.phase}:${event.file ?? ""}`;
    if (key === lastKey && event.phase !== "done" && now() - lastAt < LOG_PROGRESS_INTERVAL_MS) return;
    lastKey = key;
    lastAt = now();
    stream.write(`${line}\n`);
  };
  print.end = () => {
    if (live && shown) stream.write("\n");
    shown = "";
  };
  return print;
}

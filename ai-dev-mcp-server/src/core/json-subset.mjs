/**
 * Reading a few named keys out of a large JSON file without holding it.
 *
 * `~/.claude.json` is the reason this exists. Two keys in it declare
 * user-scope MCP servers — `mcpServers` and `projects[<path>].mcpServers` — and
 * the same file is where Claude Code keeps the conversation history for every
 * project it has ever opened, which on an active machine is tens of megabytes
 * (docs/ecc-upgrades/DEBTS.md, Д-17). `JSON.parse` of the whole document to
 * reach two keys is the wrong amount of work and the wrong amount of memory,
 * and the parsed history sits in the heap for as long as the call lasts.
 *
 * So the file is streamed and only the wanted values are buffered. The scanner
 * tracks where it is — a path of object keys — and copies characters only while
 * that path matches something the caller asked for. Everything else is counted
 * and dropped.
 *
 * It is a scanner, not a validator: a file that is not JSON yields whatever it
 * could recognise plus an error, which is exactly what a report wants. The
 * values it does return went through `JSON.parse`, so they are either valid or
 * absent.
 *
 * One shape of broken file it does recognise, because the alternative is worse
 * than saying nothing: a document that stops in the middle. Nesting is counted
 * as the scan goes, so a file whose last character leaves an object or a string
 * open ends with an error rather than with an empty result — "this file is cut
 * off", not "this file declares no servers" (Д-25).
 */
import { createReadStream } from "node:fs";

/** Longest single value the scanner will buffer. */
export const MAX_SUBSET_VALUE_BYTES = 4 * 1024 * 1024;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function pathMatches(path, pattern) {
  if (path.length !== pattern.length) return false;
  return pattern.every((segment, index) => segment === "*" || segment === path[index]);
}

/**
 * A character-at-a-time scanner that keeps only the values whose key path
 * matches one of `patterns`.
 *
 * `patterns` are arrays of object keys, with `"*"` for "any key at this level":
 * `[["mcpServers"], ["projects", "*", "mcpServers"]]`.
 *
 * @param {string[][]} patterns
 * @param {{ maxValueBytes?: number }} [options]
 * @returns {{ push: (chunk: string) => void, finish: () => { values: Array<{ path: string[], value: unknown }>, bytes: number, truncated: string[], errors: string[], root: string } }}
 */
export function createJsonSubsetScanner(patterns, { maxValueBytes = MAX_SUBSET_VALUE_BYTES } = {}) {
  const stack = [];
  const values = [];
  const truncated = [];
  const errors = [];
  let bytes = 0;
  let expectKey = false;
  let inString = false;
  let escaped = false;
  let readingKey = false;
  let keyBuffer = "";
  let capture = null;
  // The document's first non-whitespace character. The scanner does not
  // validate, so this is the one cheap check a caller can make: a file whose
  // first character is not `{` is not the object it was looking for.
  let root = "";

  // The path of the value about to be read: the key of every open object frame,
  // outermost first. An array frame, and an object frame whose key has not been
  // read yet, contribute `*`, which no pattern position can match as a target —
  // so a value inside an array is never captured, only a named key is.
  const currentPath = () => stack.map((frame) => frame.key ?? "*");

  const startCapture = (kind) => {
    if (capture) return;
    const path = currentPath();
    if (!path.length || path.at(-1) === "*") return;
    if (!patterns.some((pattern) => pathMatches(path, pattern))) return;
    capture = { path, depth: stack.length, kind, text: "" };
  };

  const append = (char) => {
    if (!capture) return;
    if (capture.text.length >= maxValueBytes) {
      truncated.push(capture.path.join("."));
      capture = null;
      return;
    }
    capture.text += char;
  };

  const endCapture = () => {
    const finished = capture;
    capture = null;
    const text = finished.text.trim();
    if (!text) return;
    try {
      values.push({ path: finished.path, value: JSON.parse(text) });
    } catch (error) {
      errors.push(`${finished.path.join(".")}: ${error?.message ?? error}`);
    }
  };

  return {
    push(chunk) {
      const text = String(chunk);
      bytes += text.length;
      for (const char of text) {
        if (!root && !WHITESPACE.has(char)) root = char;
        if (inString) {
          append(char);
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "\"") {
            inString = false;
            if (readingKey) {
              readingKey = false;
              if (stack.length) stack.at(-1).key = keyBuffer;
              keyBuffer = "";
              expectKey = false;
            } else if (capture?.kind === "string") {
              endCapture();
            }
          } else if (readingKey) {
            keyBuffer += char;
          }
          continue;
        }
        if (char === "\"") {
          inString = true;
          escaped = false;
          if (expectKey) {
            readingKey = true;
            keyBuffer = "";
          } else {
            startCapture("string");
          }
          // A key's opening quote belongs to the captured object's text too.
          append(char);
          continue;
        }
        if (char === "{" || char === "[") {
          startCapture(char === "{" ? "object" : "array");
          append(char);
          stack.push({ type: char === "{" ? "object" : "array", key: null });
          expectKey = char === "{";
          continue;
        }
        if (char === "}" || char === "]") {
          // A scalar has no frame of its own, so the container closing is what
          // ends it, and the brace is not part of its text.
          if (capture?.kind === "scalar" && stack.length === capture.depth) endCapture();
          stack.pop();
          expectKey = false;
          append(char);
          if (capture && stack.length <= capture.depth) endCapture();
          continue;
        }
        if (char === ",") {
          if (capture?.kind === "scalar" && stack.length === capture.depth) endCapture();
          append(char);
          expectKey = stack.at(-1)?.type === "object";
          if (expectKey && stack.length) stack.at(-1).key = null;
          continue;
        }
        if (char === ":") {
          append(char);
          continue;
        }
        if (WHITESPACE.has(char)) {
          if (capture?.kind === "scalar") endCapture();
          else append(char);
          continue;
        }
        startCapture("scalar");
        append(char);
      }
    },
    finish() {
      if (capture) {
        if (capture.kind === "scalar") endCapture();
        else truncated.push(capture.path.join("."));
      }
      if (inString || stack.length) {
        const open = stack.length ? `${stack.length} unclosed ${stack.length === 1 ? "value" : "values"}` : "";
        const string = inString ? "an unterminated string" : "";
        errors.push(`the document ends in the middle, with ${[open, string].filter(Boolean).join(" and ")}: the file is cut off or still being written, so what it holds is unknown rather than absent`);
      }
      return { values, bytes, truncated, errors, root };
    }
  };
}

/**
 * Read the values at the given key paths out of a JSON file.
 *
 * @param {string} filePath
 * @param {string[][]} patterns - See {@link createJsonSubsetScanner}.
 * @param {{ maxValueBytes?: number, highWaterMark?: number }} [options]
 * @returns {Promise<{ found: Array<{ path: string[], value: unknown }>, bytes: number, truncated: string[], errors: string[], root: string, exists: boolean }>}
 */
export async function readJsonSubset(filePath, patterns, { maxValueBytes, highWaterMark = 256 * 1024 } = {}) {
  const scanner = createJsonSubsetScanner(patterns, { maxValueBytes });
  try {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark });
    for await (const chunk of stream) scanner.push(chunk);
  } catch (error) {
    if (error?.code === "ENOENT") return { found: [], bytes: 0, truncated: [], errors: [], root: "", exists: false };
    const { values, bytes, truncated, errors, root } = scanner.finish();
    return { found: values, bytes, truncated, root, errors: [...errors, String(error?.message ?? error)], exists: true };
  }
  const { values, bytes, truncated, errors, root } = scanner.finish();
  return { found: values, bytes, truncated, errors, root, exists: true };
}

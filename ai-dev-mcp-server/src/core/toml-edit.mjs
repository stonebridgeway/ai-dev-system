/**
 * Tables of a TOML document found, replaced and removed as text.
 *
 * Codex keeps its MCP servers in `~/.codex/config.toml`, next to everything
 * else it is configured with, and people edit that file by hand: comments,
 * other servers, profiles. A server there is a table, `[mcp_servers.<name>]`,
 * plus any subtables of it (`[mcp_servers.<name>.env]`), with the name in any
 * spelling TOML allows (`ai-dev`, `"ai-dev"`, `'ai-dev'`). Those tables are
 * replaced or cut out; every other line stays exactly as it was.
 *
 * Treating the header as a pattern, as the Docker installer did, missed both
 * the subtables and the quoted spellings and wrote a second definition beside
 * them — a file Codex then refused to read at all, losing every server in it.
 *
 * The scan follows strings, multi-line strings and multi-line arrays, so a `[`
 * inside a value is never taken for a header. Values are not validated: the
 * file is Codex's to parse, and what is read here is what finding the tables
 * needs.
 */

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\", e: "\u001b" };

/** The document cannot be read as TOML at the line named. */
export class TomlEditError extends SyntaxError {
  /**
   * @param {string} message
   * @param {number} line
   */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = "TomlEditError";
    this.line = line;
  }
}

/**
 * @typedef {object} TomlTable
 * @property {string[]} path - The header's key, decoded.
 * @property {boolean} array - `[[…]]` rather than `[…]`.
 * @property {number} start - Offset where the header's line begins.
 * @property {number} end - Offset just past the table's last line with content
 *   (blank and comment-only lines that follow belong to whatever comes next).
 */

/**
 * @typedef {object} TomlKey
 * @property {string[]} table - The table the key is written in.
 * @property {string[]} path - The key as written, decoded (dotted keys give several parts).
 * @property {number} line
 */

function decodeBasic(raw) {
  return raw.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g, (whole, short, long, single) => {
    if (short || long) return String.fromCodePoint(Number.parseInt(short || long, 16));
    return ESCAPES[single] ?? whole;
  });
}

/** Index just past the closing quote of a one-line basic string that opens at `at`. */
function skipBasic(text, at, end, line) {
  for (let index = at + 1; index < end; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "\"") return index + 1;
  }
  throw new TomlEditError("a string is never closed", line);
}

function skipLiteral(text, at, end, line) {
  const close = text.indexOf("'", at + 1);
  if (close < 0 || close >= end) throw new TomlEditError("a string is never closed", line);
  return close + 1;
}

/** Index just past a multi-line string's closing delimiter, or -1 when it is not on this line. */
function closeMultiline(text, at, end, delimiter) {
  let from = at;
  for (;;) {
    const found = text.indexOf(delimiter, from);
    if (found < 0 || found >= end) return -1;
    if (delimiter === "\"\"\"") {
      let backslashes = 0;
      for (let index = found - 1; index >= at && text[index] === "\\"; index -= 1) backslashes += 1;
      if (backslashes % 2 === 1) {
        from = found + 1;
        continue;
      }
    }
    // Up to two quotes may sit inside the string right before the delimiter.
    let close = found + 3;
    for (let extra = 0; extra < 2 && text[close] === delimiter[0]; extra += 1) close += 1;
    return close;
  }
}

/**
 * Read a dotted key starting at `at`: bare, "basic" and 'literal' parts, with
 * whitespace around the dots. Stops before whatever follows the key.
 */
function readKey(text, at, end, line) {
  const parts = [];
  let index = at;
  for (;;) {
    while (text[index] === " " || text[index] === "\t") index += 1;
    const char = text[index];
    if (char === "\"") {
      const close = skipBasic(text, index, end, line);
      parts.push(decodeBasic(text.slice(index + 1, close - 1)));
      index = close;
    } else if (char === "'") {
      const close = skipLiteral(text, index, end, line);
      parts.push(text.slice(index + 1, close - 1));
      index = close;
    } else {
      BARE_KEY.lastIndex = index;
      const match = BARE_KEY.exec(text);
      if (!match || match.index !== index) throw new TomlEditError("expected a key", line);
      parts.push(match[0]);
      index += match[0].length;
    }
    while (text[index] === " " || text[index] === "\t") index += 1;
    if (text[index] !== ".") return { parts, after: index };
    index += 1;
  }
}

/**
 * Find every table and every top-level key of a TOML document.
 *
 * @param {string} text
 * @returns {{ tables: TomlTable[], keys: TomlKey[], eol: string }}
 * @throws {TomlEditError} When a string or a header is never closed.
 */
export function scanToml(text) {
  const tables = [];
  const keys = [];
  let tablePath = [];
  let current = null;
  let multiline = null;
  let depth = 0;
  let line = 0;
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (position < text.length) {
    line += 1;
    const newline = text.indexOf("\n", position);
    const end = newline < 0 ? text.length : newline + 1;
    let content = multiline !== null || depth > 0;
    let at = position;
    while (at < end) {
      if (multiline) {
        const close = closeMultiline(text, at, end, multiline);
        if (close < 0) {
          at = end;
          break;
        }
        multiline = null;
        at = close;
        continue;
      }
      const char = text[at];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        at += 1;
        continue;
      }
      if (char === "#") break;
      if (!content) {
        // The first thing on a line that does not continue a value: a header or a key.
        content = true;
        if (char === "[") {
          const array = text[at + 1] === "[";
          const key = readKey(text, at + (array ? 2 : 1), end, line);
          const closing = array ? "]]" : "]";
          if (!text.startsWith(closing, key.after)) throw new TomlEditError("a table header is never closed", line);
          current = { path: key.parts, array, start: position, end };
          tables.push(current);
          tablePath = key.parts;
          at = key.after + closing.length;
          continue;
        }
        const key = readKey(text, at, end, line);
        if (text[key.after] !== "=") throw new TomlEditError("expected '=' after a key", line);
        keys.push({ table: tablePath, path: key.parts, line });
        at = key.after + 1;
        continue;
      }
      if (text.startsWith("\"\"\"", at) || text.startsWith("'''", at)) {
        multiline = text.slice(at, at + 3);
        at += 3;
        continue;
      }
      if (char === "\"") at = skipBasic(text, at, end, line);
      else if (char === "'") at = skipLiteral(text, at, end, line);
      else {
        if (char === "[" || char === "{") depth += 1;
        else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
        at += 1;
      }
    }
    if (content && current) current.end = end;
    position = end;
  }
  if (multiline) throw new TomlEditError("a multi-line string is never closed", line);
  return { tables, keys, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function startsWith(path, prefix) {
  return prefix.every((part, index) => path[index] === part);
}

/**
 * Where `prefix` is defined other than by tables of its own: a dotted key
 * (`mcp_servers.ai-dev.command = …`), an inline table inside `[mcp_servers]`,
 * or an inline table holding all of it (`mcp_servers = { … }`). Such a file
 * cannot take a table for the same name, and is not rewritten.
 *
 * @param {{ keys: TomlKey[] }} scan
 * @param {string[]} prefix
 * @returns {TomlKey[]}
 */
export function inlineDefinitions(scan, prefix) {
  return scan.keys.filter((key) => {
    if (startsWith(key.table, prefix)) return false;
    const full = [...key.table, ...key.path];
    return startsWith(full, prefix) || startsWith(prefix, full);
  });
}

/**
 * The tables of `prefix` and its subtables.
 *
 * @param {{ tables: TomlTable[] }} scan
 * @param {string[]} prefix
 * @returns {TomlTable[]}
 */
export function tablesUnder(scan, prefix) {
  return scan.tables.filter((table) => startsWith(table.path, prefix));
}

/** A key as a header or an assignment spells it: bare when it can be. */
export function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A basic string, with everything TOML forbids raw escaped. */
export function tomlString(value) {
  return `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    const named = { "\\": "\\\\", "\"": "\\\"", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" }[char];
    return named ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  })}"`;
}

/** A value as TOML: strings, finite numbers, booleans, arrays and inline tables. */
export function tomlValue(value) {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  throw new TypeError(`TOML has no way to write ${value === null ? "null" : typeof value}.`);
}

/**
 * A table: its header, then one `key = value` line per defined value.
 *
 * @param {string[]} path
 * @param {Record<string, unknown>} values
 * @param {string} [eol]
 * @returns {string} Ending with `eol`.
 */
export function renderTable(path, values, eol = "\n") {
  const lines = [`[${path.map(tomlKey).join(".")}]`];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  }
  return `${lines.join(eol)}${eol}`;
}

function refuseInline(scan, prefix) {
  const [inline] = inlineDefinitions(scan, prefix);
  if (inline) {
    const written = [...inline.table, ...inline.path].map(tomlKey).join(".");
    throw new TomlEditError(`${written} is written as a key, not as a [${prefix.map(tomlKey).join(".")}] table; `
      + "this file is left as it is — move it into that table by hand", inline.line);
  }
}

/** Only spaces, tabs and line breaks: a byte order mark is not blank. */
const BLANK = /^[ \t\r\n]*$/;

/**
 * A table's span with one blank line that separated it: the one in front of
 * it (the one an append puts there), or else the one after it. A byte order
 * mark belongs to the file, not to its first line, and stays.
 */
function spanWithBlank(text, table) {
  const first = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (table.start > first) {
    const previous = Math.max(first, text.lastIndexOf("\n", table.start - 2) + 1);
    if (BLANK.test(text.slice(previous, table.start))) return [previous, table.end];
  }
  const newline = text.indexOf("\n", table.end);
  const next = newline < 0 ? text.length : newline + 1;
  if (table.end < text.length && BLANK.test(text.slice(table.end, next))) return [table.start, next];
  return [table.start, table.end];
}

/**
 * The text with each span, `[start, end, insert]` in the original's offsets,
 * replaced. Two tables in a row can both claim the blank line between them;
 * the spans then overlap and are taken as one. Cut one at a time, the second
 * cut used offsets the first had already moved and ate the first character of
 * whatever followed — the `[` of the next header.
 */
function cut(text, spans) {
  let result = "";
  let at = 0;
  for (const [start, end, insert = ""] of [...spans].sort((left, right) => left[0] - right[0])) {
    result += text.slice(at, Math.max(at, start)) + insert;
    at = Math.max(at, end);
  }
  return result + text.slice(at);
}

/** Every table and key outside `prefix`, in order: what an edit must not touch. */
function foreignShape(scan, prefix) {
  return JSON.stringify([
    scan.tables.filter((table) => !startsWith(table.path, prefix)).map((table) => [table.path, table.array]),
    scan.keys.filter((key) => !startsWith(key.table, prefix)).map((key) => [key.table, key.path])
  ]);
}

/** The tables and keys of `prefix`, in order. */
function ownShape(scan, prefix) {
  return JSON.stringify([
    tablesUnder(scan, prefix).map((table) => [table.path, table.array]),
    scan.keys.filter((key) => startsWith(key.table, prefix)).map((key) => [key.table, key.path])
  ]);
}

/**
 * The edited text, read again before anyone writes it: it must still scan,
 * keep every table and key outside `prefix` as it was, and hold under
 * `prefix` exactly what the edit put there. A file that fails is never
 * written — a `config.toml` Codex cannot read loses every server in it.
 */
function verified(text, scan, edited, prefix, section) {
  const line = text.slice(0, tablesUnder(scan, prefix)[0]?.start ?? 0).split("\n").length;
  let after;
  try {
    after = scanToml(edited);
  } catch (error) {
    throw new TomlEditError(`editing [${prefix.map(tomlKey).join(".")}] here would leave a file that cannot be read `
      + `(${error.message}); this file is left as it is`, line);
  }
  const expected = section ? ownShape(scanToml(section), prefix) : ownShape({ tables: [], keys: [] }, prefix);
  if (foreignShape(after, prefix) !== foreignShape(scan, prefix) || ownShape(after, prefix) !== expected) {
    throw new TomlEditError(`editing [${prefix.map(tomlKey).join(".")}] here would change other tables; `
      + "this file is left as it is", line);
  }
  return edited;
}

/**
 * Put `section` in place of the tables of `prefix`, where the first of them
 * stood, or after everything else, one blank line down, when there are none.
 *
 * @param {string} text
 * @param {string[]} prefix
 * @param {string} section - A rendered table ending with a line break.
 * @returns {string}
 */
export function upsertTables(text, prefix, section) {
  const scan = scanToml(text);
  refuseInline(scan, prefix);
  const [first, ...rest] = tablesUnder(scan, prefix);
  if (!first) {
    let head = text;
    if (head && !head.endsWith("\n")) head += scan.eol;
    if (head.trim()) head += scan.eol;
    return verified(text, scan, `${head}${section}`, prefix, section);
  }
  return verified(text, scan, cut(text, [[first.start, first.end, section], ...rest.map((table) => spanWithBlank(text, table))]), prefix, section);
}

/**
 * Cut the tables of `prefix` out. Text without them comes back unchanged.
 *
 * @param {string} text
 * @param {string[]} prefix
 * @returns {string}
 */
export function removeTables(text, prefix) {
  const scan = scanToml(text);
  refuseInline(scan, prefix);
  const tables = tablesUnder(scan, prefix);
  if (!tables.length) return text;
  return verified(text, scan, cut(text, tables.map((table) => spanWithBlank(text, table))), prefix);
}

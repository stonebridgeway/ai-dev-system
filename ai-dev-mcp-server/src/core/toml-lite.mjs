/**
 * A small TOML reader for agent configuration files.
 *
 * Codex keeps its MCP servers in `~/.codex/config.toml` (`[mcp_servers.<name>]`
 * with `command`, `args` and an inline `env` table), so reading the inventory of
 * a project's servers means reading TOML. The server ships two dependencies and
 * pins both exactly; a parser for the subset those files actually use is
 * smaller than the review a third one would need.
 *
 * Supported: comments, `[table]` and `[[array of tables]]` headers, dotted keys,
 * basic and literal strings (single- and triple-quoted), integers, floats,
 * booleans, arrays, and inline tables. Dates are kept as their raw text, since
 * nothing here compares them.
 *
 * Not supported, and reported as a warning with the line number rather than
 * thrown: anything else. A file that trips one keeps the keys it parsed, so a
 * config with an exotic section still yields its server list.
 */

const FAILED = Symbol("toml-lite:failed");
const BARE_KEY = /^[A-Za-z0-9_-]+/;
const INTEGER = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d+)?$/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };

/**
 * Parse a TOML document.
 *
 * @param {string} input
 * @returns {{ data: object, warnings: string[] }}
 */
export function parseTomlLite(input) {
  const source = String(input ?? "").replace(/\r\n/g, "\n");
  const data = {};
  const warnings = [];
  let index = 0;
  let current = data;

  const lineOf = (position) => source.slice(0, position).split("\n").length;
  const warn = (position, message) => {
    if (warnings.length < 20) warnings.push(`line ${lineOf(position)}: ${message}`);
  };
  const skipInlineSpace = () => {
    while (index < source.length && (source[index] === " " || source[index] === "\t")) index += 1;
  };
  const skipToLineEnd = () => {
    while (index < source.length && source[index] !== "\n") index += 1;
  };
  const skipBlank = () => {
    for (;;) {
      while (index < source.length && /\s/.test(source[index])) index += 1;
      if (source[index] !== "#") return;
      skipToLineEnd();
    }
  };

  function readQuoted(quote) {
    const triple = source.startsWith(quote.repeat(3), index);
    const terminator = triple ? quote.repeat(3) : quote;
    index += terminator.length;
    if (triple && source[index] === "\n") index += 1;
    let value = "";
    while (index < source.length) {
      if (source.startsWith(terminator, index)) {
        index += terminator.length;
        return value;
      }
      const char = source[index];
      if (!triple && char === "\n") break;
      if (quote === "\"" && char === "\\") {
        const next = source[index + 1];
        if (next in ESCAPES) {
          value += ESCAPES[next];
          index += 2;
          continue;
        }
        if (next === "u" || next === "U") {
          const width = next === "u" ? 4 : 8;
          const digits = source.slice(index + 2, index + 2 + width);
          const code = Number.parseInt(digits, 16);
          if (digits.length === width && Number.isFinite(code)) {
            value += String.fromCodePoint(code);
            index += 2 + width;
            continue;
          }
        }
        if (triple && next === "\n") {
          index += 2;
          while (index < source.length && /\s/.test(source[index])) index += 1;
          continue;
        }
      }
      value += char;
      index += 1;
    }
    warn(index, "unterminated string");
    return FAILED;
  }

  function readKeyPath(stop) {
    const parts = [];
    for (;;) {
      skipInlineSpace();
      const char = source[index];
      if (char === "\"" || char === "'") {
        const part = readQuoted(char);
        if (part === FAILED) return FAILED;
        parts.push(part);
      } else {
        const bare = BARE_KEY.exec(source.slice(index));
        if (!bare) {
          warn(index, `expected a key before ${JSON.stringify(source[index] ?? "end of file")}`);
          return FAILED;
        }
        parts.push(bare[0]);
        index += bare[0].length;
      }
      skipInlineSpace();
      if (source[index] === ".") {
        index += 1;
        continue;
      }
      if (stop && source[index] !== stop && source[index] !== "=") {
        warn(index, `expected "${stop}" after the key`);
        return FAILED;
      }
      return parts;
    }
  }

  function readValue() {
    skipInlineSpace();
    const char = source[index];
    if (char === "\"" || char === "'") return readQuoted(char);
    if (char === "[") return readArray();
    if (char === "{") return readInlineTable();
    if (source.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (source.startsWith("false", index)) {
      index += 5;
      return false;
    }
    const start = index;
    while (index < source.length && !",]}\n#".includes(source[index])) index += 1;
    const raw = source.slice(start, index).trim();
    if (!raw) {
      warn(start, "missing value");
      return FAILED;
    }
    if (INTEGER.test(raw)) return Number.parseInt(raw.replaceAll("_", ""), 10);
    if (FLOAT.test(raw)) return Number.parseFloat(raw.replaceAll("_", ""));
    return raw;
  }

  function readArray() {
    index += 1;
    const items = [];
    for (;;) {
      skipBlank();
      if (index >= source.length) {
        warn(index, "unterminated array");
        return FAILED;
      }
      if (source[index] === "]") {
        index += 1;
        return items;
      }
      const value = readValue();
      if (value === FAILED) return FAILED;
      items.push(value);
      skipBlank();
      if (source[index] === ",") index += 1;
      else if (source[index] !== "]") {
        warn(index, "expected \",\" or \"]\" in an array");
        return FAILED;
      }
    }
  }

  function readInlineTable() {
    index += 1;
    const table = {};
    for (;;) {
      skipBlank();
      if (index >= source.length) {
        warn(index, "unterminated inline table");
        return FAILED;
      }
      if (source[index] === "}") {
        index += 1;
        return table;
      }
      const parts = readKeyPath("=");
      if (parts === FAILED) return FAILED;
      skipInlineSpace();
      if (source[index] !== "=") {
        warn(index, "expected \"=\" in an inline table");
        return FAILED;
      }
      index += 1;
      const value = readValue();
      if (value === FAILED) return FAILED;
      assign(table, parts, value);
      skipBlank();
      if (source[index] === ",") index += 1;
      else if (source[index] !== "}") {
        warn(index, "expected \",\" or \"}\" in an inline table");
        return FAILED;
      }
    }
  }

  function container(root, parts) {
    let node = root;
    for (const part of parts) {
      const existing = node[part];
      if (Array.isArray(existing)) node = existing[existing.length - 1];
      else if (existing && typeof existing === "object") node = existing;
      else {
        node[part] = {};
        node = node[part];
      }
    }
    return node;
  }

  function assign(root, parts, value) {
    const node = container(root, parts.slice(0, -1));
    node[parts[parts.length - 1]] = value;
  }

  function readTableHeader() {
    const start = index;
    const arrayTable = source.startsWith("[[", index);
    index += arrayTable ? 2 : 1;
    const parts = readKeyPath("]");
    if (parts === FAILED) {
      current = {};
      skipToLineEnd();
      return;
    }
    const closing = arrayTable ? "]]" : "]";
    if (!source.startsWith(closing, index)) {
      warn(start, "unterminated table header");
      current = {};
      skipToLineEnd();
      return;
    }
    index += closing.length;
    if (arrayTable) {
      const parent = container(data, parts.slice(0, -1));
      const key = parts[parts.length - 1];
      if (!Array.isArray(parent[key])) parent[key] = [];
      const entry = {};
      parent[key].push(entry);
      current = entry;
      return;
    }
    current = container(data, parts);
  }

  while (index < source.length) {
    skipBlank();
    if (index >= source.length) break;
    if (source[index] === "[") {
      readTableHeader();
      continue;
    }
    const parts = readKeyPath("=");
    if (parts === FAILED) {
      skipToLineEnd();
      continue;
    }
    skipInlineSpace();
    if (source[index] !== "=") {
      warn(index, "expected \"=\" after the key");
      skipToLineEnd();
      continue;
    }
    index += 1;
    const value = readValue();
    if (value === FAILED) {
      skipToLineEnd();
      continue;
    }
    assign(current, parts, value);
    skipInlineSpace();
    if (index < source.length && source[index] !== "\n" && source[index] !== "#") {
      warn(index, `ignored trailing text after the value: ${JSON.stringify(source.slice(index, index + 20))}`);
      skipToLineEnd();
    }
  }

  return { data, warnings };
}

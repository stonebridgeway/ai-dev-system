/**
 * One member of one object in a JSON or JSONC document, set or removed as text.
 *
 * The files MCP clients keep their servers in are written by people and by the
 * clients themselves. VS Code and Gemini CLI accept comments and trailing
 * commas; `~/.claude.json` runs to tens of megabytes and holds all of Claude
 * Code's state. Parsing such a file and printing it back drops the comments and
 * reflows the rest, so here the document stays text: the member asked for is
 * inserted, replaced or cut out, and every other byte stays where it was.
 *
 * Inserting a member and then removing it gives back the original text, so an
 * install followed by a removal leaves no trace in a file that holds other
 * servers.
 *
 * The scan validates the whole document (a broken file is refused, not
 * half-edited) but only builds a description of the objects on the path asked
 * for; everything else is skipped without being materialised.
 */

const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 512;

/** The document is not JSON or JSONC at the place named. */
export class JsoncSyntaxError extends SyntaxError {
  /**
   * @param {string} message
   * @param {number} offset
   */
  constructor(message, offset) {
    super(message);
    this.name = "JsoncSyntaxError";
    this.offset = offset;
  }
}

function lineAndColumn(text, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * @typedef {object} MemberInfo
 * @property {string} key
 * @property {number} keyStart - Offset of the opening quote of the name.
 * @property {number} valueStart
 * @property {number} valueEnd - Offset just past the value.
 * @property {number} [comma] - Offset of the comma after the value, if any.
 * @property {string} type - "object", "array", "string", "number", "boolean" or "null".
 * @property {ObjectInfo} [object] - Described when the member lies on the path asked for.
 */

/**
 * @typedef {object} ObjectInfo
 * @property {number} open - Offset of `{`.
 * @property {number} close - Offset of `}`.
 * @property {MemberInfo[]} members
 */

class Scanner {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  fail(message, offset = this.at) {
    const { line, column } = lineAndColumn(this.text, offset);
    throw new JsoncSyntaxError(`line ${line}, column ${column}: ${message}`, offset);
  }

  /** Skip whitespace and comments. */
  space() {
    const text = this.text;
    while (this.at < text.length) {
      const code = text.charCodeAt(this.at);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        this.at += 1;
      } else if (code === 47 && text.charCodeAt(this.at + 1) === 47) {
        let end = this.at + 2;
        while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
        this.at = end;
      } else if (code === 47 && text.charCodeAt(this.at + 1) === 42) {
        const end = text.indexOf("*/", this.at + 2);
        if (end < 0) this.fail("a /* comment is never closed");
        this.at = end + 2;
      } else {
        return;
      }
    }
  }

  /** Read a string at the cursor and return its value. */
  string() {
    const start = this.at;
    let from = start + 1;
    for (;;) {
      const quote = this.text.indexOf("\"", from);
      if (quote < 0) this.fail("a string is never closed", start);
      let backslashes = 0;
      for (let index = quote - 1; this.text[index] === "\\"; index -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        this.at = quote + 1;
        break;
      }
      from = quote + 1;
    }
    try {
      return JSON.parse(this.text.slice(start, this.at));
    } catch {
      return this.fail("a string holds a character JSON does not allow there (a line break or a bad escape)", start);
    }
  }

  /**
   * Read the value at the cursor. Objects on `path` are described; any value
   * is materialised when `materialise` is set.
   *
   * @param {{ path?: string[], depth?: number, materialise?: boolean }} [options]
   * @returns {{ type: string, value?: unknown, object?: ObjectInfo }}
   */
  value({ path = null, depth = 0, materialise = false } = {}) {
    if (depth > MAX_DEPTH) this.fail("the document is nested too deeply");
    this.space();
    const char = this.text[this.at];
    if (char === "{") return this.object({ path, depth, materialise });
    if (char === "[") return this.array({ depth, materialise });
    if (char === "\"") {
      const value = this.string();
      return { type: "string", value };
    }
    LITERAL.lastIndex = this.at;
    const match = LITERAL.exec(this.text);
    if (!match) {
      return this.fail(char === undefined ? "the document ends where a value should be" : `unexpected ${JSON.stringify(char)} where a value should be`);
    }
    this.at += match[0].length;
    const word = match[0];
    if (word === "true" || word === "false") return { type: "boolean", value: word === "true" };
    if (word === "null") return { type: "null", value: null };
    return { type: "number", value: Number(word) };
  }

  object({ path, depth, materialise }) {
    const open = this.at;
    this.at += 1;
    /** @type {MemberInfo[]} */
    const members = [];
    const describe = Array.isArray(path);
    const value = materialise ? {} : undefined;
    this.space();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return { type: "object", value, object: describe ? { open, close: this.at - 1, members } : undefined };
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== "\"") this.fail("expected a \"quoted\" member name");
      const keyStart = this.at;
      const key = this.string();
      this.space();
      if (this.text[this.at] !== ":") this.fail("expected ':' after a member name");
      this.at += 1;
      this.space();
      const valueStart = this.at;
      const onPath = describe && path.length > 0 && key === path[0];
      const read = this.value({
        path: onPath ? path.slice(1) : null,
        depth: depth + 1,
        materialise
      });
      // `__proto__` is a name like any other in JSON; assigned, it would be a prototype.
      if (materialise) Object.defineProperty(value, key, { value: read.value, enumerable: true, writable: true, configurable: true });
      if (describe) {
        members.push({
          key,
          keyStart,
          valueStart,
          valueEnd: this.at,
          type: read.type,
          ...(read.object ? { object: read.object } : {})
        });
      }
      this.space();
      const next = this.text[this.at];
      if (next === ",") {
        if (describe) members.at(-1).comma = this.at;
        this.at += 1;
        this.space();
        if (this.text[this.at] === "}") break;
      } else if (next === "}") {
        break;
      } else {
        this.fail("expected ',' or '}' after a member");
      }
    }
    const close = this.at;
    this.at += 1;
    return { type: "object", value, object: describe ? { open, close, members } : undefined };
  }

  array({ depth, materialise }) {
    this.at += 1;
    const value = materialise ? [] : undefined;
    this.space();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return { type: "array", value };
    }
    for (;;) {
      const item = this.value({ depth: depth + 1, materialise });
      if (materialise) value.push(item.value);
      this.space();
      const next = this.text[this.at];
      if (next === ",") {
        this.at += 1;
        this.space();
        if (this.text[this.at] === "]") break;
      } else if (next === "]") {
        break;
      } else {
        this.fail("expected ',' or ']' after an element");
      }
    }
    this.at += 1;
    return { type: "array", value };
  }

  /** Nothing but whitespace and comments may follow the document. */
  end() {
    this.space();
    if (this.at < this.text.length) this.fail("unexpected text after the end of the document");
  }
}

/**
 * Describe the root object and the objects along `path`, validating the rest.
 *
 * @param {string} text
 * @param {string[]} [path]
 * @returns {{ root: ObjectInfo | null, bodyStart: number }} `root` is null for a
 *   document with nothing in it but whitespace and comments.
 * @throws {JsoncSyntaxError} When the document is not JSON or JSONC, or its
 *   root is not an object.
 */
export function describeJsonc(text, path = []) {
  const scanner = new Scanner(text);
  scanner.space();
  if (scanner.at >= text.length) return { root: null, bodyStart: scanner.at };
  if (text[scanner.at] !== "{") {
    const read = new Scanner(text);
    const { type } = read.value();
    read.end();
    return scanner.fail(`the document is a JSON ${type}, not an object`);
  }
  const bodyStart = scanner.at;
  const { object } = scanner.value({ path });
  scanner.end();
  return { root: object, bodyStart };
}

/**
 * The whole document as a value. Empty (or comment-only) text reads as `{}`.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function readJsonc(text) {
  const scanner = new Scanner(text);
  scanner.space();
  if (scanner.at >= text.length) return {};
  const { value } = scanner.value({ materialise: true });
  scanner.end();
  return value;
}

/** The last member named `key` (JSON keeps the last of duplicates), or null. */
function lastMember(object, key) {
  for (let index = object.members.length - 1; index >= 0; index -= 1) {
    if (object.members[index].key === key) return object.members[index];
  }
  return null;
}

/**
 * Follow `path` from the root. Returns the deepest object reached and how many
 * segments of the path it covers.
 */
function walk(root, path) {
  let object = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    const member = lastMember(object, path[depth]);
    if (!member) return { object, depth };
    if (member.type !== "object") {
      throw new JsoncSyntaxError(`"${path.slice(0, depth + 1).join(".")}" is a JSON ${member.type}, not an object`, member.valueStart);
    }
    object = member.object;
  }
  return { object, depth: path.length };
}

/**
 * The value of member `key` of the object at `path`, or undefined.
 *
 * @param {string} text
 * @param {string[]} path
 * @param {string} key
 * @returns {unknown}
 */
export function readMember(text, path, key) {
  const { root } = describeJsonc(text, path);
  if (!root) return undefined;
  const { object, depth } = walk(root, path);
  if (depth < path.length) return undefined;
  const member = lastMember(object, key);
  if (!member) return undefined;
  const scanner = new Scanner(text);
  scanner.at = member.valueStart;
  return scanner.value({ materialise: true }).value;
}

function lineStartOf(text, offset) {
  const newline = text.lastIndexOf("\n", offset - 1);
  return newline + 1;
}

/** The whitespace a line begins with, for the line holding `offset`. */
function indentOf(text, offset) {
  const start = lineStartOf(text, offset);
  let end = start;
  while (text[end] === " " || text[end] === "\t") end += 1;
  return text.slice(start, end);
}

function sameLine(text, left, right) {
  const from = Math.min(left, right);
  const to = Math.max(left, right);
  return !text.slice(from, to).includes("\n");
}

/** The document's line ending and indentation step. */
function styleOf(text, root) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let unit = "  ";
  const first = root?.members[0];
  if (first && !sameLine(text, root.open, first.keyStart)) {
    const indent = indentOf(text, first.keyStart).slice(indentOf(text, root.open).length);
    if (indent) unit = indent;
  }
  return { eol, unit };
}

/** A value printed for a member whose name starts at indentation `indent`. */
function printValue(value, { eol, unit, indent, inline }) {
  if (inline) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).replaceAll("\n", `${eol}${indent}`);
}

function splice(text, start, end, insert) {
  return `${text.slice(0, start)}${insert}${text.slice(end)}`;
}

/**
 * What follows a value on its line, when that is nothing but blanks, one
 * comma and comments: where the line break is, where the comma is (-1 for
 * none), and whether there is a comment. Null when anything else follows.
 */
function restOfLine(text, offset) {
  let at = offset;
  let comma = -1;
  let comment = false;
  for (;;) {
    while (text[at] === " " || text[at] === "\t") at += 1;
    if (text[at] === "," && comma < 0) {
      comma = at;
      at += 1;
    } else if (text.startsWith("//", at)) {
      comment = true;
      while (at < text.length && text[at] !== "\n" && !text.startsWith("\r\n", at)) at += 1;
    } else if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      if (close < 0 || text.slice(at, close).includes("\n")) return null;
      comment = true;
      at = close + 2;
    } else {
      break;
    }
  }
  if (at < text.length && text[at] !== "\n" && !text.startsWith("\r\n", at)) return null;
  return { end: at, comma, comment };
}

/** Wrap `value` in objects named by `path`, innermost last. */
function nest(path, key, value) {
  let inner = { [key]: value };
  for (let index = path.length - 1; index >= 0; index -= 1) inner = { [path[index]]: inner };
  return inner;
}

/**
 * Set member `key` of the object at `path` to `value`, creating the objects on
 * the way. An existing member keeps its place and its name's spelling; a new
 * one goes last, in the style of its neighbours.
 *
 * @param {string} text
 * @param {string[]} path
 * @param {string} key
 * @param {unknown} value - Anything `JSON.stringify` prints.
 * @returns {string}
 */
export function setMember(text, path, key, value) {
  const { root, bodyStart } = describeJsonc(text, path);
  if (!root) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const head = text.slice(0, bodyStart);
    const document = JSON.stringify(nest(path, key, value), null, 2).replaceAll("\n", eol);
    const lead = head && !/\n$/.test(head) ? eol : "";
    return `${head}${lead}${document}${eol}${text.slice(bodyStart)}`;
  }
  const style = styleOf(text, root);
  const { object, depth } = walk(root, path);
  // Where the path stops short, the first missing object becomes the new
  // member, holding the rest of the path and the value.
  const missing = depth < path.length;
  const memberName = missing ? path[depth] : key;
  const memberValue = missing ? nest(path.slice(depth + 1), key, value) : value;
  const member = missing ? null : lastMember(object, key);

  const multiline = object.members.length === 0 || !sameLine(text, object.open, object.members[0].keyStart);
  if (member) {
    const indent = indentOf(text, member.keyStart);
    return splice(text, member.valueStart, member.valueEnd, printValue(value, { ...style, indent, inline: !multiline }));
  }
  const closeIndent = indentOf(text, object.open);
  if (object.members.length) {
    const last = object.members.at(-1);
    const indent = multiline ? indentOf(text, object.members[0].keyStart) : "";
    const printed = printValue(memberValue, { ...style, indent, inline: !multiline });
    const rest = multiline ? restOfLine(text, last.valueEnd) : null;
    if (rest?.comment) {
      // A comment after the last value stays with that value: the comma goes
      // before it, the new member on a line of its own after it. Inserted at
      // the value, the comment ended up after the new member, and removing
      // the member took it along.
      const trailing = rest.comma >= 0;
      const withLine = splice(text, rest.end, rest.end, `${style.eol}${indent}${JSON.stringify(memberName)}: ${printed}${trailing ? "," : ""}`);
      return trailing ? withLine : splice(withLine, last.valueEnd, last.valueEnd, ",");
    }
    const separator = multiline ? `,${style.eol}${indent}` : ", ";
    return splice(text, last.valueEnd, last.valueEnd, `${separator}${JSON.stringify(memberName)}: ${printed}`);
  }
  const indent = `${closeIndent}${style.unit}`;
  const printed = printValue(memberValue, { ...style, indent, inline: false });
  const entry = `${style.eol}${indent}${JSON.stringify(memberName)}: ${printed}`;
  const interior = text.slice(object.open + 1, object.close);
  if (!interior.trim()) return splice(text, object.open + 1, object.close, `${entry}${style.eol}${closeIndent}`);
  return splice(text, object.open + 1, object.open + 1, entry);
}

/**
 * Cut a member that has lines of its own, with whatever else is on them —
 * its comma, a comment about it — and nothing else: a comment on the line
 * before stays with the member it was written after. Null when the member
 * shares a line.
 */
function cutMemberLines(text, object, index) {
  const member = object.members[index];
  const start = lineStartOf(text, member.keyStart);
  if (text.slice(start, member.keyStart).trim()) return null;
  const rest = restOfLine(text, member.valueEnd);
  if (!rest || (member.comma ?? -1) !== rest.comma) return null;
  const end = text.startsWith("\r\n", rest.end) ? rest.end + 2 : rest.end + (text[rest.end] === "\n" ? 1 : 0);
  const cut = splice(text, start, end, "");
  const previous = object.members[index - 1];
  // The last member gone, the one before it is last and needs no comma.
  if (member.comma === undefined && previous?.comma !== undefined) return splice(cut, previous.comma, previous.comma + 1, "");
  return cut;
}

/** Cut one member out, with the punctuation and lines that belong to it. */
function cutMember(text, object, index) {
  const member = object.members[index];
  const end = member.comma === undefined ? member.valueEnd : member.comma + 1;
  if (object.members.length > 1) {
    const cut = cutMemberLines(text, object, index);
    if (cut !== null) return cut;
  }
  if (index > 0) {
    // From the end of the previous value: its comma, the line break, this
    // member. The exact inverse of an insertion after the previous member.
    return splice(text, object.members[index - 1].valueEnd, member.valueEnd, "");
  }
  if (object.members.length === 1) {
    const rest = `${text.slice(object.open + 1, member.keyStart)}${text.slice(end, object.close)}`;
    if (!rest.trim()) return splice(text, object.open + 1, object.close, "");
    return splice(text, member.keyStart, end, "");
  }
  // The first of several: its own lines go, the next member moves up.
  let start = member.keyStart;
  const lineStart = lineStartOf(text, start);
  const ownLine = !text.slice(lineStart, start).trim();
  if (ownLine) start = lineStart;
  let stop = end;
  while (text[stop] === " " || text[stop] === "\t") stop += 1;
  if (ownLine && text.startsWith("\r\n", stop)) stop += 2;
  else if (ownLine && text[stop] === "\n") stop += 1;
  return splice(text, start, stop, "");
}

/**
 * Remove every member named `key` from the object at `path`. Text without one
 * comes back unchanged.
 *
 * @param {string} text
 * @param {string[]} path
 * @param {string} key
 * @returns {string}
 */
export function removeMember(text, path, key) {
  let current = text;
  for (;;) {
    const { root } = describeJsonc(current, path);
    if (!root) return current;
    const { object, depth } = walk(root, path);
    if (depth < path.length) return current;
    const index = object.members.findLastIndex((member) => member.key === key);
    if (index < 0) return current;
    current = cutMember(current, object, index);
  }
}

/**
 * Whether the object at `path` exists and has no members.
 *
 * @param {string} text
 * @param {string[]} path
 * @returns {boolean}
 */
export function isEmptyObjectAt(text, path) {
  const { root } = describeJsonc(text, path);
  if (!root) return false;
  const { object, depth } = walk(root, path);
  return depth === path.length && object.members.length === 0;
}

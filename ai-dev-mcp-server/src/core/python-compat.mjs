/**
 * The Python behaviours the search index depends on, reproduced in JavaScript.
 *
 * `search-index/search_cli.py` wrote the index for its whole life before the
 * Node writer existed. Every 2.x install has an index it built, the Python
 * hybrid search reads whatever index is on disk until it moves to Node as well,
 * and a stored dense vector is only reused while the passage it was embedded
 * from hashes the same. So the Node writer has to produce the ids, hashes,
 * previews and sparse vectors the Python one did — byte for byte — and these
 * are the places where the same line of code means something different in the
 * two languages: what counts as whitespace and as a line break, how long a
 * string is, how a file is read, how a float is rounded, printed and summed,
 * the natural log, case folding, and `str()` of a JSON value.
 *
 * Every function here is pinned by a test against values CPython printed.
 */
import fs from "node:fs";

/**
 * Python's whitespace (`str.isspace`, `\s` in a `str` pattern, `str.strip()`),
 * which is not JavaScript's: it includes U+001C–U+001F and U+0085, and it does
 * not include U+FEFF.
 *
 * @param {number} code - A UTF-16 code unit or code point.
 * @returns {boolean}
 */
export function isPythonWhitespace(code) {
  if (code <= 0x20) return code >= 0x1c || (code >= 0x09 && code <= 0x0d);
  if (code < 0x85) return false;
  return code === 0x85 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** The same set as a character-class body, for building patterns. */
export const PYTHON_WHITESPACE_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const WHITESPACE_RUN = new RegExp(`[${PYTHON_WHITESPACE_CLASS}]+`, "g");

/** `re.sub(r"\s+", " ", text)`. */
export function collapseWhitespace(text) {
  return text.replace(WHITESPACE_RUN, " ");
}

/** `text.strip()`. */
export function pythonStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isPythonWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isPythonWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

const LINE_BOUNDARY = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;

/** `text.splitlines()`: eleven line boundaries, and no empty last line. */
export function splitLines(text) {
  const lines = text.split(LINE_BOUNDARY);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Whether the code unit at `index` starts a surrogate pair. */
function pairAt(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
    && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
}

/** `text[:limit]`: Python counts code points, JavaScript counts UTF-16 units. */
export function sliceCodePoints(text, limit) {
  if (text.length <= limit) return text;
  let index = 0;
  for (let count = 0; count < limit && index < text.length; count += 1) index += pairAt(text, index) ? 2 : 1;
  return text.slice(0, index);
}

/** `len(text)`. */
export function codePointLength(text) {
  let length = text.length;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (pairAt(text, index)) {
      length -= 1;
      index += 1;
    }
  }
  return length;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * `text.encode("utf-8", errors="replace")`: a lone surrogate becomes `?`,
 * where `Buffer.from` would write U+FFFD.
 *
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeUtf8(text) {
  return Buffer.from(text.isWellFormed() ? text : text.replace(LONE_SURROGATE, "?"), "utf8");
}

const UTF8 = new TextDecoder("utf-8");

/**
 * `path.read_text(encoding="utf-8-sig", errors="replace")`: one leading BOM
 * dropped, invalid bytes replaced, and — because `read_text` opens in text mode
 * — `\r\n` and a lone `\r` read as `\n`.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function readPythonText(filePath) {
  return decodePythonText(fs.readFileSync(filePath));
}

/** The decoding half of {@link readPythonText}. */
export function decodePythonText(bytes) {
  const text = UTF8.decode(bytes);
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/**
 * `repr(x)` of a float: the shortest round-trip digits, as JavaScript prints
 * them too, but in Python's layout — `1.0`, `1e-05`, `1e+16`.
 *
 * @param {number} x
 * @returns {string}
 */
export function pythonFloatRepr(x) {
  const magnitude = Math.abs(x);
  // Where both languages print positional notation they print the same
  // digits; JavaScript only leaves off the ".0" of an integer.
  if (magnitude >= 1e-4 && magnitude < 1e16) return Number.isInteger(x) ? `${x}.0` : String(x);
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, exponentText] = x.toExponential().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  // CPython switches to exponent notation when the decimal point would sit
  // more than 16 digits right or 4 zeros left of the digits.
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const power = Math.abs(exponent);
    return `${sign}${fraction}e${exponent < 0 ? "-" : "+"}${power < 10 ? `0${power}` : power}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = digits.slice(exponent + 1);
  return `${sign}${whole}.${fraction || "0"}`;
}

/**
 * `round(x, digits)`: the exact value rounded half to even. `toFixed` rounds
 * the exact value too but sends a tie up, and a tie at `digits` places is
 * exactly an `x` for which `x * 2 ** (digits + 1)` is an odd integer.
 *
 * @param {number} x
 * @param {number} digits - 0 to 15.
 * @returns {number}
 */
export function pythonRound(x, digits) {
  // From 2 ** 52 every double is an integer; below it `round(x, 0)` still has
  // a fraction to settle.
  if (!Number.isFinite(x) || x === 0 || Math.abs(x) >= 2 ** 52) return x;
  const scaled = x * 2 ** (digits + 1);
  if (Number.isInteger(scaled) && Math.abs(scaled % 2) === 1) {
    // In BigInt: `scaled * 5 ** digits` leaves 2 ** 53 behind for ties above
    // about 4.5e7, and a Number then rounds the tie it is meant to settle. The
    // even neighbour, read back from its decimal form, is the double nearest to
    // it, which is what Python returns.
    const doubled = BigInt(scaled) * 5n ** BigInt(digits);
    const lower = (doubled - 1n) / 2n;
    const even = lower % 2n === 0n ? lower : lower + 1n;
    if (even === 0n) return x < 0 ? -0 : 0;
    return Number(`${even}e-${digits}`);
  }
  return Number(x.toFixed(digits));
}

/**
 * `sum(values)` over floats. CPython 3.12 and later sum floats with Neumaier's
 * compensation, which can differ from a plain loop in the last bit.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function pythonSum(values) {
  if (!values.length) return 0;
  let total = values[0];
  let compensation = 0;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    const next = total + value;
    compensation += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

const LOG_PRECISION = 256n;

/** atanh(numerator / denominator) in fixed point, for a ratio of at most 1/3. */
function atanhFixed(numerator, denominator) {
  if (numerator < 0n) return -atanhFixed(-numerator, denominator);
  const z = (numerator << LOG_PRECISION) / denominator;
  const z2 = (z * z) >> LOG_PRECISION;
  let term = z;
  let sum = 0n;
  for (let divisor = 1n; term !== 0n; divisor += 2n) {
    sum += term / divisor;
    term = (term * z2) >> LOG_PRECISION;
  }
  return sum;
}

const LN2_FIXED = 2n * atanhFixed(1n, 3n);

/** The nearest double to a positive fixed-point value. */
function fixedToDouble(value) {
  const bits = value.toString(2).length;
  const shift = BigInt(bits - 53);
  let mantissa = value >> shift;
  const rest = value - (mantissa << shift);
  const half = 1n << (shift - 1n);
  if (rest > half || (rest === half && (mantissa & 1n))) mantissa += 1n;
  return Number(mantissa) * 2 ** (bits - 53 - Number(LOG_PRECISION));
}

const logCache = new Map();

/**
 * `math.log(n)` for a positive integer, correctly rounded.
 *
 * CPython calls the C library's `log`. glibc's is correctly rounded on all but
 * a handful of integers (6 of the first 300,000, the first at 9,170), while
 * V8's `Math.log` is off by an ulp on 0.8 % of them — enough to move a sparse
 * vector's last bit and, through the norm, a rounded weight. So this computes
 * the logarithm in 256-bit fixed point and rounds once.
 *
 * @param {number} n
 * @returns {number}
 */
export function pythonLog(n) {
  if (!Number.isSafeInteger(n) || n < 1) return Math.log(n);
  if (n === 1) return 0;
  let cached = logCache.get(n);
  if (cached === undefined) {
    const value = BigInt(n);
    // n = 2^k * m with m in [2/3, 4/3), and ln m = 2 atanh((m - 1) / (m + 1)).
    let k = 0n;
    while (3n * value >= 4n << k) k += 1n;
    const power = 1n << k;
    cached = fixedToDouble(k * LN2_FIXED + 2n * atanhFixed(value - power, value + power));
    if (logCache.size < 65_536) logCache.set(n, cached);
  }
  return cached;
}

const CHEROKEE_SMALL = /[\u13f8-\u13fd\uab70-\uabbf]/g;

/**
 * `text.casefold()`. Upper- then lower-casing is full case folding except for
 * final sigma, the capital sharp s, Cherokee (which folds to upper case) and
 * the dotless i (which does not fold at all).
 *
 * @param {string} text
 * @returns {string}
 */
export function pythonCasefold(text) {
  return text
    .split("\u0131")
    .map((part) => part.toUpperCase().toLowerCase().replace(/\u03c2/g, "\u03c3").replace(/\u00df/g, "ss"))
    .join("\u0131")
    .replace(CHEROKEE_SMALL, (char) => {
      const code = char.charCodeAt(0);
      return String.fromCharCode(code >= 0xab70 ? code - 0xab70 + 0x13a0 : code - 0x13f8 + 0x13f0);
    });
}

/**
 * A JSON number Python read as a float. `json.loads("87.0")` is `87.0` and
 * prints as such, where `JSON.parse` keeps only `87`.
 */
export class PythonFloat {
  /** @param {number} value */
  constructor(value) {
    this.value = value;
  }
}

/** A number token written as a float, or an integer of 16 digits or more. */
const FLOAT_OR_LONG_NUMBER = /[:,[][\t\n\r ]*-?(?:\d+\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d{16,})/g;

/** Whether `JSON.parse` alone would lose something `str()` prints: `87.0`, `1e5`, a long integer. */
function needsExactNumbers(text) {
  FLOAT_OR_LONG_NUMBER.lastIndex = 0;
  for (let match = FLOAT_OR_LONG_NUMBER.exec(text); match; match = FLOAT_OR_LONG_NUMBER.exec(text)) {
    const value = Number(match[0].replace(/^[:,[][\t\n\r ]*/, ""));
    if (Number.isInteger(value)) return true;
  }
  return false;
}

/**
 * `json.loads(text)` with Python's int and float kept apart: a number written
 * with a fraction or an exponent becomes a {@link PythonFloat}, an integer too
 * large for a double a BigInt.
 *
 * Only where it matters, though: telling them apart takes a reviver, which
 * makes parsing the 9 MB skill registry eight times slower, and a non-integral
 * float or a short integer prints the same either way. So the reviver runs
 * only when a token might be an integral float or a long integer — a match
 * inside a string is a false alarm that costs time, not correctness.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parsePythonJson(text) {
  if (!needsExactNumbers(text)) return JSON.parse(text);
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    const source = typeof context?.source === "string" ? context.source : String(value);
    if (/[.eE]/.test(source)) return new PythonFloat(value);
    return Number.isSafeInteger(value) ? value : BigInt(source);
  });
}

/** Python's truth value of a JSON value. */
export function pythonTruthy(value) {
  if (value === null || value === undefined) return false;
  if (value instanceof PythonFloat) return value.value !== 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `repr()` of a string. */
function stringRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x7f || !NOT_PRINTABLE.test(char)) out += char;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** `repr()` of a JSON value. */
export function pythonRepr(value) {
  return typeof value === "string" ? stringRepr(value) : pythonStr(value);
}

/**
 * `str()` of a JSON value as {@link parsePythonJson} returns it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function pythonStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (value instanceof PythonFloat) return pythonFloatRepr(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pythonFloatRepr(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${stringRepr(key)}: ${pythonRepr(item)}`).join(", ")}}`;
  }
  return String(value);
}

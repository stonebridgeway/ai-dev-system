/**
 * Just enough semver to reason about npm advisories without a dependency.
 *
 * Two questions need it: which published version is the first one outside
 * every advisory's vulnerable range, and whether that version still satisfies
 * the range a parent package declared. Both are npm-range questions, so the
 * grammar here is npm's: `||` alternatives, space-separated comparators,
 * hyphen ranges, x-ranges, `~` and `^`. Prerelease versions follow npm's rule —
 * `1.2.3-rc.1` satisfies a range only if a comparator in the same alternative
 * names `1.2.3` with a prerelease — because advisory ranges such as
 * `>=7.0.0-alpha.0 <8.18.0` are written with that rule in mind.
 *
 * A version or range this module cannot read is never guessed at: `parse`
 * returns `null` and `satisfies` returns `false`. A fix plan built on a
 * misread range is worse than one that says it could not read it.
 */

const VERSION = /^\s*[v=]*\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/;
const PARTIAL = /^[v=]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {{ major: number, minor: number, patch: number, prerelease: Array<string|number> }} SemVer
 */

/**
 * @param {unknown} value
 * @returns {SemVer | null}
 */
export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  };
}

function compareParsed(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const a = left.prerelease;
  const b = right.prerelease;
  if (!a.length || !b.length) return a.length === b.length ? 0 : (a.length ? -1 : 1);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] === b[index]) continue;
    const numeric = typeof a[index] === "number" && typeof b[index] === "number";
    if (numeric) return a[index] < b[index] ? -1 : 1;
    if (typeof a[index] === "number") return -1;
    if (typeof b[index] === "number") return 1;
    return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Semver precedence: -1, 0 or 1. Unreadable versions sort first, so a list
 * sorted with this puts them where nobody picks them.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  return compareParsed(a, b);
}

/** Whether a version is a prerelease (`1.2.3-rc.1`). Unreadable versions are not. */
export function isPrerelease(value) {
  return Boolean(parseVersion(value)?.prerelease.length);
}

/**
 * How far apart two versions are, the way npm's caret reads it: below 1.0.0 a
 * minor bump is breaking, below 0.1.0 a patch bump is.
 *
 * @param {string} from
 * @param {string} to
 * @returns {"major" | "minor" | "patch" | "prerelease" | "none" | "unknown"}
 */
export function upgradeKind(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";
  if (compareParsed(a, b) === 0) return "none";
  if (a.major !== b.major) return "major";
  if (a.major === 0 && a.minor !== b.minor) return "major";
  if (a.major === 0 && a.minor === 0 && a.patch !== b.patch) return "major";
  if (a.minor !== b.minor) return "minor";
  if (a.patch !== b.patch) return "patch";
  return "prerelease";
}

function comparator(operator, major, minor, patch, prerelease = []) {
  return { operator, version: { major, minor, patch, prerelease } };
}

function readPartial(text) {
  const match = PARTIAL.exec(text);
  if (!match) return null;
  const part = (value) => (value === undefined || /^[xX*]$/.test(value) ? null : Number(value));
  return {
    major: part(match[1]),
    minor: part(match[2]),
    patch: part(match[3]),
    prerelease: match[4] ? match[4].split(".").map((item) => (/^\d+$/.test(item) ? Number(item) : item)) : []
  };
}

/** The comparators one range token stands for, or null when it is unreadable. */
function desugar(token) {
  const operatorMatch = /^(<=|>=|<|>|=|~>?|\^)?\s*(.*)$/.exec(token);
  const operator = operatorMatch[1] ?? "";
  const partial = readPartial(operatorMatch[2]);
  if (!partial) return null;
  const { major, minor, patch, prerelease } = partial;
  if (major === null) return operator === "<" || operator === ">" ? [comparator("<", 0, 0, 0, [0])] : [];
  const lowMinor = minor ?? 0;
  const lowPatch = patch ?? 0;
  if (operator === "^") {
    const low = comparator(">=", major, lowMinor, lowPatch, prerelease);
    if (major > 0 || minor === null) return [low, comparator("<", major + 1, 0, 0, [0])];
    if (minor > 0 || patch === null) return [low, comparator("<", 0, minor + 1, 0, [0])];
    return [low, comparator("<", 0, 0, patch + 1, [0])];
  }
  if (operator === "~" || operator === "~>") {
    const low = comparator(">=", major, lowMinor, lowPatch, prerelease);
    return minor === null ? [low, comparator("<", major + 1, 0, 0, [0])] : [low, comparator("<", major, minor + 1, 0, [0])];
  }
  if (minor === null || patch === null) {
    // An x-range: `1.2` is `>=1.2.0 <1.3.0-0`, `<1.2` is `<1.2.0-0`, `>1.2` is `>=1.3.0`.
    const next = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
    if (operator === "" || operator === "=") return [comparator(">=", major, lowMinor, 0), comparator("<", ...next, [0])];
    if (operator === ">=") return [comparator(">=", major, lowMinor, 0)];
    if (operator === ">") return [comparator(">=", ...next)];
    if (operator === "<") return [comparator("<", major, lowMinor, 0, [0])];
    return [comparator("<", ...next, [0])];
  }
  return [comparator(operator || "=", major, minor, patch, prerelease)];
}

/** One `||` alternative as a list of comparators, or null when unreadable. */
function parseAlternative(text) {
  const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(text);
  if (hyphen) {
    const low = desugar(`>=${hyphen[1]}`);
    const high = readPartial(hyphen[2]);
    if (!low || !high || high.major === null) return null;
    const upper = high.minor === null
      ? comparator("<", high.major + 1, 0, 0, [0])
      : high.patch === null
        ? comparator("<", high.major, high.minor + 1, 0, [0])
        : comparator("<=", high.major, high.minor, high.patch, high.prerelease);
    return [...low, upper];
  }
  const tokens = text.trim().replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, "$1").split(/\s+/).filter(Boolean);
  const comparators = [];
  for (const token of tokens) {
    const set = desugar(token);
    if (!set) return null;
    comparators.push(...set);
  }
  return comparators;
}

function test(version, { operator, version: bound }) {
  const order = compareParsed(version, bound);
  if (operator === "<") return order < 0;
  if (operator === "<=") return order <= 0;
  if (operator === ">") return order > 0;
  if (operator === ">=") return order >= 0;
  return order === 0;
}

/**
 * Whether a version satisfies an npm range.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const source = String(range ?? "").trim();
  const alternatives = (source === "" ? ["*"] : source.split("||")).map((item) => parseAlternative(item.trim() || "*"));
  for (const comparators of alternatives) {
    if (!comparators) continue;
    if (!comparators.every((item) => test(parsed, item))) continue;
    if (!parsed.prerelease.length) return true;
    // npm's prerelease rule: only a comparator on the same tuple that itself
    // carries a prerelease lets one in. The synthetic `<X.Y.Z-0` upper bounds
    // need no exception: every real prerelease of X.Y.Z sorts above `-0`, so
    // they have already failed the comparator itself.
    const admitted = comparators.some(({ version: bound }) => (
      bound.prerelease.length > 0 &&
      bound.major === parsed.major && bound.minor === parsed.minor && bound.patch === parsed.patch
    ));
    if (admitted) return true;
  }
  return false;
}

/**
 * Whether a range can be read at all. A plan names the ranges it could not
 * read instead of treating them as "matches nothing".
 *
 * @param {string} range
 * @returns {boolean}
 */
export function isValidRange(range) {
  const source = String(range ?? "").trim();
  if (source === "") return true;
  return source.split("||").every((item) => parseAlternative(item.trim() || "*") !== null);
}

/**
 * Sort versions ascending by semver precedence, dropping the unreadable ones.
 *
 * @param {string[]} versions
 * @returns {string[]}
 */
export function sortVersions(versions) {
  return [...new Set(versions)].filter((item) => parseVersion(item)).sort(compareVersions);
}

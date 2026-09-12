import fs from "node:fs/promises";
import path from "node:path";

/**
 * Coverage reports: reading the four formats a project is likely to have
 * already produced, and turning them into the one question worth asking after
 * a change — which of the lines and functions I just touched is nothing
 * running over.
 *
 * Ported from ECC's `commands/test-coverage.md` and `agents/pr-test-analyzer.md`
 * (parse the report, rank what is missing, weigh the files the change touched).
 * Nothing is executed here: a coverage run belongs to the quality gate, and
 * this reads what that run left behind.
 */

/** The report formats this understands, in the order the conventional paths are searched. */
export const COVERAGE_FORMATS = Object.freeze(["lcov", "istanbul", "cobertura", "go"]);

/** Where each format usually lands. The first file that exists wins. */
export const COVERAGE_REPORT_PATHS = Object.freeze([
  { format: "lcov", path: "coverage/lcov.info" },
  { format: "lcov", path: "lcov.info" },
  { format: "lcov", path: "coverage/lcov-report/lcov.info" },
  { format: "istanbul", path: "coverage/coverage-final.json" },
  { format: "istanbul", path: "coverage/coverage.json" },
  { format: "cobertura", path: "coverage.xml" },
  { format: "cobertura", path: "coverage/coverage.xml" },
  { format: "cobertura", path: "coverage/cobertura-coverage.xml" },
  { format: "go", path: "coverage.out" },
  { format: "go", path: "coverage/coverage.out" }
]);

/** A report bigger than this is a generated artifact nobody meant to commit; reading it whole is not worth it. */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(hit, found) {
  return found > 0 ? Number(((hit / found) * 100).toFixed(2)) : 100;
}

/** A repository-relative, POSIX-separated path, whatever spelling the report used. */
export function normalizeReportPath(projectRoot, filePath) {
  const raw = String(filePath ?? "").trim().replaceAll("\\", "/");
  if (!raw) return "";
  if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(projectRoot), raw).replaceAll("\\", "/");
    return relative && !relative.startsWith("..") ? relative : raw;
  }
  return raw.replace(/^\.\//, "");
}

function emptyFile(filePath) {
  return {
    path: filePath,
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    uncovered_lines: [],
    uncovered_functions: []
  };
}

/**
 * Parse an lcov tracefile: `SF` opens a record, `DA` is a line and its hit
 * count, `FN`/`FNDA` name a function and how often it ran, `LF`/`LH` and
 * `BRF`/`BRH` are the totals the tool already computed.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseLcov(text) {
  const files = [];
  let current = null;
  let declarations = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = emptyFile(line.slice(3).trim());
      declarations = new Map();
      continue;
    }
    if (!current) continue;
    if (line === "end_of_record") {
      files.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("DA:")) {
      const [at, hits] = line.slice(3).split(",");
      current.lines.found += 1;
      if (number(hits) > 0) current.lines.hit += 1;
      else current.uncovered_lines.push(number(at));
    } else if (line.startsWith("FN:")) {
      const [at, ...rest] = line.slice(3).split(",");
      declarations.set(rest.join(",").trim(), number(at));
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...rest] = line.slice(5).split(",");
      const name = rest.join(",").trim();
      if (number(hits) === 0) current.uncovered_functions.push({ name, line: declarations.get(name) ?? 0 });
    } else if (line.startsWith("LF:")) {
      current.lines.found = Math.max(current.lines.found, number(line.slice(3)));
    } else if (line.startsWith("LH:")) {
      current.lines.hit = Math.max(current.lines.hit, number(line.slice(3)));
    } else if (line.startsWith("BRF:")) {
      current.branches.found = number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      current.branches.hit = number(line.slice(4));
    }
  }
  return files;
}

/**
 * Parse an Istanbul `coverage-final.json`: one entry per file, with a map from
 * statement and function ids to their position and a parallel map of counts.
 *
 * @param {object} document
 * @returns {Array<object>}
 */
export function parseIstanbul(document) {
  const files = [];
  for (const [key, entry] of Object.entries(document ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const file = emptyFile(String(entry.path || key));
    for (const [id, count] of Object.entries(entry.s ?? {})) {
      file.lines.found += 1;
      if (number(count) > 0) file.lines.hit += 1;
      else file.uncovered_lines.push(number(entry.statementMap?.[id]?.start?.line));
    }
    for (const [id, count] of Object.entries(entry.f ?? {})) {
      if (number(count) > 0) continue;
      const declaration = entry.fnMap?.[id];
      file.uncovered_functions.push({
        name: String(declaration?.name || `function#${id}`),
        line: number(declaration?.decl?.start?.line ?? declaration?.loc?.start?.line)
      });
    }
    for (const counts of Object.values(entry.b ?? {})) {
      for (const count of Array.isArray(counts) ? counts : []) {
        file.branches.found += 1;
        if (number(count) > 0) file.branches.hit += 1;
      }
    }
    files.push(file);
  }
  return files;
}

/**
 * Parse a Cobertura report — what `coverage.py --xml`, JaCoCo's converter and
 * Jest's cobertura reporter all write. Read with regular expressions rather
 * than an XML parser: the shape is fixed, and the server ships no parser.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseCobertura(text) {
  const files = [];
  const source = String(text ?? "");
  for (const match of source.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const filename = match[1].match(/filename="([^"]*)"/)?.[1];
    if (!filename) continue;
    const body = match[2];
    const file = emptyFile(filename);
    const seen = new Map();
    for (const line of body.matchAll(/<line\b[^>]*number="(\d+)"[^>]*hits="(\d+)"/g)) {
      const at = number(line[1]);
      // A method repeats its own lines inside the class block; the highest hit
      // count for a line is the true one.
      seen.set(at, Math.max(seen.get(at) ?? 0, number(line[2])));
    }
    for (const [at, hits] of [...seen.entries()].sort((left, right) => left[0] - right[0])) {
      file.lines.found += 1;
      if (hits > 0) file.lines.hit += 1;
      else file.uncovered_lines.push(at);
    }
    for (const method of body.matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)) {
      const name = method[1].match(/name="([^"]*)"/)?.[1];
      if (!name) continue;
      const hits = [...method[2].matchAll(/hits="(\d+)"/g)].reduce((sum, item) => sum + number(item[1]), 0);
      if (hits > 0) continue;
      const at = number(method[2].match(/number="(\d+)"/)?.[1]);
      file.uncovered_functions.push({ name, line: at });
    }
    files.push(file);
  }
  return files;
}

/**
 * Parse a `go test -coverprofile` file. Each row is a block of statements —
 * `file.go:startLine.col,endLine.col statements count` — so an uncovered block
 * contributes its whole line range and there are no function names to report.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseGoCover(text) {
  const byFile = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const row = raw.trim();
    if (!row || row.startsWith("mode:")) continue;
    const match = row.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    const [, filePath, start, end, statements, count] = match;
    const file = byFile.get(filePath) ?? emptyFile(filePath);
    file.lines.found += number(statements);
    if (number(count) > 0) file.lines.hit += number(statements);
    else for (let at = number(start); at <= number(end); at += 1) file.uncovered_lines.push(at);
    byFile.set(filePath, file);
  }
  return [...byFile.values()];
}

/** Consecutive numbers folded into `18-24`, singles left alone. */
export function lineRanges(lines, limit = 12) {
  const sorted = [...new Set((lines ?? []).map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
  const ranges = [];
  let start = null;
  let previous = null;
  for (const at of sorted) {
    if (start === null) {
      start = at;
    } else if (at !== previous + 1) {
      ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
      start = at;
    }
    previous = at;
  }
  if (start !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.slice(0, Math.max(1, limit));
}

/**
 * Read whichever coverage report a project has.
 *
 * @param {string} projectRoot
 * @param {{ reportPath?: string, format?: string }} [options]
 * @returns {Promise<{ format: string, path: string, files: object[], generated_at: string } | null>}
 */
export async function readCoverageReport(projectRoot, { reportPath = "", format = "" } = {}) {
  const root = path.resolve(projectRoot);
  const candidates = reportPath
    ? [{ format: format || guessFormat(reportPath), path: String(reportPath).replaceAll("\\", "/") }]
    : COVERAGE_REPORT_PATHS;
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate.path) ? candidate.path : path.join(root, ...candidate.path.split("/"));
    const stats = await fs.stat(absolute).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_REPORT_BYTES) continue;
    const text = await fs.readFile(absolute, "utf8").catch(() => "");
    if (!text.trim()) continue;
    const files = parseByFormat(candidate.format, text);
    if (!files.length) continue;
    return {
      format: candidate.format,
      path: path.relative(root, absolute).replaceAll("\\", "/") || candidate.path,
      generated_at: stats.mtime.toISOString(),
      files: files.map((file) => ({ ...file, path: normalizeReportPath(root, file.path) }))
    };
  }
  return null;
}

/** The format a path's name implies, for an explicitly named report. */
export function guessFormat(reportPath) {
  const name = path.basename(String(reportPath ?? "")).toLowerCase();
  if (name.endsWith(".info")) return "lcov";
  if (name.endsWith(".xml")) return "cobertura";
  if (name.endsWith(".out")) return "go";
  if (name.endsWith(".json")) return "istanbul";
  return "lcov";
}

function parseByFormat(format, text) {
  if (format === "istanbul") {
    try {
      return parseIstanbul(JSON.parse(text));
    } catch {
      return [];
    }
  }
  if (format === "cobertura") return parseCobertura(text);
  if (format === "go") return parseGoCover(text);
  return parseLcov(text);
}

/** Totals over every file in a report. */
export function summarizeCoverage(files) {
  const totals = { files: (files ?? []).length, lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, uncovered_functions: 0 };
  for (const file of files ?? []) {
    totals.lines.found += file.lines.found;
    totals.lines.hit += file.lines.hit;
    totals.branches.found += file.branches.found;
    totals.branches.hit += file.branches.hit;
    totals.uncovered_functions += file.uncovered_functions.length;
  }
  totals.line_percent = percent(totals.lines.hit, totals.lines.found);
  totals.branch_percent = percent(totals.branches.hit, totals.branches.found);
  return totals;
}

/**
 * Whether a report entry and a repository path are the same file. Go writes
 * import paths and some tools write a build-relative prefix, so a suffix match
 * on whole segments is the honest comparison.
 */
function samePath(reportPath, changedPath) {
  if (reportPath === changedPath) return true;
  return reportPath.endsWith(`/${changedPath}`) || changedPath.endsWith(`/${reportPath}`);
}

/**
 * The gaps worth closing, strongest first: a file the change touched outranks
 * one it did not, and within that, the one with the most uncovered lines.
 *
 * @param {object} input
 * @param {object[]} input.files - From a parsed report.
 * @param {string[]} [input.changedFiles] - Repository-relative paths of the change set.
 * @param {boolean} [input.changedOnly] - Drop files the change did not touch (ignored when it touched none).
 * @param {number} [input.limit]
 * @returns {{ gaps: object[], changed_files_in_report: number, scope: "changed" | "project" }}
 */
export function rankCoverageGaps({ files = [], changedFiles = [], changedOnly = true, limit = 20 } = {}) {
  const changed = new Set((changedFiles ?? []).map((item) => String(item).replaceAll("\\", "/")));
  const rows = (files ?? []).map((file) => {
    const touched = [...changed].some((item) => samePath(file.path, item));
    const uncovered = file.uncovered_lines.length;
    return {
      file: file.path,
      changed: touched,
      line_percent: percent(file.lines.hit, file.lines.found),
      covered_lines: file.lines.hit,
      uncovered_lines: uncovered,
      ranges: lineRanges(file.uncovered_lines),
      uncovered_functions: file.uncovered_functions
        .slice()
        .sort((left, right) => left.line - right.line)
        .slice(0, 10),
      // A file the change touched is where an untested line was most likely
      // just written, so it outranks a long-standing gap somewhere else.
      score: (touched ? 3 : 1) * (uncovered + file.uncovered_functions.length * 2)
    };
  }).filter((row) => row.uncovered_lines || row.uncovered_functions.length);

  const touchedRows = rows.filter((row) => row.changed);
  const scope = changedOnly && touchedRows.length ? "changed" : "project";
  const selected = scope === "changed" ? touchedRows : rows;
  return {
    scope,
    changed_files_in_report: touchedRows.length,
    gaps: selected
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)))
  };
}

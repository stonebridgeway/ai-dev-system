import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

/**
 * Change hygiene: a deterministic pre-completion review of the *changed* lines
 * in a repository. It ports the checks that Everything Claude Code runs from
 * hooks (commit-quality, governance secret capture, console.log audit, config
 * protection, verification-loop security phase) into one client-agnostic scan
 * that `verify_task` can bind to the current Git state.
 *
 * Severity model: `block` fails verification, `warn` is reported and expected
 * to be addressed or explained, `info` is advisory.
 */

export const SECRET_PATTERNS = Object.freeze([
  { id: "anthropic_key", severity: "block", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai_key", severity: "block", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/ },
  { id: "github_token", severity: "block", pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
  { id: "github_fine_grained_token", severity: "block", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: "aws_access_key", severity: "block", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "slack_token", severity: "block", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google_api_key", severity: "block", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "telegram_bot_token", severity: "block", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { id: "private_key_block", severity: "block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "jwt", severity: "warn", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: "generic_secret_assignment",
    severity: "block",
    pattern: /\b(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i,
    placeholderAware: true
  }
]);

/** Values that look like a secret but are a stand-in for one. Shared with the hooks through `patterns.json`. */
export const PLACEHOLDER_VALUE = /^(?:process\.env\.[A-Za-z0-9_]+|\$\{[^}]*\}|<[^<>]*>|\{\{[^}]*\}\}|REPLACE_?ME|CHANGE_?ME|YOUR[_-]?API[_-]?KEY|YOUR[_-]?KEY[_-]?HERE|YOUR[_-]?[A-Z_]*|API[_-]?KEY|SECRET|TOKEN|PASSWORD|KEY|TODO|TBD|FIXME|X{4,}|x{4,}|\*{4,}|\.{3,}|example|test|dummy|placeholder|changeme|redacted)$/i;

/** Files whose presence in a change set is itself a finding. */
export const SECRET_FILE_PATTERN = /(^|\/)(\.env(?!\.(?:example|sample|template|dist)$)(?:\.[^/]+)?|[^/]*\.(?:pem|key|p12|pfx|jks|keystore)|id_rsa|id_ed25519|[^/]*secrets?\.(?:json|ya?ml|toml)|credentials(?:\.json)?)$/i;

/** Linter/formatter/type-checker configs: editing them alongside code deserves review (ECC config-protection). */
export const PROTECTED_CONFIG_FILES = new Set([
  ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
  ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  "biome.json", "biome.jsonc", ".ruff.toml", "ruff.toml", "mypy.ini", ".flake8", "setup.cfg",
  "tsconfig.json", "tsconfig.base.json", "jsconfig.json",
  ".shellcheckrc", ".stylelintrc", ".stylelintrc.json", ".stylelintrc.yml",
  ".markdownlint.json", ".markdownlint.yaml", ".markdownlintrc", ".editorconfig"
]);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$|\.tests?\.py$/i;
/** Anything a reader of the project would consult: Markdown, reStructuredText, AsciiDoc, or a file under docs/. */
const DOCUMENTATION_PATH = /(^|\/)(?:docs?|documentation)\/|\.(?:md|mdx|rst|adoc|txt)$/i;
const VENDORED_PATH = /(^|\/)(?:node_modules|vendor|dist|build|out|target|coverage|\.venv|venv|__pycache__)\//i;
/** Shells and task runners: an interface is often declared here, but they are not "source" for the test rules. */
const INTERFACE_SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ps1"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php", ".rb", ".swift", ".vue", ".svelte"]);
const NON_SOURCE_PATH = /(^|\/)(docs?|documentation|examples?|scripts?|migrations|fixtures|\.ai-dev|\.github|\.claude|\.cursor|node_modules|dist|build)\//i;
const CONFIG_BASENAME = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|uv\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|tsconfig[^/]*\.json|.*\.config\.[cm]?[jt]s|.*rc(\.[a-z]+)?|\.gitignore|Dockerfile|docker-compose[^/]*\.ya?ml|Makefile|README(\.[a-z]+)?\.md)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const LARGE_FILE_LINES = 800;
/** Generated caches and QA artifacts are never part of the reviewed change set. */
/**
 * Server-generated project paths: compiled context, Frontend QA artifacts and
 * prepared pull-request text are outputs of this system, not part of the change
 * under review. Exported so every consumer of a change set skips the same paths.
 */
export const IGNORED_CHANGE_PATH = /(^|\/)\.ai-dev\/(context|frontend-qa|frontend-qa-baselines|artifacts|pr)\//i;

/** Debug and merge leftovers, one line each. Exported for the hooks, which read them from `patterns.json`. */
export const LEFTOVER_PATTERNS = Object.freeze([
  { id: "merge_conflict_marker", severity: "block", pattern: /^(?:<{7}|>{7})(?:\s|$)/, message: "Merge conflict marker left in the file." },
  { id: "test_only", severity: "block", pattern: /\b(?:describe|it|test|context)\.only\s*\(/, message: "A focused test (.only) would silently skip the rest of the suite.", languages: ["js"] },
  { id: "debugger_statement", severity: "block", pattern: /^\s*debugger\s*;?\s*$/, message: "debugger statement left in code.", languages: ["js"] },
  { id: "breakpoint_call", severity: "block", pattern: /\b(?:breakpoint\(\)|pdb\.set_trace\(\)|ipdb\.set_trace\(\))/, message: "Interactive debugger call left in code.", languages: ["py"] },
  { id: "skipped_test", severity: "warn", pattern: /\b(?:describe|it|test|context)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip\b|@unittest\.skip\b|t\.Skip\(/, message: "A test was skipped in this change; justify it or restore it." },
  { id: "console_log", severity: "warn", pattern: /\bconsole\.(?:log|debug|trace)\s*\(/, message: "console.log left in non-test code.", languages: ["js"], sourceOnly: true },
  { id: "print_debug", severity: "info", pattern: /^\s*print\((?:f?["'`])?(?:DEBUG|debug|>>>|xxx|here)/, message: "Debug print left in code.", languages: ["py"], sourceOnly: true },
  { id: "lint_suppression", severity: "warn", pattern: /eslint-disable(?!-next-line)|@ts-ignore|@ts-nocheck|#\s*noqa(?!:)|#\s*type:\s*ignore|#\s*pylint:\s*disable|#\s*nosec|\/\/\s*nolint/, message: "Lint/type suppression added; prefer fixing the code or narrow the suppression with a reason." },
  { id: "todo_without_reference", severity: "info", pattern: /\b(?:TODO|FIXME|HACK|XXX)\b(?![^\n]*(?:#\d+|[A-Z]{2,}-\d+|issue|ticket))/, message: "TODO/FIXME without an issue reference." },
  { id: "empty_catch", severity: "warn", pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)|\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/, message: "Empty catch swallows the error silently (silent failure)." },
  { id: "bare_except_pass", severity: "warn", pattern: /^\s*except(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:\s*(?:pass|\.\.\.)\s*$/, message: "except: pass hides failures (silent failure).", languages: ["py"] },
  { id: "hardcoded_localhost_url", severity: "info", pattern: /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/, message: "Hard-coded local URL; move to configuration if it is not test-only.", sourceOnly: true }
]);

/** Two-line leftovers: the first added line matches `first`, the next added line matches `second`. */
const LEFTOVER_PAIR_PATTERNS = Object.freeze([
  { id: "bare_except_pass", severity: "warn", first: /^\s*except(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:\s*$/, second: /^\s*(?:pass|\.\.\.)\s*$/, message: "except: pass hides failures (silent failure).", languages: ["py"] },
  { id: "empty_catch", severity: "warn", first: /catch\s*(?:\([^)]*\))?\s*\{\s*$/, second: /^\s*\}/, message: "Empty catch swallows the error silently (silent failure).", languages: ["js"] }
]);

/**
 * Signals that an added line widened or reshaped the surface other people code
 * against: a new export, a tool contract, a command-line flag. ECC keeps the
 * same list in `update-docs` and `living-docs-governance`, where the rule is
 * that a public change without a documentation change is a stale document.
 *
 * Only *declarations* match. A body line inside an exported function is not an
 * interface change, and passing `--no-color` to a subprocess is not a flag the
 * project offers, so neither fires the rule.
 */
export const PUBLIC_INTERFACE_PATTERNS = Object.freeze([
  { id: "export", pattern: /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|abstract)\b/, languages: ["js"] },
  { id: "export", pattern: /^\s*export\s*(?:\{|\*)/, languages: ["js"] },
  { id: "export", pattern: /^\s*(?:module\.exports\b|exports\.[A-Za-z_$][\w$]*\s*=)/, languages: ["js"] },
  { id: "export", pattern: /^(?:async\s+)?(?:def|class)\s+(?!_)[A-Za-z]/, languages: ["py"] },
  { id: "export", pattern: /^__all__\s*=/, languages: ["py"] },
  { id: "export", pattern: /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|mod)\b/, languages: ["rs"] },
  { id: "export", pattern: /^func\s+(?:\([^)]*\)\s*)?[A-Z]/, languages: ["go"] },
  { id: "export", pattern: /^\s*(?:public|protected)\s+(?:static\s+|final\s+|abstract\s+|async\s+)*(?:class|interface|enum|record|fun|func|var|val|[A-Za-z_<>\[\]]+\s+[A-Za-z_]\w*\s*\()/, languages: ["other"] },
  { id: "tool_schema", pattern: /\binputSchema\b|"inputSchema"/ },
  { id: "cli_flag", pattern: /(?:\.option|\.addOption|\.argument|add_argument|\.flag|StringVar|BoolVar|IntVar)\s*\(\s*["'`]?-{1,2}[A-Za-z]/ },
  { id: "cli_flag", pattern: /(?:case|===|==|\.includes|\.has|startsWith)\s*\(?\s*["'`]--[a-z][a-z0-9-]*["'`]/ }
]);

/** Human-readable name of each interface signal, for the `docs_stale` message. */
const INTERFACE_SIGNAL_LABELS = Object.freeze({ export: "exports", tool_schema: "tool schemas", cli_flag: "CLI flags" });

function languageOf(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"].includes(extension)) return "js";
  if (extension === ".py") return "py";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rs";
  return "other";
}

function isTestPath(relativePath) {
  return TEST_PATH.test(relativePath);
}

function isSourcePath(relativePath) {
  const base = path.basename(relativePath);
  return SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    && !isTestPath(relativePath)
    && !NON_SOURCE_PATH.test(relativePath)
    && !CONFIG_BASENAME.test(base);
}

/** A file a reader consults rather than runs: the counterpart of an interface change. */
function isDocumentationPath(relativePath) {
  return DOCUMENTATION_PATH.test(relativePath);
}

/**
 * Files whose added lines are searched for interface signals: code, including
 * the scripts an interface is usually declared in, but not tests, not vendored
 * trees, and not documentation. Data files are left out — a schema key in JSON
 * is as often a fixture as a contract.
 */
function isInterfaceCandidate(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return (SOURCE_EXTENSIONS.has(extension) || INTERFACE_SCRIPT_EXTENSIONS.has(extension))
    && !isTestPath(relativePath)
    && !isDocumentationPath(relativePath)
    && !VENDORED_PATH.test(relativePath);
}

/**
 * The interface signals an added line carries, if any.
 *
 * @param {string} line
 * @param {string} language - Result of {@link languageOf}.
 * @returns {string[]} Signal ids: `export`, `tool_schema`, `cli_flag`.
 */
export function findInterfaceSignals(line, language = "other") {
  const text = String(line ?? "");
  const signals = new Set();
  for (const rule of PUBLIC_INTERFACE_PATTERNS) {
    if (rule.languages && !rule.languages.includes(language)) continue;
    if (rule.pattern.test(text)) signals.add(rule.id);
  }
  return [...signals];
}

function mask(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} chars)`;
}

function excerpt(line) {
  const text = String(line ?? "").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * Scan one line for secrets. Exported for reuse by hooks and tests.
 *
 * @param {string} line
 * @returns {Array<{ id: string, severity: string, masked: string }>}
 */
export function findSecretsInLine(line) {
  const text = String(line ?? "");
  const hits = [];
  for (const rule of SECRET_PATTERNS) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    if (rule.placeholderAware) {
      const value = match[1] ?? "";
      if (PLACEHOLDER_VALUE.test(value) || /^[A-Z_]{6,}$/.test(value)) continue;
    }
    hits.push({ id: rule.id, severity: rule.severity, masked: mask(match[1] ?? match[0]) });
  }
  return hits;
}

async function git(projectRoot, args, maxOutputBytes = 8 * 1024 * 1024) {
  try {
    return await runProcess({
      executable: "git",
      args: ["-C", projectRoot, ...args],
      cwd: projectRoot,
      timeoutMs: 30_000,
      maxOutputBytes
    });
  } catch {
    return { ok: false, exitCode: null, stdout: "", stderr: "" };
  }
}

/**
 * Parse `git diff --unified=0` output into added lines per file.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<{ line: number, text: string }>>}
 */
export function parseAddedLines(diffText) {
  const files = new Map();
  let currentPath = null;
  let lineNumber = 0;
  let skipFile = false;
  for (const raw of String(diffText ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null;
      skipFile = false;
      continue;
    }
    if (raw.startsWith("Binary files ")) {
      skipFile = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null") {
        skipFile = true;
        continue;
      }
      currentPath = target.replace(/^b\//, "").replace(/^"|"$/g, "");
      if (!files.has(currentPath)) files.set(currentPath, []);
      continue;
    }
    if (skipFile || !currentPath) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      files.get(currentPath).push({ line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // removed line: new-file numbering does not advance
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (!raw.startsWith("---")) {
      lineNumber += 1;
    }
  }
  return files;
}

async function readAddedLinesFromFile(projectRoot, relativePath) {
  const target = path.join(projectRoot, ...relativePath.split("/"));
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isFile() || stats.size > MAX_FILE_BYTES) return { lines: [], skipped: stats ? "too large" : "missing" };
  const content = await fs.readFile(target, "utf8").catch(() => "");
  if (content.includes(" ")) return { lines: [], skipped: "binary" };
  return {
    lines: content.split(/\r?\n/).map((text, index) => ({ line: index + 1, text })),
    skipped: ""
  };
}

async function countLines(projectRoot, relativePath) {
  const target = path.join(projectRoot, ...relativePath.split("/"));
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isFile() || stats.size > MAX_FILE_BYTES) return null;
  const content = await fs.readFile(target, "utf8").catch(() => "");
  return content ? content.split(/\r?\n/).length : 0;
}

/**
 * Collect the change set of a repository: modified/added tracked files diffed
 * against `baseRef` (default `HEAD`, i.e. uncommitted work) plus untracked files
 * read in full. Only added lines are returned so pre-existing problems are not
 * blamed on the current task.
 *
 * @param {string} projectRoot
 * @param {{ baseRef?: string, maxFiles?: number }} [options]
 * @returns {Promise<{ git: boolean, base_ref: string, files: Array<{ path: string, kind: string, added: Array<{ line: number, text: string }>, skipped?: string }>, truncated: boolean }>}
 */
export async function collectChangeSet(projectRoot, { baseRef = "HEAD", maxFiles = 200 } = {}) {
  const root = path.resolve(projectRoot);
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return { git: false, base_ref: baseRef, files: [], truncated: false };
  const untracked = [];
  const deleted = new Set();
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim().replace(/^"|"$/g, "").split(" -> ").at(-1);
    if (code === "??") untracked.push(filePath);
    if (code.includes("D")) deleted.add(filePath);
  }
  const diff = await git(root, ["diff", "--unified=0", "--no-color", "--no-ext-diff", baseRef, "--"]);
  const added = diff.ok ? parseAddedLines(diff.stdout) : new Map();
  const files = [];
  for (const [filePath, lines] of added) {
    if (deleted.has(filePath) || IGNORED_CHANGE_PATH.test(filePath)) continue;
    files.push({ path: filePath, kind: "modified", added: lines });
  }
  for (const filePath of untracked) {
    if (IGNORED_CHANGE_PATH.test(filePath)) continue;
    if (SECRET_FILE_PATTERN.test(filePath)) {
      files.push({ path: filePath, kind: "untracked", added: [], skipped: "secret file" });
      continue;
    }
    const read = await readAddedLinesFromFile(root, filePath);
    files.push({ path: filePath, kind: "untracked", added: read.lines, skipped: read.skipped });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const limit = Math.max(1, Math.min(Number(maxFiles) || 200, 2000));
  return {
    git: true,
    base_ref: baseRef,
    files: files.slice(0, limit),
    truncated: files.length > limit
  };
}

/**
 * One hygiene finding in the single shape every consumer speaks — the tool
 * response, the Markdown projection, the docs and the `verification-loop`
 * skill: `{ rule, severity, file, line, message, excerpt }`. `excerpt` is
 * always present (empty when the finding is about the file, not a line);
 * aggregate findings may add a `files` list after it.
 *
 * @param {"block" | "warn" | "info"} severity
 * @param {string} rule - Rule id, for example `console_log` or `secret:jwt`.
 * @param {string} file - Repository-relative path; empty for change-set-wide findings.
 * @param {number} line - 1-based line in the new file; 0 when not line-bound.
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ rule: string, severity: string, file: string, line: number, message: string, excerpt: string }}
 */
function finding(severity, rule, file, line, message, extra = {}) {
  return { rule, severity, file, line, message, excerpt: "", ...extra };
}

/** The keys every finding carries, in order. Exported for the schema test. */
export const FINDING_FIELDS = Object.freeze(["rule", "severity", "file", "line", "message", "excerpt"]);

/**
 * Run every hygiene rule over a change set produced by {@link collectChangeSet}.
 *
 * @param {ReturnType<typeof collectChangeSet> extends Promise<infer T> ? T : never} changeSet
 * @param {{ projectRoot?: string, lineCounts?: Record<string, number> }} [options]
 * @returns {{ status: "pass" | "warn" | "block", findings: Array<{ rule: string, severity: string, file: string, line: number, message: string, excerpt: string }>, summary: object }}
 */
export function analyzeChangeSet(changeSet, { lineCounts = {} } = {}) {
  const findings = [];
  const sourceFiles = [];
  const testFiles = [];
  const documentationFiles = [];
  const interfaceFiles = new Set();
  const interfaceSignals = new Set();
  for (const file of changeSet.files ?? []) {
    const relativePath = file.path;
    const base = path.basename(relativePath);
    const language = languageOf(relativePath);
    const test = isTestPath(relativePath);
    const source = isSourcePath(relativePath);
    const interfaceCandidate = isInterfaceCandidate(relativePath);
    if (source) sourceFiles.push(relativePath);
    if (test) testFiles.push(relativePath);
    if (isDocumentationPath(relativePath)) documentationFiles.push(relativePath);

    if (SECRET_FILE_PATTERN.test(relativePath)) {
      findings.push(finding("block", "secret_file_in_change_set", relativePath, 0,
        "A secret-bearing file is part of the change set. Keep it out of Git and use environment variables or a secret manager."));
    }
    if (PROTECTED_CONFIG_FILES.has(base)) {
      findings.push(finding("warn", "protected_config_changed", relativePath, 0,
        "Linter/formatter/type-checker configuration changed together with code. Confirm the change does not just suppress violations."));
    }
    const lines = lineCounts[relativePath];
    if (Number.isFinite(lines) && lines > LARGE_FILE_LINES && source) {
      findings.push(finding("info", "large_file", relativePath, 0,
        `File has ${lines} lines (guideline: keep files under ${LARGE_FILE_LINES} lines; split by feature).`));
    }

    const addedLines = file.added ?? [];
    for (const [index, { line, text }] of addedLines.entries()) {
      const next = addedLines[index + 1];
      if (interfaceCandidate) {
        for (const signal of findInterfaceSignals(text, language)) {
          interfaceFiles.add(relativePath);
          interfaceSignals.add(signal);
        }
      }
      for (const rule of LEFTOVER_PAIR_PATTERNS) {
        if (rule.languages && !rule.languages.includes(language)) continue;
        if (!next || next.line !== line + 1) continue;
        if (rule.first.test(text) && rule.second.test(next.text)) {
          findings.push(finding(rule.severity, rule.id, relativePath, line, rule.message, { excerpt: excerpt(`${text} / ${next.text}`) }));
        }
      }
      for (const secret of findSecretsInLine(text)) {
        findings.push(finding(secret.severity, `secret:${secret.id}`, relativePath, line,
          `Possible ${secret.id.replaceAll("_", " ")} in added code (${secret.masked}). Rotate it if real and load it from the environment.`));
      }
      for (const rule of LEFTOVER_PATTERNS) {
        if (rule.languages && !rule.languages.includes(language)) continue;
        if (rule.sourceOnly && (test || !source)) continue;
        if (rule.id === "skipped_test" && !test && language === "other") continue;
        if (!rule.pattern.test(text)) continue;
        findings.push(finding(rule.severity, rule.id, relativePath, line, rule.message, { excerpt: excerpt(text) }));
      }
    }
  }

  const untestedSources = sourceFiles.filter((filePath) => {
    const stem = path.basename(filePath).replace(/\.[^.]+$/, "").toLowerCase();
    return !testFiles.some((testPath) => testPath.toLowerCase().includes(stem));
  });
  if (sourceFiles.length && !testFiles.length) {
    findings.push(finding("warn", "no_test_changes", "", 0,
      `${sourceFiles.length} source file(s) changed but no test file changed. Add or update a focused test, or record why none is needed.`,
      { files: sourceFiles.slice(0, 20) }));
  } else if (untestedSources.length) {
    findings.push(finding("info", "sources_without_matching_test", "", 0,
      "Changed source files with no test file naming them in this change set.",
      { files: untestedSources.slice(0, 20) }));
  }

  if (interfaceFiles.size && !documentationFiles.length) {
    const signals = [...interfaceSignals].map((signal) => INTERFACE_SIGNAL_LABELS[signal] ?? signal);
    findings.push(finding("warn", "docs_stale", "", 0,
      `The public interface changed (${signals.join(", ")}) but no documentation file changed. Update the README or docs/, or record in the checkpoint note why the change is internal.`,
      { files: [...interfaceFiles].slice(0, 20) }));
  }

  const counts = { block: 0, warn: 0, info: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] || 0) + 1;
  const status = counts.block ? "block" : counts.warn ? "warn" : "pass";
  return {
    status,
    findings: findings.sort((left, right) => (
      ["block", "warn", "info"].indexOf(left.severity) - ["block", "warn", "info"].indexOf(right.severity)
      || left.file.localeCompare(right.file)
      || left.line - right.line
    )),
    summary: {
      files_changed: (changeSet.files ?? []).length,
      source_files: sourceFiles.length,
      test_files: testFiles.length,
      documentation_files: documentationFiles.length,
      interface_files: interfaceFiles.size,
      added_lines: (changeSet.files ?? []).reduce((sum, file) => sum + (file.added?.length ?? 0), 0),
      ...counts,
      truncated: Boolean(changeSet.truncated)
    }
  };
}

/**
 * Collect and analyze the current change set of a repository.
 *
 * @param {string} projectRoot
 * @param {{ baseRef?: string, maxFiles?: number }} [options]
 * @returns {Promise<{ status: string, findings: Array<{ rule: string, severity: string, file: string, line: number, message: string, excerpt: string }>, summary: object, base_ref: string, git: boolean, files: string[] }>}
 */
export async function verifyChangeHygiene(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const changeSet = await collectChangeSet(root, options);
  if (!changeSet.git) {
    return {
      status: "pass",
      git: false,
      base_ref: options.baseRef || "HEAD",
      files: [],
      findings: [],
      summary: { files_changed: 0, note: "Not a Git repository: hygiene scan skipped." }
    };
  }
  const lineCounts = {};
  for (const file of changeSet.files) {
    if (isSourcePath(file.path)) {
      const count = await countLines(root, file.path);
      if (count !== null) lineCounts[file.path] = count;
    }
  }
  const analysis = analyzeChangeSet(changeSet, { lineCounts });
  return {
    ...analysis,
    git: true,
    base_ref: changeSet.base_ref,
    files: changeSet.files.map((file) => file.path)
  };
}

/**
 * Markdown projection for reports and task notes.
 *
 * @param {{ status: string, findings: Array<{ rule: string, severity: string, file: string, line: number, message: string }>, summary: object }} result
 * @returns {string}
 */
export function renderChangeHygieneMarkdown(result) {
  const lines = [
    `Status: ${result.status}`,
    "",
    `Files changed: ${result.summary?.files_changed ?? 0}; added lines: ${result.summary?.added_lines ?? 0}; block: ${result.summary?.block ?? 0}; warn: ${result.summary?.warn ?? 0}; info: ${result.summary?.info ?? 0}`,
    ""
  ];
  if (!result.findings?.length) {
    lines.push("- No hygiene findings.");
    return lines.join("\n");
  }
  for (const item of result.findings) {
    const location = item.file ? `\`${item.file}${item.line ? `:${item.line}` : ""}\` ` : "";
    lines.push(`- [${item.severity}] ${item.rule}: ${location}${item.message}`);
  }
  return lines.join("\n");
}

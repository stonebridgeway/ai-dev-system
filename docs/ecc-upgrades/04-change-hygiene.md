# 04. Гигиена изменений: сканер диффа внутри `verify_task`

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01.

## Идея из ECC

В ECC это несколько хуков: `check-console-log`, `secret-capture`, `config-protection`,
`block-no-verify`, проверка `.only`/`.skip`, TODO/FIXME. Здесь они собраны в один детерминированный
анализ добавленных строк (`git diff -U0`), который:

- **блокирует** (`status: "block"`): ключи провайдеров (`sk-ant-…`, `sk-…`, `ghp_…`, `github_pat_…`,
  `AKIA…`, `xox…`, `AIza…`, токен Telegram-бота), блоки private key, присваивания вида
  `password|api_key|secret|token = "…"`, секретные файлы в change set (`.env`, `*.pem`, `id_rsa`, …),
  маркеры конфликтов, `debugger`/`breakpoint()`/`pdb.set_trace()`, `.only(`;
- **предупреждает** (`warn`): JWT в коде, пропущенные тесты (`.skip`, `xit`, `@pytest.mark.skip`),
  `console.log` в не-тестовом коде, подавления линтера (`eslint-disable`, `@ts-ignore`, `noqa`, `nosec`),
  пустой `catch {}` и `except: pass` (в том числе двухстрочные), отсутствие тестовых изменений в диффе;
- **информирует** (`info`): debug-`print`, TODO/FIXME без ссылки на issue, захардкоженный localhost,
  файлы > 800 строк, исходники без парного теста;
- пропускает служебные пути (`.ai-dev/context`, артефакты `frontend-qa`, lock-файлы, минифицированные
  и бинарные файлы).

`verify_task` получил параметры `run_hygiene=true` и `hygiene_base_ref="HEAD"` и добавляет
проверку типа `change_hygiene`; `block` проваливает верификацию. Отдельный инструмент
`verify_change_hygiene` можно звать до коммита без задачи.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/change-hygiene.mjs`** (442 строк)

```js
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

const PLACEHOLDER_VALUE = /^(?:process\.env\.[A-Za-z0-9_]+|\$\{[^}]*\}|<[^<>]*>|\{\{[^}]*\}\}|REPLACE_?ME|CHANGE_?ME|YOUR[_-]?API[_-]?KEY|YOUR[_-]?KEY[_-]?HERE|YOUR[_-]?[A-Z_]*|API[_-]?KEY|SECRET|TOKEN|PASSWORD|KEY|TODO|TBD|FIXME|X{4,}|x{4,}|\*{4,}|\.{3,}|example|test|dummy|placeholder|changeme|redacted)$/i;

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
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php", ".rb", ".swift", ".vue", ".svelte"]);
const NON_SOURCE_PATH = /(^|\/)(docs?|documentation|examples?|scripts?|migrations|fixtures|\.ai-dev|\.github|\.claude|\.cursor|node_modules|dist|build)\//i;
const CONFIG_BASENAME = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|uv\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|tsconfig[^/]*\.json|.*\.config\.[cm]?[jt]s|.*rc(\.[a-z]+)?|\.gitignore|Dockerfile|docker-compose[^/]*\.ya?ml|Makefile|README(\.[a-z]+)?\.md)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const LARGE_FILE_LINES = 800;
/** Generated caches and QA artifacts are never part of the reviewed change set. */
const IGNORED_CHANGE_PATH = /(^|\/)\.ai-dev\/(context|frontend-qa|frontend-qa-baselines|artifacts)\//i;

const LEFTOVER_PATTERNS = Object.freeze([
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
  for (const file of changeSet.files ?? []) {
    const relativePath = file.path;
    const base = path.basename(relativePath);
    const language = languageOf(relativePath);
    const test = isTestPath(relativePath);
    const source = isSourcePath(relativePath);
    if (source) sourceFiles.push(relativePath);
    if (test) testFiles.push(relativePath);

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
```

**Файл: `ai-dev-mcp-server/src/core/change-hygiene.test.mjs`** (210 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  FINDING_FIELDS,
  analyzeChangeSet,
  collectChangeSet,
  findSecretsInLine,
  parseAddedLines,
  renderChangeHygieneMarkdown,
  verifyChangeHygiene
} from "./change-hygiene.mjs";

// Fixture secrets are assembled at runtime so the repository's own secret scan
// never sees a literal token in this file.
const fakeAwsKey = ["AKIA", "IOSFODNN7EXAMPL", "E"].join("");
const fakeGithubToken = ["ghp_", "a".repeat(36)].join("");
const fakeAssignment = ["password", " = ", "\"correct-horse-battery-staple\""].join("");

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function gitFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-hygiene-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.js"), "export const app = 1;\nexport const two = 2;\n");
  await fs.writeFile(path.join(root, "README.md"), "# fixture\n");
  runGit(root, ["init", "-q"]);
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=Hygiene", "-c", "user.email=hygiene@example.invalid", "commit", "-q", "-m", "init"]);
  return root;
}

test("findSecretsInLine detects real secrets and ignores placeholders", () => {
  assert.deepEqual(findSecretsInLine(`const key = "${fakeAwsKey}";`).map((hit) => hit.id), ["aws_access_key"]);
  assert.deepEqual(findSecretsInLine(`Authorization: token ${fakeGithubToken}`).map((hit) => hit.id), ["github_token"]);
  assert.equal(findSecretsInLine(fakeAssignment).length, 1);
  assert.equal(findSecretsInLine(fakeAssignment)[0].masked.includes("correct-horse"), false);
  assert.equal(findSecretsInLine("password = process.env.PASSWORD").length, 0);
  assert.equal(findSecretsInLine("api_key: \"<your-api-key>\"").length, 0);
  assert.equal(findSecretsInLine("token = \"REPLACE_ME\"").length, 0);
  assert.equal(findSecretsInLine("secret: \"${SECRET}\"").length, 0);
});

test("parseAddedLines tracks new-file line numbers across hunks and skips deletions", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,0 +2,2 @@",
    "+added two",
    "+added three",
    "@@ -10 +12 @@",
    "-old",
    "+replacement",
    "diff --git a/gone.js b/gone.js",
    "--- a/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "Binary files differ",
    ""
  ].join("\n");
  const parsed = parseAddedLines(diff);
  assert.deepEqual([...parsed.keys()], ["src/a.js"]);
  assert.deepEqual(parsed.get("src/a.js"), [
    { line: 2, text: "added two" },
    { line: 3, text: "added three" },
    { line: 12, text: "replacement" }
  ]);
});

test("analyzeChangeSet reports leftovers, secrets, protected configs, and missing tests", () => {
  const result = analyzeChangeSet({
    files: [
      { path: "src/service.ts", kind: "modified", added: [
        { line: 3, text: "  console.log(\"debug\")" },
        { line: 4, text: "  debugger" },
        { line: 5, text: "  } catch (error) {}" },
        { line: 6, text: "  // TODO clean this up" },
        { line: 7, text: `  const secret = "${fakeGithubToken}";` },
        { line: 8, text: "<<<<<<< HEAD" }
      ] },
      { path: "src/service.test.ts", kind: "untracked", added: [{ line: 1, text: "it.only(\"works\", () => {})" }] },
      { path: ".eslintrc.json", kind: "modified", added: [{ line: 1, text: "{ \"rules\": {} }" }] },
      { path: ".env", kind: "untracked", added: [], skipped: "secret file" },
      { path: "src/handler.py", kind: "modified", added: [
        { line: 1, text: "except Exception:" },
        { line: 2, text: "    pass" },
        { line: 3, text: "breakpoint()" }
      ] }
    ]
  }, { lineCounts: { "src/service.ts": 950 } });
  const rules = new Set(result.findings.map((item) => item.rule));
  for (const expected of [
    "console_log", "debugger_statement", "empty_catch", "todo_without_reference", "secret:github_token",
    "merge_conflict_marker", "test_only", "protected_config_changed", "secret_file_in_change_set",
    "bare_except_pass", "breakpoint_call", "large_file", "sources_without_matching_test"
  ]) {
    assert.ok(rules.has(expected), `missing finding ${expected}`);
  }
  assert.equal(result.status, "block");
  assert.equal(result.findings[0].severity, "block");
  assert.ok(result.summary.block >= 5);
  assert.match(renderChangeHygieneMarkdown(result), /\[block\] merge_conflict_marker: `src\/service\.ts:8`/);

  const clean = analyzeChangeSet({ files: [{ path: "src/ok.ts", kind: "modified", added: [{ line: 1, text: "export const ok = true;" }] }] });
  assert.equal(clean.status, "warn");
  assert.deepEqual(clean.findings.map((item) => item.rule), ["no_test_changes"]);
  const withTests = analyzeChangeSet({ files: [
    { path: "src/ok.ts", kind: "modified", added: [{ line: 1, text: "export const ok = true;" }] },
    { path: "src/ok.test.ts", kind: "modified", added: [{ line: 1, text: "test(\"ok\", () => {});" }] }
  ] });
  assert.equal(withTests.status, "pass");
  assert.equal(renderChangeHygieneMarkdown(withTests).includes("No hygiene findings"), true);
});

test("every finding uses the documented { rule, severity, file, line, message, excerpt } shape", () => {
  const result = analyzeChangeSet({
    files: [
      { path: "src/service.ts", kind: "modified", added: [
        { line: 4, text: "console.log(\"debug\");" },
        { line: 5, text: `const token = "${fakeGithubToken}";` },
        { line: 6, text: "<<<<<<< HEAD" }
      ] },
      { path: ".eslintrc.json", kind: "modified", added: [{ line: 1, text: "{ \"rules\": {} }" }] },
      { path: ".env", kind: "untracked", added: [], skipped: "secret file" }
    ]
  }, { lineCounts: { "src/service.ts": 950 } });

  assert.ok(result.findings.length >= 6);
  const severities = new Set(["block", "warn", "info"]);
  for (const item of result.findings) {
    assert.deepEqual(Object.keys(item).slice(0, FINDING_FIELDS.length), [...FINDING_FIELDS],
      `finding ${item.rule ?? "?"} must start with the canonical fields`);
    assert.equal(typeof item.rule, "string");
    assert.ok(item.rule.length > 0);
    assert.ok(severities.has(item.severity), `unknown severity ${item.severity}`);
    assert.equal(typeof item.file, "string");
    assert.equal(typeof item.line, "number");
    assert.ok(Number.isInteger(item.line) && item.line >= 0);
    assert.equal(typeof item.message, "string");
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.excerpt, "string");
    for (const legacy of ["code", "path"]) {
      assert.equal(legacy in item, false, `finding ${item.rule} still carries the old field ${legacy}`);
    }
    for (const key of Object.keys(item).slice(FINDING_FIELDS.length)) {
      assert.ok(["files"].includes(key), `unexpected extra finding field ${key}`);
    }
  }

  const lineBound = result.findings.find((item) => item.rule === "console_log");
  assert.equal(lineBound.file, "src/service.ts");
  assert.equal(lineBound.line, 4);
  assert.equal(lineBound.excerpt, "console.log(\"debug\");");
  const fileBound = result.findings.find((item) => item.rule === "secret_file_in_change_set");
  assert.equal(fileBound.file, ".env");
  assert.equal(fileBound.line, 0);
  assert.equal(fileBound.excerpt, "");
  const changeSetWide = result.findings.find((item) => item.rule === "no_test_changes");
  assert.equal(changeSetWide.file, "");
  assert.deepEqual(changeSetWide.files, ["src/service.ts"]);
});

test("collectChangeSet and verifyChangeHygiene use git added lines and untracked files", async (t) => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, "src", "app.js"), "export const app = 1;\nconsole.log(\"x\");\nexport const two = 2;\n");
  await fs.writeFile(path.join(root, "src", "new.js"), `export const token = "${fakeAwsKey}";\n`);
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");

  const changeSet = await collectChangeSet(root);
  assert.equal(changeSet.git, true);
  assert.deepEqual(changeSet.files.map((file) => `${file.kind}:${file.path}`), [
    "untracked:.env", "modified:src/app.js", "untracked:src/new.js"
  ]);
  assert.deepEqual(changeSet.files[1].added, [{ line: 2, text: "console.log(\"x\");" }]);
  assert.equal(changeSet.files[0].skipped, "secret file");

  const result = await verifyChangeHygiene(root);
  assert.equal(result.status, "block");
  const rules = result.findings.map((item) => item.rule);
  assert.ok(rules.includes("secret:aws_access_key"));
  assert.ok(rules.includes("secret_file_in_change_set"));
  assert.ok(rules.includes("console_log"));
  assert.deepEqual(result.files, [".env", "src/app.js", "src/new.js"]);

  // Committed work compared against an explicit base ref is still covered.
  await fs.rm(path.join(root, ".env"));
  runGit(root, ["add", "."]);
  runGit(root, ["-c", "user.name=Hygiene", "-c", "user.email=hygiene@example.invalid", "commit", "-q", "-m", "feat: work"]);
  const head = await verifyChangeHygiene(root);
  assert.equal(head.findings.length, 0, "nothing uncommitted");
  const branch = await verifyChangeHygiene(root, { baseRef: "HEAD~1" });
  assert.ok(branch.findings.some((item) => item.rule === "secret:aws_access_key"));

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "change-hygiene-plain-"));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  const nonGit = await verifyChangeHygiene(plain);
  assert.equal(nonGit.git, false);
  assert.equal(nonGit.status, "pass");
});
```

> Тесты строят «секреты» динамически (конкатенацией), иначе `scripts/security-check.mjs` находит их
> в исходниках. Сохраняйте этот приём при доработке.

**Файл: `ai-dev-mcp-server/src/extensions/hygiene.mjs`** (70 строк)

```js
import { renderChangeHygieneMarkdown, verifyChangeHygiene } from "../core/change-hygiene.mjs";

/**
 * Change hygiene tool: a deterministic review of added lines (secrets, debug
 * leftovers, focused/skipped tests, conflict markers, protected config edits,
 * missing test changes). `verify_task` runs the same scan automatically; this
 * tool lets the agent run it early and often.
 *
 * @param {{ resolveProjectIdentity: Function, taskStore: { read: Function, checkpoint: Function } }} host
 */
export function createHygieneTools(host) {
  return {
    definitions: [
      {
        name: "verify_change_hygiene",
        description: "Scan the current change set (uncommitted work, or everything since base_ref) for secrets, debug leftovers, focused or skipped tests, merge-conflict markers, weakened lint configs, oversized files, and source changes without test changes. Each finding is { rule, severity, file, line, message, excerpt } with severity block, warn, or info.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task whose project is scanned; a checkpoint note with the summary is added." },
            base_ref: { type: "string", default: "HEAD", description: "Git ref to diff against. Use the branch base (for example main) to include committed work." },
            max_files: { type: "number", default: 200 },
            record_checkpoint: { type: "boolean", default: false, description: "Attach the summary to the task as a checkpoint note." }
          }
        }
      }
    ],
    handlers: {
      async verify_change_hygiene(args) {
        let projectRoot;
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          projectRoot = (await host.resolveProjectIdentity(record.project.path)).project_root;
        } else if (args.project_path) {
          projectRoot = (await host.resolveProjectIdentity(args.project_path)).project_root;
        } else {
          throw new Error("project_path or task_id is required.");
        }
        const result = await verifyChangeHygiene(projectRoot, {
          baseRef: args.base_ref || "HEAD",
          maxFiles: args.max_files
        });
        const markdown = renderChangeHygieneMarkdown(result);
        let checkpoint = null;
        if (record && args.record_checkpoint && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Change hygiene: ${result.status} (${result.summary?.block ?? 0} block, ${result.summary?.warn ?? 0} warn)`,
            changedFiles: result.files,
            notes: markdown
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        return {
          project_path: projectRoot,
          ...result,
          markdown,
          checkpoint,
          next_step: result.status === "block"
            ? "Fix every block finding (rotate real secrets, remove leftovers) before verify_task."
            : result.status === "warn"
              ? "Address or explicitly justify the warnings in your checkpoint notes."
              : "No hygiene issues; continue with verify_task."
        };
      }
    },
    readOnly: []
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/hygiene.test.mjs`** (61 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { FINDING_FIELDS } from "../core/change-hygiene.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createHygieneTools } from "./hygiene.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

test("verify_change_hygiene scans a task project and can checkpoint the summary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "index.js"), "export const a = 1;\n");
  runGit(projectRoot, ["init", "-q"]);
  runGit(projectRoot, ["add", "."]);
  runGit(projectRoot, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createHygieneTools]);
  const task = await taskStore.begin({
    task: "Add feature",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "a" }
  });

  const clean = await registry.handlers.get("verify_change_hygiene")({ project_path: projectRoot });
  assert.equal(clean.status, "pass");
  assert.equal(clean.findings.length, 0);

  await fs.writeFile(path.join(projectRoot, "src", "index.js"), "export const a = 1;\nconsole.log(a);\n");
  const dirty = await registry.handlers.get("verify_change_hygiene")({ task_id: task.id, record_checkpoint: true });
  assert.equal(dirty.status, "warn");
  const leftover = dirty.findings.find((item) => item.rule === "console_log");
  // The response schema every consumer reads: docs, the verification-loop skill, task notes.
  assert.deepEqual(Object.keys(leftover), [...FINDING_FIELDS]);
  assert.equal(leftover.file, "src/index.js");
  assert.equal(leftover.line, 2);
  assert.equal(leftover.severity, "warn");
  assert.equal(leftover.excerpt, "console.log(a);");
  assert.ok(dirty.findings.some((item) => item.rule === "no_test_changes"));
  assert.equal(dirty.checkpoint.checkpoints, 1);
  assert.match(dirty.markdown, /console_log/);
  const updated = await taskStore.read(task.id);
  assert.match(updated.checkpoints[0].summary, /Change hygiene: warn/);
  assert.deepEqual(updated.checkpoints[0].changed_files, ["src/index.js"]);
  await assert.rejects(registry.handlers.get("verify_change_hygiene")({}), /project_path or task_id is required/);
});
```

## Изменения существующих файлов

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index 8374428..9239d92 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -52,6 +52,7 @@ import {
   contextPackFreshness
 } from "./core/context-compiler.mjs";
 import { loadContextExtras } from "./core/context-extras.mjs";
+import { verifyChangeHygiene } from "./core/change-hygiene.mjs";
 import {
   DIAGRAM_REQUEST_PATTERN,
   prioritizeRoutedRecommendations,
@@ -8471,6 +8472,7 @@ function verificationPassed(checks) {
     if (item.type === "frontend_qa") return item.result?.gate === "pass";
     if (item.type === "frontend_product") return item.result?.ok === true;
     if (item.type === "archify_deliver" || item.type === "archify_visual_check") return item.result?.ok === true;
+    if (item.type === "change_hygiene") return item.result?.status !== "block";
     return false;
   });
 }
@@ -8495,6 +8497,8 @@ async function verifyTask({
   quality_labels = [],
   run_frontend = false,
   frontend_options = {},
+  run_hygiene = true,
+  hygiene_base_ref = "HEAD",
   evidence = []
 }) {
   const record = await taskStore.read(task_id);
@@ -8593,6 +8597,7 @@ async function verifyTask({
     }
   }
 
+  if (run_hygiene) checks.push({ type: "change_hygiene", result: await verifyChangeHygiene(projectRoot, { baseRef: hygiene_base_ref }) });
   const projectState = await captureProjectState(projectRoot);
   const passed = verificationPassed(checks);
   const verification = {
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-definitions.mjs b/ai-dev-mcp-server/src/tool-definitions.mjs
index 16a42f4..9f85e34 100644
--- a/ai-dev-mcp-server/src/tool-definitions.mjs
+++ b/ai-dev-mcp-server/src/tool-definitions.mjs
@@ -1689,6 +1689,8 @@ export function buildToolDefinitions({
         quality_labels: { type: "array", items: { type: "string" }, default: [] },
         run_frontend: { type: "boolean", default: false },
         frontend_options: { type: "object", additionalProperties: true, default: {} },
+        run_hygiene: { type: "boolean", default: true, description: "Scan added lines for secrets, debug leftovers, focused/skipped tests, conflict markers, weakened lint configs, and missing test changes. A block finding fails verification." },
+        hygiene_base_ref: { type: "string", default: "HEAD", description: "Git ref the hygiene scan diffs against; use the branch base (for example main) to include committed work." },
         evidence: ARCHIFY_EVIDENCE_SCHEMA
       },
       required: ["task_id"]
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index 240ad05..879c71d 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -21,10 +21,12 @@
  */
 
 import { createDecisionTools } from "./extensions/decisions.mjs";
+import { createHygieneTools } from "./extensions/hygiene.mjs";
 import { createUsageTools } from "./extensions/usage.mjs";
 
 export const EXTENSION_FACTORIES = [
   createDecisionTools,
+  createHygieneTools,
   createUsageTools
 ];
 
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/change-hygiene.test.mjs src/extensions/hygiene.test.mjs
node scripts/security-check.mjs
node scripts/lifecycle-smoke.mjs   # verify_task теперь содержит check type=change_hygiene
```

## Использование

```json
{ "tool": "verify_change_hygiene", "args": { "project_path": "/repo", "base_ref": "main" } }
```

Ответ: `{ status: "pass"|"warn"|"block", findings: [{ rule, severity, file, line, message, excerpt }], summary, files }`.
Поля находки всегда те же шесть; `excerpt` пуст, когда находка про файл, а не про строку, а находки
обо всём change set (`no_test_changes`, `sources_without_matching_test`) дополнительно несут `files`.
Одну и ту же форму читают документация, скилл `verification-loop` и Markdown-проекция.
С `task_id` и `record_checkpoint=true` результат записывается как checkpoint задачи.

## Для Argentum

Это серверная половина guard-хуков из документа 11: хуки ловят опасное в момент редактирования,
`verify_change_hygiene` — перед завершением задачи, даже если агент работал без хуков (например,
через `claude -p` в контейнере воркспейса).

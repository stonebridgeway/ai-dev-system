import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".csv",
  ".dockerignore",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml"
]);

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  ".ai-dev",
  ".codex",
  ".git",
  ".obsidian",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "artifacts",
  "backups",
  "coverage",
  "node_modules",
  "task runs",
  "venv"
]);

const FORBIDDEN_FILE_PATTERNS = [
  { rule: "environment-file", pattern: /(^|\/)\.env(?:\.|$)/i },
  { rule: "local-runtime-config", pattern: /(^|\/)(?:runtime\.)?[^/]*\.local\.json$/i },
  { rule: "database-or-index", pattern: /\.(?:db|sqlite|sqlite3)(?:-[a-z]+)?$/i },
  { rule: "private-key-file", pattern: /\.(?:key|p12|pfx|pem)$/i },
  { rule: "backup-file", pattern: /\.(?:bak|backup)(?:[-.]|$)/i },
  { rule: "log-file", pattern: /\.log$/i }
];

export function isApprovedVendoredDependencyPath(relativePath) {
  return /(?:^|\/)03-skills-catalog\/sources\/external\/archify\/node_modules(?:\/|$)/i.test(relativePath);
}

const SECRET_PATTERNS = [
  {
    rule: "private-key-material",
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/
  },
  {
    rule: "github-token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/
  },
  {
    rule: "aws-access-key",
    pattern: /AKIA[0-9A-Z]{16}/
  },
  {
    rule: "google-api-key",
    pattern: /AIza[0-9A-Za-z_-]{30,}/
  },
  {
    rule: "slack-token",
    pattern: /xox[baprs]-[0-9A-Za-z-]{20,}/
  },
  {
    rule: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i
  }
];

function normalizedRelativePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function placeholderCredential(value) {
  const text = String(value || "").trim();
  return !text
    || /\$\{|<[^>]+>|YOUR_|EXAMPLE|DUMMY|PLACEHOLDER|REPLACE|process\.env|os\.environ/i.test(text)
    || /^[A-Z][A-Z0-9_]+$/.test(text);
}

/**
 * Privacy findings for a single distribution-relative path: forbidden directory
 * names, private vault zones (`02-knowledge/Projects`, `10-inbox`, `99-archive`,
 * …), and forbidden file patterns.
 *
 * @param {string} relativePath - Path relative to the distribution root.
 * @returns {Array<{ rule: string, path: string }>}
 */
export function distributionPathFindings(relativePath) {
  const normalized = normalizedRelativePath(relativePath);
  // A pinned, provenance-reviewed third-party dependency tree carries its own
  // normal artifacts (coverage/, *.pem test fixtures, *.log). Provenance is the
  // guarantee here, not per-file structural scanning — so skip these checks for
  // the approved vendored subtree. Secret content scanning still applies.
  if (isApprovedVendoredDependencyPath(normalized)) return [];
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  const findings = [];
  for (const segment of segments) {
    if (FORBIDDEN_DIRECTORY_NAMES.has(segment)) {
      findings.push({ rule: "forbidden-directory", path: normalized });
      break;
    }
  }
  if (
    /(^|\/)02-knowledge\/(?:projects|task runs)(\/|$)/i.test(normalized)
    || /(^|\/)(?:10-inbox|99-archive)(\/|$)/i.test(normalized)
  ) {
    findings.push({ rule: "private-vault-zone", path: normalized });
  }
  for (const item of FORBIDDEN_FILE_PATTERNS) {
    if (item.pattern.test(normalized)) findings.push({ rule: item.rule, path: normalized });
  }
  return findings;
}

// Ordinary English / system words that routinely appear as a bare account name
// (`root`, `runner`, `ci`, …). Matching one of these as an owner-context term
// flags every file that happens to use the word, so they are never matched on
// their own — a real home-directory path still is.
const COMMON_TERM_STOPLIST = new Set([
  "root", "user", "users", "home", "admin", "node", "test", "tests", "data", "dev",
  "build", "runner", "docker", "guest", "default", "ubuntu", "debian", "fedora",
  "arch", "vagrant", "ci", "app", "www", "public", "shared", "temp", "tmp"
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile owner-context terms into anchored matchers.
 *
 * A bare account name must appear as a whole word and must not be an ordinary
 * English / system word (see {@link COMMON_TERM_STOPLIST}). A home directory
 * must appear as a path of at least two segments — `/root` or `C:\` alone is
 * not specific enough to identify anyone — and matches either separator.
 *
 * @param {string[]} terms
 * @returns {RegExp[]}
 */
function forbiddenTermMatchers(terms) {
  const matchers = [];
  for (const raw of terms || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (/[\\/]/.test(value)) {
      const segments = value.split(/[\\/]+/).filter(Boolean);
      if (segments.length < 2) continue;
      const body = segments.map(escapeRegExp).join("[\\\\/]+");
      matchers.push(new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9_.-])`, "i"));
    } else {
      if (value.length < 4) continue;
      if (COMMON_TERM_STOPLIST.has(value.toLowerCase())) continue;
      matchers.push(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, "i"));
    }
  }
  return matchers;
}

/**
 * Privacy findings for a text file's contents: known secret patterns, non-
 * placeholder credential assignments, and any configured forbidden owner-context
 * terms (bare account names matched as whole words, home directories as
 * multi-segment paths — see {@link forbiddenTermMatchers}).
 *
 * @param {string} text - File contents.
 * @param {string} relativePath - Path recorded on each finding.
 * @param {{ forbiddenTerms?: string[] }} [options]
 * @returns {Array<{ rule: string, path: string }>}
 */
export function distributionTextFindings(text, relativePath, { forbiddenTerms = [] } = {}) {
  const source = String(text || "");
  const findings = [];
  for (const item of SECRET_PATTERNS) {
    if (item.pattern.test(source)) findings.push({ rule: item.rule, path: relativePath });
  }

  const credentialAssignment = /(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;
  for (const match of source.matchAll(credentialAssignment)) {
    if (!placeholderCredential(match[1])) {
      findings.push({ rule: "assigned-credential", path: relativePath });
      break;
    }
  }

  for (const matcher of forbiddenTermMatchers(forbiddenTerms)) {
    if (matcher.test(source)) {
      findings.push({ rule: "private-owner-context", path: relativePath });
      break;
    }
  }
  return findings;
}

function looksTextual(buffer, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return true;
  return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

async function walk(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relative = normalizedRelativePath(path.relative(root, absolute));
    if (entry.isSymbolicLink()) {
      result.push({ absolute, relative, type: "symlink" });
    } else if (entry.isDirectory()) {
      result.push(...await walk(root, absolute));
    } else if (entry.isFile()) {
      result.push({ absolute, relative, type: "file" });
    }
  }
  return result;
}

/**
 * Recursively audit a prepared distribution tree: reject symlinks, run path and
 * text privacy checks on every file, reject NUL bytes in text files, and record
 * a SHA-256 per file.
 *
 * @param {string} root - Distribution root directory.
 * @param {{ forbiddenTerms?: string[] }} [options] - Passed to {@link distributionTextFindings}.
 * @returns {Promise<{ ok: boolean, findings: Array<{ rule: string, path: string }>, files: Array<{ path: string, bytes: number, sha256: string }>, total_files: number, total_bytes: number }>}
 */
export async function auditDistributionTree(root, options = {}) {
  const findings = [];
  const files = [];
  for (const entry of await walk(root)) {
    if (entry.type === "symlink") {
      findings.push({ rule: "symbolic-link", path: entry.relative });
      continue;
    }
    findings.push(...distributionPathFindings(entry.relative));
    const content = await fs.readFile(entry.absolute);
    const extension = path.extname(entry.absolute).toLowerCase();
    if (extension && TEXT_EXTENSIONS.has(extension) && content.includes(0)) {
      // Any reader that takes text as a C string stops at the first NUL, and
      // node:sqlite returns a TEXT column only up to it.
      // A file without an extension may be a program a skill ships.
      findings.push({ rule: "nul-byte-in-text", path: entry.relative });
    }
    if (looksTextual(content, entry.absolute)) {
      findings.push(...distributionTextFindings(
        content.toString("utf8"),
        entry.relative,
        options
      ));
    }
    files.push({
      path: entry.relative,
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex")
    });
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: findings.length === 0,
    findings,
    files,
    total_files: files.length,
    total_bytes: files.reduce((sum, item) => sum + item.bytes, 0)
  };
}

/**
 * Throw a summarised error if an audit result is not clean; return it otherwise.
 *
 * @param {{ ok: boolean, findings: Array<{ rule: string, path: string }> }} audit - Result of {@link auditDistributionTree}.
 * @param {string} [label="distribution"] - Prefix for the error message.
 * @returns {typeof audit}
 */
export function assertCleanDistribution(audit, label = "distribution") {
  if (audit.ok) return audit;
  const summary = audit.findings
    .slice(0, 30)
    .map((item) => `${item.rule}: ${item.path}`)
    .join("\n");
  throw new Error(`${label} failed privacy audit:\n${summary}`);
}

/**
 * Recursively copy a directory into the distribution target, honouring an
 * `exclude(relativePath, dirent)` predicate and refusing to copy symlinks.
 *
 * `vendoredDependencyTree` marks the source as already inside an approved
 * vendored dependency. The approval check below reads a path relative to this
 * copy's own root, so a nested `node_modules` (`ajv/node_modules/fast-uri`)
 * never matches the distribution-root pattern and would be dropped — taking a
 * pinned runtime dependency with it.
 *
 * @param {string} source - Source directory.
 * @param {string} target - Target directory.
 * @param {{ exclude?: (relativePath: string, entry: import("node:fs").Dirent) => boolean, vendoredDependencyTree?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function copyDistributionTree(source, target, { exclude = () => false, vendoredDependencyTree = false } = {}) {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);

  async function copyDirectory(currentSource, currentTarget) {
    await fs.mkdir(currentTarget, { recursive: true });
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absoluteSource = path.join(currentSource, entry.name);
      const relative = normalizedRelativePath(path.relative(sourceRoot, absoluteSource));
      if (exclude(relative, entry)) continue;
      // Never carry runtime junk (`__pycache__`, `.venv`, `node_modules`, `.git`,
      // …) into the distribution: a stray directory left behind by a local tool
      // run must not fail the privacy audit that follows. The one pinned,
      // provenance-reviewed vendored tree is exempt.
      if (
        entry.isDirectory()
        && FORBIDDEN_DIRECTORY_NAMES.has(entry.name.toLowerCase())
        && !vendoredDependencyTree
        && !isApprovedVendoredDependencyPath(relative)
      ) continue;
      const absoluteTarget = path.join(currentTarget, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to copy symbolic link into public distribution: ${relative}`);
      }
      if (entry.isDirectory()) {
        await copyDirectory(absoluteSource, absoluteTarget);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
        await fs.copyFile(absoluteSource, absoluteTarget);
      }
    }
  }

  await copyDirectory(sourceRoot, targetRoot);
}

/**
 * Copy a single regular file into the distribution (creating parent dirs).
 * Throws if the source is a symlink or not a regular file.
 *
 * @param {string} source - Source file.
 * @param {string} target - Target file path.
 * @returns {Promise<void>}
 */
export async function copyDistributionFile(source, target) {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Public distribution source must be a regular file: ${source}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

/**
 * Order-sensitive SHA-256 over an audit's file list (`path`, `bytes`, `sha256`
 * each), used to detect whether a prepared distribution changed.
 *
 * @param {Array<{ path: string, bytes: number, sha256: string }>} files
 * @returns {string} Hex digest.
 */
/**
 * Relative import specifiers in a JavaScript module, static and dynamic.
 *
 * Deliberately textual: the context is staged, not installed, so there is
 * nothing to load and nothing to parse it with.
 */
const RELATIVE_IMPORT = /(?:^|[\s;(])(?:import|export)\s[^"'`]*?from\s*["'](\.[^"']*)["']|\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)|\bimport\s*["'](\.[^"']*)["']/g;

/**
 * Imports inside a staged tree that point at files the tree does not carry.
 *
 * The allowlist that builds the Docker context decides what ships, and a module
 * left out of it is not found until something imports it at runtime: the
 * published image died on startup with
 * `ERR_MODULE_NOT_FOUND: /opt/ai-dev/app/src/core/public-distribution.mjs`,
 * because a shipped module imported one the allowlist excluded. The context is
 * checked for that before an image is ever built.
 *
 * Since 3.0 every target is laid out as the distribution is — the server in
 * `ai-dev-mcp-server/`, the Frontend QA runner beside it in `frontend-qa/` —
 * so an import resolves in the staged tree as it does where it runs. Before,
 * the Docker context had a layout of its own and the runner's imports of the
 * server resolved nowhere in it; they were broken in the published image,
 * undetected because only the server's folder was walked.
 *
 * @param {string} root - Directory to walk, e.g. the staged `ai-dev-mcp-server/`.
 * @returns {Promise<Array<{ file: string, specifier: string, resolved: string }>>}
 */
export async function findDanglingImports(root) {
  const base = path.resolve(root);
  const findings = [];
  const walk = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(absolute);
        continue;
      }
      if (!/\.(?:mjs|js|cjs)$/i.test(entry.name)) continue;
      const text = await fs.readFile(absolute, "utf8").catch(() => "");
      for (const match of text.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!specifier) continue;
        const target = path.resolve(path.dirname(absolute), specifier);
        const candidates = [target].flatMap((item) => (path.extname(item)
          ? [item]
          : [`${item}.mjs`, `${item}.js`, path.join(item, "index.mjs"), path.join(item, "index.js")]));
        const exists = await Promise.all(candidates.map((item) => fs.stat(item).then(() => true).catch(() => false)));
        if (exists.some(Boolean)) continue;
        findings.push({
          file: path.relative(base, absolute).replaceAll("\\", "/"),
          specifier,
          resolved: path.relative(base, target).replaceAll("\\", "/")
        });
      }
    }
  };
  await walk(base);
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier));
}

export function distributionContentFingerprint(files) {
  const source = files
    .map((item) => `${item.path}\0${item.bytes}\0${item.sha256}`)
    .join("\n");
  return crypto.createHash("sha256").update(source).digest("hex");
}

/**
 * The current user's name for privacy scanning, or `""` when the runtime cannot
 * resolve it.
 *
 * `os.userInfo()` throws (`uv_os_get_passwd returned ENOENT`) when the effective
 * uid has no `/etc/passwd` entry — routine inside `docker run --user "$uid:$gid"`
 * during `bootstrap.sh --build-local` on macOS, or on any Linux host whose uid is
 * not the image's baked-in `1000`. Falling back to the environment keeps the
 * privacy audit running instead of aborting the build.
 *
 * @returns {string}
 */
export function ownerUsername() {
  try {
    return os.userInfo().username || "";
  } catch {
    return process.env.USER || process.env.USERNAME || process.env.LOGNAME || "";
  }
}

/**
 * Skill catalogues the repository vendors instead of generating from a vault.
 *
 * The seed is built from the owner's vault by an explicit allowlist, so a
 * directory that exists only in the checkout is deleted by the next
 * `npm run docker:seed` — the refresh stages a fresh tree and replaces the
 * output wholesale. These catalogues arrived by import, are recorded in
 * `THIRD_PARTY_NOTICES.md`, and have no vault to be copied from; `grill-me` is
 * this project's own but ships from here for the same reason. The refresh
 * carries them forward from the checkout and then asserts they survived.
 *
 * `minimumSkills` is the count the seed carries, so a partial copy fails the
 * build rather than shipping a seed that is quietly missing most of its
 * catalogue. Membrane's is the curated set described in its `CURATION.md`, not
 * the 3,074 connectors upstream publishes.
 *
 * @type {ReadonlyArray<{ relative: string, minimumSkills: number }>}
 */
export const VENDORED_SEED_CATALOGUES = Object.freeze([
  Object.freeze({ relative: "external/membrane", minimumSkills: 460 }),
  Object.freeze({ relative: "external/understand-anything", minimumSkills: 9 }),
  Object.freeze({ relative: "external/mattpocock-skills", minimumSkills: 1 }),
  Object.freeze({ relative: "custom/grill-me", minimumSkills: 1 })
]);

/**
 * Report the vendored catalogues a staged seed lost or truncated.
 *
 * @param {Record<string, number>} counts skills found per `relative` path
 * @returns {Array<{ relative: string, expected: number, found: number }>} empty when every catalogue is whole
 */
export function missingVendoredCatalogues(counts) {
  const findings = [];
  for (const { relative, minimumSkills } of VENDORED_SEED_CATALOGUES) {
    const found = Number(counts?.[relative] ?? 0);
    if (!Number.isFinite(found) || found < minimumSkills) {
      findings.push({ relative, expected: minimumSkills, found: Number.isFinite(found) ? found : 0 });
    }
  }
  return findings;
}

/**
 * Is a prepared build context older than the sources it was built from?
 *
 * `.docker/build-context` is local build output, and the audit reads it rather
 * than the repository. A context left over from an earlier tree makes the audit
 * report findings about files that no longer exist — measured on a verification
 * run, where it named `scripts/models.mjs`, a module this repository does not
 * carry and nothing in it imports.
 *
 * A context that cannot say when it was made is stale by definition: an audit
 * of an unidentifiable tree proves nothing about this one.
 *
 * @param {{ generatedAt?: string, newestSourceMs?: number }} [input]
 * @returns {{ stale: boolean, reason: string }}
 */
export function buildContextStaleness({ generatedAt, newestSourceMs } = {}) {
  const generatedMs = Date.parse(String(generatedAt ?? ""));
  if (!Number.isFinite(generatedMs)) {
    return { stale: true, reason: "the context does not say when it was generated" };
  }
  if (!Number.isFinite(newestSourceMs)) return { stale: false, reason: "" };
  if (newestSourceMs > generatedMs) {
    return {
      stale: true,
      reason: `a source file changed ${new Date(newestSourceMs).toISOString()}, after the context was generated ${new Date(generatedMs).toISOString()}`
    };
  }
  return { stale: false, reason: "" };
}

/**
 * Is a file's only difference from the manifest its line endings?
 *
 * `.gitattributes` normalises the tree to LF, but git does not rewrite files
 * already on disk when that rule arrives — a checkout older than the rule keeps
 * CRLF until something re-checks those files out. The verifier then reports
 * "content differs from the manifest", which reads as corruption. Measured on a
 * Windows checkout: 74 files, each larger than its manifest entry by exactly
 * its line count.
 *
 * @param {Buffer} content - The file as it sits on disk.
 * @param {string} expectedSha256 - What the manifest lists for it.
 * @returns {boolean} true when stripping CR before LF reproduces the listed hash
 */
export function lineEndingOnlyMismatch(content, expectedSha256) {
  if (!Buffer.isBuffer(content) || !content.includes(0x0d)) return false;
  const normalised = Buffer.from(
    content.toString("latin1").replaceAll("\r\n", "\n"),
    "latin1"
  );
  return crypto.createHash("sha256").update(normalised).digest("hex") === String(expectedSha256);
}

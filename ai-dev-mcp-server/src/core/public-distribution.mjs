import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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

function isApprovedVendoredDependencyPath(relativePath) {
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

function forbiddenTermVariants(terms) {
  const variants = new Set();
  for (const raw of terms || []) {
    const value = String(raw || "").trim();
    if (value.length < 4) continue;
    variants.add(value.toLowerCase());
    variants.add(value.replaceAll("\\", "/").toLowerCase());
    variants.add(value.replaceAll("/", "\\").toLowerCase());
  }
  return [...variants];
}

/**
 * Privacy findings for a text file's contents: known secret patterns, non-
 * placeholder credential assignments, and any configured forbidden owner-context
 * terms (matched case-insensitively with `/` and `\` variants).
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

  const lowered = source.toLowerCase();
  for (const term of forbiddenTermVariants(forbiddenTerms)) {
    if (lowered.includes(term)) {
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
 * text privacy checks on every file, and record a SHA-256 per file.
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
 * @param {string} source - Source directory.
 * @param {string} target - Target directory.
 * @param {{ exclude?: (relativePath: string, entry: import("node:fs").Dirent) => boolean }} [options]
 * @returns {Promise<void>}
 */
export async function copyDistributionTree(source, target, { exclude = () => false } = {}) {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);

  async function copyDirectory(currentSource, currentTarget) {
    await fs.mkdir(currentTarget, { recursive: true });
    const entries = await fs.readdir(currentSource, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absoluteSource = path.join(currentSource, entry.name);
      const relative = normalizedRelativePath(path.relative(sourceRoot, absoluteSource));
      if (exclude(relative, entry)) continue;
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
export function distributionContentFingerprint(files) {
  const source = files
    .map((item) => `${item.path}\0${item.bytes}\0${item.sha256}`)
    .join("\n");
  return crypto.createHash("sha256").update(source).digest("hex");
}

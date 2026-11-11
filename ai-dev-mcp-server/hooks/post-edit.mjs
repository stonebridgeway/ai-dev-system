#!/usr/bin/env node
// PostToolUse (Write|Edit|MultiEdit): format the edited file with the project's
// own formatter when one is installed locally, and tell the agent when it has
// just changed a dependency manifest or lockfile, whose packages nothing has
// scanned yet. Never blocks, never installs anything, never uses npx.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { emitContext, hooksDisabled, loadPolicy, log, normalizeInput, profileAllows, projectRootOf, readStdin } from "./lib.mjs";

/** Files whose edit changes what gets installed. */
export const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", ".npmrc", ".yarnrc.yml", "bunfig.toml"]);

const FORMATTERS = [
  { extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".css", ".scss", ".md", ".vue", ".svelte", ".html", ".yaml", ".yml"], binaries: [["node_modules/.bin/biome", ["format", "--write"]], ["node_modules/.bin/prettier", ["--write", "--log-level", "warn"]]] },
  { extensions: [".py"], binaries: [[".venv/bin/ruff", ["format"]], [".venv/Scripts/ruff.exe", ["format"]], ["ruff", ["format"]], [".venv/bin/black", ["-q"]], ["black", ["-q"]]] },
  { extensions: [".go"], binaries: [["gofmt", ["-w"]]] },
  { extensions: [".rs"], binaries: [["rustfmt", ["--edition", "2021"]]] }
];

function resolveBinary(projectRoot, candidate) {
  if (candidate.includes("/")) {
    const absolute = path.join(projectRoot, ...candidate.split("/"));
    if (fs.existsSync(absolute)) return absolute;
    if (process.platform === "win32" && fs.existsSync(`${absolute}.cmd`)) return `${absolute}.cmd`;
    return "";
  }
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const target = path.join(directory, `${candidate}${extension}`);
      if (directory && fs.existsSync(target)) return target;
    }
  }
  return "";
}

function formatFile(projectRoot, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const group = FORMATTERS.find((item) => item.extensions.includes(extension));
  if (!group) return "";
  for (const [candidate, args] of group.binaries) {
    const binary = resolveBinary(projectRoot, candidate);
    if (!binary) continue;
    try {
      execFileSync(binary, [...args, filePath], { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"], timeout: 20_000, windowsHide: true });
      return path.basename(candidate);
    } catch (error) {
      log(`[ai-dev post-edit] ${path.basename(candidate)} failed for ${filePath}: ${String(error.stderr || error.message).split("\n")[0]}`);
      return "";
    }
  }
  return "";
}

/**
 * The note for an edit that touched what gets installed, or "".
 *
 * @param {string[]} relativeFiles
 * @returns {string}
 */
export function dependencyNote(relativeFiles) {
  const touched = relativeFiles.filter((file) => DEPENDENCY_FILES.has(path.basename(file)));
  if (!touched.length) return "";
  return `[ai-dev security] ${touched.join(", ")} changed what this project installs, and nothing has scanned it since. Before relying on it: run_security_scan (ar-security-review skill), and plan_security_fixes for anything it finds. Install nothing the plan has not been confirmed for.`;
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("post:edit:format")) process.exit(0);
  const input = normalizeInput(raw);
  const projectRoot = projectRootOf(input.cwd);
  const policy = loadPolicy(projectRoot);
  if (!profileAllows(policy.profile, ["standard", "strict"])) process.exit(0);
  const files = [...new Set((input.edits.length ? input.edits.map((edit) => String(edit.file_path || "")) : [input.filePath]).filter(Boolean))];
  const absolutes = files.map((file) => (path.isAbsolute(file) ? file : path.join(projectRoot, file)));
  if (policy.format_on_edit !== false) {
    for (const absolute of absolutes) {
      if (!fs.existsSync(absolute)) continue;
      const formatter = formatFile(projectRoot, absolute);
      if (formatter) log(`[ai-dev post-edit] formatted ${path.relative(projectRoot, absolute)} with ${formatter}`);
    }
  }
  emitContext("PostToolUse", dependencyNote(absolutes.map((absolute) => path.relative(projectRoot, absolute).split(path.sep).join("/"))));
  process.exit(0);
}

// Run as the hook; imported by the tests for dependencyNote.
if (process.argv[1] && path.basename(process.argv[1]) === "post-edit.mjs") {
  main().catch((error) => {
    log(`[ai-dev post-edit] error: ${error.message}`);
    process.exit(0);
  });
}

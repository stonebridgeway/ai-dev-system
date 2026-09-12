#!/usr/bin/env node
// PostToolUse (Write|Edit|MultiEdit): format the edited file with the project's
// own formatter when one is installed locally. Never blocks, never installs
// anything, never uses npx.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hooksDisabled, loadPolicy, log, normalizeInput, profileAllows, projectRootOf, readStdin } from "./lib.mjs";

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

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("post:edit:format")) process.exit(0);
  const input = normalizeInput(raw);
  const projectRoot = projectRootOf(input.cwd);
  const policy = loadPolicy(projectRoot);
  if (!profileAllows(policy.profile, ["standard", "strict"]) || policy.format_on_edit === false) process.exit(0);
  const files = input.edits.length ? input.edits.map((edit) => String(edit.file_path || "")) : [input.filePath];
  for (const file of new Set(files.filter(Boolean))) {
    const absolute = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const formatter = formatFile(projectRoot, absolute);
    if (formatter) log(`[ai-dev post-edit] formatted ${path.relative(projectRoot, absolute)} with ${formatter}`);
  }
  process.exit(0);
}

main().catch((error) => {
  log(`[ai-dev post-edit] error: ${error.message}`);
  process.exit(0);
});

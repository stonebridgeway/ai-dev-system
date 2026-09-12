import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The `src/mcp-stdio.mjs` line budget. It lives in src/core so the System
// Dashboard reports the ceiling this gate enforces: the file shrank one
// extraction at a time (docs/ecc-upgrades/PLAN.md, stage 1) and the ceiling was
// re-pinned to its actual size plus roughly 300 lines of working room after each
// step, so the file can be edited but not re-grown.
import { SYSTEM_LINE_CEILING } from "../src/core/system-health.mjs";
// The size rules themselves live in src/core so they can be tested without
// breaking a real file on purpose and putting it back
// (docs/ecc-upgrades/DEBTS.md, Д-12). This file is the input and output
// around them.
import {
  MODULE_LINE_CEILING,
  MODULE_LINE_EXCEPTIONS,
  evaluateLineBudget
} from "../src/core/line-budget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const skipDirectories = new Set(["node_modules", ".git", "coverage"]);

function countLines(source) {
  return source.split(/\r?\n/).length;
}

async function sourceFiles(directory) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  await walk(directory);
  return files.sort();
}

const files = [
  ...await sourceFiles(path.join(root, "src")),
  ...await sourceFiles(path.join(root, "scripts"))
];
const findings = [];
const modules = [];
for (const file of files) {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const syntax = spawnSync(node, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (syntax.status !== 0) {
    findings.push(`${relative}: syntax check failed: ${(syntax.stderr || syntax.stdout).trim()}`);
  }
  const source = await fs.readFile(file, "utf8");
  if (relative !== "scripts/static-quality.mjs") {
    if (/\beval\s*\(/.test(source)) findings.push(`${relative}: eval() is forbidden.`);
    if (/\bnew\s+Function\s*\(/.test(source)) findings.push(`${relative}: new Function() is forbidden.`);
    if (/\bshell\s*:\s*true\b/.test(source)) findings.push(`${relative}: shell:true is forbidden.`);
  }
  if (
    /from\s+["']node:child_process["']/.test(source) &&
    /import\s*\{[^}]*\bexec\b[^}]*\}/s.test(source)
  ) {
    findings.push(`${relative}: child_process.exec is forbidden; use argv-based execution.`);
  }
  if (relative.startsWith("src/core/") || relative.startsWith("src/extensions/")) {
    modules.push({ path: relative, lines: countLines(source) });
  }
}

const runtimePath = path.join(root, "src", "mcp-stdio.mjs");
const runtimeLines = countLines(await fs.readFile(runtimePath, "utf8"));
findings.push(...evaluateLineBudget({
  modules,
  runtime: { path: "src/mcp-stdio.mjs", lines: runtimeLines },
  moduleCeiling: MODULE_LINE_CEILING,
  systemCeiling: SYSTEM_LINE_CEILING
}).map((finding) => finding.message));

const definitionsPath = path.join(root, "src", "tool-definitions.mjs");
if (!await fs.stat(definitionsPath).then((item) => item.isFile()).catch(() => false)) {
  findings.push("src/tool-definitions.mjs: extracted tool metadata module is missing.");
}

const { tools } = await import("../src/mcp-stdio.mjs");
const names = new Set();
for (const tool of tools) {
  if (!tool?.name || typeof tool.name !== "string") findings.push("Tool without a valid name.");
  if (names.has(tool.name)) findings.push(`Duplicate MCP tool name: ${tool.name}.`);
  names.add(tool.name);
  if (tool?.inputSchema?.type !== "object") {
    findings.push(`${tool.name}: inputSchema must be an object schema.`);
  }
}

const { PROMPTS } = await import("../src/server.mjs");
const promptNames = new Set();
for (const prompt of PROMPTS) {
  if (!prompt?.name || typeof prompt.name !== "string") findings.push("Prompt without a valid name.");
  // GetPrompt resolves by `find`, so a duplicate name is dead weight, not an override.
  if (promptNames.has(prompt.name)) findings.push(`Duplicate MCP prompt name: ${prompt.name}.`);
  promptNames.add(prompt.name);
  if (typeof prompt?.render !== "function") findings.push(`${prompt.name}: prompt must define a render function.`);
}

if (findings.length) {
  console.error(["Static quality gate failed:", ...findings.map((item) => `- ${item}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "passed",
    checked_files: files.length,
    tools: tools.length,
    prompts: PROMPTS.length,
    runtime_lines: runtimeLines,
    modularity_ceiling: SYSTEM_LINE_CEILING,
    module_line_ceiling: MODULE_LINE_CEILING,
    pinned_modules: MODULE_LINE_EXCEPTIONS.length
  }, null, 2));
}

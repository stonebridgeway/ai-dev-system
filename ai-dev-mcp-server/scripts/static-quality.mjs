import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const skipDirectories = new Set(["node_modules", ".git", "coverage"]);

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
}

const runtimePath = path.join(root, "src", "mcp-stdio.mjs");
const runtimeLines = (await fs.readFile(runtimePath, "utf8")).split(/\r?\n/).length;
if (runtimeLines > 10_500) {
  findings.push(`src/mcp-stdio.mjs: ${runtimeLines} lines exceeds the 10,500-line modularity ceiling.`);
}
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

if (findings.length) {
  console.error(["Static quality gate failed:", ...findings.map((item) => `- ${item}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "passed",
    checked_files: files.length,
    tools: tools.length,
    runtime_lines: runtimeLines,
    modularity_ceiling: 10_500
  }, null, 2));
}

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The `src/mcp-stdio.mjs` line budget. It lives in src/core so the System
// Dashboard reports the ceiling this gate enforces: the file shrank one
// extraction at a time (stage 1 of the modularity work) and the ceiling was
// re-pinned to its actual size plus roughly 300 lines of working room after each
// step, so the file can be edited but not re-grown.
import { SYSTEM_LINE_CEILING } from "../src/core/system-health.mjs";
// The size rules themselves live in src/core so they can be tested without
// breaking a real file on purpose and putting it back.
// This file is the input and output
// around them.
import {
  MODULE_LINE_CEILING,
  MODULE_LINE_EXCEPTIONS,
  evaluateLineBudget
} from "../src/core/line-budget.mjs";
// The forbidden calls are found by what the code does, not by one spelling of
// it: the rules and their tests live in src/core.
import { forbiddenCalls } from "../src/core/forbidden-calls.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const skipDirectories = new Set(["node_modules", ".git", "coverage"]);

function countLines(source) {
  return source.split(/\r?\n/).length;
}

async function sourceFiles(directory, extensions = [".mjs"]) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  await walk(directory);
  return files.sort();
}

// `hooks/` is copied into other people's repositories and runs there: the
// syntax check and the forbidden calls hold for it as well; the line ceiling
// does not, as each hook is one file by design.
const files = [
  ...await sourceFiles(path.join(root, "bin")),
  ...await sourceFiles(path.join(root, "src")),
  ...await sourceFiles(path.join(root, "scripts")),
  ...await sourceFiles(path.join(root, "hooks"))
];

// The desktop app (`desktop/`, beside this package in the repository) is held
// to the same rules: the syntax check, the forbidden calls and the line
// ceiling. Its tests call eval and new Function inside
// the page on purpose — to show the page's policy refuses them — so those two
// are looked for in its code only; a shell and exec in its tests too.
// A copy of this package without the app (the npm package, the
// image) has nothing to check.
const desktopRoot = path.join(root, "..", "desktop");
const DESKTOP_EXTENSIONS = [".mjs", ".js", ".cjs"];
const desktopFiles = await fs.stat(path.join(desktopRoot, "package.json")).then(() => true, () => false)
  ? [
    ...await sourceFiles(path.join(desktopRoot, "src"), DESKTOP_EXTENSIONS),
    ...await sourceFiles(path.join(desktopRoot, "scripts"), DESKTOP_EXTENSIONS),
    ...await sourceFiles(path.join(desktopRoot, "test"), DESKTOP_EXTENSIONS)
  ]
  : [];
const findings = [];
const modules = [];
for (const file of desktopFiles) {
  const relative = path.relative(path.dirname(root), file).replaceAll("\\", "/");
  const syntax = spawnSync(node, ["--check", file], { cwd: desktopRoot, encoding: "utf8", windowsHide: true });
  if (syntax.status !== 0) findings.push(`${relative}: syntax check failed: ${(syntax.stderr || syntax.stdout).trim()}`);
  const inTests = relative.startsWith("desktop/test/");
  const source = await fs.readFile(file, "utf8");
  // A `.cjs` file is a script, with HTML-like comments a module does not have.
  for (const finding of forbiddenCalls(source, { allowEval: inTests, script: file.endsWith(".cjs") })) findings.push(`${relative}:${finding.line}: ${finding.message}`);
  if (!inTests) modules.push({ path: relative, lines: countLines(source) });
}
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
  for (const finding of forbiddenCalls(source)) findings.push(`${relative}:${finding.line}: ${finding.message}`);
  // `src/galaxy/` is browser code, but code all the same: the ceiling holds there
  // too, and in the CLI (`bin/`, `src/cli/`).
  if (["bin/", "src/cli/", "src/core/", "src/extensions/", "src/galaxy/"].some((prefix) => relative.startsWith(prefix))) {
    modules.push({ path: relative, lines: countLines(source) });
  }
}

// The hook launcher is a shell script, parsed by the shell that runs it.
if (process.platform !== "win32") {
  for (const name of (await fs.readdir(path.join(root, "hooks"))).filter((entry) => entry.endsWith(".sh")).sort()) {
    const parsed = spawnSync("/bin/sh", ["-n", path.join(root, "hooks", name)], { cwd: root, encoding: "utf8", windowsHide: true });
    if (parsed.status !== 0) findings.push(`hooks/${name}: sh -n failed: ${(parsed.stderr || parsed.stdout).trim()}`);
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
    checked_files: files.length + desktopFiles.length,
    checked_server_files: files.length,
    checked_desktop_files: desktopFiles.length,
    tools: tools.length,
    prompts: PROMPTS.length,
    runtime_lines: runtimeLines,
    modularity_ceiling: SYSTEM_LINE_CEILING,
    module_line_ceiling: MODULE_LINE_CEILING,
    pinned_modules: MODULE_LINE_EXCEPTIONS.length
  }, null, 2));
}

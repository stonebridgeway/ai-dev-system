import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIFY_TYPES, runArchify } from "./archify.mjs";

const DEFAULT_PATTERN = "**/*.{architecture,workflow,sequence,dataflow,lifecycle}.json";

function globPattern(pattern) {
  const normalized = String(pattern || DEFAULT_PATTERN).replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").includes("..")) throw new Error("diagram_specs must not contain parent traversal.");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += normalized[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += normalized[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = normalized.indexOf("}", index);
      if (end < 0) throw new Error("diagram_specs has an unclosed brace expression.");
      source += `(${normalized.slice(index + 1, end).split(",").map((item) => item.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      index = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

async function filesBelow(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(root, child));
    else if (entry.isFile()) output.push(child.replaceAll("\\", "/"));
  }
  return output;
}

function diagramType(file) {
  const parts = path.basename(file).split(".");
  const type = parts.at(-2);
  return ARCHIFY_TYPES.includes(type) ? type : "";
}

export async function validateArchifyDiagramSpecs({ vaultRoot, projectRoot, pattern, timeoutMs = 120000 }) {
  const matcher = globPattern(pattern);
  const files = (await filesBelow(projectRoot)).filter((file) => matcher.test(file) && diagramType(file));
  const results = [];
  for (const relativePath of files) {
    const type = diagramType(relativePath);
    const filePath = path.join(projectRoot, relativePath);
    const run = await runArchify({
      vaultRoot,
      args: ["validate", type, filePath, "--json", "--quality", "showcase", "--repo-root", projectRoot],
      cwd: projectRoot,
      timeoutMs
    });
    const warnings = Number(run.json?.composition?.summary?.warnings || 0);
    results.push({
      path: relativePath,
      type,
      status: !run.ok || run.json?.ok === false ? "block" : warnings > 0 ? "warn" : "pass",
      diagnostics: run.json?.diagnostics || [],
      warnings,
      exit_code: run.exitCode,
      stderr: run.stderr
    });
  }
  return {
    enabled: true,
    pattern: String(pattern || DEFAULT_PATTERN),
    files: results,
    status: results.some((item) => item.status === "block") ? "block" : results.some((item) => item.status === "warn") ? "warn" : "pass"
  };
}

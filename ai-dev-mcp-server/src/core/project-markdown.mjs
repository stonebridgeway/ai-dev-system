/**
 * Markdown that describes a project.
 *
 * The tables, bullet lists and section readers shared by every generated
 * project document: `AGENTS.md`, the project map, the project brief, the
 * quality gate file and the registry card in `src/core/project-cards.mjs`.
 * All of it is pure text over an already-detected project, so each piece is
 * testable without a repository on disk.
 */
import { mdCell } from "./text-format.mjs";

/** A bullet list, or one bullet saying there was nothing to list. */
export function asBulletList(items, fallback = "Not detected.") {
  if (!items.length) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

/** The detected build/test/lint commands, one row each. */
export function commandsTable(commands) {
  return [
    "| Task | Component | CWD | Command | Source |",
    "| --- | --- | --- | --- | --- |",
    ...commands.map((item) => `| ${mdCell(item.label)} | ${mdCell(item.component || "")} | ${mdCell(item.cwd || ".")} | ${mdCell(item.command)} | ${mdCell(item.source)} |`)
  ].join("\n");
}

/** One row per component of a monorepo, or a sentence when there are none. */
export function componentsTable(components = []) {
  if (!components.length) return "No project components detected.";
  return [
    "| Component | Path | Ecosystem | Types | Stack |",
    "| --- | --- | --- | --- | --- |",
    ...components.map((item) => `| ${mdCell(item.name)} | ${mdCell(item.path)} | ${mdCell(item.ecosystem)} | ${mdCell((item.project_types || []).join(", "))} | ${mdCell((item.stack || []).join(", "))} |`)
  ].join("\n");
}

/** Source roots, test roots, entrypoints and the rest of the shape. */
export function architectureMarkdown(architecture = {}) {
  const row = (label, values) => `- ${label}: ${(values || []).length ? values.map((item) => `\`${item}\``).join(", ") : "not detected"}`;
  return [
    row("Source roots", architecture.source_roots),
    row("Test roots", architecture.test_roots),
    row("Entrypoints", architecture.entrypoints),
    row("API surfaces", architecture.api_surfaces),
    row("Data and migrations", architecture.data_paths),
    row("CI workflows", architecture.ci)
  ].join("\n");
}

/** Every package script verbatim, so an agent can see what exists. */
export function scriptsTable(scripts) {
  const entries = Object.entries(scripts);
  if (!entries.length) return "No package scripts detected.";
  return [
    "| Script | Command |",
    "| --- | --- |",
    ...entries.map(([name, command]) => `| ${mdCell(name)} | ${mdCell(command)} |`)
  ].join("\n");
}

/** Which of the usual documentation files are present. */
export function documentationMarkdown(detected) {
  const files = detected.documentation?.files || [];
  if (!files.length) return "- Documentation scan not available.";
  return [
    "| Item | Status | Type |",
    "| --- | --- | --- |",
    ...files.map((item) => `| ${mdCell(item.path)} | ${item.exists ? "present" : "missing"} | ${mdCell(item.type)} |`)
  ].join("\n");
}

/** `.env*` files by kind, and the warning that goes with the local ones. */
export function environmentMarkdown(detected) {
  const env = detected.environment || { files: [], local_secret_files: [] };
  const lines = [];
  if (!env.files.length) {
    lines.push("- No `.env*` files detected by the lightweight scan.");
  } else {
    for (const file of env.files) {
      lines.push(`- \`${file.path}\`: ${file.type === "example" ? "example/template file" : "local secret-bearing file, do not copy contents into chat or Obsidian"}`);
    }
  }
  if (env.local_secret_files?.length && !env.has_example) {
    lines.push("- Local env files exist but no `.env.example`/sample file was detected.");
  }
  return lines.join("\n");
}

/** Scripts flagged as side-effectful, with the reason each was flagged. */
export function dangerousScriptsMarkdown(detected) {
  const scripts = detected.dangerous_scripts || [];
  if (!scripts.length) return "- No package scripts were automatically flagged as side-effectful.";
  return scripts.map((item) => `- \`${item.name}\`: ${item.reason}. Command: \`${item.command}\``).join("\n");
}

/** Split detected commands from the ones the detector could not find. */
export function commandsByStatus(commands) {
  return {
    detected: commands.filter((item) => item.command && item.command !== "Not detected"),
    missing: commands.filter((item) => !item.command || item.command === "Not detected")
  };
}

/** The skills worth reading before working on this project. */
export function recommendedSkillsForProject(detected) {
  const skills = [
    ["repo-onboarding", "Repository setup, AGENTS.md, project map, quality gate."],
    ["feature-builder", "Feature implementation with repo patterns and tests."],
    ["bugfix-investigator", "Bug, regression, failing test, or CI investigation."],
    ["code-reviewer", "Risk review, missing tests, security/data/behavior checks."],
    ["knowledge-curator", "Durable project notes and lessons."]
  ];
  if (detected.is_frontend) {
    skills.splice(4, 0, ["frontend-product-builder", "Single design-first orchestrator for product context, references, approvals, implementation, and visual handoff."]);
    skills.splice(5, 0, ["frontend-polisher", "Frontend/UI quality, states, responsiveness."]);
    skills.splice(6, 0, ["beta-frontend-maintainer", "Existing beta frontend support with minimal safe diffs."]);
    skills.splice(7, 0, ["frontend-quality-gate", "Technical UI QA plus strict visual-reference evidence."]);
    skills.splice(8, 0, ["landing-conversion-reviewer", "Landing page clarity, trust, CTA, and conversion review."]);
    skills.splice(9, 0, ["design-taste-frontend", "Visually important frontend/design work."]);
  }
  return skills;
}

/** `recommendedSkillsForProject` as a table. */
export function recommendedSkillsMarkdown(detected) {
  return [
    "| Skill | Use when |",
    "| --- | --- |",
    ...recommendedSkillsForProject(detected).map(([skill, reason]) => `| \`${skill}\` | ${mdCell(reason)} |`)
  ].join("\n");
}

/** A filesystem-safe slug for a project name, hashed when nothing survives. */
export function projectSlug(value) {
  const raw = String(value ?? "").trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug.slice(0, 80);

  let hash = 0;
  for (const char of raw) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return `project-${Math.abs(hash)}`;
}

/** The `key: value` pairs of a document's YAML frontmatter. */
export function parseSimpleFrontmatterFields(text) {
  const match = text.match(/^---\s*([\s\S]*?)\s*---/);
  if (!match) return {};

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const rawValue = fieldMatch[2].trim();
    if (/^".*"$/.test(rawValue)) {
      try {
        fields[fieldMatch[1]] = JSON.parse(rawValue);
        continue;
      } catch {
        // Fall through to simple stripping for non-JSON YAML-ish values.
      }
    }
    fields[fieldMatch[1]] = rawValue.replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** The first `# ` heading of a document. */
export function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

/** The body of a `## ` section, up to the next `## ` heading. */
export function extractMarkdownSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** The values of a bullet list, with surrounding backticks stripped. */
export function bulletValues(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .map((value) => value.replace(/^`|`$/g, ""));
}

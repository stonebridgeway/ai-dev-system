import fs from "node:fs/promises";
import path from "node:path";

/**
 * Pull-request template discovery, parsing and filling.
 *
 * A repository that ships a pull-request template has already said how its
 * maintainers want a change described. `prepare_pull_request` therefore fills
 * that template instead of replacing it: every heading it recognises receives
 * the matching evidence section, every heading it does not recognise keeps the
 * text the template author wrote, and the generated sections that found no home
 * are appended so no evidence is silently dropped.
 */

/** Template files, in the order GitHub itself resolves them. */
export const PR_TEMPLATE_FILES = Object.freeze([
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/PULL_REQUEST_TEMPLATE.markdown",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md"
]);

/** Directories that hold one template per file; `default.md` wins, then alphabetical order. */
export const PR_TEMPLATE_DIRS = Object.freeze([
  ".github/PULL_REQUEST_TEMPLATE",
  ".github/pull_request_template",
  "docs/PULL_REQUEST_TEMPLATE",
  ".gitlab/merge_request_templates"
]);

/**
 * Headings whose content is the template author's to write, never ours: a
 * checklist, a screenshot slot, a "type of change" list, a breaking-change
 * notice. They are left exactly as the template has them.
 */
const SKIP_HEADINGS = /\b(?:check-?lists?|screenshots?|breaking[- ]changes?|type of change|types?|reviewers?|related (?:issues?|prs?|tickets?)|deployment notes?|rollout)\b/i;

/**
 * Heading text to generated-section key, most specific pattern first: "Test
 * plan" must not be read as "Plan", and "Changed files" must not be read as
 * "Summary".
 */
export const SECTION_MATCHERS = Object.freeze([
  ["test_plan", /\b(?:test plan|testing|how (?:was|has|do i) this|tests?|qa)\b/i],
  ["acceptance", /\b(?:acceptance|criteri(?:a|on)|requirements?|definition of done)\b/i],
  ["outstanding", /\b(?:outstanding|remaining|left|follow[- ]?ups?|known (?:issues|limitations)|open (?:questions|items|issues)|still open|todo)\b/i],
  ["verification", /\b(?:verification|validation|verified|quality gate|checks|evidence)\b/i],
  ["hygiene", /\b(?:hygiene|risks?|security|lint)\b/i],
  ["decisions", /\b(?:decisions?|adrs?|rationale|trade[- ]?offs?)\b/i],
  ["checkpoints", /\b(?:checkpoints?|progress|timeline|history)\b/i],
  ["plan", /\b(?:plan|approach|implementation|design)\b/i],
  ["changes", /\b(?:changed files|files changed|changes?|files|diff)\b/i],
  ["summary", /\b(?:summary|description|overview|what and why|motivation|context|why|what)\b/i]
]);

const CHECKLIST_LINE = /^\s*[-*]\s+\[[ xX]\]\s+/;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * @param {string} title - Heading text from a template.
 * @returns {string} Generated-section key, or `""` when the heading belongs to the template author.
 */
export function matchSectionKey(title) {
  const text = String(title || "").trim();
  if (!text || SKIP_HEADINGS.test(text)) return "";
  for (const [key, pattern] of SECTION_MATCHERS) {
    if (pattern.test(text)) return key;
  }
  return "";
}

/**
 * Split a template into the text before its first heading and one entry per
 * heading. Headings inside fenced code blocks are text, not structure.
 *
 * @param {string} markdown
 * @returns {{ preamble: string[], sections: Array<{ level: number, title: string, body: string[] }> }}
 */
export function parseTemplate(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = { level: heading[1].length, title: heading[2].trim(), body: [] };
      sections.push(current);
      continue;
    }
    (current ? current.body : preamble).push(line);
  }
  return { preamble, sections };
}

/**
 * Drop HTML comments. Template instructions ("<!-- describe your change -->")
 * are addressed to whoever fills the template in; once it is filled they are
 * noise in a file a human is expected to read.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function stripComments(lines) {
  const out = [];
  let inside = false;
  for (const line of lines) {
    let text = line;
    if (inside) {
      const end = text.indexOf("-->");
      if (end < 0) continue;
      text = text.slice(end + 3);
      inside = false;
    }
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    const open = text.indexOf("<!--");
    if (open >= 0) {
      text = text.slice(0, open);
      inside = true;
    }
    if (!text.trim() && line.trim()) continue;
    out.push(text.trimEnd());
  }
  return out;
}

/**
 * @param {string[]} lines
 * @returns {string[]} The same lines without leading and trailing blank lines.
 */
export function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

function rejectUnsafeRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.includes("..")) {
    throw new Error(`Unsafe template path: ${relativePath}`);
  }
  return segments.join("/");
}

/**
 * Find the repository's pull-request template.
 *
 * @param {string} projectRoot - Repository path.
 * @param {{ explicitPath?: string }} [options] - `explicitPath` skips discovery and must exist.
 * @returns {Promise<{ path: string, markdown: string } | null>} `null` when the repository has no template.
 */
export async function findPullRequestTemplate(projectRoot, { explicitPath = "" } = {}) {
  const root = path.resolve(projectRoot);
  const read = async (relative) => {
    const target = path.join(root, ...relative.split("/"));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return null;
    const markdown = await fs.readFile(target, "utf8").catch(() => "");
    return markdown.trim() ? { path: relative, markdown } : null;
  };
  if (explicitPath) {
    const found = await read(rejectUnsafeRelativePath(explicitPath));
    if (!found) throw new Error(`Pull request template not found or empty: ${explicitPath}`);
    return found;
  }
  for (const candidate of PR_TEMPLATE_FILES) {
    const found = await read(candidate);
    if (found) return found;
  }
  for (const directory of PR_TEMPLATE_DIRS) {
    const entries = await fs.readdir(path.join(root, ...directory.split("/"))).catch(() => []);
    const names = entries
      .filter((item) => /\.(?:md|markdown)$/i.test(item))
      .sort((left, right) => (/^default\./i.test(left) ? 0 : 1) - (/^default\./i.test(right) ? 0 : 1) || left.localeCompare(right));
    for (const name of names) {
      const found = await read(`${directory}/${name}`);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Render generated sections as a standalone body, for a repository without a
 * template.
 *
 * @param {Array<{ key: string, title: string, lines: string[] }>} sections
 * @param {number} [level=2] - Heading level.
 * @returns {string}
 */
export function renderSections(sections, level = 2) {
  const out = [];
  for (const section of sections) {
    if (!section.lines?.length) continue;
    if (out.length) out.push("");
    out.push(`${"#".repeat(level)} ${section.title}`, "", ...section.lines);
  }
  return `${trimBlankLines(out).join("\n")}\n`;
}

/**
 * Fill a template with generated sections.
 *
 * A recognised heading keeps its own wording and receives the generated lines,
 * followed by any checklist items the template had under it (those are the
 * reviewer's, not filler). An unrecognised heading keeps its body. Generated
 * sections that matched no heading are appended at the template's shallowest
 * heading level.
 *
 * @param {{ markdown: string, sections: Array<{ key: string, title: string, lines: string[] }> }} input
 * @returns {{ markdown: string, filled: Array<{ key: string, heading: string }>, appended: string[], kept: string[] }}
 */
export function fillTemplate({ markdown, sections }) {
  const parsed = parseTemplate(markdown);
  const byKey = new Map(sections.map((item) => [item.key, item]));
  const used = new Set();
  const filled = [];
  const kept = [];
  const out = [...trimBlankLines(stripComments(parsed.preamble))];
  for (const section of parsed.sections) {
    const key = matchSectionKey(section.title);
    const generated = key && !used.has(key) && byKey.get(key)?.lines?.length ? byKey.get(key) : null;
    const body = trimBlankLines(stripComments(section.body));
    if (out.length) out.push("");
    out.push(`${"#".repeat(section.level)} ${section.title}`, "");
    if (generated) {
      used.add(key);
      filled.push({ key, heading: section.title });
      out.push(...generated.lines);
      const checklist = body.filter((line) => CHECKLIST_LINE.test(line));
      if (checklist.length) out.push("", ...checklist);
    } else {
      kept.push(section.title);
      out.push(...body);
    }
  }
  const level = parsed.sections.length ? Math.min(...parsed.sections.map((item) => item.level)) : 2;
  const appended = [];
  for (const section of sections) {
    if (used.has(section.key) || !section.lines?.length) continue;
    appended.push(section.key);
    if (out.length) out.push("");
    out.push(`${"#".repeat(level)} ${section.title}`, "", ...section.lines);
  }
  return { markdown: `${trimBlankLines(out).join("\n")}\n`, filled, appended, kept };
}

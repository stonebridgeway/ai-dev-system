import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-files.mjs";

export const DECISIONS_RELATIVE_DIR = ".ai-dev/decisions";
export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"];

const FILE_PATTERN = /^(\d{4})-([a-z0-9-]+)\.md$/;

function normalize(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function slugify(value, fallback = "decision") {
  const slug = normalize(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function bulletList(values, fallback = "- None recorded.") {
  const items = (Array.isArray(values) ? values : [values])
    .map(normalize)
    .filter(Boolean);
  return items.length ? items.map((item) => `- ${item.replace(/\n+/g, " ")}`).join("\n") : fallback;
}

function frontmatterValue(value) {
  return JSON.stringify(String(value ?? ""));
}

/**
 * Render one decision record as an ADR-style Markdown document with a small
 * YAML frontmatter block (id, title, status, date, task, tags).
 *
 * @param {{ id: string, title: string, status: string, date: string, task_id?: string, tags?: string[], context: string, decision: string, alternatives?: string[], consequences?: string[], supersedes?: string }} record
 * @returns {string} Markdown document.
 */
export function renderDecision(record) {
  const tags = (record.tags ?? []).map((tag) => slugify(tag, "")).filter(Boolean);
  return [
    "---",
    `id: ${record.id}`,
    `title: ${frontmatterValue(record.title)}`,
    `status: ${record.status}`,
    `date: ${record.date}`,
    `task: ${frontmatterValue(record.task_id || "")}`,
    `tags: [${tags.map((tag) => `"${tag}"`).join(", ")}]`,
    `supersedes: ${frontmatterValue(record.supersedes || "")}`,
    "---",
    "",
    `# ${record.id}: ${normalize(record.title)}`,
    "",
    "## Context",
    "",
    normalize(record.context) || "Not recorded.",
    "",
    "## Decision",
    "",
    normalize(record.decision) || "Not recorded.",
    "",
    "## Alternatives Considered",
    "",
    bulletList(record.alternatives),
    "",
    "## Consequences",
    "",
    bulletList(record.consequences),
    ""
  ].join("\n");
}

/**
 * Parse a decision document written by {@link renderDecision} back into a
 * record. Tolerates hand-edited files: missing fields fall back to defaults.
 *
 * @param {string} markdown - Document text.
 * @param {string} [fileName] - Used to recover the id when frontmatter is damaged.
 * @returns {object | null} Parsed record, or null when the file is not a decision.
 */
export function parseDecision(markdown, fileName = "") {
  const text = normalize(markdown);
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const idFromName = fileName.match(FILE_PATTERN)?.[1] ? `ADR-${fileName.match(FILE_PATTERN)[1]}` : "";
  if (!match) {
    if (!idFromName) return null;
    return { id: idFromName, title: fileName, status: "accepted", date: "", task_id: "", tags: [], decision: "", context: "", file: fileName };
  }
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^".*"$/.test(value)) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    }
    fields[pair[1]] = value;
  }
  const body = match[2];
  const section = (name) => normalize(body.match(new RegExp(`\\n## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1] || "");
  const bullets = (value) => value.split("\n").map((line) => line.replace(/^-\s+/, "").trim()).filter((line) => line && !/^None recorded\.$/.test(line));
  const tags = String(fields.tags || "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tag) => tag.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return {
    id: String(fields.id || idFromName || "").trim(),
    title: String(fields.title || body.match(/^# [^:\n]+:\s*(.+)$/m)?.[1] || fileName).trim(),
    status: DECISION_STATUSES.includes(fields.status) ? fields.status : "accepted",
    date: String(fields.date || ""),
    task_id: String(fields.task || ""),
    tags,
    supersedes: String(fields.supersedes || ""),
    context: section("Context"),
    decision: section("Decision"),
    alternatives: bullets(section("Alternatives Considered")),
    consequences: bullets(section("Consequences")),
    file: fileName
  };
}

async function listDecisionFiles(directory) {
  try {
    return (await fs.readdir(directory)).filter((name) => FILE_PATTERN.test(name)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Read every decision under `<projectRoot>/.ai-dev/decisions`, newest first.
 *
 * @param {string} projectRoot - Repository root.
 * @param {{ status?: string, tag?: string, limit?: number }} [options]
 * @returns {Promise<object[]>} Parsed decision records.
 */
export async function listDecisions(projectRoot, { status = "", tag = "", limit = 50 } = {}) {
  const directory = path.join(path.resolve(projectRoot), ...DECISIONS_RELATIVE_DIR.split("/"));
  const files = await listDecisionFiles(directory);
  const records = [];
  for (const file of files.reverse()) {
    const text = await fs.readFile(path.join(directory, file), "utf8").catch(() => "");
    const record = parseDecision(text, file);
    if (!record) continue;
    if (status && record.status !== status) continue;
    if (tag && !record.tags.includes(slugify(tag, ""))) continue;
    records.push({ ...record, path: `${DECISIONS_RELATIVE_DIR}/${file}` });
  }
  return records.slice(0, Math.max(1, Math.min(Number(limit) || 50, 500)));
}

/**
 * Append a new decision (`NNNN-slug.md`) to the project ledger. Numbering
 * continues from the highest existing file so hand-written ADRs are respected.
 * Optionally marks an older decision as superseded.
 *
 * @param {string} projectRoot - Repository root.
 * @param {{ title: string, context: string, decision: string, alternatives?: string[], consequences?: string[], task_id?: string, tags?: string[], status?: string, supersedes?: string, now?: string }} input
 * @returns {Promise<{ record: object, path: string, superseded: string | null }>}
 */
export async function recordDecision(projectRoot, input) {
  const title = normalize(input?.title);
  const decision = normalize(input?.decision);
  if (!title) throw new Error("title is required.");
  if (!decision) throw new Error("decision is required.");
  const status = input?.status || "accepted";
  if (!DECISION_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${DECISION_STATUSES.join(", ")}`);
  }
  const root = path.resolve(projectRoot);
  const directory = path.join(root, ...DECISIONS_RELATIVE_DIR.split("/"));
  const files = await listDecisionFiles(directory);
  const last = files.length ? Number(files.at(-1).match(FILE_PATTERN)[1]) : 0;
  const number = String(last + 1).padStart(4, "0");
  const id = `ADR-${number}`;
  const record = {
    id,
    title,
    status,
    date: (input?.now || new Date().toISOString()).slice(0, 10),
    task_id: normalize(input?.task_id),
    tags: (input?.tags ?? []).map((tag) => slugify(tag, "")).filter(Boolean),
    supersedes: normalize(input?.supersedes),
    context: normalize(input?.context),
    decision,
    alternatives: (input?.alternatives ?? []).map(normalize).filter(Boolean),
    consequences: (input?.consequences ?? []).map(normalize).filter(Boolean)
  };
  const supersededFile = record.supersedes
    ? files.find((file) => `ADR-${file.match(FILE_PATTERN)[1]}` === record.supersedes)
    : null;
  if (record.supersedes && !supersededFile) {
    throw new Error(`Unknown decision to supersede: ${record.supersedes}`);
  }
  const fileName = `${number}-${slugify(title)}.md`;
  await atomicWriteFile(path.join(directory, fileName), renderDecision(record), "utf8");

  let superseded = null;
  if (supersededFile) {
    const targetPath = path.join(directory, supersededFile);
    const text = await fs.readFile(targetPath, "utf8");
    await atomicWriteFile(targetPath, text.replace(/^status: .*$/m, "status: superseded"), "utf8");
    superseded = `${DECISIONS_RELATIVE_DIR}/${supersededFile}`;
  }
  return { record, path: `${DECISIONS_RELATIVE_DIR}/${fileName}`, superseded };
}

/**
 * Compact Markdown summary of the latest decisions for a context pack.
 *
 * @param {object[]} decisions - Records from {@link listDecisions}.
 * @param {number} [limit=5]
 * @returns {string} Markdown bullet list (empty string when nothing to show).
 */
export function summarizeDecisions(decisions, limit = 5) {
  const items = (decisions ?? [])
    .filter((item) => item.status !== "rejected")
    .slice(0, Math.max(1, limit));
  if (!items.length) return "";
  return items.map((item) => {
    const line = normalize(item.decision).split("\n")[0].slice(0, 200);
    const marker = item.status === "superseded" ? " (superseded)" : "";
    return `- ${item.id}${marker}: ${item.title} — ${line || "see record"}`;
  }).join("\n");
}

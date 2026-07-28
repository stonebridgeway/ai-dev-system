import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", ".venv", "venv", "env", "node_modules", "dist", "build",
  "coverage", "__pycache__", ".pytest_cache", ".mypy_cache", "target", "vendor"
]);

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".graphql", ".h", ".html", ".java",
  ".js", ".jsx", ".json", ".kt", ".kts", ".md", ".mjs", ".php", ".prisma",
  ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift", ".toml",
  ".ts", ".tsx", ".vue", ".yaml", ".yml"
]);

const SECRET_FILE_PATTERN = /(^|\/)(\.env($|\.)|.*\.(key|pem|p12|pfx)|id_rsa|secrets?\.)/i;
const GENERATED_PATH_PATTERN = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.(js|css))$/i;

const TASK_HINTS = Object.freeze({
  frontend: {
    terms: ["frontend", "ui", "ux", "screen", "page", "layout", "component", "дизайн", "интерфейс", "страниц", "экран"],
    extensions: new Set([".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".html"])
  },
  backend: {
    terms: ["backend", "api", "endpoint", "server", "service", "бэкенд", "апи", "эндпоинт", "сервер"],
    extensions: new Set([".py", ".go", ".rs", ".java", ".kt", ".ts", ".js", ".php", ".rb"])
  },
  database: {
    terms: ["database", "migration", "schema", "query", "sql", "база", "миграц", "схем", "запрос"],
    extensions: new Set([".sql", ".prisma", ".py", ".ts", ".js"])
  },
  test: {
    terms: ["test", "spec", "coverage", "тест", "провер"],
    extensions: new Set([".test.ts", ".test.js", ".spec.ts", ".spec.js", ".py"])
  }
});

function normalize(value) {
  return String(value ?? "").trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tokens(value) {
  return [...new Set(normalize(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./:-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.replace(/^[./:-]+|[./:-]+$/g, ""))
    .filter((item) => item.length >= 3)
    .slice(0, 80))];
}

function taskDomains(task) {
  const normalized = normalize(task).toLowerCase();
  return Object.entries(TASK_HINTS)
    .filter(([, definition]) => definition.terms.some((term) => normalized.includes(term)))
    .map(([name]) => name);
}

function safeRelative(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function fileExtension(relativePath) {
  const lower = relativePath.toLowerCase();
  for (const compound of [".test.ts", ".test.js", ".spec.ts", ".spec.js"]) {
    if (lower.endsWith(compound)) return compound;
  }
  return path.extname(lower);
}

function scoreFile(relativePath, {
  taskTokens,
  domains,
  dirtyFiles
}) {
  const normalizedPath = safeRelative(relativePath).toLowerCase();
  const baseName = path.basename(normalizedPath);
  const extension = fileExtension(normalizedPath);
  let score = 0;
  const reasons = [];
  if (dirtyFiles.has(normalizedPath)) {
    score += 80;
    reasons.push("currently changed");
  }
  for (const token of taskTokens) {
    if (baseName.includes(token)) {
      score += 18;
      reasons.push(`filename matches "${token}"`);
    } else if (normalizedPath.includes(token)) {
      score += 8;
      reasons.push(`path matches "${token}"`);
    }
  }
  for (const domain of domains) {
    if (TASK_HINTS[domain].extensions.has(extension)) {
      score += 7;
      reasons.push(`${domain} file`);
    }
  }
  if (/((^|\/)(src|app|lib|server|client|api|routes|components|pages|features)\/)/.test(normalizedPath)) {
    score += 4;
    reasons.push("application source");
  }
  if (/((^|\/)(test|tests|__tests__)\/|\.(test|spec)\.)/.test(normalizedPath)) {
    score += domains.includes("test") ? 10 : 2;
    reasons.push("test coverage");
  }
  if (/^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|tsconfig\.json|vite\.config|next\.config)/.test(baseName)) {
    score += 5;
    reasons.push("project configuration");
  }
  if (GENERATED_PATH_PATTERN.test(normalizedPath)) score -= 50;
  return { score, reasons: [...new Set(reasons)].slice(0, 4) };
}

async function discoverFiles(projectRoot, {
  maxFiles = 6000,
  maxDepth = 12
} = {}) {
  const files = [];
  async function walk(directory, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = safeRelative(path.relative(projectRoot, path.join(directory, entry.name)));
      if (relativePath.startsWith(".ai-dev/context/")) continue;
      if (SECRET_FILE_PATTERN.test(relativePath)) continue;
      const extension = path.extname(entry.name.toLowerCase());
      if (!TEXT_EXTENSIONS.has(extension) && !["Dockerfile", "Makefile"].includes(entry.name)) continue;
      files.push(relativePath);
    }
  }
  await walk(projectRoot, 0);
  return files;
}

async function fileEvidence(projectRoot, relativePath, maxExcerptChars) {
  const target = path.join(projectRoot, ...relativePath.split("/"));
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isFile() || stats.size > 512 * 1024) return null;
  const content = await fs.readFile(target, "utf8").catch(() => "");
  if (!content || content.includes("\u0000")) return null;
  const excerpt = content.slice(0, maxExcerptChars);
  return {
    path: relativePath,
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString(),
    sha256: hash(content),
    excerpt,
    excerpt_truncated: content.length > excerpt.length
  };
}

function relevantCommands(commands, domains) {
  const selected = (commands ?? []).filter((command) => {
    const label = normalize(command.label).toLowerCase();
    if (domains.includes("test") && /test|lint|type|check/.test(label)) return true;
    if (domains.includes("frontend") && /dev|test|lint|type|build|frontend/.test(label)) return true;
    if (domains.includes("backend") && /dev|test|lint|type|build|api|backend/.test(label)) return true;
    return /test|lint|type|build/.test(label);
  });
  return (selected.length ? selected : commands ?? []).slice(0, 10);
}

export async function compileContextPack({
  projectRoot,
  task,
  project = {},
  identity = {},
  acceptanceCriteria = [],
  skills = [],
  projectState = {},
  agentRules = "",
  projectBrief = "",
  projectMap = "",
  qualityGate = "",
  maxSourceFiles = 12,
  maxChars = 24_000,
  now = new Date().toISOString()
}) {
  const root = path.resolve(projectRoot);
  const taskText = normalize(task);
  if (!taskText) throw new Error("Context compilation requires a task.");
  const domains = taskDomains(taskText);
  const taskTokens = tokens(taskText);
  const dirtyFiles = new Set((projectState.dirty_files ?? []).map((item) => safeRelative(item).toLowerCase()));
  const candidates = await discoverFiles(root);
  const ranked = candidates
    .map((relativePath) => ({
      path: relativePath,
      ...scoreFile(relativePath, { taskTokens, domains, dirtyFiles })
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, Math.min(Number(maxSourceFiles) || 12, 30)));

  const contentBudget = Math.max(4_000, maxChars - 4_000);
  const documentBudget = Math.floor(contentBudget * 0.55);
  const sourceBudget = Math.max(1_500, contentBudget - documentBudget);
  const excerptBudget = Math.max(500, Math.floor(sourceBudget / Math.max(1, ranked.length)));
  const selectedFiles = (await Promise.all(
    ranked.map((item) => fileEvidence(root, item.path, excerptBudget).then((evidence) => (
      evidence ? { ...item, ...evidence } : null
    )))
  )).filter(Boolean);

  const criteria = (acceptanceCriteria ?? []).map(normalize).filter(Boolean);
  const commands = relevantCommands(project.commands, domains);
  const unknowns = [];
  if (!criteria.length) unknowns.push("Acceptance criteria were not supplied; confirm observable completion conditions.");
  if (!selectedFiles.length) unknowns.push("No task-specific source files were identified; inspect the relevant component before editing.");
  if (!commands.some((command) => /test/i.test(normalize(command.label)))) {
    unknowns.push("No automated test command was detected for the selected project scope.");
  }
  if (domains.includes("frontend") && !projectBrief) {
    unknowns.push("Project brief is missing; product context may be incomplete for frontend work.");
  }

  const sourceFingerprint = hash(JSON.stringify({
    task: taskText,
    project_id: identity.project_id,
    project_state: projectState.fingerprint,
    files: selectedFiles.map((file) => [file.path, file.sha256]),
    skills: skills.map((skill) => [skill.name, skill.source]),
    criteria
  }));
  const compactTimestamp = now.replace(/\D/g, "").slice(0, 14);
  const contextPackId = `ctx-${compactTimestamp}-${sourceFingerprint.slice(0, 10)}`;
  const pack = {
    schema_version: 1,
    id: contextPackId,
    generated_at: now,
    task: taskText,
    domains,
    project: {
      id: identity.project_id || project.project_id || "",
      name: project.project_name || path.basename(root),
      root,
      repository_id: identity.repository_id || project.repository_id || "",
      types: project.project_types ?? [],
      stack: project.stack ?? [],
      components: project.components ?? []
    },
    acceptance_criteria: criteria,
    routed_skills: skills.slice(0, 3),
    commands,
    quality_gaps: project.quality_gaps ?? [],
    risk_signals: project.risk_signals ?? [],
    selected_files: selectedFiles,
    context_sources: {
      agents: agentRules.slice(0, Math.floor(documentBudget * 0.2)),
      project_brief: projectBrief.slice(0, Math.floor(documentBudget * 0.3)),
      project_map: projectMap.slice(0, Math.floor(documentBudget * 0.2)),
      quality_gate: qualityGate.slice(0, Math.floor(documentBudget * 0.3))
    },
    unknowns,
    boundaries: [
      "Read selected files and their nearby dependencies before editing.",
      "Do not load unrelated repository files or the full skill catalog.",
      "Never include .env, private keys, certificates, or secret values in the context pack.",
      "Recompile after architecture, task scope, project state, or acceptance criteria change."
    ],
    source_state_fingerprint: projectState.fingerprint || "",
    source_fingerprint: sourceFingerprint
  };
  let markdown = renderContextPack(pack);
  while (markdown.length > maxChars && pack.selected_files.length > 1) {
    pack.selected_files.pop();
    markdown = renderContextPack(pack);
  }
  if (markdown.length > maxChars) {
    pack.selected_files = pack.selected_files.map((file) => ({
      ...file,
      excerpt: file.excerpt.slice(0, 240),
      excerpt_truncated: true
    }));
    markdown = renderContextPack(pack);
  }
  if (markdown.length > maxChars) {
    for (const key of Object.keys(pack.context_sources)) {
      pack.context_sources[key] = pack.context_sources[key].slice(0, 600);
    }
    markdown = renderContextPack(pack);
  }
  if (markdown.length > maxChars) {
    pack.selected_files = [];
    markdown = renderContextPack(pack);
  }
  return {
    ...pack,
    markdown,
    budget: {
      max_chars: maxChars,
      actual_chars: markdown.length,
      estimated_tokens: Math.ceil(markdown.length / 4),
      selected_source_files: selectedFiles.length,
      discovered_text_files: candidates.length
    }
  };
}

function bullet(values, empty = "None detected.") {
  return values?.length ? values.map((value) => `- ${normalize(value)}`).join("\n") : `- ${empty}`;
}

export function renderContextPack(pack) {
  const lines = [
    "# Project Context Pack",
    "",
    `- ID: \`${pack.id}\``,
    `- Generated: ${pack.generated_at}`,
    `- Project: ${pack.project.name} (\`${pack.project.id || "unregistered"}\`)`,
    `- Source state: \`${pack.source_state_fingerprint || "filesystem"}\``,
    "",
    "## Task",
    "",
    pack.task,
    "",
    "## Acceptance Criteria",
    "",
    bullet(pack.acceptance_criteria, "Not supplied; define before implementation."),
    "",
    "## Routed Skills",
    "",
    ...(pack.routed_skills.length ? pack.routed_skills.map((skill) => (
      `- \`${skill.name}\`${skill.source ? ` (${skill.source})` : ""}: ${normalize(skill.reason) || "Task route."}`
    )) : ["- No skills routed."]),
    "",
    "## Project Shape",
    "",
    `- Types: ${(pack.project.types ?? []).join(", ") || "unknown"}`,
    `- Stack: ${(pack.project.stack ?? []).join(", ") || "unknown"}`,
    `- Domains inferred from task: ${pack.domains.join(", ") || "general"}`,
    "",
    "## Relevant Commands",
    "",
    ...(pack.commands.length ? pack.commands.map((command) => (
      `- ${normalize(command.label)}: \`${normalize(command.command)}\` (cwd: \`${normalize(command.cwd) || "."}\`)`
    )) : ["- No commands detected."]),
    "",
    "## Risks And Quality Gaps",
    "",
    bullet([...(pack.risk_signals ?? []), ...(pack.quality_gaps ?? [])]),
    "",
    "## Selected Source Files",
    ""
  ];
  if (!pack.selected_files.length) {
    lines.push("- No task-specific files selected.");
  }
  for (const file of pack.selected_files) {
    lines.push(
      `### \`${file.path}\``,
      "",
      `Relevance: ${file.score}; ${file.reasons.join(", ") || "project context"}.`,
      `SHA-256: \`${file.sha256}\``,
      "",
      "```text",
      file.excerpt,
      file.excerpt_truncated ? "\n... excerpt truncated ..." : "",
      "```",
      ""
    );
  }
  lines.push(
    "## Agent Rules",
    "",
    pack.context_sources.agents || "AGENTS.md is missing.",
    "",
    "## Project Brief",
    "",
    pack.context_sources.project_brief || "Project brief is missing.",
    "",
    "## Quality Gate",
    "",
    pack.context_sources.quality_gate || "Quality gate is missing.",
    "",
    "## Open Questions",
    "",
    bullet(pack.unknowns, "No automatic unknowns."),
    "",
    "## Context Boundaries",
    "",
    bullet(pack.boundaries),
    ""
  );
  return lines.join("\n");
}

export function contextPackFreshness(pack, projectState) {
  const current = normalize(projectState?.fingerprint);
  const source = normalize(pack?.source_state_fingerprint);
  return {
    fresh: Boolean(current && source && current === source),
    source_state_fingerprint: source,
    current_state_fingerprint: current,
    reason: current === source
      ? "Project state matches the compiled context."
      : "Project state changed after context compilation."
  };
}

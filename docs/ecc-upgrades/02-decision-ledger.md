# 02. Журнал решений (ADR-lite) и секции «extras» в context pack

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01. **Требуется для:** 09 и 10 (они добавляют свои провайдеры в `context-extras.mjs`).

## Идея из ECC

В ECC решения фиксируются в `docs/decisions` и через планировщик, а память проекта
(`memory-persistence`, `session-start`) подмешивается в контекст каждой сессии. В
`ai-dev-system` уже есть `.ai-dev/project-brief.md` и `project-map.md`, но нет места для
«почему код именно такой». Этот апгрейд добавляет:

- `.ai-dev/decisions/NNNN-slug.md` — нумерованные ADR с frontmatter (id, title, status, date, task, tags, supersedes);
- инструменты `record_decision` и `list_decisions`;
- механизм **extra sections**: `compileContextPack` принимает `extras.sections`, а
  `loadContextExtras()` собирает их из провайдеров (решения, позже handoff и инстинкты). Секции
  рендерятся после «Routed Skills» и первыми урезаются при переполнении `maxChars`.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/decision-ledger.mjs`** (231 строк)

```js
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
```

**Файл: `ai-dev-mcp-server/src/core/decision-ledger.test.mjs`** (89 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listDecisions,
  parseDecision,
  recordDecision,
  renderDecision,
  summarizeDecisions
} from "./decision-ledger.mjs";

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("records numbered ADR files, lists newest first, and supersedes older decisions", async (t) => {
  const root = await tempProject(t);
  const first = await recordDecision(root, {
    title: "Use SQLite for local state",
    context: "We need durable local state without a server.",
    decision: "Keep SQLite as the only local database.",
    alternatives: ["Postgres in Docker", "JSON files"],
    consequences: ["No network dependency", "Single-writer limits"],
    task_id: "task-20260101T000000-abcdef12",
    tags: ["Storage", "local first"],
    now: "2026-01-01T10:00:00.000Z"
  });
  assert.equal(first.record.id, "ADR-0001");
  assert.equal(first.path, ".ai-dev/decisions/0001-use-sqlite-for-local-state.md");
  assert.deepEqual(first.record.tags, ["storage", "local-first"]);

  const second = await recordDecision(root, {
    title: "Move state to Postgres",
    context: "Multi-user access is now required.",
    decision: "Use Postgres for shared state.",
    supersedes: "ADR-0001",
    now: "2026-02-01T10:00:00.000Z"
  });
  assert.equal(second.record.id, "ADR-0002");
  assert.equal(second.superseded, ".ai-dev/decisions/0001-use-sqlite-for-local-state.md");

  const decisions = await listDecisions(root);
  assert.deepEqual(decisions.map((item) => item.id), ["ADR-0002", "ADR-0001"]);
  assert.equal(decisions[1].status, "superseded");
  assert.equal(decisions[1].task_id, "task-20260101T000000-abcdef12");
  assert.deepEqual(decisions[1].alternatives, ["Postgres in Docker", "JSON files"]);
  assert.deepEqual(await listDecisions(root, { tag: "storage" }).then((items) => items.map((item) => item.id)), ["ADR-0001"]);
  assert.deepEqual(await listDecisions(root, { status: "accepted" }).then((items) => items.map((item) => item.id)), ["ADR-0002"]);

  const summary = summarizeDecisions(decisions);
  assert.match(summary, /ADR-0002: Move state to Postgres — Use Postgres for shared state\./);
  assert.match(summary, /ADR-0001 \(superseded\)/);
});

test("render and parse round-trip preserves fields and rejects bad input", async (t) => {
  const record = {
    id: "ADR-0007",
    title: "Adopt \"strict\" mode",
    status: "proposed",
    date: "2026-03-01",
    task_id: "",
    tags: ["typescript"],
    context: "Loose types hide bugs.",
    decision: "Enable strict mode.\nMigrate module by module.",
    alternatives: ["Keep as is"],
    consequences: ["More compile errors at first"]
  };
  const parsed = parseDecision(renderDecision(record), "0007-adopt-strict-mode.md");
  assert.equal(parsed.id, "ADR-0007");
  assert.equal(parsed.title, "Adopt \"strict\" mode");
  assert.equal(parsed.status, "proposed");
  assert.deepEqual(parsed.tags, ["typescript"]);
  assert.equal(parsed.decision, "Enable strict mode.\nMigrate module by module.");
  assert.deepEqual(parsed.consequences, ["More compile errors at first"]);
  assert.equal(parseDecision("just text", "notes.md"), null);
  assert.equal(parseDecision("# hand written", "0003-hand-written.md").id, "ADR-0003");

  const root = await tempProject(t);
  await assert.rejects(recordDecision(root, { title: "", decision: "x" }), /title is required/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "" }), /decision is required/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "y", status: "maybe" }), /status must be one of/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "y", supersedes: "ADR-0099" }), /Unknown decision to supersede/);
  assert.equal(await listDecisions(root).then((items) => items.length), 0);
  assert.equal(summarizeDecisions([]), "");
});
```

Провайдеры контекста. Файл показан в финальном виде (с провайдерами handoff и инстинктов из
09/10); если переносите только 02, оставьте `decisionsContextProvider` и удалите два других
импорта и записи в `CONTEXT_EXTRA_PROVIDERS`.

**Файл: `ai-dev-mcp-server/src/core/context-extras.mjs`** (101 строк)

```js
import { listDecisions, summarizeDecisions } from "./decision-ledger.mjs";
import { InstinctStore } from "./instincts.mjs";
import { SessionStore, sessionAgeDays } from "./session-memory.mjs";

/**
 * Extra context-pack sections contributed by optional subsystems (decision
 * ledger, learned instincts, session handoff, ...). Each provider receives the
 * same input and returns `null` or `{ id, title, markdown, items }`.
 *
 * Providers must be cheap, read-only, and must never throw: a broken provider
 * is reported as an `unknown` entry instead of failing `begin_task`.
 */
export const CONTEXT_EXTRA_PROVIDERS = [
  decisionsContextProvider,
  handoffContextProvider,
  instinctsContextProvider
];

/**
 * Recent architecture decisions from `<projectRoot>/.ai-dev/decisions`.
 *
 * @param {{ projectRoot: string }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function decisionsContextProvider({ projectRoot }) {
  const decisions = await listDecisions(projectRoot, { limit: 20 });
  const markdown = summarizeDecisions(decisions, 5);
  if (!markdown) return null;
  return {
    id: "decisions",
    title: "Recent Decisions",
    markdown,
    items: decisions.slice(0, 5).map((item) => ({ id: item.id, title: item.title, status: item.status, path: item.path }))
  };
}

/**
 * Latest substantive session handoff for the project: next step, blockers,
 * and approaches that already failed (so they are not retried).
 *
 * @param {{ stateRoot?: string, projectId?: string }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function handoffContextProvider({ stateRoot, projectId }) {
  if (!stateRoot || !projectId) return null;
  const record = await new SessionStore({ stateRoot }).latest(projectId);
  if (!record) return null;
  const age = sessionAgeDays(record);
  const lines = [
    `- Saved ${record.saved_at}${age > 7 ? ` (WARNING: ${Math.floor(age)} days ago; verify against git before trusting it)` : ""}${record.task_id ? `, task ${record.task_id}` : ""}: ${record.topic}`,
    `- Next step: ${record.next_step || "not recorded"}`
  ];
  for (const item of (record.failed ?? []).slice(0, 3)) lines.push(`- Do not retry: ${item.approach} (${item.reason || "reason not recorded"})`);
  for (const item of (record.blockers ?? []).slice(0, 3)) lines.push(`- Blocker: ${item}`);
  lines.push("- Historical reference only: verify the working tree before acting on it.");
  return {
    id: "handoff",
    title: "Last Session Handoff",
    markdown: lines.join("\n"),
    items: [{ id: record.id, saved_at: record.saved_at, task_id: record.task_id }]
  };
}

/**
 * High-confidence learned instincts relevant to this project, stack, and task.
 *
 * @param {{ stateRoot?: string, projectId?: string, task?: string, stack?: string[] }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function instinctsContextProvider({ stateRoot, projectId, task, stack = [] }) {
  if (!stateRoot) return null;
  const ranked = await new InstinctStore({ stateRoot }).rankForContext({ projectId, stack, task });
  if (!ranked.instincts.length) return null;
  return {
    id: "instincts",
    title: "Learned Instincts",
    markdown: ranked.markdown,
    items: ranked.instincts.map((item) => ({ id: item.id, confidence: item.effective_confidence, scope: item.scope }))
  };
}

/**
 * Run every registered provider and collect the sections a context pack should
 * render after the routed skills. Errors are captured per provider.
 *
 * @param {{ projectRoot: string, stateRoot?: string, projectId?: string, task?: string, stack?: string[], providers?: Function[] }} input
 * @returns {Promise<{ sections: object[], errors: string[] }>}
 */
export async function loadContextExtras({ projectRoot, stateRoot = "", projectId = "", task = "", stack = [], providers = CONTEXT_EXTRA_PROVIDERS }) {
  const sections = [];
  const errors = [];
  for (const provider of providers) {
    try {
      const section = await provider({ projectRoot, stateRoot, projectId, task, stack });
      if (section?.markdown) sections.push(section);
    } catch (error) {
      errors.push(`${provider.name || "provider"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sections, errors };
}
```

**Файл: `ai-dev-mcp-server/src/core/context-extras.test.mjs`** (64 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordDecision } from "./decision-ledger.mjs";
import { InstinctStore } from "./instincts.mjs";
import { SessionStore } from "./session-memory.mjs";
import { decisionsContextProvider, handoffContextProvider, instinctsContextProvider, loadContextExtras } from "./context-extras.mjs";

test("context extras collect decision sections and isolate provider failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const empty = await loadContextExtras({ projectRoot: root });
  assert.deepEqual(empty, { sections: [], errors: [] });

  await recordDecision(root, { title: "Use pnpm", context: "Monorepo.", decision: "pnpm workspaces everywhere." });
  const loaded = await loadContextExtras({
    projectRoot: root,
    providers: [
      decisionsContextProvider,
      async function brokenProvider() { throw new Error("boom"); },
      async () => null
    ]
  });
  assert.equal(loaded.sections.length, 1);
  assert.equal(loaded.sections[0].id, "decisions");
  assert.match(loaded.sections[0].markdown, /ADR-0001: Use pnpm — pnpm workspaces everywhere\./);
  assert.deepEqual(loaded.errors, ["brokenProvider: boom"]);
});

test("handoff and instinct providers surface session memory and learned behaviors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  assert.equal(await handoffContextProvider({ stateRoot, projectId: "project-x" }), null);
  assert.equal(await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "x" }), null);

  await new SessionStore({ stateRoot }).save({
    projectId: "project-x",
    projectPath: root,
    building: "Payment retries with idempotency keys across the checkout service.",
    failed: [{ approach: "Retrying without keys", reason: "double charges in staging" }],
    blockers: ["Need sandbox credentials"],
    next_step: "Add the idempotency middleware and re-run verify_task.",
    now: "2026-01-01T00:00:00.000Z"
  });
  const handoff = await handoffContextProvider({ stateRoot, projectId: "project-x" });
  assert.equal(handoff.id, "handoff");
  assert.match(handoff.markdown, /Next step: Add the idempotency middleware/);
  assert.match(handoff.markdown, /Do not retry: Retrying without keys \(double charges in staging\)/);
  assert.match(handoff.markdown, /WARNING: \d+ days ago/);

  const store = new InstinctStore({ stateRoot });
  await store.record({ trigger: "when retrying payments", action: "use idempotency keys", domain: "architecture", projectId: "project-x", confidence: 0.8 });
  await store.record({ trigger: "when naming files", action: "prefer kebab-case", domain: "code-style", projectId: "project-x", confidence: 0.4 });
  const instincts = await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "Fix payment retries", stack: ["Node.js"] });
  assert.equal(instincts.items.length, 1, "only instincts above the 0.7 threshold are injected");
  assert.match(instincts.markdown, /use idempotency keys/);

  const all = await loadContextExtras({ projectRoot: root, stateRoot, projectId: "project-x", task: "Fix payment retries" });
  assert.deepEqual(all.sections.map((section) => section.id), ["handoff", "instincts"]);
});
```

**Файл: `ai-dev-mcp-server/src/extensions/decisions.mjs`** (111 строк)

```js
import {
  DECISION_STATUSES,
  DECISIONS_RELATIVE_DIR,
  listDecisions,
  recordDecision
} from "../core/decision-ledger.mjs";

/**
 * Decision ledger tools: lightweight ADRs stored with the code under
 * `.ai-dev/decisions/` and surfaced in every context pack.
 *
 * @param {{ resolveProjectIdentity: Function, taskStore: { read: Function, checkpoint: Function }, markSearchIndexDirty?: Function }} host
 */
export function createDecisionTools(host) {
  async function projectRootFor({ project_path, task_id }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      return { projectRoot: (await host.resolveProjectIdentity(record.project.path)).project_root, record };
    }
    if (!project_path) throw new Error("project_path or task_id is required.");
    return { projectRoot: (await host.resolveProjectIdentity(project_path)).project_root, record: null };
  }

  return {
    definitions: [
      {
        name: "record_decision",
        description: "Record an architecture or product decision as a numbered ADR under .ai-dev/decisions (title, context, decision, alternatives, consequences). Decisions are versioned with the code and surfaced in later context packs.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task that produced the decision; a checkpoint note is added to it." },
            title: { type: "string" },
            context: { type: "string", description: "Why the decision was needed." },
            decision: { type: "string", description: "What was decided, stated as a fact." },
            alternatives: { type: "array", items: { type: "string" }, default: [] },
            consequences: { type: "array", items: { type: "string" }, default: [] },
            tags: { type: "array", items: { type: "string" }, default: [] },
            status: { type: "string", enum: DECISION_STATUSES, default: "accepted" },
            supersedes: { type: "string", description: "Id of an older decision this one replaces, for example ADR-0003." }
          },
          required: ["title", "decision"]
        }
      },
      {
        name: "list_decisions",
        description: "List recorded decisions (ADRs) for a project, newest first, optionally filtered by status or tag.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            status: { type: "string", enum: DECISION_STATUSES },
            tag: { type: "string" },
            limit: { type: "number", default: 20 }
          }
        }
      }
    ],
    handlers: {
      async record_decision(args) {
        const { projectRoot, record } = await projectRootFor(args);
        const result = await recordDecision(projectRoot, {
          title: args.title,
          context: args.context,
          decision: args.decision,
          alternatives: args.alternatives,
          consequences: args.consequences,
          tags: args.tags,
          status: args.status,
          supersedes: args.supersedes,
          task_id: args.task_id || ""
        });
        let checkpoint = null;
        if (record && record.status !== "complete") {
          checkpoint = await host.taskStore.checkpoint(record.id, {
            summary: `Decision recorded: ${result.record.id} ${result.record.title}`,
            changedFiles: [result.path],
            notes: result.record.decision
          }).then((updated) => ({ task_id: updated.id, checkpoints: updated.checkpoints.length }));
        }
        host.markSearchIndexDirty?.(`decision recorded: ${result.path}`);
        return {
          action: "decision_recorded",
          project_path: projectRoot,
          decision: result.record,
          path: result.path,
          superseded: result.superseded,
          checkpoint,
          next_step: `Commit ${DECISIONS_RELATIVE_DIR} with the code change so the decision travels with the repository.`
        };
      },
      async list_decisions(args) {
        const { projectRoot } = await projectRootFor(args);
        const decisions = await listDecisions(projectRoot, {
          status: args.status,
          tag: args.tag,
          limit: args.limit
        });
        return {
          project_path: projectRoot,
          directory: DECISIONS_RELATIVE_DIR,
          count: decisions.length,
          decisions
        };
      }
    },
    readOnly: ["list_decisions"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/decisions.test.mjs`** (51 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createDecisionTools } from "./decisions.mjs";

test("decision tools record ADRs, checkpoint the task, and list results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const dirty = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createDecisionTools]);
  assert.deepEqual(registry.definitions.map((item) => item.name), ["record_decision", "list_decisions"]);
  assert.deepEqual(registry.readOnly, ["list_decisions"]);

  const task = await taskStore.begin({
    task: "Choose storage",
    project: { project_name: "fixture", project_path: projectRoot, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" }
  });
  const recorded = await registry.handlers.get("record_decision")({
    task_id: task.id,
    title: "Keep SQLite",
    context: "Single machine.",
    decision: "SQLite stays the state store.",
    tags: ["storage"]
  });
  assert.equal(recorded.decision.id, "ADR-0001");
  assert.equal(recorded.checkpoint.checkpoints, 1);
  assert.equal(dirty.length, 1);
  const updated = await taskStore.read(task.id);
  assert.match(updated.checkpoints[0].summary, /Decision recorded: ADR-0001 Keep SQLite/);
  assert.deepEqual(updated.checkpoints[0].changed_files, [".ai-dev/decisions/0001-keep-sqlite.md"]);

  const listed = await registry.handlers.get("list_decisions")({ project_path: projectRoot, tag: "storage" });
  assert.equal(listed.count, 1);
  assert.equal(listed.decisions[0].task_id, task.id);

  await assert.rejects(registry.handlers.get("list_decisions")({}), /project_path or task_id is required/);
});
```

## Изменения существующих файлов

```diff
diff --git a/ai-dev-mcp-server/src/core/context-compiler.mjs b/ai-dev-mcp-server/src/core/context-compiler.mjs
index 4d446bc..1621b2b 100644
--- a/ai-dev-mcp-server/src/core/context-compiler.mjs
+++ b/ai-dev-mcp-server/src/core/context-compiler.mjs
@@ -181,7 +181,7 @@ function relevantCommands(commands, domains) {
  * acceptance criteria, routed skills, and the project brief/map/quality-gate,
  * all fingerprinted against the current project state for freshness checks.
  *
- * @param {{ projectRoot: string, task: string, project?: object, identity?: object, acceptanceCriteria?: string[], skills?: object[], projectState?: object, agentRules?: string, projectBrief?: string, projectMap?: string, qualityGate?: string, maxSourceFiles?: number, maxChars?: number, now?: string }} input
+ * @param {{ projectRoot: string, task: string, project?: object, identity?: object, acceptanceCriteria?: string[], skills?: object[], projectState?: object, agentRules?: string, projectBrief?: string, projectMap?: string, qualityGate?: string, extras?: { sections?: Array<{ id?: string, title?: string, markdown: string, items?: object[] }> }, maxSourceFiles?: number, maxChars?: number, now?: string }} input
  * @returns {Promise<object>} Context pack.
  */
 export async function compileContextPack({
@@ -196,6 +196,7 @@ export async function compileContextPack({
   projectBrief = "",
   projectMap = "",
   qualityGate = "",
+  extras = { sections: [] },
   maxSourceFiles = 12,
   maxChars = 24_000,
   now = new Date().toISOString()
@@ -265,6 +266,14 @@ export async function compileContextPack({
     },
     acceptance_criteria: criteria,
     routed_skills: skills.slice(0, 3),
+    extra_sections: (extras?.sections ?? [])
+      .filter((section) => section?.markdown)
+      .map((section) => ({
+        id: String(section.id || "extra"),
+        title: String(section.title || "Additional Context"),
+        markdown: String(section.markdown),
+        items: section.items ?? []
+      })),
     commands,
     quality_gaps: project.quality_gaps ?? [],
     risk_signals: project.risk_signals ?? [],
@@ -304,6 +313,13 @@ export async function compileContextPack({
     }
     markdown = renderContextPack(pack);
   }
+  if (markdown.length > maxChars) {
+    pack.extra_sections = pack.extra_sections.map((section) => ({
+      ...section,
+      markdown: section.markdown.slice(0, 400)
+    }));
+    markdown = renderContextPack(pack);
+  }
   if (markdown.length > maxChars) {
     pack.selected_files = [];
     markdown = renderContextPack(pack);
@@ -355,6 +371,7 @@ export function renderContextPack(pack) {
       `- \`${skill.name}\`${skill.source ? ` (${skill.source})` : ""}: ${normalize(skill.reason) || "Task route."}`
     )) : ["- No skills routed."]),
     "",
+    ...(pack.extra_sections ?? []).flatMap((section) => [`## ${section.title}`, "", section.markdown, ""]),
     "## Project Shape",
     "",
     `- Types: ${(pack.project.types ?? []).join(", ") || "unknown"}`,
```

```diff
diff --git a/ai-dev-mcp-server/src/core/context-compiler.test.mjs b/ai-dev-mcp-server/src/core/context-compiler.test.mjs
index 67aa2dc..0a8b1bb 100644
--- a/ai-dev-mcp-server/src/core/context-compiler.test.mjs
+++ b/ai-dev-mcp-server/src/core/context-compiler.test.mjs
@@ -38,3 +38,40 @@ test("context compiler selects task files, excludes secrets, and stays bounded",
   assert.equal(contextPackFreshness(pack, { fingerprint: "state-one" }).fresh, true);
   assert.equal(contextPackFreshness(pack, { fingerprint: "state-two" }).fresh, false);
 });
+
+test("context compiler renders extra sections after routed skills and trims them under pressure", async (t) => {
+  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-compiler-extras-"));
+  t.after(() => fs.rm(root, { recursive: true, force: true }));
+  await fs.writeFile(path.join(root, "index.ts"), "export const x = 1;\n");
+  const extras = {
+    sections: [
+      { id: "decisions", title: "Recent Decisions", markdown: "- ADR-0001: Keep SQLite", items: [{ id: "ADR-0001" }] },
+      { id: "empty", title: "Ignored", markdown: "" }
+    ]
+  };
+  const pack = await compileContextPack({
+    projectRoot: root,
+    task: "Refactor index",
+    project: { project_name: "Fixture", project_types: ["backend"], commands: [] },
+    projectState: { fingerprint: "s1", dirty_files: [] },
+    extras,
+    maxChars: 12_000
+  });
+  assert.deepEqual(pack.extra_sections.map((section) => section.id), ["decisions"]);
+  const skillsIndex = pack.markdown.indexOf("## Routed Skills");
+  const decisionsIndex = pack.markdown.indexOf("## Recent Decisions");
+  const shapeIndex = pack.markdown.indexOf("## Project Shape");
+  assert.ok(skillsIndex < decisionsIndex && decisionsIndex < shapeIndex);
+  assert.match(pack.markdown, /- ADR-0001: Keep SQLite/);
+
+  const squeezed = await compileContextPack({
+    projectRoot: root,
+    task: "Refactor index",
+    project: { project_name: "Fixture", project_types: ["backend"], commands: [] },
+    projectState: { fingerprint: "s1", dirty_files: [] },
+    extras: { sections: [{ id: "big", title: "Big", markdown: "x".repeat(9_000) }] },
+    maxChars: 8_000
+  });
+  assert.ok(squeezed.extra_sections[0].markdown.length <= 400);
+  assert.ok(squeezed.budget.actual_chars <= 8_000 || squeezed.selected_files.length === 0);
+});
```

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index 46ce88d..af8803e 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -51,6 +51,7 @@ import {
   compileContextPack,
   contextPackFreshness
 } from "./core/context-compiler.mjs";
+import { loadContextExtras } from "./core/context-extras.mjs";
 import {
   DIAGRAM_REQUEST_PATTERN,
   prioritizeRoutedRecommendations,
@@ -8159,6 +8160,7 @@ async function buildProjectContextPack({
     projectBrief: brief,
     projectMap,
     qualityGate,
+    extras: await loadContextExtras({ projectRoot: identity.project_root, stateRoot: taskStateRoot, projectId: identity.project_id, task }),
     maxSourceFiles,
     maxChars
   });
@@ -8284,6 +8286,7 @@ async function beginTask({
     projectBrief: brief,
     projectMap,
     qualityGate,
+    extras: await loadContextExtras({ projectRoot, stateRoot: taskStateRoot, projectId: identity.project_id, task }),
     maxSourceFiles: 12,
     maxChars: 20_000
   });
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index b768e25..e861e1b 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -20,9 +20,10 @@
  * import cycle and couple pure logic to the vault.
  */
 
+import { createDecisionTools } from "./extensions/decisions.mjs";
+
 export const EXTENSION_FACTORIES = [
-  // Register extension factories here, for example:
-  // createInstinctTools,
+  createDecisionTools
 ];
 
 /**
```

## Подключение

1. Добавить четыре новых файла ядра/расширения и тесты.
2. `context-compiler.mjs`: параметр `extras`, поле `extra_sections`, рендер и урезание.
3. `mcp-stdio.mjs`: импорт `loadContextExtras`, вызов в `buildProjectContextPack` и `beginTask`.
4. `tool-extensions.mjs`: `createDecisionTools` в `EXTENSION_FACTORIES`.

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/decision-ledger.test.mjs src/core/context-extras.test.mjs src/core/context-compiler.test.mjs src/extensions/decisions.test.mjs
```

## Использование

```json
{ "tool": "record_decision", "args": {
  "project_path": "/repo", "task_id": "task-20260910T120000-1a2b3c4d",
  "title": "Use Postgres advisory locks for job claims",
  "context": "Two workers claimed the same job under load.",
  "decision": "Claim jobs with pg_try_advisory_xact_lock inside the claim transaction.",
  "alternatives": ["SELECT ... FOR UPDATE SKIP LOCKED", "Redis lease"],
  "consequences": ["Claims are Postgres-only", "Simpler than a Redis dependency"],
  "tags": ["jobs", "postgres"] } }
```

Ответ содержит `id` (`0001`), путь файла и отрендеренный markdown. `list_decisions` возвращает
краткую сводку; в context pack следующей задачи появится секция «Decisions» с последними
принятыми решениями. Устаревшее решение помечайте через `supersedes: "0001"` — старое переводится
в `superseded` автоматически (проверка существования делается до записи).

## Для Argentum

Журнал решений — прямой кандидат в «память проекта» воркспейса: файлы версионируются вместе с
кодом, а не живут в `~/.ai-dev`, поэтому переживут смену машины и попадут в PR.

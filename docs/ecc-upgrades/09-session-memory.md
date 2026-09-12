# 09. Память сессий: `save_session` / `resume_session` и бюджет контекста

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01, 02 (провайдеры `context-extras.mjs`). Вместе с 10 составляет один коммит
(`feat(memory)`), поэтому diff-ы общих файлов приведены здесь, а в 10 — только инстинкты.

## Идея из ECC

Команды `/save-session` и `/resume-session` с жёстким форматом («что строим, что сработало
(с доказательством), что не сработало и почему, что не пробовали, состояние файлов, решения,
блокеры, точный следующий шаг») и защитой «HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS».
Плюс `strategic-compact`/`suggest-compact`: сжимать контекст на границах фаз, а не посреди
правки. В `ai-dev-system`:

- `SessionStore` пишет записи в `~/.ai-dev/state/sessions/<project_id>/<session_id>.json`;
  «содержательность» записи считается `sessionSubstanceScore` (пустые handoff-ы не побеждают
  при `resume`);
- `save_session` дополнительно проецирует handoff в `.ai-dev/context/handoff.md` (его читает
  хук `session-start` из документа 11 и провайдер контекста);
- `resume_session` собирает брифинг: handoff + открытые задачи проекта + git-состояние +
  свежесть context pack + инстинкты, с предупреждением о «историчности»;
- `context_budget_status` оценивает статический оверхед задачи (context pack, скиллы, правила,
  `AGENTS.md`, число чекпойнтов/верификаций) относительно окна модели и советует, когда сжимать;
- провайдер `handoffContextProvider` добавляет секцию «Session Handoff» в context pack следующего
  `begin_task`.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/session-memory.mjs`** (363 строк)

```js
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomic-files.mjs";

export const HANDOFF_RELATIVE_PATH = ".ai-dev/context/handoff.md";
export const FILE_STATUSES = ["complete", "in_progress", "broken", "not_started"];
const STALE_AFTER_DAYS = 7;
const DEFAULT_WINDOW_TOKENS = 200_000;

function normalize(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function list(values) {
  return (Array.isArray(values) ? values : values ? [values] : []).map(normalize).filter(Boolean);
}

/**
 * Normalize `[{ [first]: …, [second]: … }]` input. A bare string becomes the
 * first field. `aliases` are accepted for the second field and folded into it,
 * so both spellings that appear in the wild reach storage as one key (ECC's
 * save-session prompt writes `why` where this schema says `reason`).
 *
 * @param {unknown} values
 * @param {string} first
 * @param {string} second
 * @param {string[]} [aliases] - Alternative input keys for `second`.
 * @returns {Array<Record<string, string>>}
 */
function pairs(values, first, second, aliases = []) {
  return (Array.isArray(values) ? values : []).map((item) => {
    if (typeof item === "string") return { [first]: normalize(item), [second]: "" };
    const secondValue = [second, ...aliases].map((key) => normalize(item?.[key])).find(Boolean) || "";
    return { [first]: normalize(item?.[first]), [second]: secondValue };
  }).filter((item) => item[first]);
}

function slug(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}

/**
 * Validate and normalize a session handoff record (the ECC save-session
 * sections: what we are building, what worked with evidence, what failed and
 * why, untried ideas, file states, decisions, blockers, exact next step).
 *
 * `failed` entries take `{ approach, reason }` or `{ approach, why }`; both are
 * stored as `reason`.
 *
 * @param {object} input
 * @returns {object} Normalized record without storage metadata.
 */
export function normalizeSessionRecord(input = {}) {
  const topic = normalize(input.topic);
  const building = normalize(input.building);
  if (!topic && !building) throw new Error("topic or building is required.");
  const files = (Array.isArray(input.files) ? input.files : []).map((item) => {
    const filePath = normalize(typeof item === "string" ? item : item?.path);
    if (!filePath) return null;
    const status = normalize(item?.status).toLowerCase().replace(/[\s-]+/g, "_") || "in_progress";
    return { path: filePath, status: FILE_STATUSES.includes(status) ? status : "in_progress", notes: normalize(item?.notes) };
  }).filter(Boolean);
  return {
    topic: topic || building.split("\n")[0].slice(0, 120),
    building,
    worked: pairs(input.worked, "item", "evidence"),
    failed: pairs(input.failed, "approach", "reason", ["why"]),
    untried: list(input.untried),
    files,
    decisions: pairs(input.decisions, "decision", "reason"),
    blockers: list(input.blockers),
    next_step: normalize(input.next_step),
    environment: normalize(input.environment)
  };
}

/**
 * ECC-style substantiveness check: a handoff must carry real content, not
 * placeholders, before it can be selected for resume or injected as context.
 *
 * @param {object} record
 * @returns {number} Score; 0 means reject.
 */
export function sessionSubstanceScore(record) {
  if (!record) return 0;
  let score = 0;
  const placeholder = /^\s*(\[.*\]|-|n\/a|none|tbd|todo)\s*$/i;
  const meaningful = (value) => normalize(value).length >= 12 && !placeholder.test(value);
  if (meaningful(record.building)) score += 2;
  if (meaningful(record.next_step)) score += 3;
  score += Math.min(3, (record.worked ?? []).filter((item) => meaningful(item.item)).length);
  score += Math.min(3, (record.failed ?? []).filter((item) => meaningful(item.approach)).length);
  score += Math.min(2, (record.files ?? []).length);
  score += Math.min(2, (record.decisions ?? []).length + (record.blockers ?? []).length);
  return score;
}

export class SessionStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.root = path.join(this.stateRoot, "sessions");
  }

  directoryFor(projectId) {
    const safe = String(projectId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.root, safe);
  }

  /**
   * Persist a handoff record. Returns the stored record including metadata.
   *
   * @param {{ projectId: string, projectPath: string, projectName?: string, taskId?: string, branch?: string, worktree?: string, source?: string, client?: string, sessionId?: string, now?: string } & object} input
   */
  async save(input) {
    const record = normalizeSessionRecord(input);
    const savedAt = input.now || new Date().toISOString();
    const id = `session-${savedAt.replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const stored = {
      schema_version: 1,
      id,
      saved_at: savedAt,
      project_id: String(input.projectId || ""),
      project_path: String(input.projectPath || ""),
      project_name: String(input.projectName || path.basename(String(input.projectPath || "")) || ""),
      task_id: String(input.taskId || ""),
      branch: String(input.branch || ""),
      worktree: String(input.worktree || input.projectPath || ""),
      source: String(input.source || "agent"),
      client: String(input.client || ""),
      session_id: String(input.sessionId || ""),
      ...record
    };
    const fileName = `${savedAt.replace(/\D/g, "").slice(0, 14)}-${slug(record.topic)}.json`;
    const filePath = path.join(this.directoryFor(stored.project_id), fileName);
    await atomicWriteJson(filePath, stored);
    return { record: stored, path: filePath };
  }

  async list(projectId, { limit = 20, substantiveOnly = false } = {}) {
    const directory = this.directoryFor(projectId);
    let names = [];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
        record.substance_score = sessionSubstanceScore(record);
        record.path = path.join(directory, name);
        if (substantiveOnly && record.substance_score < 3) continue;
        records.push(record);
      } catch {
        // Corrupt files are skipped; system health can report them.
      }
    }
    return records
      .sort((left, right) => String(right.saved_at).localeCompare(String(left.saved_at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
  }

  async latest(projectId) {
    return (await this.list(projectId, { limit: 1, substantiveOnly: true }))[0] ?? null;
  }

  async read(projectId, sessionId) {
    const records = await this.list(projectId, { limit: 200 });
    const record = records.find((item) => item.id === sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }
}

function table(files) {
  if (!files.length) return "No files modified this session.";
  const label = { complete: "PASS: Complete", in_progress: "In Progress", broken: "FAIL: Broken", not_started: "Not Started" };
  return [
    "| File | Status | Notes |",
    "| --- | --- | --- |",
    ...files.map((file) => `| \`${file.path}\` | ${label[file.status] || file.status} | ${file.notes || ""} |`)
  ].join("\n");
}

/**
 * Render a handoff in the ECC session-file format.
 *
 * @param {object} record - Stored record from {@link SessionStore.save}.
 * @returns {string}
 */
export function renderHandoffMarkdown(record) {
  const worked = record.worked?.length
    ? record.worked.map((item) => `- **${item.item}** — confirmed by: ${item.evidence || "no evidence recorded"}`).join("\n")
    : "Nothing confirmed working yet — all approaches still in progress or untested.";
  const failed = record.failed?.length
    ? record.failed.map((item) => `- **${item.approach}** — failed because: ${item.reason || "reason not recorded"}`).join("\n")
    : "No failed approaches yet.";
  return [
    `# Session: ${String(record.saved_at || "").slice(0, 10)}`,
    "",
    `**Last Updated:** ${record.saved_at || ""}`,
    `**Project:** ${record.project_name || record.project_path || ""}`,
    `**Branch:** ${record.branch || "unknown"}`,
    `**Worktree:** ${record.worktree || record.project_path || ""}`,
    `**Task:** ${record.task_id || "none"}`,
    `**Topic:** ${record.topic || ""}`,
    "",
    "---",
    "",
    "## What We Are Building",
    "",
    record.building || record.topic || "",
    "",
    "## What WORKED (with evidence)",
    "",
    worked,
    "",
    "## What Did NOT Work (and why)",
    "",
    failed,
    "",
    "## What Has NOT Been Tried Yet",
    "",
    record.untried?.length ? record.untried.map((item) => `- ${item}`).join("\n") : "No specific untried approaches identified.",
    "",
    "## Current State of Files",
    "",
    table(record.files ?? []),
    "",
    "## Decisions Made",
    "",
    record.decisions?.length ? record.decisions.map((item) => `- **${item.decision}** — reason: ${item.reason || "not recorded"}`).join("\n") : "No major decisions made this session.",
    "",
    "## Blockers & Open Questions",
    "",
    record.blockers?.length ? record.blockers.map((item) => `- ${item}`).join("\n") : "No active blockers.",
    "",
    "## Exact Next Step",
    "",
    record.next_step || "Next step not determined — review 'What Has NOT Been Tried Yet' and 'Blockers' before starting.",
    ...(record.environment ? ["", "## Environment & Setup Notes", "", record.environment] : []),
    ""
  ].join("\n");
}

/**
 * Days since the record was saved (fractional).
 *
 * @param {object} record
 * @param {string} [now]
 * @returns {number}
 */
export function sessionAgeDays(record, now = new Date().toISOString()) {
  const saved = Date.parse(record?.saved_at || "");
  if (!Number.isFinite(saved)) return Number.POSITIVE_INFINITY;
  return (Date.parse(now) - saved) / 86_400_000;
}

/**
 * Render the resume briefing (ECC resume-session format) with the stale-replay
 * guard: the prior summary is historical, not live instructions.
 *
 * @param {{ record: object | null, tasks?: object[], git?: object, freshness?: object, instincts?: string, now?: string }} input
 * @returns {string}
 */
export function renderResumeBriefing({ record, tasks = [], git = null, freshness = null, instincts = "", now = new Date().toISOString() }) {
  const lines = [];
  if (!record) {
    lines.push("NO SAVED SESSION for this project. Run save_session at the end of a session to create one.");
  } else {
    const age = sessionAgeDays(record, now);
    lines.push(
      `SESSION LOADED: ${record.path || record.id}`,
      "════════════════════════════════════════════════",
      "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. Verify against git and the working tree before acting; prior work may already be done.",
      "",
      `PROJECT: ${record.project_name || record.project_path} (${record.topic})`,
      `SAVED: ${record.saved_at}${age > STALE_AFTER_DAYS ? ` — WARNING: ${Math.floor(age)} days ago, things may have changed` : ""}`,
      record.task_id ? `TASK: ${record.task_id}` : "",
      "",
      "WHAT WE'RE BUILDING:",
      record.building || record.topic,
      "",
      "CURRENT STATE:",
      `PASS: Working: ${record.worked?.length ?? 0} items confirmed`,
      `In Progress: ${(record.files ?? []).filter((file) => file.status === "in_progress").map((file) => file.path).join(", ") || "none"}`,
      `Broken: ${(record.files ?? []).filter((file) => file.status === "broken").map((file) => file.path).join(", ") || "none"}`,
      `Not Started: ${(record.files ?? []).filter((file) => file.status === "not_started").map((file) => file.path).join(", ") || "none"}`,
      "",
      "WHAT NOT TO RETRY:",
      record.failed?.length ? record.failed.map((item) => `- ${item.approach} — ${item.reason || "reason not recorded"}`).join("\n") : "- nothing recorded",
      "",
      "OPEN QUESTIONS / BLOCKERS:",
      record.blockers?.length ? record.blockers.map((item) => `- ${item}`).join("\n") : "- none",
      "",
      "NEXT STEP:",
      record.next_step || "No next step defined — review 'What Has NOT Been Tried Yet' before starting."
    );
  }
  if (tasks.length) {
    lines.push("", "OPEN TASKS:", ...tasks.map((task) => `- ${task.id} [${task.status}] ${task.task}${task.plan_policy?.plan_required && !task.plan ? " (plan required, not recorded)" : ""}`));
  }
  if (git) {
    lines.push("", `GIT: branch ${git.branch || "unknown"}, ${git.dirty ? `${git.dirty_files?.length ?? 0} uncommitted file(s)` : "clean"}`);
  }
  if (freshness) {
    lines.push(`CONTEXT PACK: ${freshness.compiled ? (freshness.fresh ? "fresh" : "stale — recompile with begin_task or compile_project_context") : "not compiled"}`);
  }
  if (instincts) lines.push("", instincts);
  lines.push("", "════════════════════════════════════════════════", "Ready to continue. Confirm the next step before touching files.");
  return lines.filter((line) => line !== undefined && line !== null).join("\n");
}

/**
 * Estimate the static context overhead a task session carries and advise on
 * compaction at phase boundaries (ECC strategic-compact / context-budget).
 *
 * @param {{ contextPackChars?: number, skillChars?: number, rulesChars?: number, agentsChars?: number, checkpoints?: number, verifications?: number, windowTokens?: number }} input
 * @returns {object}
 */
export function estimateContextBudget({ contextPackChars = 0, skillChars = 0, rulesChars = 0, agentsChars = 0, checkpoints = 0, verifications = 0, windowTokens = DEFAULT_WINDOW_TOKENS }) {
  const tokens = (chars) => Math.ceil(Number(chars || 0) / 4);
  const components = {
    context_pack: tokens(contextPackChars),
    routed_skills: tokens(skillChars),
    rules: tokens(rulesChars),
    agents_md: tokens(agentsChars)
  };
  const staticTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
  const window = Math.max(50_000, Number(windowTokens) || DEFAULT_WINDOW_TOKENS);
  const staticShare = staticTokens / window;
  const advice = [];
  if (staticShare > 0.25) advice.push(`Static overhead is ${Math.round(staticShare * 100)}% of the window; trim rules/skills or recompile a smaller context pack.`);
  if (checkpoints >= 5) advice.push("Five or more checkpoints recorded: save_session, then compact at the next phase boundary (after verify_task), never mid-edit.");
  if (verifications >= 3) advice.push("Three or more verification rounds: debugging traces likely fill the window; save what was learned (record_instinct/record_decision) and compact.");
  if (!advice.length) advice.push("Budget looks healthy; compact only after a phase is checkpointed and verified.");
  return {
    window_tokens: window,
    static_tokens: staticTokens,
    static_share: Number(staticShare.toFixed(3)),
    components,
    checkpoints,
    verifications,
    compaction_hint: checkpoints >= 5 || verifications >= 3 ? "boundary" : "none",
    advice
  };
}

/**
 * Write the project-local handoff projection (`.ai-dev/context/handoff.md`).
 *
 * @param {string} projectRoot
 * @param {object} record
 * @returns {Promise<string>} Relative path written.
 */
export async function writeHandoffProjection(projectRoot, record) {
  const target = path.join(path.resolve(projectRoot), ...HANDOFF_RELATIVE_PATH.split("/"));
  await atomicWriteFile(target, renderHandoffMarkdown(record), "utf8");
  return HANDOFF_RELATIVE_PATH;
}
```

**Файл: `ai-dev-mcp-server/src/core/session-memory.test.mjs`** (108 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionStore,
  estimateContextBudget,
  normalizeSessionRecord,
  renderHandoffMarkdown,
  renderResumeBriefing,
  sessionSubstanceScore,
  writeHandoffProjection
} from "./session-memory.mjs";

test("session records normalize, score substance, and render handoff + briefing", () => {
  assert.throws(() => normalizeSessionRecord({}), /topic or building is required/);
  const record = normalizeSessionRecord({
    building: "JWT auth with httpOnly cookies for the Next.js app.",
    worked: [{ item: "register endpoint", evidence: "POST returns 200 in Postman" }, "password hashing"],
    failed: [
      { approach: "Next-Auth", reason: "conflicts with the Prisma adapter" },
      { approach: "iron-session", why: "no rotation story" },
      { approach: "cookie in localStorage" }
    ],
    untried: ["set cookie in login route"],
    files: [{ path: "app/api/login/route.ts", status: "In Progress", notes: "token not set yet" }, "lib/auth.ts", { path: "x.ts", status: "weird" }],
    decisions: [{ decision: "httpOnly cookie over localStorage", reason: "prevents XSS" }],
    blockers: ["does cookies().set() work in route handlers?"],
    next_step: "Set the cookie in login route and test with Postman."
  });
  assert.equal(record.topic, "JWT auth with httpOnly cookies for the Next.js app.");
  assert.equal(record.worked[1].item, "password hashing");
  // ECC's save-session prompt writes `why`; both spellings land in `reason`.
  assert.deepEqual(record.failed, [
    { approach: "Next-Auth", reason: "conflicts with the Prisma adapter" },
    { approach: "iron-session", reason: "no rotation story" },
    { approach: "cookie in localStorage", reason: "" }
  ]);
  assert.equal(record.files[0].status, "in_progress");
  assert.equal(record.files[1].status, "in_progress");
  assert.equal(record.files[2].status, "in_progress");
  assert.ok(sessionSubstanceScore(record) >= 8);
  assert.equal(sessionSubstanceScore({ topic: "x", next_step: "[next step goes here]" }), 0);

  const markdown = renderHandoffMarkdown({ ...record, saved_at: "2026-09-10T12:00:00.000Z", project_name: "my-app", branch: "main" });
  assert.match(markdown, /## What Did NOT Work \(and why\)\n\n- \*\*Next-Auth\*\* — failed because: conflicts/);
  assert.match(markdown, /\| `app\/api\/login\/route\.ts` \| In Progress \|/);
  assert.match(markdown, /## Exact Next Step\n\nSet the cookie/);

  const briefing = renderResumeBriefing({
    record: { ...record, id: "session-1", saved_at: "2026-01-01T00:00:00.000Z", project_name: "my-app" },
    tasks: [{ id: "task-1", status: "active", task: "Finish auth", plan_policy: { plan_required: true }, plan: null }],
    git: { branch: "main", dirty: true, dirty_files: ["a"] },
    freshness: { compiled: true, fresh: false },
    now: "2026-02-01T00:00:00.000Z"
  });
  assert.match(briefing, /HISTORICAL REFERENCE ONLY/);
  assert.match(briefing, /WARNING: 31 days ago/);
  assert.match(briefing, /WHAT NOT TO RETRY:\n- Next-Auth — conflicts/);
  assert.match(briefing, /task-1 \[active\] Finish auth \(plan required, not recorded\)/);
  assert.match(briefing, /GIT: branch main, 1 uncommitted file/);
  assert.match(briefing, /CONTEXT PACK: stale/);
  assert.match(renderResumeBriefing({ record: null }), /NO SAVED SESSION/);
});

test("session store saves, lists newest-first with substance filter, and writes the projection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ stateRoot: path.join(root, "state") });
  const placeholder = await store.save({ projectId: "project-a", projectPath: root, topic: "empty", now: "2026-01-01T00:00:00.000Z" });
  const real = await store.save({
    projectId: "project-a",
    projectPath: root,
    projectName: "fixture",
    taskId: "task-1",
    branch: "feature/x",
    building: "Real work on the login flow with several moving parts.",
    worked: [{ item: "login endpoint", evidence: "tests pass" }],
    next_step: "Wire the cookie into the middleware and run verify_task.",
    now: "2026-01-02T00:00:00.000Z"
  });
  assert.match(real.path, /20260102000000-real-work-on-the-login-flow/);
  const all = await store.list("project-a");
  assert.deepEqual(all.map((item) => item.id), [real.record.id, placeholder.record.id]);
  const latest = await store.latest("project-a");
  assert.equal(latest.id, real.record.id);
  assert.equal(latest.task_id, "task-1");
  assert.equal(await store.latest("project-b"), null);
  assert.equal((await store.read("project-a", placeholder.record.id)).topic, "empty");
  await assert.rejects(store.read("project-a", "nope"), /Unknown session/);

  const projection = await writeHandoffProjection(root, real.record);
  assert.equal(projection, ".ai-dev/context/handoff.md");
  assert.match(await fs.readFile(path.join(root, ".ai-dev", "context", "handoff.md"), "utf8"), /Wire the cookie/);
});

test("estimateContextBudget reports static overhead and boundary compaction hints", () => {
  const healthy = estimateContextBudget({ contextPackChars: 20_000, skillChars: 12_000, rulesChars: 8_000, agentsChars: 4_000 });
  assert.equal(healthy.static_tokens, 11_000);
  assert.equal(healthy.compaction_hint, "none");
  assert.match(healthy.advice[0], /healthy/);
  const heavy = estimateContextBudget({ contextPackChars: 120_000, skillChars: 100_000, checkpoints: 6, verifications: 3, windowTokens: 200_000 });
  assert.equal(heavy.compaction_hint, "boundary");
  assert.ok(heavy.advice.some((item) => /Static overhead is/.test(item)));
  assert.ok(heavy.advice.some((item) => /Five or more checkpoints/.test(item)));
  assert.ok(heavy.advice.some((item) => /verification rounds/.test(item)));
});
```

**Файл: `ai-dev-mcp-server/src/extensions/sessions.mjs`** (215 строк)

```js
import fs from "node:fs/promises";
import path from "node:path";
import { contextPackFreshness } from "../core/context-compiler.mjs";
import {
  FILE_STATUSES,
  HANDOFF_RELATIVE_PATH,
  estimateContextBudget,
  renderHandoffMarkdown,
  renderResumeBriefing,
  writeHandoffProjection
} from "../core/session-memory.mjs";

async function sizeOf(target) {
  try {
    return (await fs.stat(target)).size;
  } catch {
    return 0;
  }
}

async function directoryChars(directory) {
  let total = 0;
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) total += await sizeOf(target);
    }
  }
  await walk(directory);
  return total;
}

/**
 * Session memory tools: save a structured handoff, resume from the latest one
 * with a briefing, and estimate the static context budget of a task.
 *
 * @param {{ sessionStore: import("../core/session-memory.mjs").SessionStore, taskStore: { read: Function, list: Function, checkpoint: Function }, resolveProjectIdentity: Function, captureProjectState: Function, detectProject?: Function, vaultRoot?: string, instinctStore?: { rankForContext: Function } }} host
 */
export function createSessionTools(host) {
  async function projectFor({ project_path, task_id }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      const identity = await host.resolveProjectIdentity(record.project.path);
      return { identity, record };
    }
    if (!project_path) throw new Error("project_path or task_id is required.");
    return { identity: await host.resolveProjectIdentity(project_path), record: null };
  }

  return {
    definitions: [
      {
        name: "save_session",
        description: "Save a structured session handoff (what we are building, what worked with evidence, what failed and why, untried ideas, file states, decisions, blockers, exact next step). Stored under ~/.ai-dev/state/sessions and projected to .ai-dev/context/handoff.md so the next session (or a compaction) resumes from facts.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            topic: { type: "string", description: "One line: what this session was about." },
            building: { type: "string", description: "1-3 paragraphs a person with zero memory could act on." },
            worked: { type: "array", items: { type: "object", properties: { item: { type: "string" }, evidence: { type: "string" } }, required: ["item"] }, default: [] },
            failed: { type: "array", items: { type: "object", properties: { approach: { type: "string" }, reason: { type: "string", description: "Why it failed. `why` is accepted as an alias and stored as reason." }, why: { type: "string" } }, required: ["approach"] }, default: [] },
            untried: { type: "array", items: { type: "string" }, default: [] },
            files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, status: { type: "string", enum: FILE_STATUSES }, notes: { type: "string" } }, required: ["path"] }, default: [] },
            decisions: { type: "array", items: { type: "object", properties: { decision: { type: "string" }, reason: { type: "string" } }, required: ["decision"] }, default: [] },
            blockers: { type: "array", items: { type: "string" }, default: [] },
            next_step: { type: "string", description: "The single most important thing to do when resuming." },
            environment: { type: "string" },
            client: { type: "string", description: "claude-code, cursor, codex, ..." },
            session_id: { type: "string" }
          }
        }
      },
      {
        name: "resume_session",
        description: "Load the latest substantive session handoff for a project (or a specific session id) and return a resume briefing: what not to retry, blockers, next step, open tasks, git state, context-pack freshness, and relevant learned instincts. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            session_id: { type: "string" },
            limit_history: { type: "number", default: 5 }
          },
          required: ["project_path"]
        }
      },
      {
        name: "context_budget_status",
        description: "Estimate the static context overhead of a task (compiled pack, routed skills, rules, AGENTS.md) against the model window and advise when to compact: at phase boundaries after checkpoint/verify, never mid-edit.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            window_tokens: { type: "number", default: 200000 }
          },
          required: ["task_id"]
        }
      }
    ],
    handlers: {
      async save_session(args) {
        const { identity, record } = await projectFor(args);
        const state = await host.captureProjectState(identity.project_root);
        const saved = await host.sessionStore.save({
          projectId: identity.project_id,
          projectPath: identity.project_root,
          projectName: record?.project?.name || path.basename(identity.project_root),
          taskId: record?.id || "",
          branch: state.branch || "",
          worktree: identity.project_root,
          client: args.client,
          sessionId: args.session_id,
          source: "agent",
          topic: args.topic,
          building: args.building,
          worked: args.worked,
          failed: args.failed,
          untried: args.untried,
          files: args.files,
          decisions: args.decisions,
          blockers: args.blockers,
          next_step: args.next_step,
          environment: args.environment
        });
        const handoffPath = await writeHandoffProjection(identity.project_root, saved.record);
        let checkpoint = null;
        if (record && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Session saved: ${saved.record.topic}`,
            changedFiles: [],
            notes: `Handoff: ${saved.path}\nNext step: ${saved.record.next_step || "not set"}`
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        return {
          action: "session_saved",
          session_id: saved.record.id,
          path: saved.path,
          handoff_path: handoffPath,
          project_id: identity.project_id,
          markdown: renderHandoffMarkdown(saved.record),
          checkpoint,
          next_step: saved.record.next_step
            ? "Safe to compact or end the session; resume_session restores this handoff."
            : "Record an exact next step so the next session does not have to rediscover it."
        };
      },
      async resume_session(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const record = args.session_id
          ? await host.sessionStore.read(identity.project_id, args.session_id)
          : await host.sessionStore.latest(identity.project_id);
        const history = await host.sessionStore.list(identity.project_id, { limit: args.limit_history || 5 });
        const tasks = (await host.taskStore.list({ projectPath: identity.project_root, limit: 20 }))
          .filter((task) => ["active", "verified"].includes(task.status));
        const state = await host.captureProjectState(identity.project_root);
        let freshness = null;
        try {
          const latest = JSON.parse(await fs.readFile(path.join(identity.project_root, ".ai-dev", "context", "latest.json"), "utf8"));
          freshness = { compiled: true, ...contextPackFreshness(latest, state) };
        } catch {
          freshness = { compiled: false, fresh: false };
        }
        let instincts = "";
        if (host.instinctStore) {
          const detected = host.detectProject ? await host.detectProject(identity.project_root).catch(() => null) : null;
          const ranked = await host.instinctStore.rankForContext({
            projectId: identity.project_id,
            stack: detected?.stack ?? [],
            task: record?.next_step || record?.topic || ""
          });
          instincts = ranked.markdown || "";
        }
        return {
          project_id: identity.project_id,
          project_path: identity.project_root,
          session: record,
          history: history.map((item) => ({ id: item.id, saved_at: item.saved_at, topic: item.topic, task_id: item.task_id, substance_score: item.substance_score })),
          open_tasks: tasks.map((task) => ({ id: task.id, status: task.status, task: task.task, plan_required: Boolean(task.plan_policy?.plan_required), plan_recorded: Boolean(task.plan) })),
          git: { branch: state.branch || "", dirty: Boolean(state.dirty), dirty_files: state.dirty_files ?? [] },
          context_pack: freshness,
          handoff_path: HANDOFF_RELATIVE_PATH,
          briefing: renderResumeBriefing({ record, tasks, git: state, freshness, instincts })
        };
      },
      async context_budget_status(args) {
        const record = await host.taskStore.read(args.task_id);
        const identity = await host.resolveProjectIdentity(record.project.path);
        let skillChars = 0;
        for (const skill of record.skills ?? []) {
          if (skill.path && host.vaultRoot) skillChars += await sizeOf(path.join(host.vaultRoot, ...String(skill.path).split("/")));
        }
        const budget = estimateContextBudget({
          contextPackChars: String(record.context?.compiled_context || "").length,
          skillChars,
          rulesChars: await directoryChars(path.join(identity.project_root, ".ai-dev", "rules")),
          agentsChars: await sizeOf(path.join(identity.project_root, "AGENTS.md")),
          checkpoints: record.checkpoints?.length ?? 0,
          verifications: record.verifications?.length ?? 0,
          windowTokens: args.window_tokens
        });
        return { task_id: record.id, status: record.status, ...budget };
      }
    },
    readOnly: ["resume_session", "context_budget_status"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/sessions.test.mjs`** (79 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../core/session-memory.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createSessionTools } from "./sessions.mjs";

test("session tools save a handoff, resume with a briefing, and estimate the budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, ".ai-dev", "rules"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# AGENTS\n".repeat(50));
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "rules", "common.md"), "rules ".repeat(400));
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(path.join(vaultRoot, "skills"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "skills", "one.md"), "x".repeat(8_000));
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const sessionStore = new SessionStore({ stateRoot });
  const host = {
    taskStore,
    sessionStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    captureProjectState: async () => ({ fingerprint: "f1", branch: "feature/auth", dirty: true, dirty_files: ["a.ts"] }),
    detectProject: async () => ({ stack: ["TypeScript"], project_types: ["frontend"] }),
    instinctStore: { rankForContext: async () => ({ markdown: "Active instincts:\n- [project 80%] grep before edit" }) }
  };
  const registry = createExtensionTools(host, [createSessionTools]);
  const task = await taskStore.begin({
    task: "Finish auth",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [{ name: "one", path: "skills/one.md" }],
    baseline: { fingerprint: "f0" },
    context: { compiled_context: "c".repeat(20_000) }
  });

  const empty = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(empty.session, null);
  assert.match(empty.briefing, /NO SAVED SESSION/);
  assert.equal(empty.context_pack.compiled, false);

  const saved = await registry.handlers.get("save_session")({
    task_id: task.id,
    building: "JWT auth with httpOnly cookies; the login route still needs to set the cookie.",
    worked: [{ item: "register endpoint", evidence: "Postman 200" }],
    failed: [{ approach: "Next-Auth", reason: "Prisma adapter conflict" }, { approach: "iron-session", why: "no rotation story" }],
    next_step: "Set the cookie in the login route and run verify_task.",
    client: "claude-code"
  });
  assert.equal(saved.action, "session_saved");
  assert.equal(saved.checkpoint.checkpoints, 1);
  assert.match(await fs.readFile(path.join(projectRoot, ".ai-dev", "context", "handoff.md"), "utf8"), /Set the cookie/);

  await fs.mkdir(path.join(projectRoot, ".ai-dev", "context"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "context", "latest.json"), JSON.stringify({ source_state_fingerprint: "f1" }));
  const resumed = await registry.handlers.get("resume_session")({ project_path: projectRoot });
  assert.equal(resumed.session.id, saved.session_id);
  assert.equal(resumed.session.branch, "feature/auth");
  assert.equal(resumed.open_tasks[0].id, task.id);
  assert.equal(resumed.context_pack.fresh, true);
  assert.match(resumed.briefing, /WHAT NOT TO RETRY:\n- Next-Auth — Prisma adapter conflict/);
  // `why` is the ECC spelling of `reason`; it must survive the round trip as reason.
  assert.deepEqual(resumed.session.failed[1], { approach: "iron-session", reason: "no rotation story" });
  assert.match(resumed.briefing, /grep before edit/);
  assert.match(resumed.briefing, /GIT: branch feature\/auth, 1 uncommitted/);

  const budget = await registry.handlers.get("context_budget_status")({ task_id: task.id });
  assert.equal(budget.components.context_pack, 5_000);
  assert.equal(budget.components.routed_skills, 2_000);
  assert.ok(budget.components.rules > 0);
  assert.ok(budget.components.agents_md > 0);
  assert.equal(budget.compaction_hint, "none");
  await assert.rejects(registry.handlers.get("save_session")({ topic: "x" }), /project_path or task_id is required/);
});
```

## Изменения существующих файлов (общие для 09 и 10)

```diff
diff --git a/ai-dev-mcp-server/src/core/context-extras.mjs b/ai-dev-mcp-server/src/core/context-extras.mjs
index ea2cc1e..d5b286b 100644
--- a/ai-dev-mcp-server/src/core/context-extras.mjs
+++ b/ai-dev-mcp-server/src/core/context-extras.mjs
@@ -1,4 +1,6 @@
 import { listDecisions, summarizeDecisions } from "./decision-ledger.mjs";
+import { InstinctStore } from "./instincts.mjs";
+import { SessionStore, sessionAgeDays } from "./session-memory.mjs";
 
 /**
  * Extra context-pack sections contributed by optional subsystems (decision
@@ -9,10 +11,9 @@ import { listDecisions, summarizeDecisions } from "./decision-ledger.mjs";
  * is reported as an `unknown` entry instead of failing `begin_task`.
  */
 export const CONTEXT_EXTRA_PROVIDERS = [
-  decisionsContextProvider
-  // Later upgrades append their providers here, for example:
-  // instinctsContextProvider,
-  // handoffContextProvider
+  decisionsContextProvider,
+  handoffContextProvider,
+  instinctsContextProvider
 ];
 
 /**
@@ -33,19 +34,64 @@ export async function decisionsContextProvider({ projectRoot }) {
   };
 }
 
+/**
+ * Latest substantive session handoff for the project: next step, blockers,
+ * and approaches that already failed (so they are not retried).
+ *
+ * @param {{ stateRoot?: string, projectId?: string }} input
+ * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
+ */
+export async function handoffContextProvider({ stateRoot, projectId }) {
+  if (!stateRoot || !projectId) return null;
+  const record = await new SessionStore({ stateRoot }).latest(projectId);
+  if (!record) return null;
+  const age = sessionAgeDays(record);
+  const lines = [
+    `- Saved ${record.saved_at}${age > 7 ? ` (WARNING: ${Math.floor(age)} days ago; verify against git before trusting it)` : ""}${record.task_id ? `, task ${record.task_id}` : ""}: ${record.topic}`,
+    `- Next step: ${record.next_step || "not recorded"}`
+  ];
+  for (const item of (record.failed ?? []).slice(0, 3)) lines.push(`- Do not retry: ${item.approach} (${item.reason || "reason not recorded"})`);
+  for (const item of (record.blockers ?? []).slice(0, 3)) lines.push(`- Blocker: ${item}`);
+  lines.push("- Historical reference only: verify the working tree before acting on it.");
+  return {
+    id: "handoff",
+    title: "Last Session Handoff",
+    markdown: lines.join("\n"),
+    items: [{ id: record.id, saved_at: record.saved_at, task_id: record.task_id }]
+  };
+}
+
+/**
+ * High-confidence learned instincts relevant to this project, stack, and task.
+ *
+ * @param {{ stateRoot?: string, projectId?: string, task?: string, stack?: string[] }} input
+ * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
+ */
+export async function instinctsContextProvider({ stateRoot, projectId, task, stack = [] }) {
+  if (!stateRoot) return null;
+  const ranked = await new InstinctStore({ stateRoot }).rankForContext({ projectId, stack, task });
+  if (!ranked.instincts.length) return null;
+  return {
+    id: "instincts",
+    title: "Learned Instincts",
+    markdown: ranked.markdown,
+    items: ranked.instincts.map((item) => ({ id: item.id, confidence: item.effective_confidence, scope: item.scope }))
+  };
+}
+
 /**
  * Run every registered provider and collect the sections a context pack should
  * render after the routed skills. Errors are captured per provider.
  *
- * @param {{ projectRoot: string, stateRoot?: string, projectId?: string, task?: string, providers?: Function[] }} input
+ * @param {{ projectRoot: string, stateRoot?: string, projectId?: string, task?: string, stack?: string[], providers?: Function[] }} input
  * @returns {Promise<{ sections: object[], errors: string[] }>}
  */
-export async function loadContextExtras({ projectRoot, stateRoot = "", projectId = "", task = "", providers = CONTEXT_EXTRA_PROVIDERS }) {
+export async function loadContextExtras({ projectRoot, stateRoot = "", projectId = "", task = "", stack = [], providers = CONTEXT_EXTRA_PROVIDERS }) {
   const sections = [];
   const errors = [];
   for (const provider of providers) {
     try {
-      const section = await provider({ projectRoot, stateRoot, projectId, task });
+      const section = await provider({ projectRoot, stateRoot, projectId, task, stack });
       if (section?.markdown) sections.push(section);
     } catch (error) {
       errors.push(`${provider.name || "provider"}: ${error instanceof Error ? error.message : String(error)}`);
```

```diff
diff --git a/ai-dev-mcp-server/src/core/context-extras.test.mjs b/ai-dev-mcp-server/src/core/context-extras.test.mjs
index 3bc1f78..8676fd4 100644
--- a/ai-dev-mcp-server/src/core/context-extras.test.mjs
+++ b/ai-dev-mcp-server/src/core/context-extras.test.mjs
@@ -4,7 +4,9 @@ import os from "node:os";
 import path from "node:path";
 import test from "node:test";
 import { recordDecision } from "./decision-ledger.mjs";
-import { decisionsContextProvider, loadContextExtras } from "./context-extras.mjs";
+import { InstinctStore } from "./instincts.mjs";
+import { SessionStore } from "./session-memory.mjs";
+import { decisionsContextProvider, handoffContextProvider, instinctsContextProvider, loadContextExtras } from "./context-extras.mjs";
 
 test("context extras collect decision sections and isolate provider failures", async (t) => {
   const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-"));
@@ -27,3 +29,36 @@ test("context extras collect decision sections and isolate provider failures", a
   assert.match(loaded.sections[0].markdown, /ADR-0001: Use pnpm — pnpm workspaces everywhere\./);
   assert.deepEqual(loaded.errors, ["brokenProvider: boom"]);
 });
+
+test("handoff and instinct providers surface session memory and learned behaviors", async (t) => {
+  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-memory-"));
+  t.after(() => fs.rm(root, { recursive: true, force: true }));
+  const stateRoot = path.join(root, "state");
+  assert.equal(await handoffContextProvider({ stateRoot, projectId: "project-x" }), null);
+  assert.equal(await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "x" }), null);
+
+  await new SessionStore({ stateRoot }).save({
+    projectId: "project-x",
+    projectPath: root,
+    building: "Payment retries with idempotency keys across the checkout service.",
+    failed: [{ approach: "Retrying without keys", reason: "double charges in staging" }],
+    blockers: ["Need sandbox credentials"],
+    next_step: "Add the idempotency middleware and re-run verify_task.",
+    now: "2026-01-01T00:00:00.000Z"
+  });
+  const handoff = await handoffContextProvider({ stateRoot, projectId: "project-x" });
+  assert.equal(handoff.id, "handoff");
+  assert.match(handoff.markdown, /Next step: Add the idempotency middleware/);
+  assert.match(handoff.markdown, /Do not retry: Retrying without keys \(double charges in staging\)/);
+  assert.match(handoff.markdown, /WARNING: \d+ days ago/);
+
+  const store = new InstinctStore({ stateRoot });
+  await store.record({ trigger: "when retrying payments", action: "use idempotency keys", domain: "architecture", projectId: "project-x", confidence: 0.8 });
+  await store.record({ trigger: "when naming files", action: "prefer kebab-case", domain: "code-style", projectId: "project-x", confidence: 0.4 });
+  const instincts = await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "Fix payment retries", stack: ["Node.js"] });
+  assert.equal(instincts.items.length, 1, "only instincts above the 0.7 threshold are injected");
+  assert.match(instincts.markdown, /use idempotency keys/);
+
+  const all = await loadContextExtras({ projectRoot: root, stateRoot, projectId: "project-x", task: "Fix payment retries" });
+  assert.deepEqual(all.sections.map((section) => section.id), ["handoff", "instincts"]);
+});
```

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index 4963167..c5cb43a 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -88,6 +88,8 @@ import {
 } from "./core/evidence.mjs";
 import { TaskStore } from "./core/task-lifecycle.mjs";
 import { UsageLedger } from "./core/usage-ledger.mjs";
+import { SessionStore } from "./core/session-memory.mjs";
+import { InstinctStore } from "./core/instincts.mjs";
 import {
   applySkillOutcome,
   SkillOutcomeStore
@@ -264,6 +266,8 @@ const taskStore = new TaskStore({ stateRoot: taskStateRoot });
 const skillOutcomeStore = new SkillOutcomeStore({ stateRoot: taskStateRoot });
 const pilotStore = new PilotStore({ stateRoot: taskStateRoot });
 const usageLedger = new UsageLedger({ stateRoot: taskStateRoot });
+const sessionStore = new SessionStore({ stateRoot: taskStateRoot });
+const instinctStore = new InstinctStore({ stateRoot: taskStateRoot });
 const bgeM3EmbedCliPath = path.join(embeddingsDir, "bge_m3_embed.py");
 const bgeM3WorkerCliPath = path.join(embeddingsDir, "bge_m3_worker.py");
 const defaultBgeM3ModelDir = path.resolve(
@@ -8164,7 +8168,7 @@ async function buildProjectContextPack({
     projectBrief: brief,
     projectMap,
     qualityGate,
-    extras: await loadContextExtras({ projectRoot: identity.project_root, stateRoot: taskStateRoot, projectId: identity.project_id, task }),
+    extras: await loadContextExtras({ projectRoot: identity.project_root, stateRoot: taskStateRoot, projectId: identity.project_id, task, stack: detected.stack }),
     maxSourceFiles,
     maxChars
   });
@@ -8290,7 +8294,7 @@ async function beginTask({
     projectBrief: brief,
     projectMap,
     qualityGate,
-    extras: await loadContextExtras({ projectRoot, stateRoot: taskStateRoot, projectId: identity.project_id, task }),
+    extras: await loadContextExtras({ projectRoot, stateRoot: taskStateRoot, projectId: identity.project_id, task, stack: detected.stack }),
     maxSourceFiles: 12,
     maxChars: 20_000
   });
@@ -8749,7 +8753,7 @@ async function completeTask({
 // Extension tools live in src/extensions/* and receive shared runtime services
 // through this host object (see src/tool-extensions.mjs).
 const extensions = createExtensionTools({
-  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, usageLedger, callTool,
+  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, usageLedger, sessionStore, instinctStore, callTool,
   resolveProjectIdentity, detectProject, captureProjectState, readProjectTextIfExists,
   writeProjectFile, safeProjectFile, safeProjectRoot, writeKnowledgeNote, appendKnowledgeNote,
   markSearchIndexDirty
```

```diff
diff --git a/ai-dev-mcp-server/src/server.mjs b/ai-dev-mcp-server/src/server.mjs
index 96dd800..643ccf7 100644
--- a/ai-dev-mcp-server/src/server.mjs
+++ b/ai-dev-mcp-server/src/server.mjs
@@ -212,6 +212,22 @@ const PROMPTS = [
       "Do not approve the design system until Reference Factory coverage is registered."
     ].filter(Boolean).join("\n")
   },
+  {
+    name: "learn_from_task",
+    title: "Извлеки уроки из задачи",
+    description: "After a task, turn corrections, resolved errors, repeated workflows, and decisions into durable memory: instincts, decisions, and a session handoff.",
+    arguments: [
+      { name: "project_path", description: "Absolute repository path.", required: true },
+      { name: "task_id", description: "Task lifecycle id to learn from (optional).", required: false }
+    ],
+    render: ({ project_path, task_id = "" }) => [
+      `Проект: ${project_path}${task_id ? `, задача: ${task_id}` : ""}`,
+      "Просмотри ход работы и выдели: исправления пользователя, ошибки, которые решались одинаково дважды и больше, повторяющиеся последовательности действий, архитектурные решения.",
+      "Для каждого устойчивого паттерна (3+ наблюдения или явное исправление) вызови record_instinct с коротким trigger/action, domain и note без кода и секретов; scope=project по умолчанию, global только для универсальных практик.",
+      "Архитектурные выборы запиши через record_decision. Если задача продолжится в другой сессии, сохрани handoff через save_session с точным next_step и списком неудачных подходов.",
+      "Не создавай инстинкты из единичных случаев и не дублируй уже существующие: сначала list_instincts, потом update_instinct action=confirm для совпадений."
+    ].join("\n")
+  },
   {
     name: "refresh_project_context",
     title: "Обнови память проекта",
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index 3fd7374..bfcc806 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -22,16 +22,20 @@
 
 import { createDecisionTools } from "./extensions/decisions.mjs";
 import { createHygieneTools } from "./extensions/hygiene.mjs";
+import { createInstinctTools } from "./extensions/instincts.mjs";
 import { createPlanTools } from "./extensions/plans.mjs";
 import { createRulesTools } from "./extensions/rules.mjs";
+import { createSessionTools } from "./extensions/sessions.mjs";
 import { createUsageTools } from "./extensions/usage.mjs";
 import { createWorktreeTools } from "./extensions/worktrees.mjs";
 
 export const EXTENSION_FACTORIES = [
   createDecisionTools,
   createHygieneTools,
+  createInstinctTools,
   createPlanTools,
   createRulesTools,
+  createSessionTools,
   createUsageTools,
   createWorktreeTools
 ];
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/session-memory.test.mjs src/extensions/sessions.test.mjs src/core/context-extras.test.mjs
```

## Использование

```json
{ "tool": "save_session", "args": { "project_path": "/repo", "task_id": "task-…",
  "building": "Rate limiting for /login",
  "worked": [{ "item": "Token bucket in middleware", "evidence": "login.test.ts passes 429 case" }],
  "failed": [{ "approach": "Redis INCR without TTL", "reason": "keys never expired; memory grew" }],
  "untried": ["sliding window via sorted sets"],
  "files": [{ "path": "src/middleware/rate-limit.ts", "status": "complete" }],
  "blockers": ["staging Redis credentials"],
  "next_step": "Wire middleware into routes/auth.ts and run verify_task" } }

{ "tool": "resume_session", "args": { "project_path": "/repo" } }
{ "tool": "context_budget_status", "args": { "task_id": "task-…", "window_tokens": 200000 } }
```

Поле причины в `failed` называется `reason`; `why` (написание из промптов ECC) принимается
и сохраняется как `reason`, поэтому оба варианта попадают в handoff одинаково. Статусы
файлов — `complete`, `in_progress`, `broken`, `not_started`.

Подсказка по сжатию: `context_budget_status` отвечает «safe to compact» только после
сохранённого handoff; `save_session` с пустыми полями не даст «содержательной» записи и
`resume_session` вернёт предыдущий полный handoff.

## Для Argentum

Это основа памяти между сессиями `claude -p`: воркспейс сохраняет handoff по завершении
сессии (или из хука `session-end`), а перед следующим запуском кладёт `resume_session` в
системный промпт. Файл `.ai-dev/context/handoff.md` можно показывать пользователю как
«где мы остановились».

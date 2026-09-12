# 10. Инстинкты: обучение на поправках с уверенностью, распадом и эволюцией в скиллы

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01, 02, 09 (общие diff-ы существующих файлов приведены в 09).

## Идея из ECC

`continuous-learning-v2`: наблюдатель извлекает из сессий атомарные «инстинкты»
(«когда <trigger> — <action>») с уверенностью, они подтверждаются/опровергаются, распадаются со
временем, продвигаются из проектных в глобальные и, накопившись в одном домене, превращаются в
скилл (`/evolve`). `instinct-relevance.js` выбирает, какие инстинкты вообще инжектить в контекст.
Порт в `ai-dev-system` (без фонового наблюдателя — записывает сам агент по промпту
`learn_from_task` или по хуку `session-end`):

| Механика | Значение |
| --- | --- |
| Начальная уверенность | 1 наблюдение 0.3 · 2 → 0.5 · 3+ → 0.7 · явная поправка пользователя 0.85 |
| Подтверждение / опровержение | +0.05 / −0.1; ниже 0.2 инстинкт уходит в retired |
| Распад | −0.02 за неделю без наблюдений, не ниже 0.3 |
| Инжект в context pack | эффективная уверенность ≥ 0.7, максимум 6, бонусы +0.25 за проект и +0.2 за совпадение стека/домена с задачей |
| Продвижение в global | инстинкт встречается в 2+ проектах со средней уверенностью ≥ 0.8 |
| Эволюция | кластер ≥ 3 инстинктов одного домена → черновик `SKILL.md` в `03-skills-catalog/sources/custom/learned-<domain>-<project>/` |
| Импорт | уверенность импортированных записей ограничена 0.7 до локального подтверждения |

Похожие записи (`similar`: тот же домен и пересечение слов trigger/action) сливаются в одну
с ростом числа наблюдений вместо дублирования. Хранилище: `~/.ai-dev/state/instincts.json`.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/instincts.mjs`** (440 строк)

```js
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";

/**
 * Instincts: atomic learned behaviors ("when <trigger>, <action>") with a
 * confidence score, scope (project or global), domain tag, and evidence.
 * Ported from Everything Claude Code continuous-learning-v2 into a
 * client-agnostic store: the agent records observations explicitly (or a
 * session-end hook does), confidence evolves with confirmations and
 * contradictions, high-confidence instincts are injected into context packs,
 * and clusters of instincts evolve into skill drafts.
 */

export const INSTINCT_DOMAINS = ["code-style", "testing", "git", "debugging", "workflow", "security", "architecture", "tooling", "performance", "documentation", "general"];
export const INSTINCT_SCOPES = ["project", "global"];
export const INSTINCT_SOURCES = ["agent", "observation", "task-outcome", "import", "hook"];
export const GLOBAL_FRIENDLY_DOMAINS = ["security", "workflow", "git", "general", "testing"];

const STORE_SCHEMA_VERSION = 1;
const CONFIDENCE_FLOOR = 0.1;
const CONFIDENCE_CEILING = 0.95;
const RETIRE_BELOW = 0.2;
const CONFIRM_STEP = 0.05;
const CONTRADICT_STEP = 0.1;
const DECAY_PER_WEEK = 0.02;
const DECAY_FLOOR = 0.3;
const PROJECT_SCOPE_BOOST = 0.25;
const STACK_MATCH_BOOST = 0.2;
const TASK_MATCH_BOOST = 0.15;
const DEFAULT_INJECT_THRESHOLD = 0.7;
const DEFAULT_MAX_INJECTED = 6;

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function clamp(value) {
  return Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, Number(value) || 0));
}

function tokens(value) {
  return new Set(String(value ?? "").toLowerCase().split(/[^a-z0-9а-яё]+/i).filter((token) => token.length >= 3));
}

/**
 * Stable id from trigger + action text.
 *
 * @param {string} trigger
 * @param {string} action
 * @returns {string}
 */
export function instinctId(trigger, action) {
  const base = `${normalize(trigger)} ${normalize(action)}`
    .toLowerCase()
    .replace(/^when\s+/, "")
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  return base || "instinct";
}

/**
 * Initial confidence from the observation count (ECC observer scale).
 *
 * @param {number} observations
 * @returns {number}
 */
export function initialConfidence(observations) {
  const count = Math.max(1, Number(observations) || 1);
  if (count >= 11) return 0.85;
  if (count >= 6) return 0.7;
  if (count >= 3) return 0.5;
  return 0.3;
}

/**
 * Confidence after time decay: -0.02 per week without observation, never below 0.3.
 *
 * @param {{ confidence: number, last_observed_at?: string }} instinct
 * @param {string} [now]
 * @returns {number}
 */
export function effectiveConfidence(instinct, now = new Date().toISOString()) {
  const last = Date.parse(instinct.last_observed_at || instinct.updated_at || instinct.created_at || now);
  const weeks = Number.isFinite(last) ? Math.max(0, (Date.parse(now) - last) / (7 * 86_400_000)) : 0;
  const decayed = instinct.confidence - Math.floor(weeks) * DECAY_PER_WEEK;
  return round(Math.max(Math.min(instinct.confidence, DECAY_FLOOR), decayed));
}

function similar(left, right) {
  const leftTokens = tokens(`${left.trigger} ${left.action}`);
  const rightTokens = tokens(`${right.trigger} ${right.action}`);
  if (!leftTokens.size || !rightTokens.size) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.75;
}

function emptyStore() {
  return { schema_version: STORE_SCHEMA_VERSION, updated_at: null, instincts: [] };
}

export class InstinctStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "instincts.json");
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return { ...emptyStore(), ...parsed, instincts: Array.isArray(parsed.instincts) ? parsed.instincts : [] };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      throw error;
    }
  }

  async update(mutator) {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const store = await this.read();
      const next = (await mutator(store)) ?? store;
      next.schema_version = STORE_SCHEMA_VERSION;
      next.updated_at = new Date().toISOString();
      next.instincts = (next.instincts || []).slice(-5_000);
      await atomicWriteJson(this.filePath, next);
      return next;
    });
    return this.queue;
  }

  /**
   * Record an observation. Merges into an existing instinct with the same id
   * or a near-identical trigger/action; otherwise creates a new one.
   *
   * @param {{ trigger: string, action: string, domain?: string, scope?: string, projectId?: string, projectName?: string, source?: string, note?: string, taskId?: string, confidence?: number, observations?: number, stack?: string[], now?: string }} input
   * @returns {Promise<{ instinct: object, created: boolean }>}
   */
  async record(input) {
    const trigger = normalize(input.trigger);
    const action = normalize(input.action);
    if (!trigger || !action) throw new Error("trigger and action are required.");
    const domain = INSTINCT_DOMAINS.includes(input.domain) ? input.domain : "general";
    const scope = INSTINCT_SCOPES.includes(input.scope) ? input.scope : "project";
    const source = INSTINCT_SOURCES.includes(input.source) ? input.source : "agent";
    if (scope === "project" && !input.projectId) throw new Error("projectId is required for project-scoped instincts.");
    const now = input.now || new Date().toISOString();
    let result;
    await this.update((store) => {
      const id = instinctId(trigger, action);
      const candidate = { trigger, action };
      const existing = store.instincts.find((item) => item.status !== "retired" && (
        (item.id === id || similar(item, candidate))
        && (item.scope === "global" || scope === "global" || item.project_id === input.projectId)
      ));
      const evidence = { at: now, kind: "observe", note: normalize(input.note), task_id: String(input.taskId || ""), source };
      if (existing) {
        const added = Math.max(1, Number(input.observations) || 1);
        existing.observations += added;
        existing.confidence = round(clamp(Math.max(existing.confidence + CONFIRM_STEP * added, initialConfidence(existing.observations))));
        existing.last_observed_at = now;
        existing.updated_at = now;
        existing.evidence = [...existing.evidence.slice(-19), evidence];
        for (const label of input.stack ?? []) if (!existing.stack.includes(label)) existing.stack.push(label);
        result = { instinct: structuredClone(existing), created: false };
        return store;
      }
      const observations = Math.max(1, Number(input.observations) || 1);
      const instinct = {
        id,
        trigger,
        action,
        domain,
        scope,
        project_id: scope === "project" ? String(input.projectId) : "",
        project_name: scope === "project" ? String(input.projectName || "") : "",
        confidence: round(clamp(Number.isFinite(Number(input.confidence)) && input.confidence !== undefined ? Number(input.confidence) : initialConfidence(observations))),
        observations,
        source,
        stack: [...new Set((input.stack ?? []).map(String))],
        status: "active",
        created_at: now,
        updated_at: now,
        last_observed_at: now,
        evidence: [evidence],
        promoted_to: null
      };
      store.instincts.push(instinct);
      result = { instinct: structuredClone(instinct), created: true };
      return store;
    });
    return result;
  }

  async adjust(id, kind, { note = "", taskId = "", now = new Date().toISOString() } = {}) {
    let updated = null;
    await this.update((store) => {
      const instinct = store.instincts.find((item) => item.id === id);
      if (!instinct) throw new Error(`Unknown instinct: ${id}`);
      if (kind === "confirm") {
        instinct.observations += 1;
        instinct.confidence = round(clamp(instinct.confidence + CONFIRM_STEP));
        instinct.last_observed_at = now;
        if (instinct.status === "retired") instinct.status = "active";
      } else if (kind === "contradict") {
        instinct.confidence = round(clamp(instinct.confidence - CONTRADICT_STEP));
        if (instinct.confidence < RETIRE_BELOW) instinct.status = "retired";
      } else if (kind === "retire") {
        instinct.status = "retired";
      } else if (kind === "promote") {
        if (instinct.scope === "global") throw new Error(`Instinct ${id} is already global.`);
        instinct.scope = "global";
        instinct.project_id = "";
        instinct.project_name = "";
      } else {
        throw new Error(`Unknown adjustment: ${kind}`);
      }
      instinct.updated_at = now;
      instinct.evidence = [...(instinct.evidence || []).slice(-19), { at: now, kind, note: normalize(note), task_id: String(taskId || ""), source: "agent" }];
      updated = structuredClone(instinct);
      return store;
    });
    return updated;
  }

  /**
   * List instincts visible to a project (its own plus global ones).
   *
   * Retired and promoted instincts are hidden unless `includeRetired` is set.
   *
   * @param {{ projectId?: string, scope?: string, domain?: string, minConfidence?: number, includeRetired?: boolean, now?: string }} [filter]
   * @returns {Promise<object[]>}
   */
  async list({ projectId = "", scope = "", domain = "", minConfidence = 0, includeRetired = false, now = new Date().toISOString() } = {}) {
    const store = await this.read();
    return store.instincts
      .filter((item) => includeRetired || item.status === "active")
      .filter((item) => !projectId || item.scope === "global" || item.project_id === projectId)
      .filter((item) => !scope || item.scope === scope)
      .filter((item) => !domain || item.domain === domain)
      .map((item) => ({ ...item, effective_confidence: effectiveConfidence(item, now) }))
      .filter((item) => item.effective_confidence >= minConfidence)
      .sort((left, right) => right.effective_confidence - left.effective_confidence || left.id.localeCompare(right.id));
  }

  /**
   * Instincts worth injecting into a context pack: confidence above the
   * threshold, ranked by confidence plus project-scope, stack, and task
   * relevance boosts (ECC instinct-relevance).
   *
   * @param {{ projectId?: string, stack?: string[], task?: string, threshold?: number, limit?: number, now?: string }} input
   * @returns {Promise<{ instincts: object[], markdown: string }>}
   */
  async rankForContext({ projectId = "", stack = [], task = "", threshold = DEFAULT_INJECT_THRESHOLD, limit = DEFAULT_MAX_INJECTED, now = new Date().toISOString() } = {}) {
    const candidates = await this.list({ projectId, minConfidence: threshold, now });
    const stackTokens = new Set((stack ?? []).flatMap((label) => [...tokens(label)]));
    const taskTokens = tokens(task);
    const ranked = candidates.map((item) => {
      let boost = 0;
      if (item.scope === "project") boost += PROJECT_SCOPE_BOOST;
      const own = tokens(`${item.domain} ${item.trigger} ${item.stack.join(" ")}`);
      if ([...own].some((token) => stackTokens.has(token))) boost += STACK_MATCH_BOOST;
      if (taskTokens.size && [...tokens(`${item.trigger} ${item.action}`)].some((token) => taskTokens.has(token))) boost += TASK_MATCH_BOOST;
      return { ...item, relevance: round(item.effective_confidence + boost) };
    })
      .sort((left, right) => right.relevance - left.relevance || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(Number(limit) || DEFAULT_MAX_INJECTED, 20)));
    return { instincts: ranked, markdown: renderInstinctsMarkdown(ranked) };
  }

  /**
   * Project-scoped instincts seen in two or more projects with average
   * confidence >= 0.8 are candidates for global promotion.
   *
   * @returns {Promise<Array<{ id: string, projects: number, average_confidence: number, domain: string }>>}
   */
  async promotionCandidates() {
    const store = await this.read();
    const groups = new Map();
    for (const item of store.instincts) {
      if (item.status === "retired" || item.scope !== "project") continue;
      const key = item.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const candidates = [];
    for (const [id, items] of groups) {
      const projects = new Set(items.map((item) => item.project_id)).size;
      const average = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
      if (projects >= 2 && average >= 0.8) {
        candidates.push({ id, projects, average_confidence: round(average), domain: items[0].domain, trigger: items[0].trigger, action: items[0].action });
      }
    }
    return candidates;
  }

  /**
   * Cluster active instincts by domain and shared vocabulary; clusters of
   * `minSize` or more become skill-draft candidates (ECC /evolve).
   *
   * @param {{ projectId?: string, minSize?: number }} [input]
   * @returns {Promise<Array<{ key: string, domain: string, scope: string, instincts: object[], skill_name: string }>>}
   */
  async clusters({ projectId = "", minSize = 3 } = {}) {
    const items = await this.list({ projectId });
    const groups = new Map();
    for (const item of items) {
      const key = `${item.scope}:${item.domain}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()]
      .filter(([, members]) => members.length >= Math.max(2, Number(minSize) || 3))
      .map(([key, members]) => ({
        key,
        domain: members[0].domain,
        scope: members[0].scope,
        instincts: members,
        skill_name: `learned-${members[0].domain}${members[0].scope === "project" ? `-${String(members[0].project_name || members[0].project_id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project"}` : ""}`
      }));
  }

  async markPromoted(ids, target) {
    await this.update((store) => {
      for (const item of store.instincts) {
        if (ids.includes(item.id)) {
          item.status = "promoted";
          item.promoted_to = target;
          item.updated_at = new Date().toISOString();
        }
      }
      return store;
    });
  }

  async exportInstincts({ scope = "", domain = "", minConfidence = 0.5, projectId = "", now = new Date().toISOString() } = {}) {
    const items = await this.list({ projectId, scope, domain, minConfidence, now });
    return {
      schema_version: STORE_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      instincts: items.map(({ effective_confidence, evidence, ...item }) => ({ ...item, evidence_count: (evidence || []).length }))
    };
  }

  async importInstincts(entries, { scope = "", projectId = "", projectName = "" } = {}) {
    const results = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const targetScope = scope || entry.scope || "global";
      results.push(await this.record({
        trigger: entry.trigger,
        action: entry.action,
        domain: entry.domain,
        scope: targetScope,
        projectId: targetScope === "project" ? projectId || entry.project_id : "",
        projectName: targetScope === "project" ? projectName || entry.project_name : "",
        confidence: Number.isFinite(Number(entry.confidence)) ? Math.min(0.7, Number(entry.confidence)) : undefined,
        observations: entry.observations,
        source: "import",
        note: `imported${entry.id ? ` from ${entry.id}` : ""}`
      }));
    }
    return results;
  }
}

/**
 * Compact Markdown for context packs: `- [scope confidence%] action (when trigger)`.
 *
 * @param {object[]} instincts
 * @returns {string}
 */
export function renderInstinctsMarkdown(instincts) {
  if (!instincts?.length) return "";
  return [
    "Active instincts (learned from previous work; apply when the trigger matches):",
    ...instincts.map((item) => `- [${item.scope} ${Math.round((item.effective_confidence ?? item.confidence) * 100)}%] ${item.action} (when ${item.trigger.replace(/^when\s+/i, "")})`)
  ].join("\n");
}

/**
 * Draft a SKILL.md from a cluster of instincts. The layout satisfies the
 * repository's Skill Schema v2 structure checks (trigger-first description,
 * numbered workflow, guardrails, verification, output) so the draft starts
 * as `reviewed` rather than `draft` once a human edits the specifics.
 *
 * @param {{ skill_name: string, domain: string, scope: string, instincts: object[] }} cluster
 * @param {{ projectName?: string }} [options]
 * @returns {{ name: string, markdown: string }}
 */
export function renderInstinctSkillDraft(cluster, { projectName = "" } = {}) {
  const name = cluster.skill_name.replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const scopeLabel = cluster.scope === "project" ? `the ${projectName || cluster.instincts[0]?.project_name || "current"} project` : "any project";
  const triggers = [...new Set(cluster.instincts.map((item) => item.trigger.replace(/^when\s+/i, "")))];
  const description = `Use when working on ${cluster.domain} tasks in ${scopeLabel}: ${triggers.slice(0, 3).join("; ")}. Learned from ${cluster.instincts.length} confirmed instincts with confidence ${Math.round(Math.min(...cluster.instincts.map((item) => item.confidence)) * 100)}% or higher.`;
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")}`,
    "",
    `Learned ${cluster.domain} behaviors for ${scopeLabel}. Generated from the instinct store; review the specifics, then keep this file as the source of truth and retire the instincts it replaced.`,
    "",
    "## When to use",
    "",
    ...triggers.map((trigger) => `- When ${trigger}.`),
    "",
    "## Workflow",
    "",
    ...cluster.instincts.map((item, index) => `${index + 1}. When ${item.trigger.replace(/^when\s+/i, "")}: ${item.action} (confidence ${Math.round(item.confidence * 100)}%, ${item.observations} observation(s)).`),
    `${cluster.instincts.length + 1}. Confirm the behavior still matches the repository before applying it; record contradictions with update_instinct so confidence stays honest.`,
    "",
    "## Guardrails",
    "",
    "- Do not apply a learned behavior when the current task or project rules contradict it; project rules win.",
    "- Do not treat this draft as validated: it is reviewed only after a human edits it and tasks using it pass verification.",
    "- Never copy secrets, credentials, or raw code from the observations that created these instincts.",
    "",
    "## Verification",
    "",
    "- Check the result with the project quality gate (verify_task) and, for user-visible changes, a real run or screenshot.",
    "- Record the outcome: confirm_instinct when the behavior helped, contradict when it did not.",
    "",
    "## Output",
    "",
    "- Report which learned behaviors were applied, the evidence that they helped, and any that should be retired.",
    ""
  ];
  return { name, markdown: lines.join("\n") };
}
```

**Файл: `ai-dev-mcp-server/src/core/instincts.test.mjs`** (96 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InstinctStore,
  effectiveConfidence,
  initialConfidence,
  instinctId,
  renderInstinctSkillDraft,
  renderInstinctsMarkdown
} from "./instincts.mjs";

test("instinct ids, initial confidence, and decay follow the ECC scale", () => {
  assert.equal(instinctId("when writing new functions", "Use functional patterns over classes"), "writing-new-functions-use-functional-patterns-over-classes");
  assert.equal(initialConfidence(1), 0.3);
  assert.equal(initialConfidence(4), 0.5);
  assert.equal(initialConfidence(7), 0.7);
  assert.equal(initialConfidence(12), 0.85);
  assert.equal(effectiveConfidence({ confidence: 0.7, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-01-29T00:00:00.000Z"), 0.62);
  assert.equal(effectiveConfidence({ confidence: 0.35, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-12-01T00:00:00.000Z"), 0.3, "decay floor");
  assert.equal(effectiveConfidence({ confidence: 0.25, last_observed_at: "2026-01-01T00:00:00.000Z" }, "2026-12-01T00:00:00.000Z"), 0.25, "never raised by the floor");
});

test("store records, merges similar observations, adjusts, ranks, promotes, and clusters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instincts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new InstinctStore({ stateRoot: root });
  await assert.rejects(store.record({ trigger: "x", action: "" }), /trigger and action are required/);
  await assert.rejects(store.record({ trigger: "x", action: "y" }), /projectId is required/);

  const first = await store.record({ trigger: "when editing React components", action: "Use hooks instead of class components", domain: "code-style", projectId: "project-a", projectName: "app", stack: ["React"], note: "user corrected class component", now: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.created, true);
  assert.equal(first.instinct.confidence, 0.3);
  const merged = await store.record({ trigger: "when editing react components", action: "use hooks instead of class components!", domain: "code-style", projectId: "project-a", now: "2026-01-02T00:00:00.000Z" });
  assert.equal(merged.created, false);
  assert.equal(merged.instinct.observations, 2);
  assert.equal(merged.instinct.confidence, 0.35);
  const third = await store.record({ trigger: "when editing React components", action: "Use hooks instead of class components", projectId: "project-a", observations: 4, now: "2026-01-03T00:00:00.000Z" });
  assert.equal(third.instinct.observations, 6);
  assert.equal(third.instinct.confidence, 0.7, "jumps to the scale value for 6 observations");

  await store.record({ trigger: "when handling user input", action: "Validate at the boundary with a schema", domain: "security", scope: "global", confidence: 0.8, now: "2026-01-03T00:00:00.000Z" });
  await store.record({ trigger: "when a test fails", action: "Read the assertion before touching code", domain: "debugging", projectId: "project-b", confidence: 0.9, now: "2026-01-03T00:00:00.000Z" });

  const visible = await store.list({ projectId: "project-a", now: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(visible.map((item) => item.scope), ["global", "project"]);
  const ranked = await store.rankForContext({ projectId: "project-a", stack: ["React", "TypeScript"], task: "Refactor the checkout React components", now: "2026-01-03T00:00:00.000Z" });
  assert.equal(ranked.instincts[0].id, first.instinct.id, "project + stack + task boosts win over a global 0.8");
  assert.match(ranked.markdown, /^Active instincts/);
  assert.match(ranked.markdown, /\[project 70%\] Use hooks instead of class components \(when editing React components\)/);

  const confirmed = await store.adjust(first.instinct.id, "confirm", { note: "helped" });
  assert.equal(confirmed.confidence, 0.75);
  let contradicted = await store.adjust(first.instinct.id, "contradict", { note: "user wanted a class here" });
  assert.equal(contradicted.confidence, 0.65);
  for (let index = 0; index < 5; index += 1) contradicted = await store.adjust(first.instinct.id, "contradict");
  assert.equal(contradicted.status, "retired");
  assert.equal((await store.list({ projectId: "project-a" })).some((item) => item.id === first.instinct.id), false);
  assert.equal((await store.list({ projectId: "project-a", includeRetired: true })).some((item) => item.id === first.instinct.id), true);
  await assert.rejects(store.adjust("nope", "confirm"), /Unknown instinct/);
  await assert.rejects(store.adjust(first.instinct.id, "explode"), /Unknown adjustment/);

  await store.record({ trigger: "when a test fails", action: "Read the assertion before touching code", domain: "debugging", projectId: "project-c", confidence: 0.85, now: "2026-01-04T00:00:00.000Z" });
  const candidates = await store.promotionCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projects, 2);
  const promoted = await store.adjust(candidates[0].id, "promote");
  assert.equal(promoted.scope, "global");
  await assert.rejects(store.adjust(candidates[0].id, "promote"), /already global/);

  for (const [trigger, action] of [["when writing tests", "Use table-driven cases"], ["when a test is flaky", "Pin the reproduction rate first"], ["when adding a regression test", "Name it by behavior"]]) {
    await store.record({ trigger, action, domain: "testing", projectId: "project-a", confidence: 0.75, now: "2026-01-05T00:00:00.000Z" });
  }
  const clusters = await store.clusters({ projectId: "project-a", minSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].domain, "testing");
  assert.match(clusters[0].skill_name, /^learned-testing-project/);
  const draft = renderInstinctSkillDraft(clusters[0], { projectName: "Shop" });
  assert.match(draft.markdown, /^---\nname: learned-testing-project[a-z0-9-]*\ndescription: "Use when working on testing tasks in the Shop project/);
  assert.match(draft.markdown, /## Workflow\n\n1\. When /);
  assert.match(draft.markdown, /\d\. When writing tests: Use table-driven cases \(confidence 75%/);
  assert.match(draft.markdown, /## Guardrails/);
  await store.markPromoted(clusters[0].instincts.map((item) => item.id), { skill: draft.name });
  assert.equal((await store.list({ projectId: "project-a", domain: "testing" })).length, 0, "promoted instincts leave the active list");

  const exported = await store.exportInstincts({ scope: "global", minConfidence: 0.5, now: "2026-01-06T00:00:00.000Z" });
  assert.ok(exported.instincts.length >= 2);
  assert.equal(exported.instincts[0].evidence, undefined);
  const other = new InstinctStore({ stateRoot: path.join(root, "other") });
  const imported = await other.importInstincts(exported.instincts, { scope: "global" });
  assert.equal(imported.length, exported.instincts.length);
  assert.ok(imported.every((item) => item.instinct.confidence <= 0.7), "imports are capped at 0.7");
  assert.equal(renderInstinctsMarkdown([]), "");
});
```

**Файл: `ai-dev-mcp-server/src/extensions/instincts.mjs`** (241 строк)

```js
import path from "node:path";
import { atomicWriteFile } from "../core/atomic-files.mjs";
import {
  INSTINCT_DOMAINS,
  INSTINCT_SCOPES,
  renderInstinctSkillDraft
} from "../core/instincts.mjs";
import { resolveWithinSync } from "../core/path-policy.mjs";

/**
 * Continuous-learning tools built on the instinct store: record observations,
 * confirm/contradict/retire/promote, list and rank, evolve clusters into skill
 * drafts in the vault, and export/import instinct sets.
 *
 * @param {{ instinctStore: import("../core/instincts.mjs").InstinctStore, taskStore: { read: Function }, resolveProjectIdentity: Function, detectProject?: Function, vaultRoot?: string, markSearchIndexDirty?: Function }} host
 */
export function createInstinctTools(host) {
  async function projectFor({ project_path, task_id }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      const identity = await host.resolveProjectIdentity(record.project.path);
      return { identity, record };
    }
    if (!project_path) return { identity: null, record: null };
    return { identity: await host.resolveProjectIdentity(project_path), record: null };
  }

  async function stackFor(identity) {
    if (!identity || !host.detectProject) return [];
    const detected = await host.detectProject(identity.project_root).catch(() => null);
    return detected?.stack ?? [];
  }

  return {
    definitions: [
      {
        name: "record_instinct",
        description: "Record a learned behavior as an atomic instinct: when <trigger>, <action>. Use after a user correction, an error you resolved the same way twice, or a workflow you repeat. Repeated observations of the same instinct raise its confidence; instincts above 70% are injected into later context packs. Default scope is project; use global only for universal practices.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            trigger: { type: "string", description: "Condition, e.g. \"when editing React components\"." },
            action: { type: "string", description: "Behavior, e.g. \"use hooks instead of class components\"." },
            domain: { type: "string", enum: INSTINCT_DOMAINS, default: "general" },
            scope: { type: "string", enum: INSTINCT_SCOPES, default: "project" },
            note: { type: "string", description: "Evidence: what happened (no code, no secrets)." },
            observations: { type: "number", default: 1, description: "How many times this was observed in the session." },
            confidence: { type: "number", description: "Optional explicit initial confidence 0.1-0.95." }
          },
          required: ["trigger", "action"]
        }
      },
      {
        name: "list_instincts",
        description: "List learned instincts visible to a project (project-scoped plus global), with decayed effective confidence; optionally filter by scope, domain, or minimum confidence.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            scope: { type: "string", enum: INSTINCT_SCOPES },
            domain: { type: "string", enum: INSTINCT_DOMAINS },
            min_confidence: { type: "number", default: 0 },
            include_retired: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "update_instinct",
        description: "Adjust an instinct: confirm (+0.05, it helped), contradict (-0.1, it was wrong; retires below 0.2), retire, or promote (project -> global).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            action: { type: "string", enum: ["confirm", "contradict", "retire", "promote"] },
            note: { type: "string" },
            task_id: { type: "string" }
          },
          required: ["id", "action"]
        }
      },
      {
        name: "evolve_instincts",
        description: "Cluster instincts by domain into skill-draft candidates and list project instincts eligible for global promotion (seen in 2+ projects, average confidence >= 0.8). With write_drafts=true, writes SKILL.md drafts into the vault custom skill catalog and marks the instincts promoted.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            min_cluster_size: { type: "number", default: 3 },
            write_drafts: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "export_instincts",
        description: "Export instincts (patterns only, no evidence text) as a JSON document that can be imported elsewhere.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            scope: { type: "string", enum: INSTINCT_SCOPES },
            domain: { type: "string", enum: INSTINCT_DOMAINS },
            min_confidence: { type: "number", default: 0.5 }
          }
        }
      },
      {
        name: "import_instincts",
        description: "Import instinct entries (from export_instincts) into the store; imported confidence is capped at 0.7 until confirmed locally.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Required when importing as project scope." },
            scope: { type: "string", enum: INSTINCT_SCOPES, description: "Override the scope of every imported entry." },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  trigger: { type: "string" },
                  action: { type: "string" },
                  domain: { type: "string" },
                  scope: { type: "string" },
                  confidence: { type: "number" },
                  observations: { type: "number" }
                },
                required: ["trigger", "action"]
              }
            }
          },
          required: ["entries"]
        }
      }
    ],
    handlers: {
      async record_instinct(args) {
        const { identity, record } = await projectFor(args);
        if ((args.scope || "project") === "project" && !identity) throw new Error("project_path or task_id is required for project-scoped instincts.");
        const result = await host.instinctStore.record({
          trigger: args.trigger,
          action: args.action,
          domain: args.domain,
          scope: args.scope || "project",
          projectId: identity?.project_id,
          projectName: record?.project?.name || (identity ? path.basename(identity.project_root) : ""),
          source: "agent",
          note: args.note,
          taskId: record?.id || args.task_id || "",
          observations: args.observations,
          confidence: args.confidence,
          stack: await stackFor(identity)
        });
        return {
          action: result.created ? "instinct_created" : "instinct_reinforced",
          instinct: result.instinct,
          next_step: result.instinct.confidence >= 0.7
            ? "Confidence is high enough to be injected into future context packs."
            : "Confidence grows with repeated observations and confirmations."
        };
      },
      async list_instincts(args) {
        const { identity } = await projectFor(args);
        const instincts = await host.instinctStore.list({
          projectId: identity?.project_id || "",
          scope: args.scope,
          domain: args.domain,
          minConfidence: Number(args.min_confidence) || 0,
          includeRetired: Boolean(args.include_retired)
        });
        return { project_id: identity?.project_id || null, count: instincts.length, instincts };
      },
      async update_instinct(args) {
        const instinct = await host.instinctStore.adjust(args.id, args.action, { note: args.note, taskId: args.task_id });
        return { action: `instinct_${args.action}ed`.replace("promoteed", "promoted"), instinct };
      },
      async evolve_instincts(args) {
        const { identity } = await projectFor(args);
        const clusters = await host.instinctStore.clusters({ projectId: identity?.project_id || "", minSize: args.min_cluster_size });
        const promotions = await host.instinctStore.promotionCandidates();
        const drafts = [];
        for (const cluster of clusters) {
          const draft = renderInstinctSkillDraft(cluster, { projectName: identity ? path.basename(identity.project_root) : "" });
          const relativePath = `03-skills-catalog/sources/custom/${draft.name}/SKILL.md`;
          let written = null;
          if (args.write_drafts) {
            if (!host.vaultRoot) throw new Error("vaultRoot is not configured; cannot write skill drafts.");
            const target = resolveWithinSync(host.vaultRoot, relativePath, { mode: "write" });
            await atomicWriteFile(target, draft.markdown, "utf8");
            await host.instinctStore.markPromoted(cluster.instincts.map((item) => item.id), { skill: draft.name, path: relativePath });
            host.markSearchIndexDirty?.(`instinct skill draft: ${relativePath}`);
            written = relativePath;
          }
          drafts.push({
            skill_name: draft.name,
            domain: cluster.domain,
            scope: cluster.scope,
            instincts: cluster.instincts.map((item) => item.id),
            path: relativePath,
            written,
            markdown: args.write_drafts ? undefined : draft.markdown
          });
        }
        return {
          action: args.write_drafts ? "instincts_evolved" : "evolution_previewed",
          clusters: drafts,
          promotion_candidates: promotions,
          next_step: args.write_drafts && drafts.some((item) => item.written)
            ? "Review the drafted SKILL.md files, then run rebuild_index and validate_skill_library."
            : "Re-run with write_drafts=true to materialize the drafts; promote candidates with update_instinct action=promote."
        };
      },
      async export_instincts(args) {
        const { identity } = await projectFor(args);
        return host.instinctStore.exportInstincts({
          projectId: identity?.project_id || "",
          scope: args.scope,
          domain: args.domain,
          minConfidence: Number(args.min_confidence) || 0.5
        });
      },
      async import_instincts(args) {
        const { identity } = await projectFor(args);
        if (args.scope === "project" && !identity) throw new Error("project_path is required to import project-scoped instincts.");
        const results = await host.instinctStore.importInstincts(args.entries, {
          scope: args.scope || "",
          projectId: identity?.project_id || "",
          projectName: identity ? path.basename(identity.project_root) : ""
        });
        return {
          action: "instincts_imported",
          imported: results.length,
          created: results.filter((item) => item.created).length,
          reinforced: results.filter((item) => !item.created).length
        };
      }
    },
    readOnly: ["list_instincts", "export_instincts"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/instincts.test.mjs`** (67 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstinctStore } from "../core/instincts.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createInstinctTools } from "./instincts.mjs";

test("instinct tools record, list, update, evolve into vault drafts, export, and import", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instinct-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const vaultRoot = path.join(root, "vault");
  await fs.mkdir(projectRoot);
  await fs.mkdir(vaultRoot);
  const stateRoot = path.join(root, "state");
  const taskStore = new TaskStore({ stateRoot });
  const instinctStore = new InstinctStore({ stateRoot });
  const dirty = [];
  const host = {
    taskStore,
    instinctStore,
    vaultRoot,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" }),
    detectProject: async () => ({ stack: ["Python", "FastAPI"], project_types: ["api"] }),
    markSearchIndexDirty: (reason) => dirty.push(reason)
  };
  const registry = createExtensionTools(host, [createInstinctTools]);
  const task = await taskStore.begin({ task: "Fix flaky tests", project: { project_name: "svc", project_path: projectRoot }, skills: [], baseline: { fingerprint: "a" } });

  await assert.rejects(registry.handlers.get("record_instinct")({ trigger: "x", action: "y" }), /project_path or task_id is required/);
  const recorded = await registry.handlers.get("record_instinct")({ task_id: task.id, trigger: "when a pytest test is flaky", action: "pin the reproduction rate before fixing", domain: "testing", note: "happened twice" });
  assert.equal(recorded.action, "instinct_created");
  assert.equal(recorded.instinct.project_id, "project-test");
  assert.deepEqual(recorded.instinct.stack, ["Python", "FastAPI"]);
  for (const [trigger, action] of [["when adding a regression test", "name it by the behavior it protects"], ["when tests share state", "isolate fixtures per test"]]) {
    await registry.handlers.get("record_instinct")({ project_path: projectRoot, trigger, action, domain: "testing", confidence: 0.75 });
  }
  const globalOne = await registry.handlers.get("record_instinct")({ trigger: "when handling user input", action: "validate at the boundary", domain: "security", scope: "global", confidence: 0.8 });
  assert.equal(globalOne.instinct.scope, "global");

  const listed = await registry.handlers.get("list_instincts")({ project_path: projectRoot });
  assert.equal(listed.count, 4);
  const confirmed = await registry.handlers.get("update_instinct")({ id: recorded.instinct.id, action: "confirm", note: "helped" });
  assert.equal(confirmed.action, "instinct_confirmed");
  assert.equal(confirmed.instinct.confidence, 0.35);

  const preview = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3 });
  assert.equal(preview.action, "evolution_previewed");
  assert.equal(preview.clusters.length, 1);
  assert.match(preview.clusters[0].markdown, /^---\nname: learned-testing-project/);
  const evolved = await registry.handlers.get("evolve_instincts")({ project_path: projectRoot, min_cluster_size: 3, write_drafts: true });
  assert.equal(evolved.action, "instincts_evolved");
  const draftPath = path.join(vaultRoot, "03-skills-catalog", "sources", "custom", "learned-testing-project", "SKILL.md");
  assert.match(await fs.readFile(draftPath, "utf8"), /## Workflow/);
  assert.equal(dirty.length, 1);
  assert.equal((await registry.handlers.get("list_instincts")({ project_path: projectRoot, domain: "testing" })).count, 0);

  const exported = await registry.handlers.get("export_instincts")({ scope: "global" });
  assert.equal(exported.instincts.length, 1);
  const imported = await registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "global" });
  assert.equal(imported.imported, 1);
  assert.equal(imported.reinforced, 1, "same global instinct merges instead of duplicating");
  await assert.rejects(registry.handlers.get("import_instincts")({ entries: exported.instincts, scope: "project" }), /project_path is required/);
});
```

## Изменения существующих файлов

См. документ 09: `context-extras.mjs` (провайдер «Learned Instincts»), `mcp-stdio.mjs`
(`InstinctStore` в host), `server.mjs` (промпт `learn_from_task`), `tool-extensions.mjs`.

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/instincts.test.mjs src/extensions/instincts.test.mjs
```

## Использование

```json
{ "tool": "record_instinct", "args": { "project_path": "/repo", "domain": "testing",
  "trigger": "adding a Fastify route", "action": "add a route test with inject() before wiring the plugin",
  "note": "user corrected twice: tests were added after the fact", "observations": 2 } }

{ "tool": "list_instincts", "args": { "project_path": "/repo", "min_confidence": 0.5 } }
{ "tool": "update_instinct", "args": { "id": "inst-…", "action": "confirm", "task_id": "task-…" } }
{ "tool": "evolve_instincts", "args": { "project_path": "/repo", "write_drafts": true } }
{ "tool": "export_instincts", "args": { "scope": "global" } }
```

После `evolve_instincts … write_drafts=true` вызовите `rebuild_index`, чтобы черновик попал в
роутинг скиллов; черновик помечен как `draft` и требует редактирования.

## Для Argentum

Инстинкты — механизм, которым воркспейс «учится» на поправках пользователя между сессиями,
не раздувая системный промпт: в контекст попадает не история, а до шести коротких правил с
высокой уверенностью. Экспорт/импорт позволяет переносить глобальные инстинкты между машинами
и пользователями.

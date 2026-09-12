import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./atomic-files.mjs";
import { memoryScopeKeys } from "./project-identity.mjs";

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
/**
 * `active` is a behaviour the agent follows, `proposed` is a candidate
 * `propose_instincts` derived from a session and nobody has confirmed —
 * listed on request, never injected into a context pack, and turned into an
 * active instinct by `update_instinct(action: "confirm")`. `retired` and
 * `promoted` are the ends of the same life.
 */
export const INSTINCT_STATUSES = ["active", "proposed", "retired", "promoted"];
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

/**
 * Whether two instincts say the same thing: three quarters of the shorter
 * one's words appear in the other. Exported so a proposer can tell a new
 * candidate from one the store already holds.
 *
 * @param {{ trigger: string, action: string }} left
 * @param {{ trigger: string, action: string }} right
 * @returns {boolean}
 */
export function instinctsAreSimilar(left, right) {
  return similar(left, right);
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

/**
 * Project-scoped instincts are visible to a scope when either key matches: the
 * repository id every worktree of one clone shares, or the project id the
 * instinct was recorded under before repository ids existed.
 */
function inScope(item, keys) {
  return keys.includes(item.repository_id) || keys.includes(item.project_id);
}

/** The key a stored instinct is filed under, newest scheme first. */
function scopeKeyOf(item) {
  return item.repository_id || item.project_id || "";
}

/**
 * First write under a repository id adopts the instincts an older project id
 * recorded, so memory written before worktrees were unified stays visible.
 */
function migrateScope(store, [primary, ...legacy]) {
  if (!primary || !legacy.length) return;
  for (const item of store.instincts) {
    if (item.scope !== "project" || item.repository_id) continue;
    if (legacy.includes(item.project_id)) item.repository_id = primary;
  }
}

/**
 * Instincts are scoped by repository key (see
 * {@link import("./project-identity.mjs").memoryScopeKeys}) so a worktree and
 * its main checkout learn from each other; every reader takes both
 * `repositoryId` and `projectId` and matches either.
 */
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
   * @param {{ trigger: string, action: string, domain?: string, scope?: string, repositoryId?: string, projectId?: string, projectName?: string, source?: string, note?: string, taskId?: string, confidence?: number, observations?: number, stack?: string[], now?: string }} input
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
    const keys = memoryScopeKeys(input);
    const now = input.now || new Date().toISOString();
    let result;
    await this.update((store) => {
      migrateScope(store, keys);
      const id = instinctId(trigger, action);
      const candidate = { trigger, action };
      const existing = store.instincts.find((item) => item.status !== "retired" && (
        (item.id === id || similar(item, candidate))
        && (item.scope === "global" || scope === "global" || inScope(item, keys))
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
        repository_id: scope === "project" ? String(input.repositoryId || "") : "",
        project_id: scope === "project" ? String(input.projectId) : "",
        project_name: scope === "project" ? String(input.projectName || "") : "",
        confidence: round(clamp(Number.isFinite(Number(input.confidence)) && input.confidence !== undefined ? Number(input.confidence) : initialConfidence(observations))),
        observations,
        source,
        stack: [...new Set((input.stack ?? []).map(String))],
        // A proposal is stored, listed and confirmable, but it is not a
        // behaviour yet: `list` hides it and the context pack never sees it.
        status: input.status === "proposed" ? "proposed" : "active",
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
        // Confirming is what a proposal is waiting for, and what brings a
        // retired instinct back.
        if (["retired", "proposed"].includes(instinct.status)) instinct.status = "active";
      } else if (kind === "contradict") {
        instinct.confidence = round(clamp(instinct.confidence - CONTRADICT_STEP));
        if (instinct.confidence < RETIRE_BELOW) instinct.status = "retired";
      } else if (kind === "retire") {
        instinct.status = "retired";
      } else if (kind === "promote") {
        if (instinct.scope === "global") throw new Error(`Instinct ${id} is already global.`);
        instinct.scope = "global";
        instinct.repository_id = "";
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
   * Proposed, retired and promoted instincts are hidden unless `status` names
   * one of them, or `includeRetired` asks for everything.
   *
   * @param {{ repositoryId?: string, projectId?: string, scope?: string, domain?: string, status?: string, minConfidence?: number, includeRetired?: boolean, now?: string }} [filter]
   * @returns {Promise<object[]>}
   */
  async list({ repositoryId = "", projectId = "", scope = "", domain = "", status = "", minConfidence = 0, includeRetired = false, now = new Date().toISOString() } = {}) {
    const store = await this.read();
    const keys = memoryScopeKeys({ repositoryId, projectId });
    return store.instincts
      // An explicit status asks for exactly that one; otherwise only behaviours
      // the agent follows, unless everything was asked for.
      .filter((item) => (status ? item.status === status : includeRetired || item.status === "active"))
      .filter((item) => !keys.length || item.scope === "global" || inScope(item, keys))
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
   * @param {{ repositoryId?: string, projectId?: string, stack?: string[], task?: string, threshold?: number, limit?: number, now?: string }} input
   * @returns {Promise<{ instincts: object[], markdown: string }>}
   */
  async rankForContext({ repositoryId = "", projectId = "", stack = [], task = "", threshold = DEFAULT_INJECT_THRESHOLD, limit = DEFAULT_MAX_INJECTED, now = new Date().toISOString() } = {}) {
    const candidates = await this.list({ repositoryId, projectId, minConfidence: threshold, now });
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
   * Project-scoped instincts seen in two or more repositories with average
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
      const projects = new Set(items.map(scopeKeyOf)).size;
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
   * @param {{ repositoryId?: string, projectId?: string, minSize?: number }} [input]
   * @returns {Promise<Array<{ key: string, domain: string, scope: string, instincts: object[], skill_name: string }>>}
   */
  async clusters({ repositoryId = "", projectId = "", minSize = 3 } = {}) {
    const items = await this.list({ repositoryId, projectId });
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

  async exportInstincts({ scope = "", domain = "", minConfidence = 0.5, repositoryId = "", projectId = "", now = new Date().toISOString() } = {}) {
    const items = await this.list({ repositoryId, projectId, scope, domain, minConfidence, now });
    return {
      schema_version: STORE_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      instincts: items.map(({ effective_confidence, evidence, ...item }) => ({ ...item, evidence_count: (evidence || []).length }))
    };
  }

  async importInstincts(entries, { scope = "", repositoryId = "", projectId = "", projectName = "" } = {}) {
    const results = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const targetScope = scope || entry.scope || "global";
      results.push(await this.record({
        trigger: entry.trigger,
        action: entry.action,
        domain: entry.domain,
        scope: targetScope,
        repositoryId: targetScope === "project" ? repositoryId || entry.repository_id : "",
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

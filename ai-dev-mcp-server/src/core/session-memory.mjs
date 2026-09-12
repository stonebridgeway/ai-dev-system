import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomic-files.mjs";
import { observationsFileName } from "./instinct-proposals.mjs";
import { memoryScopeKeys } from "./project-identity.mjs";

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

/**
 * A record the `session-end` hook distilled from a transcript and nobody has
 * confirmed. Its fields are heuristics: readers must label them as such, and
 * `save_session(confirm_hook_draft: true)` is what turns one into a real
 * handoff. Records written before the flag existed are drafts too — they came
 * from the same hook.
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isHookDraft(record) {
  return String(record?.source) === "hook" && record?.confirmed !== true;
}

/**
 * The caveat a draft is shown with, wherever it is shown.
 *
 * @param {object} record
 * @returns {string}
 */
export function hookDraftCaveat(record) {
  return [
    `UNCONFIRMED HOOK DRAFT (${record?.id || "unknown"}) — the ${record?.captured_by === "pre-compact" ? "PreCompact" : "Stop"} hook distilled this from the transcript;`,
    "no agent wrote or checked it. Requests and file lists are heuristics, and there is no verified next step.",
    "Confirm it with save_session(confirm_hook_draft: true) — filling in what actually happened — or ignore it and save a real handoff."
  ].join(" ");
}

/**
 * Handoffs live under the repository key so every worktree of one clone reads
 * the same memory; `scope` accepts an identity object, `{ repositoryId,
 * projectId }`, or a bare key.
 */
export class SessionStore {
  constructor({ stateRoot }) {
    this.stateRoot = path.resolve(stateRoot);
    this.root = path.join(this.stateRoot, "sessions");
  }

  directoryFor(scopeKey) {
    const safe = String(scopeKey || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.root, safe);
  }

  /**
   * Move records a legacy key wrote into the primary key's directory. Readers
   * merge both keys, so this only consolidates: the split disappears after the
   * first save under the repository id.
   *
   * @param {object | string} scope
   * @returns {Promise<string[]>} Paths that moved.
   */
  async migrate(scope) {
    const [primary, ...legacy] = memoryScopeKeys(scope);
    if (!primary || !legacy.length) return [];
    const target = this.directoryFor(primary);
    const moved = [];
    for (const key of legacy) {
      const source = this.directoryFor(key);
      if (source === target) continue;
      const names = await this.recordNames(source);
      if (!names.length) continue;
      await fs.mkdir(target, { recursive: true });
      for (const name of names) {
        const destination = path.join(target, name);
        // A same-named record already under the repository key wins; the legacy
        // copy stays where it is and readers still merge it.
        if (await fs.access(destination).then(() => true, () => false)) continue;
        await fs.rename(path.join(source, name), destination);
        moved.push(destination);
      }
      await fs.rmdir(source).catch(() => undefined);
    }
    return moved;
  }

  /** Handoff records only: the observation logs the hook writes share the directory, not the shape. */
  async recordNames(directory) {
    try {
      return (await fs.readdir(directory)).filter((name) => name.endsWith(".json") && !name.startsWith("observe-"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Persist a handoff record. Returns the stored record including metadata.
   *
   * @param {{ repositoryId?: string, projectId: string, projectPath: string, projectName?: string, taskId?: string, branch?: string, worktree?: string, source?: string, client?: string, sessionId?: string, now?: string } & object} input
   */
  async save(input) {
    const record = normalizeSessionRecord(input);
    const savedAt = input.now || new Date().toISOString();
    const id = `session-${savedAt.replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    const [scopeKey = ""] = memoryScopeKeys(input);
    await this.migrate(input);
    const stored = {
      schema_version: 1,
      id,
      saved_at: savedAt,
      repository_id: String(input.repositoryId || ""),
      project_id: String(input.projectId || ""),
      project_path: String(input.projectPath || ""),
      project_name: String(input.projectName || path.basename(String(input.projectPath || "")) || ""),
      task_id: String(input.taskId || ""),
      branch: String(input.branch || ""),
      worktree: String(input.worktree || input.projectPath || ""),
      source: String(input.source || "agent"),
      // Agent-written records are confirmed by definition; the hook writes its
      // own files and marks them unconfirmed there.
      confirmed: input.confirmed !== false,
      confirmed_from: String(input.confirmedFrom || ""),
      client: String(input.client || ""),
      session_id: String(input.sessionId || ""),
      ...record
    };
    const fileName = `${savedAt.replace(/\D/g, "").slice(0, 14)}-${slug(record.topic)}.json`;
    const filePath = path.join(this.directoryFor(scopeKey), fileName);
    await atomicWriteJson(filePath, stored);
    return { record: stored, path: filePath };
  }

  async list(scope, { limit = 20, substantiveOnly = false } = {}) {
    const records = [];
    const seen = new Set();
    for (const key of memoryScopeKeys(scope)) {
      const directory = this.directoryFor(key);
      for (const name of await this.recordNames(directory)) {
        try {
          const record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          record.substance_score = sessionSubstanceScore(record);
          record.unconfirmed = isHookDraft(record);
          record.path = path.join(directory, name);
          if (substantiveOnly && record.substance_score < 3) continue;
          records.push(record);
        } catch {
          // Corrupt files are skipped; system health can report them.
        }
      }
    }
    return records
      .sort((left, right) => String(right.saved_at).localeCompare(String(left.saved_at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
  }

  async latest(scope) {
    return (await this.list(scope, { limit: 1, substantiveOnly: true }))[0] ?? null;
  }

  async read(scope, sessionId) {
    const records = await this.list(scope, { limit: 200 });
    const record = records.find((item) => item.id === sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    return record;
  }

  /**
   * Unconfirmed hook captures for a scope, newest first.
   *
   * @param {object | string} scope
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async drafts(scope, { limit = 20 } = {}) {
    return (await this.list(scope, { limit: 200 })).filter(isHookDraft).slice(0, Math.max(1, limit));
  }

  /**
   * Observation logs the `session-end` hook wrote for this scope, newest
   * first. They sit beside the drafts and outlive them: a draft is discarded
   * once confirmed, and the log it was distilled from is what
   * `propose_instincts` still reads.
   *
   * @param {object | string} scope
   * @param {{ sessionId?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async observations(scope, { sessionId = "" } = {}) {
    const wanted = sessionId ? observationsFileName(sessionId) : "";
    const logs = [];
    const seen = new Set();
    for (const key of memoryScopeKeys(scope)) {
      const directory = this.directoryFor(key);
      let names = [];
      try {
        names = (await fs.readdir(directory)).filter((name) => name.startsWith("observe-") && name.endsWith(".json"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        continue;
      }
      for (const name of names) {
        if (wanted && name !== wanted) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        try {
          const log = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
          logs.push({ ...log, path: path.join(directory, name) });
        } catch {
          // A half-written log is skipped; the next capture rewrites it whole.
        }
      }
    }
    return logs.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  /**
   * Drop a draft once its content has been carried into a real handoff, so it
   * stops being offered as unconfirmed memory.
   *
   * @param {object} record - A record from {@link SessionStore.list}.
   * @returns {Promise<boolean>} Whether a file was removed.
   */
  async discardDraft(record) {
    if (!isHookDraft(record) || !record?.path) return false;
    // Only ever inside our own sessions tree, whatever the record claims.
    const target = path.resolve(record.path);
    if (!target.startsWith(`${this.root}${path.sep}`)) return false;
    try {
      await fs.rm(target);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    return true;
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
 * @param {{ record: object | null, tasks?: object[], git?: object, freshness?: object, instincts?: string, drafts?: object[], now?: string }} input
 * @returns {string}
 */
export function renderResumeBriefing({ record, tasks = [], git = null, freshness = null, instincts = "", drafts = [], now = new Date().toISOString() }) {
  const lines = [];
  if (!record) {
    lines.push("NO SAVED SESSION for this project. Run save_session at the end of a session to create one.");
  } else {
    const age = sessionAgeDays(record, now);
    const draft = isHookDraft(record);
    lines.push(
      `SESSION ${draft ? "DRAFT" : "LOADED"}: ${record.path || record.id}`,
      "════════════════════════════════════════════════",
      "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. Verify against git and the working tree before acting; prior work may already be done.",
      ...(draft ? [hookDraftCaveat(record)] : []),
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
      record.next_step || (draft
        ? "None recorded — the hook cannot know it. Re-read the working tree and decide before touching files."
        : "No next step defined — review 'What Has NOT Been Tried Yet' before starting.")
    );
  }
  if (drafts.length) {
    lines.push("", "UNCONFIRMED HOOK DRAFTS (not handoffs; confirm or ignore):", ...drafts.map((item) => `- ${item.id} (${item.saved_at}) ${item.topic || ""}`));
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
  lines.push(
    "",
    "════════════════════════════════════════════════",
    isHookDraft(record)
      ? "This is a draft, not a handoff. Reconstruct the state from git and the working tree, then confirm it with save_session(confirm_hook_draft: true)."
      : "Ready to continue. Confirm the next step before touching files."
  );
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

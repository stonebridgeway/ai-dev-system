import fs from "node:fs/promises";
import path from "node:path";
import { contextPackFreshness } from "../core/context-compiler.mjs";
import {
  FILE_STATUSES,
  HANDOFF_RELATIVE_PATH,
  estimateContextBudget,
  isHookDraft,
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

/** Fields the agent left out are filled from the draft it is confirming. */
function withDraft(args, draft) {
  if (!draft) return args;
  const text = (value, fallback) => (String(value ?? "").trim() ? value : String(fallback ?? ""));
  const items = (value, fallback) => (Array.isArray(value) && value.length ? value : Array.isArray(fallback) ? fallback : []);
  return {
    ...args,
    topic: text(args.topic, draft.topic),
    building: text(args.building, draft.building),
    worked: items(args.worked, draft.worked),
    failed: items(args.failed, draft.failed),
    untried: items(args.untried, draft.untried),
    files: items(args.files, draft.files),
    decisions: items(args.decisions, draft.decisions),
    blockers: items(args.blockers, draft.blockers),
    next_step: text(args.next_step, draft.next_step),
    environment: text(args.environment, draft.environment),
    client: text(args.client, draft.client),
    session_id: text(args.session_id, draft.session_id)
  };
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
        description: "Save a structured session handoff (what we are building, what worked with evidence, what failed and why, untried ideas, file states, decisions, blockers, exact next step). Stored under ~/.ai-dev/state/sessions, keyed by repository so task worktrees and the main checkout share one memory, and projected to .ai-dev/context/handoff.md so the next session (or a compaction) resumes from facts. Give topic or building: a handoff nobody can name is a handoff nobody reads.",
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
            session_id: { type: "string" },
            confirm_hook_draft: { type: "boolean", default: false, description: "Promote the unconfirmed draft the session-end hook captured: fields you leave out are taken from it, the saved record is marked confirmed, and the draft is dropped." },
            draft_session_id: { type: "string", description: "Which draft to confirm (default: the newest). Only read when confirm_hook_draft is true." }
          }
        }
      },
      {
        name: "resume_session",
        description: "Load the latest substantive session handoff for a repository (any of its worktrees, or a specific session id) and return a resume briefing: what not to retry, blockers, next step, open tasks, git state, context-pack freshness, and relevant learned instincts. Records the session-end hook distilled from a transcript come back flagged unconfirmed, with the caveat that their fields are heuristics. Read-only.",
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
        name: "list_sessions",
        description: "List the session handoffs a repository has, newest first: who saved each one (the agent, or the session-end hook as an unconfirmed draft), its topic, next step, substance score, task and branch, and whether an observation log for it is still on disk for propose_instincts. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            limit: { type: "number", default: 20 },
            drafts_only: { type: "boolean", default: false, description: "Only the unconfirmed captures the session-end hook wrote." },
            substantive_only: { type: "boolean", default: false, description: "Drop records too thin to resume from." }
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
      async list_sessions(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const records = await host.sessionStore.list(identity, {
          limit: args.limit ?? 20,
          substantiveOnly: Boolean(args.substantive_only)
        });
        const logs = await host.sessionStore.observations(identity);
        const observed = new Set(logs.map((log) => String(log.session_id || "")).filter(Boolean));
        const sessions = records
          .filter((record) => !args.drafts_only || isHookDraft(record))
          .map((record) => ({
            id: record.id,
            saved_at: record.saved_at,
            topic: record.topic,
            next_step: record.next_step,
            source: record.source,
            unconfirmed: record.unconfirmed,
            substance_score: record.substance_score,
            task_id: record.task_id,
            branch: record.branch,
            client: record.client,
            session_id: record.session_id,
            files: (record.files ?? []).length,
            // propose_instincts reads the log, not the handoff, so this is what
            // says whether there is anything left to learn from.
            has_observations: Boolean(record.session_id && observed.has(record.session_id))
          }));
        const drafts = sessions.filter((item) => item.unconfirmed).length;
        return {
          project_id: identity.project_id,
          repository_id: identity.repository_id,
          count: sessions.length,
          drafts,
          observation_logs: logs.length,
          sessions,
          next_step: drafts
            ? `${drafts} unconfirmed hook draft(s): confirm one with save_session(confirm_hook_draft: true) or ignore it.`
            : sessions.length
              ? "resume_session loads the newest substantive handoff in full."
              : "No handoffs yet: save_session writes one, and the session-end hook drafts one when you forget."
        };
      },
      async save_session(args) {
        const { identity, record } = await projectFor(args);
        const state = await host.captureProjectState(identity.project_root);
        // Confirming a draft is what turns a hook capture into memory the next
        // session may act on: the agent's fields win, the draft fills the rest,
        // and the draft file goes away so nothing is offered as unconfirmed twice.
        const draft = args.confirm_hook_draft
          ? args.draft_session_id
            ? await host.sessionStore.read(identity, args.draft_session_id)
            : (await host.sessionStore.drafts(identity, { limit: 1 }))[0] ?? null
          : null;
        if (args.draft_session_id && draft && !isHookDraft(draft)) {
          throw new Error(`Session ${draft.id} is not an unconfirmed hook draft.`);
        }
        const input = withDraft(args, draft);
        const saved = await host.sessionStore.save({
          repositoryId: identity.repository_id,
          projectId: identity.project_id,
          projectPath: identity.project_root,
          projectName: record?.project?.name || path.basename(identity.project_root),
          taskId: record?.id || "",
          branch: state.branch || "",
          worktree: identity.project_root,
          client: input.client,
          sessionId: input.session_id,
          source: "agent",
          confirmed: true,
          confirmedFrom: draft?.id || "",
          topic: input.topic,
          building: input.building,
          worked: input.worked,
          failed: input.failed,
          untried: input.untried,
          files: input.files,
          decisions: input.decisions,
          blockers: input.blockers,
          next_step: input.next_step,
          environment: input.environment
        });
        const discarded = draft ? await host.sessionStore.discardDraft(draft) : false;
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
          repository_id: identity.repository_id,
          markdown: renderHandoffMarkdown(saved.record),
          checkpoint,
          confirmed_draft: draft ? { id: draft.id, discarded } : null,
          next_step: args.confirm_hook_draft && !draft
            ? "No unconfirmed hook draft was found for this repository; the handoff was saved as written."
            : saved.record.next_step
              ? "Safe to compact or end the session; resume_session restores this handoff."
              : "Record an exact next step so the next session does not have to rediscover it."
        };
      },
      async resume_session(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        // The identity carries both memory keys: sessions saved in a task
        // worktree and in the main checkout share one repository id.
        const record = args.session_id
          ? await host.sessionStore.read(identity, args.session_id)
          : await host.sessionStore.latest(identity);
        const history = await host.sessionStore.list(identity, { limit: args.limit_history || 5 });
        // Drafts the agent has not confirmed yet, minus the one it is reading.
        const drafts = (await host.sessionStore.drafts(identity, { limit: 5 })).filter((item) => item.id !== record?.id);
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
            repositoryId: identity.repository_id,
            projectId: identity.project_id,
            stack: detected?.stack ?? [],
            task: record?.next_step || record?.topic || ""
          });
          instincts = ranked.markdown || "";
        }
        return {
          project_id: identity.project_id,
          repository_id: identity.repository_id,
          project_path: identity.project_root,
          session: record,
          unconfirmed: isHookDraft(record),
          hook_drafts: drafts.map((item) => ({ id: item.id, saved_at: item.saved_at, topic: item.topic, captured_by: item.captured_by || "" })),
          history: history.map((item) => ({ id: item.id, saved_at: item.saved_at, topic: item.topic, task_id: item.task_id, substance_score: item.substance_score, unconfirmed: isHookDraft(item) })),
          open_tasks: tasks.map((task) => ({ id: task.id, status: task.status, task: task.task, plan_required: Boolean(task.plan_policy?.plan_required), plan_recorded: Boolean(task.plan) })),
          git: { branch: state.branch || "", dirty: Boolean(state.dirty), dirty_files: state.dirty_files ?? [] },
          context_pack: freshness,
          handoff_path: HANDOFF_RELATIVE_PATH,
          briefing: renderResumeBriefing({ record, tasks, git: state, freshness, instincts, drafts })
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
    readOnly: ["list_sessions", "resume_session", "context_budget_status"]
  };
}

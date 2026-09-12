import path from "node:path";
import { atomicWriteFile } from "../core/atomic-files.mjs";
import { proposeInstincts } from "../core/instinct-proposals.mjs";
import {
  INSTINCT_DOMAINS,
  INSTINCT_SCOPES,
  INSTINCT_STATUSES,
  instinctsAreSimilar,
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
        description: "Record a learned behavior as an atomic instinct: when <trigger>, <action>. Use after a user correction, an error you resolved the same way twice, or a workflow you repeat. Repeated observations of the same instinct raise its confidence; instincts above 70% are injected into later context packs. Default scope is project (the whole repository, task worktrees included); use global only for universal practices. A project-scoped instinct needs project_path or task_id to say which repository it belongs to; a global one does not.",
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
        description: "List learned instincts visible to a project (its repository's own plus global), with decayed effective confidence; optionally filter by scope, domain, or minimum confidence.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            scope: { type: "string", enum: INSTINCT_SCOPES },
            domain: { type: "string", enum: INSTINCT_DOMAINS },
            status: { type: "string", enum: INSTINCT_STATUSES, description: "Exactly one status. Default: active only. Use proposed to review what propose_instincts suggested." },
            min_confidence: { type: "number", default: 0 },
            include_retired: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "propose_instincts",
        description: "Read the observation log the session-end hook wrote for a session and propose candidate instincts from it: what the user corrected, the rules they stated, an error that recurred and the call that cleared it, and the commands and command pairs the session kept repeating. Candidates are stored with status \"proposed\" — listed by list_instincts(status: \"proposed\"), never injected into a context pack — and become real instincts through update_instinct(action: \"confirm\").",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            session_id: { type: "string", description: "Which session's log to read. Default: the newest one for this repository." },
            limit: { type: "number", default: 10, description: "Most candidates to propose, strongest first." },
            dry_run: { type: "boolean", default: false, description: "Return the candidates without storing them." }
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
        description: "Cluster instincts by domain into skill-draft candidates and list project instincts eligible for global promotion (seen in 2+ repositories, average confidence >= 0.8). With write_drafts=true, writes SKILL.md drafts into the vault custom skill catalog and marks the instincts promoted.",
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
          repositoryId: identity?.repository_id,
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
          repositoryId: identity?.repository_id || "",
          projectId: identity?.project_id || "",
          scope: args.scope,
          domain: args.domain,
          status: args.status || "",
          minConfidence: Number(args.min_confidence) || 0,
          includeRetired: Boolean(args.include_retired)
        });
        return { project_id: identity?.project_id || null, repository_id: identity?.repository_id || null, count: instincts.length, instincts };
      },
      async propose_instincts(args) {
        const { identity, record } = await projectFor(args);
        if (!identity) throw new Error("project_path or task_id is required.");
        const projectName = record?.project?.name || path.basename(identity.project_root);
        const logs = await host.sessionStore.observations(identity, { sessionId: args.session_id });
        const log = logs[0];
        if (!log) {
          return {
            status: "no_observations",
            project_id: identity.project_id,
            sessions: 0,
            proposals: [],
            next_step: args.session_id
              ? `No observation log for session ${args.session_id}. install_agent_hooks writes one at the end of every session; list_sessions shows which sessions this repository has.`
              : "No observation log for this repository yet. install_agent_hooks writes one at the end of every session."
          };
        }
        const { proposals, signals } = proposeInstincts({ events: log.events, projectName, limit: args.limit });
        // A candidate that repeats something the store already holds is not
        // news, and recording it would quietly raise that instinct's
        // confidence on the strength of one session.
        const known = await host.instinctStore.list({
          repositoryId: identity.repository_id,
          projectId: identity.project_id,
          includeRetired: true
        });
        const fresh = [];
        const skipped = [];
        for (const candidate of proposals) {
          const match = known.find((item) => instinctsAreSimilar(item, candidate));
          if (match) skipped.push({ ...candidate, reason: `already recorded as ${match.id} (${match.status})` });
          else fresh.push(candidate);
        }
        const stored = [];
        if (!args.dry_run) {
          for (const candidate of fresh) {
            const result = await host.instinctStore.record({
              trigger: candidate.trigger,
              action: candidate.action,
              domain: candidate.domain,
              scope: "project",
              status: "proposed",
              repositoryId: identity.repository_id,
              projectId: identity.project_id,
              projectName,
              source: "observation",
              note: candidate.note,
              observations: candidate.observations,
              confidence: candidate.confidence,
              stack: await stackFor(identity)
            });
            stored.push({ ...candidate, id: result.instinct.id, status: result.instinct.status });
          }
        }
        return {
          status: fresh.length ? "proposed" : "nothing_new",
          project_id: identity.project_id,
          repository_id: identity.repository_id,
          session_id: log.session_id || "",
          observed_at: log.updated_at || "",
          signals,
          proposals: args.dry_run ? fresh : stored,
          skipped,
          next_step: fresh.length
            ? `Review them with list_instincts(status: "proposed"), then update_instinct(id, action: "confirm") for each one that is true, or action: "retire" for the rest. A proposal quotes what was observed; the wording is yours to fix with record_instinct.`
            : "Nothing this session showed is new. Everything observed is already recorded."
        };
      },
      async update_instinct(args) {
        const instinct = await host.instinctStore.adjust(args.id, args.action, { note: args.note, taskId: args.task_id });
        return { action: `instinct_${args.action}ed`.replace("promoteed", "promoted"), instinct };
      },
      async evolve_instincts(args) {
        const { identity } = await projectFor(args);
        const clusters = await host.instinctStore.clusters({ repositoryId: identity?.repository_id || "", projectId: identity?.project_id || "", minSize: args.min_cluster_size });
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
          repositoryId: identity?.repository_id || "",
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
          repositoryId: identity?.repository_id || "",
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

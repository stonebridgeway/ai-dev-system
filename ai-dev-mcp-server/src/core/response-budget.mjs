/**
 * What a tool answers an agent by default: what changed and what to do next,
 * not the whole record again.
 *
 * The lifecycle tools used to return the full task record on every call — the
 * context pack, the routed skills and every verification so far — so one small
 * task sent the same kilobytes back four or five times. Each view below keeps
 * what the agent acts on (ids, statuses, criteria, the failing part of a check,
 * the next step) and says where the rest is: `get_task` returns the whole
 * record, and `include_details: true` on the call itself returns what it used
 * to. `AI_DEV_RESPONSE_MODE=full` restores the full answers for every call, for
 * a client that reads them.
 *
 * Everything here is pure: it shapes values it is given and reads nothing.
 */

import { createHash } from "node:crypto";

export const RESPONSE_MODE_ENV = "AI_DEV_RESPONSE_MODE";

/** Characters kept from each end of a long command output. */
export const OUTPUT_HEAD = 1200;
export const OUTPUT_TAIL = 800;

/** How long a one-line description in a search row may be. */
export const PREVIEW_CHARS = 200;

/** A command whose output says nothing its status does not. */
const QUIET_STATUSES = new Set(["passed", "pass", "ok", "skipped"]);

/** Where the whole task record is, said once in every lifecycle view. */
const DETAILS_HINT = "get_task returns the whole record; include_details: true on this call returns it here.";

/**
 * Whether a call asked for the full answer, or the environment asks for every one.
 *
 * @param {object} [args] - The tool's arguments.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function wantsDetails(args, env = process.env) {
  return args?.include_details === true || String(env?.[RESPONSE_MODE_ENV] ?? "").trim().toLowerCase() === "full";
}

/**
 * A long text cut to its head and tail, with how much was left out between them.
 *
 * @param {unknown} text
 * @param {{ head?: number, tail?: number }} [budget]
 * @returns {string}
 */
export function clip(text, { head = OUTPUT_HEAD, tail = OUTPUT_TAIL } = {}) {
  const value = String(text ?? "");
  if (value.length <= head + tail + 80) return value;
  const cut = value.length - head - tail;
  return `${value.slice(0, head)}\n… ${cut} characters cut; include_details: true returns all of it …\n${value.slice(value.length - tail)}`;
}

/** One line of text, at most `limit` characters. */
export function preview(text, limit = PREVIEW_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/**
 * A skill as a search or a browse lists it: enough to choose one and read it.
 *
 * @param {object} item - A skill registry row.
 * @returns {object}
 */
export function skillRow(item = {}) {
  const description = preview(item.description);
  const useWhen = preview(item.use_when);
  const row = {
    name: item.name,
    source: item.source,
    description,
    // Many skills say when to use them in their description: said once is enough.
    use_when: useWhen === description ? undefined : useWhen,
    primary_group: item.primary_group,
    primary_group_label: item.primary_group_label,
    quality_score: item.quality_score,
    quality_grade: item.quality_grade,
    maturity: item.maturity,
    path: item.path,
    card_path: item.card_path
  };
  for (const key of ["score", "match_score", "reason", "routing_role"]) if (item[key] !== undefined) row[key] = item[key];
  return dropEmpty(row);
}

/**
 * The skill groups without the example paths each group carries: their names are kept,
 * five at most.
 *
 * @param {{ groups?: object[] }} listing - What `list_skill_groups` builds.
 * @returns {object}
 */
export function skillGroupsView(listing = {}) {
  return {
    ...listing,
    groups: (listing.groups ?? []).map(({ examples, ...group }) => ({
      ...group,
      examples: (examples ?? []).slice(0, 5).map((example) => (typeof example === "string" ? example : example?.name)).filter(Boolean)
    }))
  };
}

/** The part of a task record every lifecycle view shares. */
function taskCore(record = {}) {
  const verifications = record.verifications ?? [];
  const latest = verifications.at(-1);
  const snapshots = record.snapshots ?? [];
  return dropEmpty({
    id: record.id,
    status: record.status,
    task: record.task,
    risk: record.risk,
    project: record.project ? dropEmpty({ name: record.project.name, path: record.project.path }) : undefined,
    acceptance_criteria: (record.acceptance_criteria ?? []).map(criterionRow),
    checkpoints: (record.checkpoints ?? []).length,
    verification: latest ? dropEmpty({ id: latest.id, passed: latest.passed, at: latest.at }) : undefined,
    // The turns rollback_task can return to: the latest five, enough to undo the last ones.
    snapshots: snapshots.slice(-5).map((snapshot) => dropEmpty({
      snapshot_id: snapshot.snapshot_id,
      turn: snapshot.turn,
      trigger: snapshot.trigger,
      label: snapshot.label === undefined ? undefined : preview(snapshot.label, 120),
      commit: snapshot.commit,
      ref: snapshot.ref,
      available: snapshot.available
    })),
    snapshot_count: snapshots.length > 5 ? snapshots.length : undefined,
    details: DETAILS_HINT
  });
}

/**
 * The fields of a task record a view either replaces or leaves to `get_task`. Anything
 * else the tool put beside the record — a lint result, a warning — stays in the view.
 */
const RECORD_FIELDS = ["schema_version", "created_at", "updated_at", "project", "context", "skills", "baseline",
  "checkpoints", "verifications", "snapshots", "acceptance_criteria", "completion", "plan", "plan_policy"];

function beside(response = {}) {
  return Object.fromEntries(Object.entries(response).filter(([key]) => !RECORD_FIELDS.includes(key)));
}

function criterionRow(criterion = {}) {
  return dropEmpty({
    id: criterion.id,
    text: criterion.text,
    status: criterion.status,
    note: criterion.note,
    evidence: criterion.evidence?.length ? criterion.evidence : undefined
  });
}

/**
 * What `begin_task` answers: the task, its criteria, the context pack and the routed
 * skills — the reason to call it — without the identity, components and baseline
 * the record also keeps.
 *
 * @param {object} record - The task record `begin_task` built.
 * @returns {object}
 */
export function beginTaskView(record = {}) {
  const { checkpoints, snapshots, snapshot_count: count, verification, ...core } = taskCore(record);
  const context = record.context ?? {};
  return dropEmpty({
    ...beside(record),
    ...core,
    plan_policy: record.plan_policy,
    plan: record.plan,
    skills: (record.skills ?? []).map(skillRow),
    context: dropEmpty({
      context_pack_id: context.context_pack_id,
      bounded: context.bounded,
      compiled_context: context.compiled_context,
      selected_files: (context.selected_files ?? []).map((file) => dropEmpty({ path: file.path, score: file.score, reasons: file.reasons })),
      context_unknowns: context.context_unknowns,
      architecture: context.architecture,
      project_brief_path: context.project_brief_path,
      project_map_path: context.project_map_path,
      quality_gate_path: context.quality_gate_path,
      worktree: context.worktree
    }),
    next_actions: record.next_actions
  });
}

/**
 * What `checkpoint_task` answers: the checkpoint just recorded, the snapshot it took,
 * and where every criterion stands.
 *
 * @param {object} response - The record `checkpoint_task` returned, with its `snapshot`.
 * @returns {object}
 */
export function checkpointView(response = {}) {
  return dropEmpty({
    ...beside(response),
    ...taskCore(response),
    checkpoint: (response.checkpoints ?? []).at(-1)
  });
}

/**
 * What `verify_task` answers: each check with its status, and for a check that did
 * not pass, the part of its output that says why.
 *
 * @param {object} response - `{ task, verification, skill_outcomes, current_project_state, ... }`.
 * @returns {object}
 */
export function verifyView(response = {}) {
  const { task, verification, skill_outcomes: outcomes, current_project_state: state, ...rest } = response;
  return dropEmpty({
    ...rest,
    task: taskCore(task),
    verification: verification ? verificationView(verification) : undefined,
    skill_outcomes: outcomes ? outcomeView(outcomes) : undefined,
    current_project_state: state ? projectStateView(state) : undefined
  });
}

/**
 * What `complete_task` answers: the closed task, its pull request and what the
 * completion recorded.
 *
 * @param {object} response - `{ task, report, skill_outcomes, pull_request, next_step, ... }`.
 * @returns {object}
 */
export function completeView(response = {}) {
  const { task, skill_outcomes: outcomes, ...rest } = response;
  const completion = task?.completion;
  return dropEmpty({
    ...rest,
    task: task ? dropEmpty({ ...taskCore(task), completion: completion ? dropEmpty({ at: completion.at, summary: completion.summary }) : undefined }) : undefined,
    skill_outcomes: outcomes ? outcomeView(outcomes) : undefined
  });
}

function verificationView(verification) {
  return dropEmpty({
    id: verification.id,
    at: verification.at,
    passed: verification.passed,
    checks: (verification.checks ?? []).map(checkView),
    evidence: verification.evidence ? dropEmpty({ status: verification.evidence.status, source_head: verification.evidence.source_head, details: verification.evidence.details }) : undefined
  });
}

function checkView(check = {}) {
  const result = check.result;
  if (!result || typeof result !== "object") return check;
  if (check.type === "quality_gate") {
    const { parsed_commands: parsed, selected_commands: selected, diagram_specs: specs, safety, started_at: started, finished_at: finished, project_path: root, ...kept } = result;
    if (!Array.isArray(kept.results)) return { ...check, result: shrink(kept) };
    return {
      ...check,
      result: dropEmpty({
        ...kept,
        results: kept.results.map((run) => {
          const failed = !QUIET_STATUSES.has(run.status);
          return dropEmpty({
            label: run.label,
            command: run.command,
            status: run.status,
            exit_code: run.exit_code,
            hint: run.hint,
            stdout: failed ? clip(run.stdout) : undefined,
            stderr: failed ? clip(run.stderr) : undefined
          });
        })
      })
    };
  }
  if (check.type === "security_scan") {
    const { scanners, findings, project_path: root, semgrep_config: semgrep, ...kept } = result;
    return {
      ...check,
      result: dropEmpty({
        ...shrink(kept),
        findings: shrink(findings),
        scanners: Array.isArray(scanners)
          ? scanners.map((scanner) => dropEmpty({ id: scanner.id, status: scanner.status, reason: scanner.status === "skipped" ? undefined : preview(scanner.reason) }))
          : undefined
      })
    };
  }
  return { ...check, result: shrink(result) };
}

function outcomeView(outcomes) {
  return dropEmpty({
    recorded: outcomes.recorded,
    outcome: outcomes.outcome,
    skills: outcomes.summaries ? Object.keys(outcomes.summaries) : undefined
  });
}

function projectStateView(state) {
  return dropEmpty({ head: state.head, branch: state.branch, dirty: state.dirty, dirty_files: state.dirty_files });
}

/**
 * A value of a shape this module does not know, kept within bounds: long strings are
 * clipped, long lists keep their first twenty items and say how many more there were.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function shrink(value, depth = 0) {
  if (typeof value === "string") return value.length > 2000 ? clip(value, { head: 1000, tail: 600 }) : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, 20).map((item) => shrink(item, depth + 1));
    return value.length > 20 ? [...kept, `… ${value.length - 20} more; include_details: true returns all`] : kept;
  }
  if (value && typeof value === "object") {
    if (depth > 6) return "…";
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, depth + 1)]));
  }
  return value;
}

/**
 * What the usage ledger keeps about one call's size: the bytes of its arguments and
 * of its answer, and short hashes of both — so repeated calls and repeated answers
 * can be told apart without storing either.
 *
 * @param {unknown} args - The tool's arguments.
 * @param {string} answer - The answer's text, or the error's message.
 * @returns {{ bytesIn: number, bytesOut: number, argsHash: string, resultHash: string }}
 */
export function answerMeasures(args, answer) {
  const input = stableJson(args ?? {});
  const output = String(answer ?? "");
  return {
    bytesIn: Buffer.byteLength(input),
    bytesOut: Buffer.byteLength(output),
    argsHash: shortHash(input),
    resultHash: shortHash(output)
  };
}

function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** JSON with every object's keys in order, so the same arguments hash the same. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The object without its undefined, empty-string and empty-array members: they say nothing. */
function dropEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
}

/**
 * Housekeeping for `~/.ai-dev/state` (PLAN.md, stage 3.12).
 *
 * Four things grow without bound and nothing removes them:
 *
 * - **Instincts** that were contradicted down below 0.3 and then never observed
 *   again. They stay in the store, are read on every context build, and mean
 *   nothing.
 * - **Session handoffs and the hook observation logs beside them.** One per
 *   session, forever.
 * - **The usage ledger.** It rotates only when it passes 8 MiB, so a project
 *   that never reaches that keeps every tool call it ever made.
 * - **Task snapshot refs.** `complete_task` deletes a finished task's refs, but
 *   a task that was cancelled, abandoned or reopened elsewhere keeps
 *   `refs/ai-dev/snapshots/<task>/*` for good, and each live ref pins a whole
 *   tree, so `git gc` cannot help (docs/ecc-upgrades/DEBTS.md, Д-14).
 *
 * The shape of the module: what to prune is decided by pure functions over
 * records the caller has already read, and doing it is one function with the
 * stores injected. `dry_run` runs the decisions and none of the writes, so the
 * plan can always be read before anything goes.
 *
 * Nothing here is destructive beyond the state directory and the snapshot refs.
 * Sessions are moved into an `archive/` directory rather than deleted — the
 * readers list `*.json` in the scope directory itself, so an archived record
 * stops being offered and stays on disk. Instincts are retired, not removed:
 * `retired` is a status the store already understands.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pruneTaskSnapshots, resolveTaskWorktree } from "./task-snapshots.mjs";

/** Thresholds from the plan. Every one is overridable per call. */
export const PRUNE_DEFAULTS = Object.freeze({
  /** Retire an instinct whose confidence is under this… */
  instinct_confidence_below: 0.3,
  /** …and which has not been observed for this long. */
  instinct_idle_days: 90,
  /** Archive a session handoff older than this. */
  session_archive_days: 90,
  /** A task that is not complete and has not moved for this long is abandoned. */
  abandoned_task_days: 30,
  /** Lines the usage ledger keeps. */
  usage_keep_lines: 20_000
});

/** Where an archived session record goes, inside its own scope directory. */
export const SESSION_ARCHIVE_DIR = "archive";

function ageDays(timestamp, now) {
  const at = Date.parse(String(timestamp ?? ""));
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return (Date.parse(now) - at) / 86_400_000;
}

/**
 * Instincts that are worth retiring: low confidence *and* silent for a long
 * time. Both conditions are needed — a fresh instinct that starts at 0.3 is
 * a proposal waiting for evidence, not dead weight.
 *
 * A `retired` or `promoted` instinct is already accounted for and is left
 * alone.
 *
 * @param {object[]} instincts
 * @param {{ confidenceBelow?: number, idleDays?: number, now?: string }} [options]
 * @returns {Array<{ id: string, trigger: string, confidence: number, idle_days: number, reason: string }>}
 */
export function instinctsToRetire(instincts, {
  confidenceBelow = PRUNE_DEFAULTS.instinct_confidence_below,
  idleDays = PRUNE_DEFAULTS.instinct_idle_days,
  now = new Date().toISOString()
} = {}) {
  return (Array.isArray(instincts) ? instincts : [])
    .filter((instinct) => ["active", "proposed"].includes(String(instinct?.status ?? "active")))
    .map((instinct) => ({
      instinct,
      confidence: Number(instinct?.confidence ?? 0),
      idle: ageDays(instinct?.last_observed_at || instinct?.updated_at || instinct?.created_at, now)
    }))
    .filter(({ confidence, idle }) => confidence < confidenceBelow && idle >= idleDays)
    .map(({ instinct, confidence, idle }) => ({
      id: String(instinct.id ?? ""),
      trigger: String(instinct.trigger ?? ""),
      confidence,
      idle_days: Number.isFinite(idle) ? Math.round(idle) : -1,
      reason: `confidence ${confidence} is under ${confidenceBelow} and it has not been observed for ${Number.isFinite(idle) ? `${Math.round(idle)} days` : "as long as the store remembers"}.`
    }));
}

/**
 * Which tasks' snapshot refs have nothing left to protect, and why.
 *
 * A completed task is the case `complete_task` already handles; this catches
 * the ones it never sees. "Abandoned" is deliberately about the record's own
 * clock: a task nobody has touched for a month is not being worked on,
 * whatever its status says.
 *
 * @param {object[]} tasks
 * @param {{ abandonedDays?: number, now?: string }} [options]
 * @returns {Array<{ task: object, reason: "completed" | "abandoned", idle_days: number, snapshots: number }>}
 */
export function tasksWithPrunableSnapshots(tasks, {
  abandonedDays = PRUNE_DEFAULTS.abandoned_task_days,
  now = new Date().toISOString()
} = {}) {
  const output = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const live = (Array.isArray(task?.snapshots) ? task.snapshots : []).filter((item) => !item?.deleted_at);
    if (!live.length) continue;
    const idle = ageDays(task?.updated_at || task?.created_at, now);
    if (task?.status === "complete") {
      output.push({ task, reason: "completed", idle_days: Number.isFinite(idle) ? Math.round(idle) : -1, snapshots: live.length });
      continue;
    }
    if (idle >= abandonedDays) {
      output.push({ task, reason: "abandoned", idle_days: Number.isFinite(idle) ? Math.round(idle) : -1, snapshots: live.length });
    }
  }
  return output;
}

/** Session records in one scope directory, with the age of each. */
async function sessionRecordsIn(directory, now) {
  let names;
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    const file = path.join(directory, name);
    let savedAt = "";
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      savedAt = String(parsed?.saved_at ?? parsed?.at ?? parsed?.recorded_at ?? "");
    } catch {
      // A record that cannot be read still has an age, and archiving it is the
      // right move: nothing can use it where it is.
    }
    if (!Date.parse(savedAt)) {
      const stats = await fs.stat(file).catch(() => null);
      savedAt = stats ? new Date(stats.mtimeMs).toISOString() : "";
    }
    records.push({ name, file, saved_at: savedAt, age_days: ageDays(savedAt, now), kind: name.startsWith("observe-") ? "observation" : "handoff" });
  }
  return records;
}

/**
 * Session records old enough to archive, across every scope directory under
 * `state/sessions`. The newest handoff of each scope is always kept: that is
 * the one `resume_session` reads, and a project nobody has touched for a year
 * is exactly the one whose handoff is worth most.
 *
 * @param {string} sessionsRoot - `state/sessions`.
 * @param {{ archiveDays?: number, now?: string }} [options]
 * @returns {Promise<Array<{ scope: string, name: string, file: string, age_days: number, kind: string }>>}
 */
export async function sessionsToArchive(sessionsRoot, {
  archiveDays = PRUNE_DEFAULTS.session_archive_days,
  now = new Date().toISOString()
} = {}) {
  let scopes;
  try {
    scopes = (await fs.readdir(sessionsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const output = [];
  for (const scope of scopes) {
    const directory = path.join(sessionsRoot, scope.name);
    const records = await sessionRecordsIn(directory, now);
    const newestHandoff = records
      .filter((record) => record.kind === "handoff")
      .sort((left, right) => left.age_days - right.age_days)[0];
    for (const record of records) {
      if (record.age_days < archiveDays) continue;
      if (newestHandoff && record.name === newestHandoff.name) continue;
      output.push({ scope: scope.name, ...record });
    }
  }
  return output;
}

async function archiveSessionRecords(records) {
  const moved = [];
  const failed = [];
  for (const record of records) {
    const target = path.join(path.dirname(record.file), SESSION_ARCHIVE_DIR, record.name);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(record.file, target);
      moved.push(target);
    } catch (error) {
      failed.push({ file: record.file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { moved, failed };
}

/**
 * Prune the state directory.
 *
 * The four areas are independent: one that fails is reported and the others
 * still run, because a state directory that cannot be tidied at all is worse
 * than one that was tidied in three places out of four.
 *
 * @param {object} input
 * @param {string} input.projectPath - Scopes the task sweep to one project.
 * @param {object} input.taskStore
 * @param {object} input.instinctStore
 * @param {object} input.usageLedger
 * @param {string} input.sessionsRoot
 * @param {Function} [input.resolveProjectIdentity]
 * @param {boolean} [input.dryRun]
 * @param {object} [input.thresholds] - Overrides for {@link PRUNE_DEFAULTS}.
 * @param {string} [input.now]
 * @returns {Promise<object>}
 */
export async function pruneState({
  projectPath,
  taskStore,
  instinctStore,
  usageLedger,
  sessionsRoot,
  resolveProjectIdentity,
  dryRun = true,
  thresholds = {},
  now = new Date().toISOString()
}) {
  const limits = { ...PRUNE_DEFAULTS, ...thresholds };
  const problems = [];
  const guard = async (area, work) => {
    try {
      return await work();
    } catch (error) {
      problems.push(`${area}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const instincts = await guard("instincts", async () => {
    const store = await instinctStore.read();
    const candidates = instinctsToRetire(store.instincts, {
      confidenceBelow: limits.instinct_confidence_below,
      idleDays: limits.instinct_idle_days,
      now
    });
    if (candidates.length && !dryRun) {
      const wanted = new Set(candidates.map((item) => item.id));
      await instinctStore.update((current) => {
        for (const instinct of current.instincts ?? []) {
          if (!wanted.has(String(instinct.id ?? ""))) continue;
          instinct.status = "retired";
          instinct.retired_at = now;
          instinct.retired_reason = "prune_state: low confidence and no recent observation";
        }
        return current;
      });
    }
    return { total: (store.instincts ?? []).length, retired: candidates.length, entries: candidates };
  });

  const sessions = await guard("sessions", async () => {
    const candidates = await sessionsToArchive(sessionsRoot, { archiveDays: limits.session_archive_days, now });
    const applied = dryRun ? { moved: [], failed: [] } : await archiveSessionRecords(candidates);
    for (const failure of applied.failed) problems.push(`sessions: ${failure.file}: ${failure.error}`);
    return {
      archived: dryRun ? candidates.length : applied.moved.length,
      archive_dir: SESSION_ARCHIVE_DIR,
      entries: candidates.map(({ scope, name, age_days: age, kind }) => ({ scope, name, age_days: Math.round(age), kind }))
    };
  });

  const usage = await guard("usage", async () => (
    dryRun
      ? { ...await usageLedger.rotationPlan(limits.usage_keep_lines), applied: false }
      : { ...await usageLedger.rotate(limits.usage_keep_lines), applied: true }
  ));

  const snapshots = await guard("snapshots", async () => {
    const tasks = await taskStore.list({ projectPath, limit: 5000 });
    const candidates = tasksWithPrunableSnapshots(tasks, { abandonedDays: limits.abandoned_task_days, now });
    const entries = [];
    let deleted = 0;
    for (const candidate of candidates) {
      const entry = {
        task_id: String(candidate.task.id ?? ""),
        status: String(candidate.task.status ?? ""),
        reason: candidate.reason,
        idle_days: candidate.idle_days,
        snapshots: candidate.snapshots
      };
      if (dryRun) {
        entries.push({ ...entry, result: "planned" });
        continue;
      }
      const worktreePath = await resolveTaskWorktree({ record: candidate.task, resolveProjectIdentity }).catch(() => "");
      const result = await pruneTaskSnapshots({
        taskStore,
        record: candidate.task,
        worktreePath,
        reason: candidate.reason
      }).catch((error) => ({ status: "skipped", deleted: 0, reason: error instanceof Error ? error.message : String(error) }));
      deleted += Number(result.deleted ?? 0);
      if (result.status === "skipped") problems.push(`snapshots: ${entry.task_id}: ${result.reason}`);
      entries.push({ ...entry, result: result.status });
    }
    return { tasks_pruned: candidates.length, refs_deleted: dryRun ? 0 : deleted, entries };
  });

  return {
    project_path: projectPath,
    dry_run: Boolean(dryRun),
    thresholds: limits,
    instincts: instincts ?? { total: 0, retired: 0, entries: [] },
    sessions: sessions ?? { archived: 0, archive_dir: SESSION_ARCHIVE_DIR, entries: [] },
    usage: usage ?? { lines: 0, removed: 0, applied: false },
    snapshots: snapshots ?? { tasks_pruned: 0, refs_deleted: 0, entries: [] },
    problems
  };
}

/**
 * The prune as the report an agent reads.
 *
 * @param {object} result - From {@link pruneState}.
 * @returns {string}
 */
export function renderPruneStateMarkdown(result) {
  const verb = result.dry_run ? "would be" : "was";
  const lines = [
    `# State prune${result.dry_run ? " (dry run)" : ""}`,
    "",
    `- Instincts: ${result.instincts.retired} of ${result.instincts.total} ${verb} retired (under ${result.thresholds.instinct_confidence_below} confidence, idle ${result.thresholds.instinct_idle_days}+ days).`,
    `- Sessions: ${result.sessions.archived} record(s) ${verb} moved to \`${result.sessions.archive_dir}/\` (older than ${result.thresholds.session_archive_days} days).`,
    `- Usage ledger: ${result.usage.removed} line(s) ${verb} dropped, keeping the newest ${result.thresholds.usage_keep_lines}.`,
    `- Task snapshots: ${result.snapshots.tasks_pruned} task(s) ${verb} cleared${result.dry_run ? "" : `, ${result.snapshots.refs_deleted} snapshot(s) deleted`}.`
  ];
  if (result.snapshots.entries.length) {
    lines.push("", "## Snapshot refs", "");
    for (const entry of result.snapshots.entries) {
      lines.push(`- ${entry.task_id} (${entry.status}, idle ${entry.idle_days}d): ${entry.reason}, ${entry.snapshots} snapshot(s) — ${entry.result}`);
    }
  }
  if (result.problems.length) {
    lines.push("", "## Problems", "");
    for (const problem of result.problems) lines.push(`- ${problem}`);
  }
  return `${lines.join("\n")}\n`;
}

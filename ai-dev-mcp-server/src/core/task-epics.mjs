/**
 * Epics: one task broken into children, with an order between them.
 *
 * ECC coordinates epics through GitHub Issues and labels (`epic-decompose`,
 * `epic-claim`, `epic-sync`, `config/github-native-coordination.json`). None of
 * that is ported: this server works offline and already owns task tracking, so
 * what comes over is the shape — a parent, its children, a `depends_on` edge
 * between siblings, and a parent that cannot close while a child is open.
 *
 * Everything here is pure. The tools in `src/extensions/epics.mjs` create the
 * children and read them back; the rules about what may depend on what, and
 * what is ready to work on, are decided here so they can be read and tested
 * without a task store.
 */

/** Most children one decomposition may create. Past this it is a backlog, not a task. */
export const MAX_SUBTASKS = 20;

/** What a child can be, from the epic's point of view. */
export const EPIC_CHILD_STATES = Object.freeze(["complete", "in_progress", "ready", "blocked"]);

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Read the `subtasks` argument into a checked list.
 *
 * A subtask is `{ task, key?, acceptance_criteria?, depends_on? }`, or a bare
 * string when it has neither criteria nor dependencies. `key` names it for
 * other subtasks to depend on; without one, its 1-based position is its name.
 *
 * @param {Array<object | string>} subtasks
 * @returns {Array<{ key: string, task: string, acceptance_criteria: string[], depends_on: string[] }>}
 */
export function normalizeSubtasks(subtasks) {
  const list = Array.isArray(subtasks) ? subtasks : [];
  if (!list.length) throw new Error("subtasks is required: give at least one child task.");
  if (list.length > MAX_SUBTASKS) throw new Error(`A task may be decomposed into at most ${MAX_SUBTASKS} children; ${list.length} were given.`);
  const normalized = list.map((item, index) => {
    const source = typeof item === "string" ? { task: item } : item ?? {};
    const task = text(source.task);
    if (!task) throw new Error(`Subtask ${index + 1} has no task text.`);
    return {
      key: text(source.key) || String(index + 1),
      task,
      acceptance_criteria: (Array.isArray(source.acceptance_criteria) ? source.acceptance_criteria : []).map(text).filter(Boolean),
      depends_on: (Array.isArray(source.depends_on) ? source.depends_on : source.depends_on ? [source.depends_on] : []).map(text).filter(Boolean)
    };
  });
  const keys = new Set();
  for (const item of normalized) {
    if (keys.has(item.key)) throw new Error(`Duplicate subtask key: ${item.key}`);
    keys.add(item.key);
  }
  return normalized;
}

/**
 * Check every `depends_on` reference and refuse an order that cannot be worked:
 * a name nobody carries, a subtask waiting for itself, or a ring of subtasks
 * each waiting for the next.
 *
 * References are matched by key, and a subtask's position is its key when it
 * was not given one.
 *
 * @param {ReturnType<typeof normalizeSubtasks>} subtasks
 * @returns {Map<string, string[]>} Key to the keys it waits for.
 */
export function resolveSubtaskDependencies(subtasks) {
  const byKey = new Map(subtasks.map((item, index) => [item.key, index]));
  const edges = new Map();
  for (const item of subtasks) {
    const dependencies = [];
    for (const reference of item.depends_on) {
      if (!byKey.has(reference)) {
        throw new Error(`Subtask "${item.key}" depends on "${reference}", which is not one of: ${[...byKey.keys()].join(", ")}.`);
      }
      if (reference === item.key) throw new Error(`Subtask "${item.key}" depends on itself.`);
      if (!dependencies.includes(reference)) dependencies.push(reference);
    }
    edges.set(item.key, dependencies);
  }
  const cycle = findCycle(edges);
  if (cycle) throw new Error(`Subtask dependencies form a cycle: ${cycle.join(" -> ")}. Nothing in it could ever start.`);
  return edges;
}

/** The first cycle in a dependency graph, as the path that closes it, or null. */
function findCycle(edges) {
  const state = new Map();
  const stack = [];
  function walk(key) {
    if (state.get(key) === "done") return null;
    if (state.get(key) === "open") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "open");
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(key, "done");
    return null;
  }
  for (const key of edges.keys()) {
    const found = walk(key);
    if (found) return found;
  }
  return null;
}

/**
 * What a child is, given the siblings it waits for: done, waiting on one of
 * them, already under way, or free to start.
 *
 * @param {{ status: string, depends_on?: string[], checkpoints?: unknown[], verifications?: unknown[] }} child
 * @param {Map<string, string>} statusById - Every sibling's status.
 * @returns {"complete" | "blocked" | "in_progress" | "ready"}
 */
export function epicChildState(child, statusById) {
  if (child.status === "complete") return "complete";
  const waiting = (child.depends_on ?? []).filter((id) => statusById.get(id) !== "complete");
  if (waiting.length) return "blocked";
  if ((child.checkpoints?.length ?? 0) > 0 || (child.verifications?.length ?? 0) > 0) return "in_progress";
  return "ready";
}

/**
 * The epic's state: every child with what it is waiting for, how far the whole
 * thing has come, and the one child to work on next.
 *
 * Children are reported in the order they were created, which is the order the
 * decomposition listed them. `missing` names ids the parent still points at and
 * the store no longer has.
 *
 * @param {{ children: Array<object>, missing?: string[] }} input
 * @returns {object}
 */
export function epicProgress({ children = [], missing = [] } = {}) {
  const statusById = new Map(children.map((child) => [child.id, child.status]));
  const rows = children.map((child) => {
    const state = epicChildState(child, statusById);
    const blockedBy = (child.depends_on ?? []).filter((id) => statusById.get(id) !== "complete");
    return {
      id: child.id,
      task: child.task,
      status: child.status,
      state,
      depends_on: child.depends_on ?? [],
      blocked_by: blockedBy,
      criteria_met: (child.acceptance_criteria ?? []).filter((item) => item.status === "met").length,
      criteria_total: (child.acceptance_criteria ?? []).length,
      checkpoints: child.checkpoints?.length ?? 0
    };
  });
  const counts = { complete: 0, in_progress: 0, ready: 0, blocked: 0 };
  for (const row of rows) counts[row.state] += 1;
  const next = rows.find((row) => row.state === "in_progress") ?? rows.find((row) => row.state === "ready") ?? null;
  return {
    total: rows.length,
    ...counts,
    percent: rows.length ? Number(((counts.complete / rows.length) * 100).toFixed(1)) : 0,
    children: rows,
    missing: [...missing],
    next: next ? { id: next.id, task: next.task, state: next.state } : null,
    // A ring of blocked children with nothing ready is the shape a bad plan
    // takes after the fact: every remaining child waits for a sibling that is
    // itself waiting, and no order of work gets any of them started.
    deadlocked: rows.length > 0 && counts.complete < rows.length && counts.ready === 0 && counts.in_progress === 0
  };
}

/**
 * Why an epic cannot be completed yet: the children that are still open, and
 * the ids it points at that no longer exist.
 *
 * @param {{ children: Array<object>, missing?: string[] }} input
 * @returns {string[]}
 */
export function epicCompletionBlockers({ children = [], missing = [] } = {}) {
  const blockers = children
    .filter((child) => child.status !== "complete")
    .map((child) => `${child.id} (${child.status}): ${child.task}`);
  for (const id of missing) blockers.push(`${id}: the child task record is gone; nothing proves it was finished.`);
  return blockers;
}

/**
 * Markdown for a report or a checkpoint note.
 *
 * @param {{ id: string, task: string }} parent
 * @param {ReturnType<typeof epicProgress>} progress
 * @returns {string}
 */
export function renderEpicMarkdown(parent, progress) {
  const label = { complete: "Done", in_progress: "In progress", ready: "Ready", blocked: "Blocked" };
  const lines = [
    `# Epic ${parent.id}`,
    "",
    parent.task,
    "",
    `${progress.complete} of ${progress.total} children complete (${progress.percent}%).`,
    ""
  ];
  if (!progress.total) {
    lines.push("- No children. `decompose_task` creates them.");
    return lines.join("\n");
  }
  lines.push("| Child | State | Criteria | Waiting for |", "| --- | --- | --- | --- |");
  for (const child of progress.children) {
    lines.push(`| \`${child.id}\` ${child.task} | ${label[child.state] || child.state} | ${child.criteria_met}/${child.criteria_total} | ${child.blocked_by.join(", ") || "—"} |`);
  }
  if (progress.missing.length) lines.push("", `Missing child records: ${progress.missing.join(", ")}.`);
  if (progress.next) lines.push("", `Next: \`${progress.next.id}\` — ${progress.next.task}`);
  return lines.join("\n");
}

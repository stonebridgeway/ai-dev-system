/**
 * The work at a glance, for the desktop app's first screen and
 * `workspace_overview`: the registered projects, the tasks open and lately
 * finished, the epics and how far each has come, the latest decisions, and
 * what the work has cost. Everything here is read from what the other tools
 * already keep; nothing is written.
 */
import { listDecisions } from "./decision-ledger.mjs";

const firstLine = (text, limit = 200) => String(text ?? "").split(/\r?\n/, 1)[0].trim().slice(0, limit);

/** One task as the overview lists it. */
function taskRow(record) {
  return {
    task_id: record.id,
    title: firstLine(record.task),
    status: record.status,
    project: record.project?.name ?? "",
    updated_at: record.updated_at ?? ""
  };
}

/**
 * @param {object} sources
 * @param {() => Promise<Array<object>>} sources.projects - Project cards (`projectSummaries`).
 * @param {(options: object) => Promise<Array<object>>} sources.tasks - The task store's `list`.
 * @param {(args: object) => Promise<object>} sources.usage - `usage_report`.
 * @param {(root: string, options: object) => Promise<Array<object>>} [sources.decisions] - Per project root.
 * @param {{ limit?: number }} [options] - How many tasks, epics and decisions to list.
 * @returns {Promise<object>} As `CONTROL_RESULTS.workspace_overview`.
 */
export async function workspaceOverview({ projects, tasks, usage, decisions = listDecisions }, { limit = 10 } = {}) {
  const shown = Math.max(1, Math.min(Number(limit) || 10, 100));
  const [cards, records, report] = await Promise.all([
    projects().catch(() => []),
    tasks({ limit: 5000 }).catch(() => []),
    usage({}).catch(() => null)
  ]);
  const byId = new Map(records.map((record) => [record.id, record]));
  const open = records.filter((record) => record.status !== "complete");
  const finished = records.filter((record) => record.status === "complete");
  const epics = records
    .filter((record) => record.epic?.children?.length)
    .slice(0, shown)
    .map((record) => {
      const children = record.epic.children.map((id) => byId.get(id)).filter(Boolean);
      return {
        epic_id: record.id,
        title: firstLine(record.task),
        status: record.status,
        children: record.epic.children.length,
        done: children.filter((child) => child.status === "complete").length
      };
    });
  const latest = [];
  for (const card of cards) {
    const root = card.canonical_path || card.project_path;
    if (!root) continue;
    for (const record of await decisions(root, { limit: shown }).catch(() => [])) {
      latest.push({ id: record.id, title: record.title, status: record.status, date: record.date, project: card.name });
    }
  }
  latest.sort((left, right) => String(right.date).localeCompare(String(left.date)));
  return {
    projects: cards.map((card) => ({
      id: card.project_id || card.slug || card.name,
      name: card.name,
      root: card.canonical_path || card.project_path || "",
      stack: card.stack ?? [],
      updated_at: card.updated ?? ""
    })),
    tasks: { active: open.slice(0, shown).map(taskRow), recent: finished.slice(0, shown).map(taskRow) },
    epics,
    decisions: latest.slice(0, shown),
    usage: {
      events: Number(report?.events ?? 0),
      tool_calls: Number(report?.tool_calls ?? 0),
      cost_usd: Number(report?.usage?.cost_usd ?? 0),
      today_cost_usd: Number(report?.periods?.today?.cost_usd ?? 0),
      last_7_days_cost_usd: Number(report?.periods?.last_7_days?.cost_usd ?? 0)
    }
  };
}

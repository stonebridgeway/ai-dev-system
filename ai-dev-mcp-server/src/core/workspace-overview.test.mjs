import assert from "node:assert/strict";
import test from "node:test";
import { markServingDaemon, servingProcess } from "./serving-process.mjs";
import { workspaceOverview } from "./workspace-overview.mjs";

const task = (id, status, extra = {}) => ({ id, task: `${id} title\nsecond line`, status, project: { name: "web" }, updated_at: `2026-10-0${id.length}`, ...extra });

test("the overview lists open and finished tasks, epics with how far each has come, the latest decisions and the cost", async () => {
  const records = [
    task("t1", "in_progress"),
    task("t2", "complete"),
    task("t3", "complete"),
    task("e1", "in_progress", { epic: { children: ["t2", "t3", "t1", "gone"] } })
  ];
  const overview = await workspaceOverview({
    projects: async () => [{ project_id: "p-1", name: "web", canonical_path: "/work/web", stack: ["Node.js"], updated: "2026-10-01" }, { name: "no root" }],
    tasks: async ({ limit }) => {
      assert.equal(limit, 5000);
      return records;
    },
    usage: async () => ({ events: 4, tool_calls: 9, usage: { cost_usd: 1.5 }, periods: { today: { cost_usd: 0.25 }, last_7_days: { cost_usd: 1.25 } } }),
    decisions: async (root, { limit }) => {
      assert.equal(root, "/work/web");
      assert.equal(limit, 2);
      return [{ id: "D-1", title: "Use SQLite", status: "accepted", date: "2026-10-01" }, { id: "D-2", title: "Drop Python", status: "accepted", date: "2026-10-05" }];
    }
  }, { limit: 2 });
  assert.deepEqual(overview.projects, [
    { id: "p-1", name: "web", root: "/work/web", stack: ["Node.js"], updated_at: "2026-10-01" },
    { id: "no root", name: "no root", root: "", stack: [], updated_at: "" }
  ]);
  assert.deepEqual(overview.tasks.active.map((row) => [row.task_id, row.title, row.project]), [["t1", "t1 title", "web"], ["e1", "e1 title", "web"]]);
  assert.deepEqual(overview.tasks.recent.map((row) => row.task_id), ["t2", "t3"]);
  assert.deepEqual(overview.epics, [{ epic_id: "e1", title: "e1 title", status: "in_progress", children: 4, done: 2 }]);
  assert.deepEqual(overview.decisions.map((row) => [row.id, row.project]), [["D-2", "web"], ["D-1", "web"]], "the latest first");
  assert.deepEqual(overview.usage, { events: 4, tool_calls: 9, cost_usd: 1.5, today_cost_usd: 0.25, last_7_days_cost_usd: 1.25 });
});

test("a source that fails leaves its part empty instead of failing the overview", async () => {
  const failing = async () => {
    throw new Error("unavailable");
  };
  const overview = await workspaceOverview({ projects: failing, tasks: failing, usage: failing, decisions: failing }, { limit: 0 });
  assert.deepEqual(overview, {
    projects: [],
    tasks: { active: [], recent: [] },
    epics: [],
    decisions: [],
    usage: { events: 0, tool_calls: 0, cost_usd: 0, today_cost_usd: 0, last_7_days_cost_usd: 0 }
  });
});

test("the serving process says whether a daemon answers, and how busy it is", () => {
  assert.deepEqual(servingProcess(), { kind: "process", pid: process.pid });
  let sessions = 2;
  markServingDaemon({ build: "abcd", startedAt: "2026-10-12T00:00:00.000Z", idleTimeoutMs: 60_000, sessions: () => sessions });
  sessions = 3;
  assert.deepEqual(servingProcess(), { kind: "daemon", pid: process.pid, build: "abcd", sessions: 3, started_at: "2026-10-12T00:00:00.000Z", idle_timeout_ms: 60_000 });
  // A fraction in the variable is still a whole number in the answer, as the contract says.
  markServingDaemon({ build: "abcd", startedAt: "2026-10-12T00:00:00.000Z", idleTimeoutMs: 60_000.5, sessions: () => 0 });
  assert.equal(servingProcess().idle_timeout_ms, 60_001);
});

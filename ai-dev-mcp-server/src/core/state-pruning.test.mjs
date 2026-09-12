import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRUNE_DEFAULTS,
  SESSION_ARCHIVE_DIR,
  instinctsToRetire,
  pruneState,
  renderPruneStateMarkdown,
  sessionsToArchive,
  tasksWithPrunableSnapshots
} from "./state-pruning.mjs";

const NOW = "2026-09-12T00:00:00.000Z";
const daysAgo = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

test("an instinct is retired only when it is both weak and silent", () => {
  const instincts = [
    { id: "weak-and-old", trigger: "when x", confidence: 0.2, last_observed_at: daysAgo(200), status: "active" },
    { id: "weak-but-fresh", trigger: "when y", confidence: 0.2, last_observed_at: daysAgo(3), status: "active" },
    { id: "strong-and-old", trigger: "when z", confidence: 0.8, last_observed_at: daysAgo(400), status: "active" },
    { id: "proposed-and-old", trigger: "when w", confidence: 0.29, last_observed_at: daysAgo(120), status: "proposed" },
    { id: "already-retired", trigger: "when v", confidence: 0.1, last_observed_at: daysAgo(500), status: "retired" },
    { id: "promoted", trigger: "when u", confidence: 0.1, last_observed_at: daysAgo(500), status: "promoted" },
    { id: "no-timestamps", trigger: "when t", confidence: 0.1, status: "active" }
  ];
  const retired = instinctsToRetire(instincts, { now: NOW });
  assert.deepEqual(retired.map((item) => item.id), ["weak-and-old", "proposed-and-old", "no-timestamps"]);
  assert.match(retired[0].reason, /confidence 0\.2 is under 0\.3 and it has not been observed for 200 days/);
  assert.match(retired[2].reason, /as long as the store remembers/);
  assert.equal(retired[2].idle_days, -1);

  // The thresholds are the plan's, and both are movable.
  assert.equal(PRUNE_DEFAULTS.instinct_confidence_below, 0.3);
  assert.equal(PRUNE_DEFAULTS.instinct_idle_days, 90);
  assert.deepEqual(instinctsToRetire(instincts, { now: NOW, idleDays: 1 }).map((item) => item.id), ["weak-and-old", "weak-but-fresh", "proposed-and-old", "no-timestamps"]);
  assert.deepEqual(instinctsToRetire(instincts, { now: NOW, confidenceBelow: 0.9 }).map((item) => item.id).includes("strong-and-old"), true);
  assert.deepEqual(instinctsToRetire(null), []);
});

// Д-14: complete_task deletes a finished task's refs. Nothing deletes the refs
// of a task that was cancelled, abandoned, or reopened as another task, and a
// live ref pins a whole tree.
test("snapshot refs go for completed tasks and for tasks nobody has touched", () => {
  const snapshot = (sequence, deleted = false) => ({ sequence, deleted_at: deleted ? daysAgo(1) : undefined });
  const tasks = [
    { id: "task-done", status: "complete", updated_at: daysAgo(1), snapshots: [snapshot(1), snapshot(2)] },
    { id: "task-abandoned", status: "active", updated_at: daysAgo(45), snapshots: [snapshot(1)] },
    { id: "task-working", status: "active", updated_at: daysAgo(2), snapshots: [snapshot(1)] },
    { id: "task-already-pruned", status: "complete", updated_at: daysAgo(90), snapshots: [snapshot(1, true)] },
    { id: "task-no-snapshots", status: "active", updated_at: daysAgo(400) }
  ];
  const prunable = tasksWithPrunableSnapshots(tasks, { now: NOW });
  assert.deepEqual(prunable.map((item) => [item.task.id, item.reason]), [
    ["task-done", "completed"],
    ["task-abandoned", "abandoned"]
  ]);
  assert.equal(prunable[0].snapshots, 2);
  assert.equal(prunable[1].idle_days, 45);
  assert.deepEqual(tasksWithPrunableSnapshots(tasks, { now: NOW, abandonedDays: 1 }).map((item) => item.task.id), ["task-done", "task-abandoned", "task-working"]);
  assert.deepEqual(tasksWithPrunableSnapshots(undefined), []);
});

async function sessionFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prune-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sessions = path.join(root, "sessions");
  const write = async (scope, name, body) => {
    await fs.mkdir(path.join(sessions, scope), { recursive: true });
    await fs.writeFile(path.join(sessions, scope, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
  };
  await write("repo-a", "session-old.json", { saved_at: daysAgo(200) });
  await write("repo-a", "session-older.json", { saved_at: daysAgo(400) });
  await write("repo-a", "session-recent.json", { saved_at: daysAgo(2) });
  await write("repo-a", "observe-old.json", { at: daysAgo(300) });
  await write("repo-a", "notes.txt", "not a record");
  // A scope whose only handoff is ancient: it is the one resume_session reads,
  // so it stays.
  await write("repo-b", "session-only.json", { saved_at: daysAgo(700) });
  // A record that cannot be parsed still has an age: the file's own mtime.
  await write("repo-c", "session-broken.json", "{ not json");
  const stale = new Date(Date.parse(daysAgo(300)));
  await fs.utimes(path.join(sessions, "repo-c", "session-broken.json"), stale, stale);
  await write("repo-c", "session-keeper.json", { saved_at: daysAgo(1) });
  return { root, sessions };
}

test("old session records are archived, and the newest handoff of a scope never is", async (t) => {
  const { sessions } = await sessionFixture(t);
  const candidates = await sessionsToArchive(sessions, { now: NOW });
  assert.deepEqual(candidates.map((item) => `${item.scope}/${item.name}`).sort(), [
    "repo-a/observe-old.json",
    "repo-a/session-old.json",
    "repo-a/session-older.json",
    "repo-c/session-broken.json"
  ]);
  assert.equal(candidates.find((item) => item.name === "observe-old.json").kind, "observation");
  assert.deepEqual(await sessionsToArchive(path.join(sessions, "nope"), { now: NOW }), []);

  // The unparsable record was aged from the file's own mtime — nothing can use
  // it where it is — while the scope's readable handoff is the newest and stays
  // at any window.
  const aggressive = await sessionsToArchive(sessions, { now: NOW, archiveDays: 0 });
  assert.equal(aggressive.some((item) => item.name === "session-keeper.json"), false);
  assert.equal(aggressive.some((item) => item.name === "session-only.json"), false, "repo-b's only handoff is the one resume_session reads");
  assert.equal(aggressive.some((item) => item.name === "notes.txt"), false, "only .json records are session records");
});

function createStores({ instincts = [], tasks = [], ledgerLines = 0 } = {}) {
  const calls = [];
  const store = { schema_version: 1, instincts: structuredClone(instincts) };
  return {
    calls,
    store,
    instinctStore: {
      read: async () => structuredClone(store),
      update: async (mutator) => {
        const next = await mutator(store);
        calls.push(["instinct-update", next.instincts.map((item) => [item.id, item.status])]);
        return next;
      }
    },
    taskStore: {
      list: async (args) => { calls.push(["task-list", args]); return structuredClone(tasks); },
      update: async (id, mutate) => { calls.push(["task-update", id]); return mutate({ id, snapshots: [] }); }
    },
    usageLedger: {
      rotationPlan: async (keep) => ({ lines: ledgerLines, kept: Math.min(ledgerLines, keep), removed: Math.max(0, ledgerLines - keep) }),
      rotate: async (keep) => { calls.push(["ledger-rotate", keep]); return { lines: ledgerLines, kept: Math.min(ledgerLines, keep), removed: Math.max(0, ledgerLines - keep) }; }
    }
  };
}

test("a dry run decides everything and writes nothing", async (t) => {
  const { sessions } = await sessionFixture(t);
  const stores = createStores({
    instincts: [{ id: "weak", trigger: "when x", confidence: 0.1, last_observed_at: daysAgo(200), status: "active" }],
    tasks: [{ id: "task-abandoned", status: "active", updated_at: daysAgo(60), snapshots: [{ sequence: 1 }] }],
    ledgerLines: 25_000
  });
  const result = await pruneState({
    projectPath: "/repo/atlas",
    ...stores,
    sessionsRoot: sessions,
    dryRun: true,
    now: NOW
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.instincts.retired, 1);
  assert.equal(result.sessions.archived, 4);
  assert.equal(result.usage.removed, 5_000);
  assert.equal(result.usage.applied, false);
  assert.equal(result.snapshots.tasks_pruned, 1);
  assert.equal(result.snapshots.refs_deleted, 0);
  assert.equal(result.snapshots.entries[0].result, "planned");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    stores.calls.filter(([name]) => name !== "task-list"),
    [],
    "a dry run touches no store"
  );
  // Nothing moved on disk either.
  assert.equal((await fs.readdir(path.join(sessions, "repo-a"))).includes("session-old.json"), true);

  const markdown = renderPruneStateMarkdown(result);
  assert.match(markdown, /^# State prune \(dry run\)/);
  assert.match(markdown, /Instincts: 1 of 1 would be retired/);
  assert.match(markdown, /Usage ledger: 5000 line\(s\) would be dropped, keeping the newest 20000/);
  assert.match(markdown, /task-abandoned \(active, idle 60d\): abandoned, 1 snapshot\(s\) — planned/);
});

test("a real run retires, archives, rotates and deletes, and keeps going when one area fails", async (t) => {
  const { sessions } = await sessionFixture(t);
  const stores = createStores({
    instincts: [
      { id: "weak", trigger: "when x", confidence: 0.1, last_observed_at: daysAgo(200), status: "active" },
      { id: "strong", trigger: "when y", confidence: 0.8, last_observed_at: daysAgo(200), status: "active" }
    ],
    // The task's project path is not a repository here, so pruneTaskSnapshots
    // cannot delete its refs. That is reported, and the other three areas still
    // run — a state directory tidied in three places out of four beats one
    // tidied nowhere.
    tasks: [{ id: "task-abandoned", status: "active", updated_at: daysAgo(60), snapshots: [{ sequence: 1 }], project: { path: path.join(sessions, "not-a-repo") } }],
    ledgerLines: 30_000
  });
  const result = await pruneState({
    projectPath: "",
    ...stores,
    sessionsRoot: sessions,
    dryRun: false,
    now: NOW
  });

  assert.deepEqual(
    stores.calls.find(([name]) => name === "instinct-update")[1],
    [["weak", "retired"], ["strong", "active"]]
  );
  assert.ok(stores.calls.some(([name, keep]) => name === "ledger-rotate" && keep === 20_000));
  assert.equal(result.usage.removed, 10_000);
  assert.equal(result.usage.applied, true);

  // The archive is a directory beside the records, so nothing is lost and the
  // readers (which list *.json in the scope directory) stop offering them.
  const remaining = await fs.readdir(path.join(sessions, "repo-a"));
  assert.deepEqual(remaining.filter((name) => name.endsWith(".json")), ["session-recent.json"]);
  assert.deepEqual(
    (await fs.readdir(path.join(sessions, "repo-a", SESSION_ARCHIVE_DIR))).sort(),
    ["observe-old.json", "session-old.json", "session-older.json"]
  );
  assert.equal(result.sessions.archived, 4);

  assert.equal(result.snapshots.tasks_pruned, 1);
  assert.equal(result.snapshots.entries[0].result, "skipped");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^snapshots: task-abandoned: /);
  assert.match(renderPruneStateMarkdown(result), /## Problems/);
});

test("a store that throws is a problem, not a crash", async (t) => {
  const { sessions } = await sessionFixture(t);
  const stores = createStores();
  stores.instinctStore.read = async () => { throw new Error("instincts.json is not JSON"); };
  stores.usageLedger.rotationPlan = async () => { throw new Error("no ledger"); };
  stores.taskStore.list = async () => { throw new Error("state root is gone"); };
  const result = await pruneState({ projectPath: "", ...stores, sessionsRoot: sessions, dryRun: true, now: NOW });
  assert.deepEqual(result.problems, [
    "instincts: instincts.json is not JSON",
    "usage: no ledger",
    "snapshots: state root is gone"
  ]);
  assert.deepEqual(result.instincts, { total: 0, retired: 0, entries: [] });
  assert.equal(result.sessions.archived, 4, "the area that worked still ran");
});

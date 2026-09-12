import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createStateTools } from "./state.mjs";

async function createFixture(t, { tasks = [], instincts = [] } = {}) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "state-ext-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const calls = [];
  const host = {
    taskStateRoot: stateRoot,
    resolveProjectIdentity: async (value) => ({ project_root: `/resolved${value}`, requested: value }),
    taskStore: {
      list: async (args) => { calls.push(["list", args]); return structuredClone(tasks); },
      update: async (id, mutate) => mutate({ id, snapshots: [] })
    },
    instinctStore: {
      read: async () => ({ instincts: structuredClone(instincts) }),
      update: async (mutator) => { const next = await mutator({ instincts: structuredClone(instincts) }); calls.push(["instinct-update", next.instincts.length]); return next; }
    },
    usageLedger: {
      rotationPlan: async () => ({ lines: 10, kept: 10, removed: 0 }),
      rotate: async () => { calls.push(["rotate"]); return { lines: 10, kept: 10, removed: 0 }; }
    }
  };
  return { registry: createExtensionTools(host, [createStateTools]), calls, stateRoot };
}

const call = (registry, args) => registry.handlers.get("prune_state")(args);

test("prune_state is a dry run unless it is told otherwise", async (t) => {
  const { registry, calls } = await createFixture(t);
  const planned = await call(registry, {});
  assert.equal(planned.dry_run, true);
  assert.equal(calls.some(([name]) => name === "rotate"), false);
  assert.match(planned.next_step, /Nothing has aged out yet/);
  assert.match(planned.markdown, /# State prune \(dry run\)/);

  const applied = await call(registry, { dry_run: false });
  assert.equal(applied.dry_run, false);
  assert.ok(calls.some(([name]) => name === "rotate"));
  assert.match(applied.next_step, /State pruned/);
});

test("the project is resolved before the task sweep, and thresholds come through", async (t) => {
  const { registry, calls } = await createFixture(t, {
    tasks: [{ id: "task-1", status: "active", updated_at: "2000-01-01T00:00:00.000Z", snapshots: [{ sequence: 1 }] }]
  });
  const result = await call(registry, { project_path: "/repo/atlas", abandoned_task_days: 7, usage_keep_lines: 100 });
  assert.deepEqual(calls.find(([name]) => name === "list")[1], { projectPath: "/resolved/repo/atlas", limit: 5000 });
  assert.equal(result.thresholds.abandoned_task_days, 7);
  assert.equal(result.thresholds.usage_keep_lines, 100);
  assert.equal(result.thresholds.instinct_idle_days, 90, "a threshold nobody set keeps its default");
  assert.equal(result.snapshots.tasks_pruned, 1);
  assert.match(result.next_step, /call prune_state with dry_run: false/);
  assert.ok(result.state_root.includes("state-ext-"), "the report names the state directory it worked on");

  // A threshold that is not a number is ignored rather than poisoning the run.
  const nonsense = await call(registry, { abandoned_task_days: "soon" });
  assert.equal(nonsense.thresholds.abandoned_task_days, 30);
});

test("with no project path every task in the state directory is swept", async (t) => {
  const { registry, calls } = await createFixture(t);
  await call(registry, {});
  assert.deepEqual(calls.find(([name]) => name === "list")[1], { projectPath: "", limit: 5000 });
});

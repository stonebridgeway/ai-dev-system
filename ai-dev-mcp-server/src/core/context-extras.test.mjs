import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordDecision } from "./decision-ledger.mjs";
import { InstinctStore } from "./instincts.mjs";
import { SessionStore } from "./session-memory.mjs";
import { decisionsContextProvider, handoffContextProvider, instinctsContextProvider, loadContextExtras } from "./context-extras.mjs";

test("context extras collect decision sections and isolate provider failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const empty = await loadContextExtras({ projectRoot: root });
  assert.deepEqual(empty, { sections: [], errors: [] });

  await recordDecision(root, { title: "Use pnpm", context: "Monorepo.", decision: "pnpm workspaces everywhere." });
  const loaded = await loadContextExtras({
    projectRoot: root,
    providers: [
      decisionsContextProvider,
      async function brokenProvider() { throw new Error("boom"); },
      async () => null
    ]
  });
  assert.equal(loaded.sections.length, 1);
  assert.equal(loaded.sections[0].id, "decisions");
  assert.match(loaded.sections[0].markdown, /ADR-0001: Use pnpm — pnpm workspaces everywhere\./);
  assert.deepEqual(loaded.errors, ["brokenProvider: boom"]);
});

test("handoff and instinct providers surface session memory and learned behaviors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-extras-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  assert.equal(await handoffContextProvider({ stateRoot, projectId: "project-x" }), null);
  assert.equal(await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "x" }), null);

  await new SessionStore({ stateRoot }).save({
    projectId: "project-x",
    projectPath: root,
    building: "Payment retries with idempotency keys across the checkout service.",
    failed: [{ approach: "Retrying without keys", reason: "double charges in staging" }],
    blockers: ["Need sandbox credentials"],
    next_step: "Add the idempotency middleware and re-run verify_task.",
    now: "2026-01-01T00:00:00.000Z"
  });
  const handoff = await handoffContextProvider({ stateRoot, projectId: "project-x" });
  assert.equal(handoff.id, "handoff");
  assert.equal(handoff.title, "Last Session Handoff");
  assert.equal(handoff.items[0].unconfirmed, false);
  assert.match(handoff.markdown, /Next step: Add the idempotency middleware/);
  assert.match(handoff.markdown, /Do not retry: Retrying without keys \(double charges in staging\)/);
  assert.match(handoff.markdown, /WARNING: \d+ days ago/);

  // A newer hook capture can win the "latest" slot; the pack must not present
  // what heuristics guessed as something an agent wrote down.
  await fs.writeFile(path.join(stateRoot, "sessions", "project-x", "hook-zz.json"), JSON.stringify({
    id: "session-hook-zz",
    saved_at: "2026-02-01T00:00:00.000Z",
    project_id: "project-x",
    project_path: root,
    source: "hook",
    confirmed: false,
    captured_by: "stop",
    topic: "Payment retries",
    building: "Requests in this session (2):\n- Fix the retry loop\n- Add a test",
    files: [{ path: "src/pay.js", status: "in_progress", notes: "touched this session (hook capture)" }],
    next_step: ""
  }));
  const captured = await handoffContextProvider({ stateRoot, projectId: "project-x" });
  assert.equal(captured.title, "Last Session Handoff (unconfirmed hook draft)");
  assert.equal(captured.items[0].unconfirmed, true);
  assert.match(captured.markdown, /UNCONFIRMED HOOK DRAFT \(session-hook-zz\)/);
  assert.match(captured.markdown, /Next step: not recorded/);

  const store = new InstinctStore({ stateRoot });
  await store.record({ trigger: "when retrying payments", action: "use idempotency keys", domain: "architecture", projectId: "project-x", confidence: 0.8 });
  await store.record({ trigger: "when naming files", action: "prefer kebab-case", domain: "code-style", projectId: "project-x", confidence: 0.4 });
  const instincts = await instinctsContextProvider({ stateRoot, projectId: "project-x", task: "Fix payment retries", stack: ["Node.js"] });
  assert.equal(instincts.items.length, 1, "only instincts above the 0.7 threshold are injected");
  assert.match(instincts.markdown, /use idempotency keys/);

  const all = await loadContextExtras({ projectRoot: root, stateRoot, projectId: "project-x", task: "Fix payment retries" });
  assert.deepEqual(all.sections.map((section) => section.id), ["handoff", "instincts"]);
});

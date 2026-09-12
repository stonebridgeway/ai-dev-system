import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listDecisions,
  parseDecision,
  recordDecision,
  renderDecision,
  summarizeDecisions
} from "./decision-ledger.mjs";

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("records numbered ADR files, lists newest first, and supersedes older decisions", async (t) => {
  const root = await tempProject(t);
  const first = await recordDecision(root, {
    title: "Use SQLite for local state",
    context: "We need durable local state without a server.",
    decision: "Keep SQLite as the only local database.",
    alternatives: ["Postgres in Docker", "JSON files"],
    consequences: ["No network dependency", "Single-writer limits"],
    task_id: "task-20260101T000000-abcdef12",
    tags: ["Storage", "local first"],
    now: "2026-01-01T10:00:00.000Z"
  });
  assert.equal(first.record.id, "ADR-0001");
  assert.equal(first.path, ".ai-dev/decisions/0001-use-sqlite-for-local-state.md");
  assert.deepEqual(first.record.tags, ["storage", "local-first"]);

  const second = await recordDecision(root, {
    title: "Move state to Postgres",
    context: "Multi-user access is now required.",
    decision: "Use Postgres for shared state.",
    supersedes: "ADR-0001",
    now: "2026-02-01T10:00:00.000Z"
  });
  assert.equal(second.record.id, "ADR-0002");
  assert.equal(second.superseded, ".ai-dev/decisions/0001-use-sqlite-for-local-state.md");

  const decisions = await listDecisions(root);
  assert.deepEqual(decisions.map((item) => item.id), ["ADR-0002", "ADR-0001"]);
  assert.equal(decisions[1].status, "superseded");
  assert.equal(decisions[1].task_id, "task-20260101T000000-abcdef12");
  assert.deepEqual(decisions[1].alternatives, ["Postgres in Docker", "JSON files"]);
  assert.deepEqual(await listDecisions(root, { tag: "storage" }).then((items) => items.map((item) => item.id)), ["ADR-0001"]);
  assert.deepEqual(await listDecisions(root, { status: "accepted" }).then((items) => items.map((item) => item.id)), ["ADR-0002"]);

  const summary = summarizeDecisions(decisions);
  assert.match(summary, /ADR-0002: Move state to Postgres — Use Postgres for shared state\./);
  assert.match(summary, /ADR-0001 \(superseded\)/);
});

test("render and parse round-trip preserves fields and rejects bad input", async (t) => {
  const record = {
    id: "ADR-0007",
    title: "Adopt \"strict\" mode",
    status: "proposed",
    date: "2026-03-01",
    task_id: "",
    tags: ["typescript"],
    context: "Loose types hide bugs.",
    decision: "Enable strict mode.\nMigrate module by module.",
    alternatives: ["Keep as is"],
    consequences: ["More compile errors at first"]
  };
  const parsed = parseDecision(renderDecision(record), "0007-adopt-strict-mode.md");
  assert.equal(parsed.id, "ADR-0007");
  assert.equal(parsed.title, "Adopt \"strict\" mode");
  assert.equal(parsed.status, "proposed");
  assert.deepEqual(parsed.tags, ["typescript"]);
  assert.equal(parsed.decision, "Enable strict mode.\nMigrate module by module.");
  assert.deepEqual(parsed.consequences, ["More compile errors at first"]);
  assert.equal(parseDecision("just text", "notes.md"), null);
  assert.equal(parseDecision("# hand written", "0003-hand-written.md").id, "ADR-0003");

  const root = await tempProject(t);
  await assert.rejects(recordDecision(root, { title: "", decision: "x" }), /title is required/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "" }), /decision is required/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "y", status: "maybe" }), /status must be one of/);
  await assert.rejects(recordDecision(root, { title: "x", decision: "y", supersedes: "ADR-0099" }), /Unknown decision to supersede/);
  assert.equal(await listDecisions(root).then((items) => items.length), 0);
  assert.equal(summarizeDecisions([]), "");
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PILOT_DIMENSIONS,
  PilotStore,
  validatePilotReview
} from "./pilot-evaluation.mjs";

function dimensions(status = "pass", score = 4) {
  return PILOT_DIMENSIONS.map((name) => ({
    name,
    status: name === "visual_quality" ? "not_applicable" : status,
    score: name === "visual_quality" ? null : score,
    evidence: name === "visual_quality" ? [] : [`Evidence for ${name}`],
    findings: []
  }));
}

test("pilot review requires independent dimension-level evidence", () => {
  assert.throws(() => validatePilotReview({
    verdict: "accepted",
    reviewer: {
      kind: "human",
      name: "Owner",
      independent_from_implementer: false,
      human_confirmed: true
    },
    revision_count: 0,
    duration_minutes: 20,
    dimensions: dimensions()
  }), /independent/i);
});

test("pilot store records baseline and honest human review", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-pilot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PilotStore({ stateRoot: root });
  const pilot = await store.start({
    projectIdentity: {
      project_id: "project-one",
      canonical_path: root,
      repository_id: null
    },
    title: "Improve account settings",
    taskType: "frontend",
    baseline: {
      kind: "existing-product",
      evidence: ["before.png"],
      notes: "Existing beta screen."
    },
    implementer: "Codex"
  });
  await store.review(pilot.id, {
    verdict: "accepted",
    reviewer: {
      kind: "human",
      name: "Product owner",
      independent_from_implementer: true,
      human_confirmed: true
    },
    revision_count: 1,
    duration_minutes: 90,
    dimensions: dimensions(),
    notes: "Accepted after one revision."
  });
  const status = await store.status({ id: pilot.id });
  assert.equal(status.summary.accepted, 1);
  assert.equal(status.summary.human_confirmed, 1);
  assert.equal(status.summary.first_pass_accepted, 0);
});

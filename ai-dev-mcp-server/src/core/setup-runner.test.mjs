import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import * as steps from "../../scripts/first-run-steps.mjs";
import { frontendQaStatus, runSetup } from "./setup-runner.mjs";

test("a stop during the Frontend QA check is a stop, not a runner that did not start", async () => {
  await assert.rejects(frontendQaStatus(os.tmpdir(), { launch: false, signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
  // Without a signal it answers with a status, whatever the runner finds.
  const status = await frontendQaStatus(os.tmpdir(), { launch: false });
  assert.equal(typeof status.playwright_available, "boolean");
});

test("a model this user cannot read is said as that, and --model refuses it rather than download over it", async () => {
  const unreadable = "EACCES: permission denied, stat '/models/bge-m3-onnx/config.json'";
  const inspection = {
    manifest: { export: "Xenova/bge-m3", revision: "a".repeat(40), dtype: "int8", files: {} },
    modelDir: "/models/bge-m3-onnx",
    indexStatus: { dense_documents: 0, dense_pending_documents: 0 },
    present: { skill_registry: true, skill_quality_report: true, search_index: true, routing_benchmark: true },
    stale: {},
    qaDependencies: false,
    modelInstalled: false,
    modelUnreadable: unreadable
  };
  const runtime = { callTool: async (name) => { throw new Error(`${name} should not run`); }, vaultRoot: os.tmpdir() };
  const quiet = await runSetup({ runtime, env: {}, steps, inspection });
  const skipped = quiet.find((step) => step.id === "dense_model");
  assert.deepEqual([skipped.status, skipped.reason], ["skipped", `cannot be read (${unreadable})`]);
  assert.equal(quiet.find((step) => step.id === "dense_index").reason, "none: the model cannot be read");

  const asked = await runSetup({ runtime, env: {}, steps, inspection, want: { model: true } });
  const refused = asked.find((step) => step.id === "dense_model");
  assert.equal(refused.status, "failed");
  assert.equal(refused.error, `The model in /models/bge-m3-onnx cannot be read (${unreadable}). Make the folder and its files readable to the user this runs as.`);
  // In the image, the host's folder at /models: uid 1000, and the volume as the way out.
  const inImage = await runSetup({ runtime, env: { AI_DEV_RUNTIME: "docker" }, steps, inspection, want: { model: true } });
  assert.match(inImage.find((step) => step.id === "dense_model").error, /The image runs as uid 1000: make the folder and its files readable to it on the host, or drop the mount/);
  // Vectors the model made before are kept, and said so.
  const kept = await runSetup({ runtime, env: {}, steps, inspection: { ...inspection, indexStatus: { dense_documents: 367, dense_pending_documents: 0 } } });
  assert.equal(kept.find((step) => step.id === "dense_index").reason, "367 kept; none added while the model cannot be read");
  assert.equal(asked.find((step) => step.id === "dense_index").status, "skipped", "nothing to embed with");
  // A model that is simply not there keeps the flag's advice.
  const absent = await runSetup({ runtime, env: {}, steps, inspection: { ...inspection, modelUnreadable: "" } });
  assert.equal(absent.find((step) => step.id === "dense_model").reason, "not installed — pass --model to install it");
});

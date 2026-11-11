import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FIRST_RUN_STEPS, planFirstRun } from "../src/core/first-run.mjs";
import { densePlan, rebuildIndex } from "../src/core/search-store.mjs";
import { sqliteSupport } from "../src/core/search-sqlite.mjs";
import {
  REQUIRED_STEP_IDS,
  createRequiredActions,
  parseToolResult,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan,
  summarizeToolResult
} from "./first-run-steps.mjs";

function toolResult(document) {
  return { content: [{ type: "text", text: JSON.stringify(document) }] };
}

/** A vault with only the files a test names in it. */
async function makeVault(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "first-run-steps-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, "utf8");
  }
  return root;
}

test("the required steps are exactly the ones no install can do without", () => {
  // The container built the registry alone, so a fresh volume had no
  // search index and no routing benchmark, and four critical checks failed on
  // a correct install. Both commands now run this list.
  const required = FIRST_RUN_STEPS.filter((step) => !step.optional).map((step) => step.id);
  assert.deepEqual([...REQUIRED_STEP_IDS], required);
  assert.deepEqual(Object.keys(createRequiredActions({ callTool: async () => ({}) })), required);
});

test("the steps that write into the vault run before the index that reads it", () => {
  // The quality report writes a dashboard note. Built after the index, it left
  // the index stale the moment the first run finished — a fresh install that
  // still could not reach `ok`, just for a different reason.
  const order = FIRST_RUN_STEPS.map((step) => step.id);
  assert.ok(
    order.indexOf("skill_quality_report") < order.indexOf("search_index"),
    "the quality report writes a vault note, so it has to come before the index"
  );
  assert.ok(order.indexOf("skill_registry") < order.indexOf("skill_quality_report"),
    "the report describes the registry, so the registry is built first");
});

test("each required step calls the tool that builds it, with the arguments that keep it offline", async () => {
  const calls = [];
  const actions = createRequiredActions({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return toolResult({
        total: 3227,
        indexed_document_count: 3442,
        summary: { passed: 37, total: 37 }
      });
    }
  });
  assert.equal(await actions.skill_registry(), "3227 skill(s) indexed");
  // Without this step nothing wrote the report the health check reads, so every fresh
  // install answered its own diagnostic with `skill_quality: report missing`.
  assert.equal(await actions.skill_quality_report(), "37 skill(s) validated");
  assert.equal(await actions.search_index(), "3442 document(s) indexed");
  assert.equal(await actions.routing_benchmark(), "37/37 cases pass");
  assert.deepEqual(calls.map((call) => call.name), [
    "rebuild_index", "validate_skill_library", "rebuild_search_index", "run_skill_routing_eval"
  ]);
  assert.equal(calls[1].args.write_report, true, "a report nobody writes is the defect itself");
  assert.equal(calls[1].args.include_duplicates, false, "the expensive half is not part of an install");
  // A container has no weights and a clone that has them has already embedded
  // with them: the index rebuild must neither drop the vectors nor make any.
  assert.deepEqual(calls[2].args, {
    include_external_project_files: true,
    dense_embeddings: false,
    preserve_dense: true
  });
});

test("a tool that answers with something other than JSON still reports", async () => {
  assert.equal(parseToolResult({ content: [{ type: "text", text: "not json" }] }), null);
  assert.equal(parseToolResult(undefined), null);
  assert.equal(summarizeToolResult({ content: [] }, () => "unused"), "done");
  const actions = createRequiredActions({ callTool: async () => ({ content: [] }) });
  assert.equal(await actions.routing_benchmark(), "done");
  const partial = createRequiredActions({ callTool: async () => toolResult({ nothing: true }) });
  assert.equal(await partial.skill_registry(), "? skill(s) indexed");
  assert.equal(await partial.search_index(), "? document(s) indexed");
  assert.equal(await partial.routing_benchmark(), "benchmark written");
  assert.equal(await partial.skill_quality_report(), "report written");
});

test("an empty vault needs every required step and a built one needs none", async (t) => {
  const empty = await makeVault(t);
  const paths = requiredArtefactPaths({
    vaultRoot: empty,
    searchIndexPath: path.join(empty, "cache", "ai-dev-search.sqlite")
  });
  assert.equal(paths.skillRegistryPath, path.join(empty, "03-skills-catalog", "registries", "skills.index.json"));

  const fresh = await readRequiredState({
    paths,
    callTool: async () => { throw new Error("the index does not exist yet"); },
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(empty, "cases.json")
  });
  assert.equal(fresh.indexStatus, null, "no index means no status call");
  assert.deepEqual(fresh.present, {
    skill_registry: false, search_index: false, routing_benchmark: false, skill_quality_report: false
  });
  const planned = planFirstRun({ present: fresh.present, stale: fresh.stale });
  assert.deepEqual(planned.filter((step) => step.run).map((step) => step.id), [...REQUIRED_STEP_IDS]);

  const built = await makeVault(t, {
    "03-skills-catalog/registries/skills.index.json": "[]",
    "03-skills-catalog/registries/skill-routing-eval.json": "{}",
    "03-skills-catalog/registries/skill-quality.index.json": "{}",
    "cache/ai-dev-search.sqlite": "",
    "cases.json": "[]"
  });
  // The benchmark was written after the cases it was built from, and the
  // quality report after the registry it describes.
  const future = new Date(Date.now() + 60_000);
  for (const name of ["skill-routing-eval.json", "skill-quality.index.json"]) {
    await fs.utimes(path.join(built, "03-skills-catalog", "registries", name), future, future);
  }
  const builtPaths = requiredArtefactPaths({
    vaultRoot: built,
    searchIndexPath: path.join(built, "cache", "ai-dev-search.sqlite")
  });
  const second = await readRequiredState({
    paths: builtPaths,
    callTool: async () => toolResult({ stale: false, dense_documents: 0 }),
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(built, "cases.json")
  });
  assert.deepEqual(second.present, {
    skill_registry: true, search_index: true, routing_benchmark: true, skill_quality_report: true
  });
  assert.deepEqual(second.stale, {
    skill_registry: false, search_index: false, routing_benchmark: false, skill_quality_report: false
  });
  // The second container start rebuilds nothing.
  assert.deepEqual(planFirstRun({ present: second.present, stale: second.stale })
    .filter((step) => step.run), []);
});

test("an index the vault has moved past, and a benchmark older than its cases, are rebuilt", async (t) => {
  const root = await makeVault(t, {
    "03-skills-catalog/registries/skills.index.json": "[]",
    "03-skills-catalog/registries/skill-routing-eval.json": "{}",
    "cache/ai-dev-search.sqlite": "",
    "cases.json": "[]"
  });
  const casesPath = path.join(root, "cases.json");
  const reportPath = path.join(root, "03-skills-catalog", "registries", "skill-routing-eval.json");
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(reportPath, past, past);

  const state = await readRequiredState({
    paths: requiredArtefactPaths({ vaultRoot: root, searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite") }),
    callTool: async () => toolResult({ stale: true }),
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: casesPath
  });
  assert.deepEqual(state.stale, { skill_registry: false, search_index: true, routing_benchmark: true });
  assert.deepEqual(
    planFirstRun({ present: state.present, stale: state.stale }).filter((step) => step.run).map((step) => step.id),
    ["skill_quality_report", "search_index", "routing_benchmark"]
  );
});

test("the skill quality report is rebuilt only when the registry has moved past it", async (t) => {
  // The step exists because nothing else writes the report the health check
  // reads; it has to be idempotent, because it runs on
  // every container start.
  const root = await makeVault(t, {
    "03-skills-catalog/registries/skills.index.json": "[]",
    "03-skills-catalog/registries/skill-quality.index.json": "{}",
    "cases.json": "[]"
  });
  const paths = requiredArtefactPaths({
    vaultRoot: root,
    searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite")
  });
  const read = async () => readRequiredState({
    paths,
    callTool: async () => { throw new Error("no index here"); },
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(root, "cases.json")
  });

  const past = new Date(Date.now() - 60_000);
  await fs.utimes(paths.skillQualityReportPath, past, past);
  const behind = await read();
  assert.equal(behind.stale.skill_quality_report, true, "a report older than the registry is out of date");
  assert.ok(planFirstRun({ present: behind.present, stale: behind.stale })
    .find((step) => step.id === "skill_quality_report").run);

  const future = new Date(Date.now() + 60_000);
  await fs.utimes(paths.skillQualityReportPath, future, future);
  const current = await read();
  assert.equal(current.stale.skill_quality_report, false);
  const step = planFirstRun({ present: current.present, stale: current.stale })
    .find((item) => item.id === "skill_quality_report");
  assert.equal(step.run, false, "the second start rebuilds nothing");
  assert.match(step.reason, /already built/);
});

test("a registry whose skills changed on disk is rebuilt, and everything built from it", async (t) => {
  // What a pull that removes a skill leaves: the generated registry still
  // lists it, the file is gone. Before, setup said "already built" to all four.
  const registry = JSON.stringify([
    { name: "kept", path: "sources/custom/kept/SKILL.md" },
    { name: "gone", path: "sources/custom/gone/SKILL.md" }
  ]);
  const root = await makeVault(t, {
    "03-skills-catalog/sources/custom/kept/SKILL.md": "# kept\n",
    "03-skills-catalog/sources/custom/gone/SKILL.md": "# gone\n",
    "03-skills-catalog/registries/skills.index.json": registry,
    "03-skills-catalog/registries/skill-routing-eval.json": "{}",
    "03-skills-catalog/registries/skill-quality.index.json": "{}",
    "cache/ai-dev-search.sqlite": "",
    "cases.json": "[]"
  });
  const catalog = path.join(root, "03-skills-catalog");
  const past = new Date(Date.now() - 120_000);
  for (const relative of ["sources/custom/kept/SKILL.md", "sources/custom/gone/SKILL.md", "sources/custom/kept", "sources/custom/gone", "sources/custom", "sources"]) {
    await fs.utimes(path.join(catalog, relative), past, past);
  }
  const later = new Date(Date.now() + 60_000);
  for (const name of ["skill-routing-eval.json", "skill-quality.index.json"]) {
    await fs.utimes(path.join(catalog, "registries", name), later, later);
  }
  const paths = requiredArtefactPaths({ vaultRoot: root, searchIndexPath: path.join(root, "cache", "ai-dev-search.sqlite") });
  let asked = 0;
  const read = () => readRequiredState({
    paths,
    callTool: async () => { asked += 1; return toolResult({ stale: false, dense_documents: 0 }); },
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(root, "cases.json")
  });

  const current = await read();
  assert.equal(current.stale.skill_registry, false, "nothing changed: the registry is current");
  assert.equal(asked, 1);

  await fs.rm(path.join(catalog, "sources", "custom", "gone"), { recursive: true });
  const pulled = await read();
  assert.deepEqual(pulled.stale, {
    skill_registry: true, search_index: true, routing_benchmark: true, skill_quality_report: true
  });
  assert.equal(asked, 1, "the index is not asked: that call would rebuild the registry itself");
  assert.deepEqual(
    planFirstRun({ present: pulled.present, stale: pulled.stale }).filter((step) => step.run).map((step) => step.id),
    [...REQUIRED_STEP_IDS]
  );
});

test("after a pull that changed skills, the dense vectors in the index are still reported", { skip: !sqliteSupport().available && sqliteSupport().reason }, async (t) => {
  const root = await makeVault(t, {
    "02-knowledge/deploy.md": "# Deploy\n\nHow to deploy and roll back.",
    "03-skills-catalog/sources/custom/kept/SKILL.md": "# kept\n",
    "03-skills-catalog/registries/skills.index.json": JSON.stringify([
      { name: "kept", source: "custom", categories: ["review"], description: "Reviews code.", path: "sources/custom/kept/SKILL.md" }
    ]),
    "cases.json": "[]"
  });
  const indexPath = path.join(root, "cache", "ai-dev-search.sqlite");
  const provenance = { backend: "onnx", revision: "abc123", dtype: "int8" };
  const plan = await densePlan({ vaultRoot: root, indexPath, provenance });
  const vectors = plan.records.map((record) => ({ id: record.id, content_hash: record.content_hash, vector: Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)) }));
  await rebuildIndex({ vaultRoot: root, indexPath, denseEmbeddings: true, suppliedVectors: vectors, denseBackend: "onnx", denseRevision: "abc123", denseDtype: "int8" });
  const catalog = path.join(root, "03-skills-catalog");
  const past = new Date(Date.now() - 120_000);
  for (const relative of ["sources/custom/kept/SKILL.md", "sources/custom/kept", "sources/custom", "sources"]) await fs.utimes(path.join(catalog, relative), past, past);
  // The pull rewrites the skill: the registry is out of date.
  await fs.writeFile(path.join(catalog, "sources/custom/kept/SKILL.md"), "# kept, pulled\n");
  let asked = 0;
  const state = await readRequiredState({
    paths: requiredArtefactPaths({ vaultRoot: root, searchIndexPath: indexPath }),
    callTool: async () => { asked += 1; return toolResult({}); },
    serverRoot: path.resolve("."),
    skillRoutingEvalCasesPath: path.join(root, "cases.json")
  });
  assert.equal(state.stale.skill_registry, true);
  assert.equal(asked, 0, "the tool is not asked: it would rebuild the registry itself");
  assert.equal(state.indexStatus?.dense_documents, plan.records.length, "the vectors the index holds");
  const step = planFirstRun({ present: { ...state.present, dense_index: state.indexStatus.dense_documents > 0 }, stale: state.stale })
    .find((item) => item.id === "dense_index");
  assert.doesNotMatch(step.reason, /not installed/);
});

test("running a plan reports every step, including the ones this caller cannot run", async () => {
  const announced = [];
  const plan = planFirstRun({ present: {}, stale: {}, want: { frontend_qa: true } });
  const results = await runFirstRunPlan(plan, {
    skill_registry: async () => "3227 skill(s) indexed",
    search_index: async () => { throw new Error("python is missing\nsecond line ignored"); },
    routing_benchmark: async () => "37/37 cases pass",
    skill_quality_report: async () => "3227 skill(s) validated"
  }, (step) => announced.push(step.id));

  assert.deepEqual(announced, ["skill_registry", "skill_quality_report", "search_index", "routing_benchmark"]);
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  assert.equal(byId.skill_registry.status, "done");
  assert.equal(byId.search_index.status, "failed");
  assert.equal(byId.search_index.error, "python is missing", "only the first line of a failure is kept");
  assert.equal(byId.routing_benchmark.status, "done", "a failed step does not stop the rest");
  // The container has no action for the optional steps and does not pretend to.
  assert.equal(byId.frontend_qa.status, "skipped");
  assert.equal(results.length, plan.length);
});

test("a stop is no failure: the step it cuts short and those after it are skipped, and none of them announced", async () => {
  const announced = [];
  const stop = new AbortController();
  const plan = planFirstRun({ present: {}, stale: {}, want: {} });
  const results = await runFirstRunPlan(plan, {
    skill_registry: async () => "614 skill(s) indexed",
    skill_quality_report: async () => "614 skill(s) validated",
    search_index: async () => {
      stop.abort();
      // As the index store answers a stop.
      throw Object.assign(new Error("The rebuild was cancelled; the index is as it was before it."), { name: "AbortError", cancelled: true });
    },
    routing_benchmark: async () => "never"
  }, (step) => announced.push(step.id), { signal: stop.signal });
  assert.deepEqual(announced, ["skill_registry", "skill_quality_report", "search_index"]);
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  assert.deepEqual([byId.search_index.status, byId.search_index.reason], ["skipped", "stopped: The rebuild was cancelled; the index is as it was before it."]);
  assert.deepEqual([byId.routing_benchmark.status, byId.routing_benchmark.reason], ["skipped", "not run: setup was stopped"]);
  assert.equal(results.filter((item) => item.status === "failed").length, 0);
});

test("a step that fails of something else as the stop comes failed, and says so", async () => {
  const stop = new AbortController();
  const plan = planFirstRun({ present: {}, stale: {}, want: {} });
  const results = await runFirstRunPlan(plan, {
    skill_registry: async () => "614 skill(s) indexed",
    skill_quality_report: async () => {
      stop.abort();
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
    search_index: async () => "never",
    routing_benchmark: async () => "never"
  }, () => undefined, { signal: stop.signal });
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  assert.deepEqual([byId.skill_quality_report.status, byId.skill_quality_report.error], ["failed", "ENOSPC: no space left on device, write"]);
  assert.equal(byId.search_index.reason, "not run: setup was stopped");
});

test("the first run counts the documents the rebuild actually reported", async () => {
  // Issue #63: a fresh rebuild answers with `document_count`, which
  // was in none of the names this line read, so the first thing a new user saw
  // was "? document(s) indexed" while the index had in fact been built.
  const actions = createRequiredActions({
    callTool: async () => toolResult({ document_count: 3442 })
  });
  assert.equal(await actions.search_index(), "3442 document(s) indexed");
});

test("the vectors are not attempted after the model step failed, and say why", async () => {
  const plan = planFirstRun({ present: {}, stale: {}, want: { dense_model: true, dense_index: true } });
  const ran = [];
  const results = await runFirstRunPlan(plan, {
    dense_model: async () => { throw new Error("Could not fetch config.json: huggingface.co could not be resolved (ENOTFOUND)."); },
    dense_index: async () => { ran.push("dense_index"); return "never"; }
  });
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  assert.equal(byId.dense_model.status, "failed");
  assert.equal(byId.dense_index.status, "skipped");
  assert.equal(byId.dense_index.reason, "not run: Local BGE-M3 model failed above, and this step needs it");
  assert.deepEqual(ran, []);

  // A model already installed is not "failed": the vectors run.
  const installed = planFirstRun({ present: { dense_model: true }, stale: {}, want: { dense_model: true, dense_index: true } });
  const again = await runFirstRunPlan(installed, { dense_index: async () => "12 document(s) embedded" });
  assert.equal(again.find((item) => item.id === "dense_index").status, "done");
});

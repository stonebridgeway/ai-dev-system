import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import {
  FRONTEND_PRODUCT_PATHS,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS
} from "../core/frontend-product-quality.mjs";
import { createFrontendQaTools } from "./frontend-qa.mjs";

/**
 * A stand-in for `09-mcp/frontend-qa/frontend_qa_runner.mjs`: same stdin/stdout
 * contract, no browser. The whole point of the extension is the orchestration
 * around the runner, and that is what this exercises.
 */
const FAKE_RUNNER = `import process from "node:process";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
if (process.env.FAKE_RUNNER_MODE === "crash") {
  process.stderr.write("runner exploded\\n");
  process.exit(3);
}
if (process.env.FAKE_RUNNER_MODE === "noisy") process.stderr.write("axe could not be loaded\\n");
const viewports = input.viewports?.length ? input.viewports : [{ name: "desktop", width: 1440, height: 900 }];
const states = (input.scenarios ?? []).map((item) => item.state || item.name);
process.stdout.write(JSON.stringify({
  gate: "pass",
  status: "completed",
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: "2026-01-01T00:00:10.000Z",
  project_path: input.project_path,
  base_url: input.url,
  dev_command: input.dev_command,
  routes: input.routes,
  viewports,
  echoed_input: input,
  visual_baselines_complete: Boolean(input.check_visual_regression),
  unwaived_anti_slop_findings: 0,
  state_coverage: {
    required: input.required_states ?? [],
    covered: states,
    missing: (input.required_states ?? []).filter((state) => !states.includes(state)),
    complete: (input.required_states ?? []).every((state) => states.includes(state))
  },
  results: input.routes.flatMap((route) => viewports.map((viewport) => ({
    route,
    viewport,
    status: "pass",
    screenshot: \`shots/\${viewport.name}.png\`,
    visual: input.check_visual_regression ? { baseline: \`\${input.visual_baseline_dir}/\${viewport.name}.png\`, diff: "" } : undefined,
    scenarios: (input.scenarios ?? []).map((scenario) => ({
      name: scenario.name,
      state: scenario.state,
      status: "pass",
      screenshot: \`shots/\${viewport.name}-\${scenario.state}.png\`
    }))
  })))
}));
`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 960 },
  { name: "mobile", width: 390, height: 844 }
];
const SCENARIOS = [{ name: "confirm", state: "success", route: "/" }];

function passingScorecard() {
  return Object.fromEntries(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => [dimension.id, {
    status: "pass",
    score: 4,
    evidence: `Reviewed the desktop and mobile evidence for ${dimension.id}.`,
    findings: []
  }]));
}

/**
 * A project plus a host that answers every service the QA extension asks for.
 * Product state lives in memory so a test can put the product in any phase
 * without walking the whole approval machine.
 */
async function createFixture(t, { state = {}, runnerMode = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-qa-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const artifactsRoot = path.join(root, "artifacts");
  const runnerPath = path.join(root, "frontend_qa_runner.mjs");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(runnerPath, FAKE_RUNNER, "utf8");
  if (runnerMode) process.env.FAKE_RUNNER_MODE = runnerMode;
  t.after(() => {
    delete process.env.FAKE_RUNNER_MODE;
  });

  const safeProjectFile = (base, relative) => path.join(base, relative);
  let productState = {
    schema_version: 2,
    phase: "ready-for-implementation",
    implementer: "builder-agent",
    // The implementation gate wants the three-skill selection the product
    // builder makes, with the orchestrator and the independent gate among them.
    selected_skills: [
      { name: "frontend-product-builder", source: "custom", role: "orchestrator" },
      { name: "ui-ux-pro-max", source: "external/ui-ux-pro-max", role: "visual-direction" },
      { name: "frontend-quality-gate", source: "custom", role: "independent-quality" }
    ],
    context: { required_states: ["success"] },
    anti_slop_exceptions: [],
    approvals: { direction: { direction_id: "calm" }, design_system: { approver: "owner" } },
    visual_reviews: [],
    latest_visual_run: null,
    ...state
  };

  const calls = [];
  const host = {
    frontendQaRunnerPath: runnerPath,
    frontendQaArtifactsRoot: artifactsRoot,
    safeProjectRoot: async (value) => {
      if (!value) throw new Error("project_path is required.");
      return projectRoot;
    },
    safeProjectFile,
    safeProjectSubdir: async (base, relative) => (relative ? path.join(base, relative) : base),
    resolveTaskProjectRoot: async () => projectRoot,
    pathExists: (target) => fs.access(target).then(() => true, () => false),
    detectProject: async (_directory, name) => ({
      project_name: name,
      stack: ["Node.js"],
      commands: [{ label: "Dev", command: "npm run dev" }]
    }),
    findProjectCard: async () => {
      calls.push(["findProjectCard"]);
      return { name: "Atlas" };
    },
    updateProjectCard: async (args) => {
      calls.push(["updateProjectCard", args.section]);
      return { action: "updated" };
    },
    syncProjectCard: async () => {
      calls.push(["syncProjectCard"]);
      return { action: "synced" };
    },
    registerProject: async () => {
      calls.push(["registerProject"]);
      return { action: "registered" };
    },
    writeProjectFile: async (base, relative, content) => {
      const target = path.join(base, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return target;
    },
    readFrontendProductState: async () => productState,
    writeFrontendProductState: async (_root, next) => {
      productState = next;
      return next;
    },
    frontendProductDocumentHashes: async () => ({}),
    resolveFrontendReviewArtifact: (base, relative) => path.join(base, relative),
    sha256: (value) => crypto.createHash("sha256").update(value).digest("hex"),
    truncateOutput: (value) => String(value ?? ""),
    markSearchIndexDirty: (reason) => calls.push(["markSearchIndexDirty", reason])
  };

  return {
    root,
    projectRoot,
    artifactsRoot,
    host,
    calls,
    state: () => productState,
    registry: createExtensionTools(host, [createFrontendQaTools])
  };
}

test("the QA extension exposes its three tools and none of them is read-only", async (t) => {
  const { registry } = await createFixture(t);
  assert.deepEqual(registry.definitions.map((definition) => definition.name), [
    "run_frontend_qa",
    "run_visual_reference_qa",
    "record_visual_review"
  ]);
  assert.deepEqual(registry.readOnly, []);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
});

test("run_frontend_qa drives the runner and reports what it ran", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const result = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot,
    url: "http://127.0.0.1:4321",
    start_dev_server: false,
    routes: ["/"],
    viewports: VIEWPORTS,
    write_report: false,
    update_registry: false
  });

  assert.equal(result.gate, "pass");
  assert.equal(result.project_name, "Atlas");
  assert.deepEqual(result.detected_stack, ["Node.js"]);
  assert.equal(result.dev_command, "npm run dev");
  assert.equal(result.artifact_location, "system");
  assert.match(result.markdown, /^# Frontend QA Report\n/);
  assert.equal(result.echoed_input.load_project_config, false);
  assert.equal(result.echoed_input.screenshot_dir, "");
  // A system run gets its own timestamped directory under the artifacts root.
  assert.match(result.echoed_input.artifact_dir, /[/\\]atlas[/\\]\d{4}-\d{2}-\d{2}T/);
});

test("a checked-in project config is read and overridden by call arguments", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  await fs.mkdir(path.join(projectRoot, ".ai-dev"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".ai-dev", "frontend-qa.json"),
    JSON.stringify({ routes: ["/from-config"], check_console: false, url: "http://config" }),
    "utf8"
  );
  const result = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot,
    url: "http://argument",
    write_report: false,
    update_registry: false
  });
  assert.deepEqual(result.echoed_input.routes, ["/from-config"]);
  assert.equal(result.echoed_input.check_console, false);
  assert.equal(result.echoed_input.url, "http://argument");
  assert.ok(result.echoed_input.loaded_config_path.endsWith("frontend-qa.json"));

  const ignored = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot,
    load_project_config: false,
    write_report: false,
    update_registry: false
  });
  assert.deepEqual(ignored.echoed_input.routes, ["/"]);
  assert.equal(ignored.echoed_input.loaded_config_path, "");
});

test("a malformed project config fails the call instead of being ignored", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  await fs.mkdir(path.join(projectRoot, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".ai-dev", "frontend-qa.json"), "[1,2,3]", "utf8");
  await assert.rejects(
    () => registry.handlers.get("run_frontend_qa")({ project_path: projectRoot }),
    /Frontend QA config must be a JSON object/
  );
});

test("an unknown artifact location and a missing runner are refused", async (t) => {
  const { registry, projectRoot, host } = await createFixture(t);
  await assert.rejects(
    () => registry.handlers.get("run_frontend_qa")({ project_path: projectRoot, artifact_location: "elsewhere" }),
    /artifact_location must be system or project/
  );
  host.frontendQaRunnerPath = path.join(projectRoot, "missing-runner.mjs");
  await assert.rejects(
    () => registry.handlers.get("run_frontend_qa")({ project_path: projectRoot }),
    /Frontend QA runner not found/
  );
});

test("a runner that dies becomes a blocking result, not an exception", async (t) => {
  const { registry, projectRoot } = await createFixture(t, { runnerMode: "crash" });
  const result = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot,
    write_report: false,
    update_registry: false
  });
  assert.equal(result.gate, "block");
  assert.equal(result.status, "runner_failed");
  assert.equal(result.setup_warnings.length, 1);
  assert.match(result.markdown, /## Setup Warnings/);
});

test("runner stderr downgrades a pass to a warning", async (t) => {
  const { registry, projectRoot } = await createFixture(t, { runnerMode: "noisy" });
  const result = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot,
    write_report: false,
    update_registry: false
  });
  assert.equal(result.gate, "warn");
  assert.match(result.setup_warnings.join("\n"), /Runner stderr: axe could not be loaded/);
});

test("the report is written where the artifacts go", async (t) => {
  const { registry, projectRoot, artifactsRoot } = await createFixture(t);
  const system = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot, update_registry: false
  });
  assert.ok(system.report_file.startsWith(artifactsRoot));
  assert.match(await fs.readFile(system.report_file, "utf8"), /# Frontend QA Report/);

  const project = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot, artifact_location: "project", update_registry: false
  });
  assert.equal(project.report_file, path.join(projectRoot, ".ai-dev/frontend-qa-report.md"));
});

test("the project card is updated, and a missing card is a skip or a registration", async (t) => {
  const { registry, projectRoot, host, calls } = await createFixture(t);
  const updated = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot, write_report: false
  });
  assert.deepEqual(updated.registry, { report: { action: "updated" }, synced: { action: "synced" } });
  assert.ok(calls.some(([name, section]) => name === "updateProjectCard" && section === "Last Frontend QA Run"));

  host.findProjectCard = async () => {
    throw new Error("Project card not found.");
  };
  const skipped = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot, write_report: false
  });
  assert.equal(skipped.registry.action, "skipped");
  assert.match(skipped.registry.reason, /Project card not found/);

  const registered = await registry.handlers.get("run_frontend_qa")({
    project_path: projectRoot, write_report: false, register_if_missing: true
  });
  assert.equal(registered.registry.action, "registered");
});

test("the strict run refuses to start behind a failing implementation gate", async (t) => {
  const { registry, projectRoot } = await createFixture(t, { state: { phase: "brief", approvals: {}, selected_skills: [] } });
  const result = await registry.handlers.get("run_visual_reference_qa")({ project_path: projectRoot });
  assert.equal(result.action, "rejected");
  assert.equal(result.reason, "implementation_gate_failed");
  assert.equal(result.implementation_gate.ok, false);
});

test("the strict run turns every check on and hands the artifacts to a reviewer", async (t) => {
  const { registry, projectRoot, state } = await createFixture(t);
  const result = await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot,
    routes: ["/"],
    viewports: VIEWPORTS,
    scenarios: SCENARIOS,
    write_report: false
  });

  assert.equal(result.action, "awaiting_visual_review");
  assert.equal(result.technical_passed, true);
  assert.deepEqual(result.strict_checks, {
    desktop_and_mobile: true,
    required_states_covered: true,
    baselines_complete: true,
    unwaived_anti_slop_findings: 0
  });
  assert.equal(result.qa.echoed_input.check_anti_slop, true);
  assert.equal(result.qa.echoed_input.check_accessibility_axe, true);
  assert.equal(result.qa.echoed_input.update_visual_baselines, false);
  assert.equal(result.qa.echoed_input.visual_baseline_dir, FRONTEND_PRODUCT_PATHS.approvedReferences);
  assert.deepEqual(result.qa.echoed_input.required_states, ["success"]);
  assert.ok(result.required_review_artifacts.length > 0);
  assert.equal(state().phase, "visual-review");
  assert.equal(state().latest_visual_run.status, "awaiting_review");
});

test("a strict run that misses a viewport class fails and says which check failed", async (t) => {
  const { registry, projectRoot, state } = await createFixture(t);
  const result = await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot,
    routes: ["/"],
    viewports: [{ name: "desktop", width: 1440, height: 960 }],
    scenarios: SCENARIOS,
    write_report: false
  });
  assert.equal(result.action, "visual_qa_failed");
  assert.equal(result.strict_checks.desktop_and_mobile, false);
  assert.equal(state().phase, "visual-qa-failed");
  assert.match(result.next_step, /rerun strict visual QA/);
});

test("a review is refused without a run, and refused to the implementer", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const noRun = await registry.handlers.get("record_visual_review")({
    project_path: projectRoot, reviewer: "sam", scorecard: passingScorecard()
  });
  assert.equal(noRun.action, "rejected");
  assert.ok(noRun.errors.includes("No strict Visual Reference QA run exists."));

  await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot, routes: ["/"], viewports: VIEWPORTS, scenarios: SCENARIOS, write_report: false
  });
  const sameHands = await registry.handlers.get("record_visual_review")({
    project_path: projectRoot, reviewer: "builder-agent", scorecard: passingScorecard()
  });
  assert.equal(sameHands.action, "rejected");
  assert.ok(sameHands.errors.includes("Visual reviewer must be independent from the implementer."));
});

test("a review needs an inspection for every artifact before anything is recorded", async (t) => {
  const { registry, projectRoot, state } = await createFixture(t);
  const strict = await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot, routes: ["/"], viewports: VIEWPORTS, scenarios: SCENARIOS, write_report: false
  });
  const partial = await registry.handlers.get("record_visual_review")({
    project_path: projectRoot,
    reviewer: "sam",
    inspections: [{
      path: strict.required_review_artifacts[0].path,
      inspection_method: "view_image",
      observations: "The hierarchy reads correctly at this width."
    }],
    scorecard: passingScorecard()
  });
  assert.equal(partial.action, "rejected");
  assert.ok(partial.errors.some((error) => error.startsWith("Missing visual inspection for artifact")));
  assert.equal(state().phase, "visual-review");
});

test("a complete review hashes what it saw and opens the handoff gate", async (t) => {
  const { registry, projectRoot, state } = await createFixture(t);
  const strict = await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot, routes: ["/"], viewports: VIEWPORTS, scenarios: SCENARIOS, write_report: false
  });
  for (const artifact of strict.required_review_artifacts) {
    const target = path.join(projectRoot, artifact.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `bytes for ${artifact.path}`, "utf8");
  }
  const review = await registry.handlers.get("record_visual_review")({
    project_path: projectRoot,
    reviewer: "sam",
    reviewer_role: "product designer",
    inspections: strict.required_review_artifacts.map((artifact) => ({
      path: artifact.path,
      inspection_method: "view_image",
      observations: `Inspected the ${artifact.type} for ${artifact.viewport} ${artifact.state}.`
    })),
    scorecard: passingScorecard()
  });

  assert.equal(review.action, "visual_review_recorded");
  assert.equal(review.phase, "handoff-ready");
  assert.equal(review.review.reviewer, "sam");
  assert.equal(review.review.independent, true);
  assert.equal(review.review.artifacts.length, strict.required_review_artifacts.length);
  for (const artifact of review.review.artifacts) assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(state().latest_visual_run.status, "passed");
  assert.equal(state().visual_reviews.length, 1);
});

test("an artifact that cannot be read is reported rather than silently reviewed", async (t) => {
  const { registry, projectRoot } = await createFixture(t);
  const strict = await registry.handlers.get("run_visual_reference_qa")({
    project_path: projectRoot, routes: ["/"], viewports: VIEWPORTS, scenarios: SCENARIOS, write_report: false
  });
  const review = await registry.handlers.get("record_visual_review")({
    project_path: projectRoot,
    reviewer: "sam",
    inspections: strict.required_review_artifacts.map((artifact) => ({
      path: artifact.path,
      inspection_method: "view_image",
      observations: `Inspected the ${artifact.type}.`
    })),
    scorecard: passingScorecard()
  });
  assert.equal(review.action, "rejected");
  assert.ok(review.errors.every((error) => error.startsWith("Could not hash reviewed artifact")));
});

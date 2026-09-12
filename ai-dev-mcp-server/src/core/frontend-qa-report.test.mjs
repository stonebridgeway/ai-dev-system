import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTEND_QA_ARTIFACT_LOCATIONS,
  buildFrontendQaRunnerInput,
  evaluateStrictVisualRun,
  frontendQaDevCommand,
  frontendQaHasDesktopAndMobile,
  frontendQaReportMarkdown,
  frontendQaRunnerFailure,
  frontendQaTimeout,
  frontendQaVisualArtifacts,
  visualInspectionErrors,
  visualInspectionIndex,
  visualReviewEligibilityErrors
} from "./frontend-qa-report.mjs";

function passingRun(overrides = {}) {
  return {
    gate: "pass",
    viewports: [{ name: "desktop", width: 1440, height: 960 }, { name: "mobile", width: 390, height: 844 }],
    state_coverage: { required: ["success"], covered: ["success"], missing: [], complete: true },
    visual_baselines_complete: true,
    unwaived_anti_slop_findings: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:10.000Z",
    results: [],
    ...overrides
  };
}

test("artifacts may only go to the two known locations", () => {
  assert.deepEqual([...FRONTEND_QA_ARTIFACT_LOCATIONS], ["system", "project"]);
});

test("the runner timeout is clamped into a workable range", () => {
  assert.equal(frontendQaTimeout(300000), 300000);
  assert.equal(frontendQaTimeout(1), 10000);
  assert.equal(frontendQaTimeout(0), 300000);
  assert.equal(frontendQaTimeout(undefined), 300000);
  assert.equal(frontendQaTimeout("nonsense"), 300000);
  assert.equal(frontendQaTimeout(60 * 60 * 1000), 20 * 60 * 1000);
});

test("the dev command prefers the caller, then the detected Dev command", () => {
  const detected = { commands: [{ label: "Dev", command: "npm run dev" }] };
  assert.equal(frontendQaDevCommand(detected, " pnpm dev "), "pnpm dev");
  assert.equal(frontendQaDevCommand(detected, ""), "npm run dev");
  assert.equal(frontendQaDevCommand({ commands: [{ label: "Dev", command: "Not detected" }] }, ""), "");
  assert.equal(frontendQaDevCommand({ commands: [{ label: "Test", command: "npm test" }] }, ""), "");
  assert.equal(frontendQaDevCommand({}, ""), "");
});

test("the runner input carries defaults and routes artifacts by location", () => {
  const base = {
    options: { artifact_location: "system", screenshot_dir: ".ai-dev/shots" },
    projectRoot: "/repo",
    devCommand: "npm run dev",
    configPath: ".ai-dev/frontend-qa.json",
    loadedConfigPath: "/repo/.ai-dev/frontend-qa.json",
    systemArtifactDir: "/state/artifacts/run"
  };
  const system = buildFrontendQaRunnerInput(base);
  assert.equal(system.project_path, "/repo");
  assert.equal(system.dev_command, "npm run dev");
  assert.equal(system.artifact_dir, "/state/artifacts/run");
  assert.equal(system.screenshot_dir, "");
  assert.equal(system.load_project_config, false);
  assert.equal(system.config_path, ".ai-dev/frontend-qa.json");
  assert.equal(system.loaded_config_path, "/repo/.ai-dev/frontend-qa.json");
  assert.deepEqual(system.routes, ["/"]);
  assert.equal(system.check_accessibility_axe, true);
  assert.equal(system.check_anti_slop, false);
  assert.equal(system.max_pixel_diff_ratio, 0.01);

  const project = buildFrontendQaRunnerInput({ ...base, options: { ...base.options, artifact_location: "project" } });
  assert.equal(project.artifact_dir, "");
  assert.equal(project.screenshot_dir, ".ai-dev/shots");
});

test("caller options override every runner default", () => {
  const input = buildFrontendQaRunnerInput({
    options: {
      artifact_location: "project",
      routes: ["/a", "/b"],
      viewports: [{ name: "wide", width: 1600, height: 900 }],
      scenarios: [{ name: "one" }],
      check_console: false,
      check_anti_slop: true,
      anti_slop_exceptions: [{ rule: "x" }],
      required_states: ["error"],
      visual_baseline_dir: "baselines",
      update_visual_baselines: true,
      max_pixel_diff_ratio: 0.5,
      scenario_timeout_ms: 1,
      take_screenshots: false,
      allowed_http_errors: [404],
      server_ready_timeout_ms: 5,
      navigation_timeout_ms: 6,
      app_subdir: "web",
      url: "http://127.0.0.1:3000",
      start_dev_server: false
    },
    projectRoot: "/repo",
    devCommand: "",
    configPath: "c.json",
    loadedConfigPath: "",
    systemArtifactDir: "/unused"
  });
  assert.deepEqual(input.routes, ["/a", "/b"]);
  assert.equal(input.check_console, false);
  assert.equal(input.check_anti_slop, true);
  assert.deepEqual(input.required_states, ["error"]);
  assert.equal(input.update_visual_baselines, true);
  assert.equal(input.take_screenshots, false);
  assert.deepEqual(input.allowed_http_errors, [404]);
  assert.equal(input.app_subdir, "web");
  assert.equal(input.start_dev_server, false);
});

test("a runner that never produced a result blocks rather than passing", () => {
  const failure = frontendQaRunnerFailure({
    projectRoot: "/repo",
    url: "http://127.0.0.1:3000",
    devCommand: "npm run dev",
    routes: ["/"],
    viewports: [],
    message: "spawn ENOENT",
    now: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(failure.gate, "block");
  assert.equal(failure.status, "runner_failed");
  assert.deepEqual(failure.setup_warnings, ["spawn ENOENT"]);
  assert.deepEqual(failure.results, []);
  assert.equal(failure.started_at, failure.finished_at);
});

test("the report keeps a runner's own Markdown untouched", () => {
  assert.equal(frontendQaReportMarkdown({ markdown: "# Their report\n" }), "# Their report\n");
});

test("the report summarises a run, escaping pipes so the table survives", () => {
  const markdown = frontendQaReportMarkdown({
    started_at: "2026-01-01T00:00:00.000Z",
    gate: "warn",
    status: "completed",
    project_path: "/repo",
    base_url: "http://127.0.0.1:3000",
    dev_command: "npm run dev",
    setup_warnings: ["axe unavailable"],
    results: [{ route: "/a|b", viewport: { name: "desktop" }, status: "pass", screenshot: "shots/a.png" }]
  });
  assert.match(markdown, /^# Frontend QA Report\n/);
  assert.match(markdown, /Gate: warn/);
  assert.match(markdown, /## Setup Warnings\n\n- axe unavailable/);
  assert.match(markdown, /\| \/a\\\|b \| desktop \| pass \| shots\/a\.png \|/);
});

test("a report with no results says so instead of rendering an empty table", () => {
  const markdown = frontendQaReportMarkdown({ gate: "block", results: [] });
  assert.match(markdown, /- No browser checks were run\./);
  assert.match(markdown, /Status: unknown/);
  assert.doesNotMatch(markdown, /\| Route \|/);
});

test("visual artifacts collect screenshots, baselines and diffs per state, deduplicated", () => {
  const artifacts = frontendQaVisualArtifacts({
    results: [{
      route: "/",
      viewport: { name: "desktop" },
      screenshot: "shots/desktop.png",
      visual: { baseline: "baselines/desktop.png", diff: "diffs/desktop.png" },
      scenarios: [
        { state: "success", screenshot: "shots/desktop-success.png", visual: { baseline: "baselines/desktop-success.png" } },
        { name: "named-only", screenshot: "shots/desktop.png" }
      ]
    }]
  });
  assert.deepEqual(artifacts.map((item) => [item.type, item.path, item.state]), [
    ["screenshot", "shots/desktop.png", "default"],
    ["baseline", "baselines/desktop.png", "default"],
    ["diff", "diffs/desktop.png", "default"],
    ["screenshot", "shots/desktop-success.png", "success"],
    ["baseline", "baselines/desktop-success.png", "success"]
  ]);
});

test("empty artifact paths are dropped and an empty run yields nothing", () => {
  assert.deepEqual(frontendQaVisualArtifacts({ results: [{ route: "/", screenshot: "  ", visual: {} }] }), []);
  assert.deepEqual(frontendQaVisualArtifacts({}), []);
});

test("viewport coverage is read from names, then from the 768px breakpoint", () => {
  assert.ok(frontendQaHasDesktopAndMobile({ viewports: [{ name: "Desktop HD" }, { name: "Mobile S" }] }));
  assert.ok(frontendQaHasDesktopAndMobile({ viewports: [{ name: "wide", width: 1440 }, { name: "narrow", width: 390 }] }));
  assert.ok(!frontendQaHasDesktopAndMobile({ viewports: [{ name: "wide", width: 1440 }, { name: "wider", width: 1920 }] }));
  assert.ok(!frontendQaHasDesktopAndMobile({ viewports: [] }));
  assert.ok(!frontendQaHasDesktopAndMobile({}));
});

test("a strict run passes only when every condition holds at once", () => {
  const { technicalPassed, visualRun } = evaluateStrictVisualRun({
    result: passingRun(),
    requiredStates: ["success"],
    runId: "visual-1",
    recordedAt: "2026-02-03T04:05:06.000Z"
  });
  assert.equal(technicalPassed, true);
  assert.equal(visualRun.status, "awaiting_review");
  assert.equal(visualRun.technical_status, "passed");
  assert.equal(visualRun.strict, true);
  assert.equal(visualRun.run_id, "visual-1");
  assert.equal(visualRun.recorded_at, "2026-02-03T04:05:06.000Z");
  assert.deepEqual(visualRun.required_states, ["success"]);
  assert.equal(visualRun.qa_started_at, "2026-01-01T00:00:00.000Z");
});

test("each failing condition alone fails the strict run", () => {
  const cases = [
    ["gate", { gate: "warn" }],
    ["viewports", { viewports: [{ name: "desktop", width: 1440 }] }],
    ["states", { state_coverage: { complete: false } }],
    ["baselines", { visual_baselines_complete: false }],
    ["anti-slop", { unwaived_anti_slop_findings: 2 }]
  ];
  for (const [label, overrides] of cases) {
    const { technicalPassed, visualRun } = evaluateStrictVisualRun({
      result: passingRun(overrides),
      requiredStates: ["success"],
      runId: "visual-1"
    });
    assert.equal(technicalPassed, false, label);
    assert.equal(visualRun.status, "failed", label);
    assert.equal(visualRun.technical_status, "failed", label);
  }
});

test("a run with no state coverage reported is not treated as covered", () => {
  const { technicalPassed, visualRun } = evaluateStrictVisualRun({
    result: passingRun({ state_coverage: undefined }),
    requiredStates: [],
    runId: "visual-1"
  });
  assert.equal(technicalPassed, false);
  assert.equal(visualRun.required_states_covered, false);
  assert.equal(visualRun.state_coverage, null);
});

test("review eligibility needs a run awaiting review and two different people", () => {
  const awaiting = { status: "awaiting_review" };
  assert.deepEqual(
    visualReviewEligibilityErrors({ run: awaiting, reviewer: "sam", implementer: "alex", scorecardErrors: [] }),
    []
  );
  assert.deepEqual(
    visualReviewEligibilityErrors({ run: null, reviewer: "sam", implementer: "alex", scorecardErrors: [] }),
    ["No strict Visual Reference QA run exists."]
  );
  assert.deepEqual(
    visualReviewEligibilityErrors({ run: { status: "passed" }, reviewer: "sam", implementer: "alex", scorecardErrors: [] }),
    ["Latest Visual Reference QA status is passed; expected awaiting_review."]
  );
  assert.deepEqual(
    visualReviewEligibilityErrors({ run: awaiting, reviewer: " ALEX ", implementer: "alex", scorecardErrors: [] }),
    ["Visual reviewer must be independent from the implementer."]
  );
  assert.deepEqual(
    visualReviewEligibilityErrors({ run: awaiting, reviewer: "", implementer: "", scorecardErrors: ["bad scorecard"] }),
    [
      "Frontend product state must name the implementer before independent review.",
      "Visual review requires a reviewer.",
      "bad scorecard"
    ]
  );
});

test("inspections are matched by path regardless of case or separator", () => {
  const index = visualInspectionIndex([
    { path: ".ai-dev\\Shots\\Desktop.PNG", inspection_method: "view_image", observations: "looked at it closely" }
  ]);
  assert.ok(index.get(".ai-dev/shots/desktop.png"));
  assert.equal(visualInspectionIndex(undefined).size, 0);
});

test("an inspection must exist, name a real method and say something concrete", () => {
  const artifact = { path: "shots/a.png" };
  assert.deepEqual(visualInspectionErrors(artifact, undefined), ["Missing visual inspection for artifact: shots/a.png."]);
  assert.deepEqual(
    visualInspectionErrors(artifact, { inspection_method: "view_image", observations: "hierarchy reads clearly" }),
    []
  );
  assert.deepEqual(
    visualInspectionErrors(artifact, { inspection_method: "guessed", observations: "short" }),
    ["Unsupported inspection method for shots/a.png.", "Visual inspection needs concrete observations for shots/a.png."]
  );
  for (const method of ["browser", "view_image", "human"]) {
    assert.deepEqual(visualInspectionErrors(artifact, { inspection_method: method, observations: "a real observation" }), []);
  }
});

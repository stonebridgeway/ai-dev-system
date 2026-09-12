/**
 * What a Frontend QA run means, without running one.
 *
 * `src/extensions/frontend-qa.mjs` spawns the browser runner and writes the
 * artifacts; everything here is a plain function over the options it was given
 * and the result it got back — the runner's input contract, the Markdown report,
 * the list of artifacts a reviewer has to look at, and the strict verdict that
 * decides whether a visual run may go to independent review.
 */
import { mdCell } from "./text-format.mjs";

/** Runner timeout floor and ceiling, whatever the caller asks for. */
const MIN_RUNNER_TIMEOUT_MS = 10_000;
const MAX_RUNNER_TIMEOUT_MS = 20 * 60 * 1000;

/** Where a run may put its screenshots. */
export const FRONTEND_QA_ARTIFACT_LOCATIONS = Object.freeze(["system", "project"]);

/** Clamp a caller's timeout into the range the runner is allowed to take. */
export function frontendQaTimeout(value) {
  return Math.max(MIN_RUNNER_TIMEOUT_MS, Math.min(Number(value) || 300000, MAX_RUNNER_TIMEOUT_MS));
}

/**
 * The dev-server command for a run: whatever the caller passed, else the "Dev"
 * command the project detector found, else nothing.
 *
 * @param {{ commands?: Array<{ label: string, command: string }> }} detected
 * @param {string} explicitCommand
 * @returns {string}
 */
export function frontendQaDevCommand(detected, explicitCommand) {
  const explicit = String(explicitCommand ?? "").trim();
  if (explicit) return explicit;
  const dev = detected.commands?.find((item) => item.label === "Dev" && item.command && item.command !== "Not detected");
  return dev?.command || "";
}

/**
 * The stdin contract for the browser runner.
 *
 * @param {object} input
 * @param {object} input.options - Project config merged under the call's arguments.
 * @param {string} input.projectRoot
 * @param {string} input.devCommand
 * @param {string} input.configPath - Config path the caller asked for.
 * @param {string} input.loadedConfigPath - Config actually read, or "".
 * @param {string} input.systemArtifactDir - Artifact directory for `system` runs.
 * @returns {object}
 */
export function buildFrontendQaRunnerInput({
  options,
  projectRoot,
  devCommand,
  configPath,
  loadedConfigPath,
  systemArtifactDir
}) {
  const {
    app_subdir = "",
    url = "",
    start_dev_server = true,
    routes = ["/"],
    viewports = [],
    scenarios = [],
    check_console = true,
    check_overflow = true,
    check_accessibility_basic = true,
    check_accessibility_axe = true,
    check_anti_slop = false,
    anti_slop_exceptions = [],
    required_states = [],
    check_visual_regression = true,
    visual_baseline_dir = "",
    update_visual_baselines = false,
    max_pixel_diff_ratio = 0.01,
    scenario_timeout_ms = 10000,
    take_screenshots = true,
    screenshot_dir = "",
    artifact_location = "system",
    allowed_http_errors = [],
    server_ready_timeout_ms = 60000,
    navigation_timeout_ms = 30000
  } = options;
  return {
    project_path: projectRoot,
    app_subdir,
    url,
    dev_command: devCommand,
    start_dev_server,
    routes,
    viewports,
    scenarios,
    check_console,
    check_overflow,
    check_accessibility_basic,
    check_accessibility_axe,
    check_anti_slop,
    anti_slop_exceptions,
    required_states,
    check_visual_regression,
    visual_baseline_dir,
    update_visual_baselines,
    max_pixel_diff_ratio,
    scenario_timeout_ms,
    load_project_config: false,
    config_path: configPath,
    loaded_config_path: loadedConfigPath,
    take_screenshots,
    screenshot_dir: artifact_location === "project" ? screenshot_dir : "",
    artifact_dir: artifact_location === "system" ? systemArtifactDir : "",
    allowed_http_errors,
    server_ready_timeout_ms,
    navigation_timeout_ms
  };
}

/**
 * The result to report when the runner never produced one. A run that could not
 * start blocks rather than passing quietly.
 *
 * @param {object} input
 * @returns {object}
 */
export function frontendQaRunnerFailure({
  projectRoot, url, devCommand, routes, viewports, message, now = new Date().toISOString()
}) {
  return {
    gate: "block",
    status: "runner_failed",
    started_at: now,
    finished_at: now,
    project_path: projectRoot,
    base_url: url,
    dev_command: devCommand,
    routes,
    viewports,
    screenshots: [],
    setup_warnings: [message],
    results: []
  };
}

/**
 * Render the run's Markdown report. A runner that produced its own Markdown
 * keeps it; otherwise the result is summarised from its fields.
 *
 * @param {object} result
 * @returns {string}
 */
export function frontendQaReportMarkdown(result) {
  if (result.markdown && typeof result.markdown === "string") return result.markdown;
  const lines = [
    "# Frontend QA Report",
    "",
    `Generated: ${result.started_at || new Date().toISOString()}`,
    `Gate: ${result.gate || "warn"}`,
    `Status: ${result.status || "unknown"}`,
    `Project path: \`${result.project_path || ""}\``,
    result.base_url ? `Base URL: ${result.base_url}` : "",
    result.dev_command ? `Dev command: \`${result.dev_command}\`` : ""
  ].filter(Boolean);

  if (result.setup_warnings?.length) {
    lines.push("", "## Setup Warnings", "");
    for (const item of result.setup_warnings) lines.push(`- ${item}`);
  }
  if (result.results?.length) {
    lines.push("", "## Results", "", "| Route | Viewport | Status | Screenshot |", "| --- | --- | --- | --- |");
    for (const item of result.results) {
      lines.push(`| ${mdCell(item.route)} | ${mdCell(item.viewport?.name || "")} | ${mdCell(item.status)} | ${mdCell(item.screenshot || "")} |`);
    }
  }
  if (!result.results?.length) {
    lines.push("", "## Results", "", "- No browser checks were run.");
  }
  return lines.join("\n");
}

/**
 * Every artifact a visual review has to look at: each screenshot, the baseline
 * it was compared against and the diff between them, per route, viewport and
 * state, deduplicated by path.
 *
 * @param {object} result
 * @returns {Array<{ path: string, type: string, route?: string, viewport?: string, state?: string }>}
 */
export function frontendQaVisualArtifacts(result) {
  const artifacts = [];
  const add = (artifactPath, type, context = {}) => {
    const value = String(artifactPath || "").trim();
    if (!value) return;
    artifacts.push({ path: value, type, ...context });
  };
  for (const item of result.results || []) {
    const context = {
      route: item.route,
      viewport: item.viewport?.name || "",
      state: "default"
    };
    add(item.screenshot, "screenshot", context);
    add(item.visual?.baseline, "baseline", context);
    add(item.visual?.diff, "diff", context);
    for (const scenario of item.scenarios || []) {
      const scenarioContext = {
        route: item.route,
        viewport: item.viewport?.name || "",
        state: scenario.state || scenario.name || ""
      };
      add(scenario.screenshot, "screenshot", scenarioContext);
      add(scenario.visual?.baseline, "baseline", scenarioContext);
      add(scenario.visual?.diff, "diff", scenarioContext);
    }
  }
  const seen = new Set();
  return artifacts.filter((artifact) => {
    const key = `${artifact.type}:${artifact.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether the run covered both a wide and a narrow viewport — by name, or by
 * the 768-pixel breakpoint when the names say nothing.
 *
 * @param {object} result
 * @returns {boolean}
 */
export function frontendQaHasDesktopAndMobile(result) {
  const viewports = result.viewports || [];
  const names = viewports.map((item) => String(item.name || "").toLowerCase());
  return (
    (names.some((name) => name.includes("desktop")) && names.some((name) => name.includes("mobile"))) ||
    (viewports.some((item) => Number(item.width) >= 768) && viewports.some((item) => Number(item.width) < 768))
  );
}

/**
 * The strict verdict on a Visual Reference QA run, and the record the product
 * state keeps for it.
 *
 * Technical pass is every condition at once: the browser gate passed, both
 * viewport classes were covered, every required state was exercised, every
 * approved baseline was compared, and no anti-slop finding went unwaived.
 * Passing only means the run has earned a human review, never that it is done.
 *
 * @param {object} input
 * @param {object} input.result - The Frontend QA result.
 * @param {string[]} input.requiredStates
 * @param {string} input.runId
 * @param {string} [input.recordedAt]
 * @returns {{ technicalPassed: boolean, visualRun: object }}
 */
export function evaluateStrictVisualRun({
  result,
  requiredStates,
  runId,
  recordedAt = new Date().toISOString()
}) {
  const artifacts = frontendQaVisualArtifacts(result);
  const desktopAndMobile = frontendQaHasDesktopAndMobile(result);
  const requiredStatesCovered = result.state_coverage?.complete === true;
  const baselinesComplete = result.visual_baselines_complete === true;
  const unwaivedAntiSlopFindings = Number(result.unwaived_anti_slop_findings || 0);
  const technicalPassed = result.gate === "pass" &&
    desktopAndMobile &&
    requiredStatesCovered &&
    baselinesComplete &&
    unwaivedAntiSlopFindings === 0;
  return {
    technicalPassed,
    visualRun: {
      run_id: runId,
      status: technicalPassed ? "awaiting_review" : "failed",
      technical_status: technicalPassed ? "passed" : "failed",
      strict: true,
      desktop_and_mobile: desktopAndMobile,
      required_states_covered: requiredStatesCovered,
      baselines_complete: baselinesComplete,
      unwaived_anti_slop_findings: unwaivedAntiSlopFindings,
      required_states: requiredStates,
      state_coverage: result.state_coverage || null,
      artifacts,
      report_file: result.report_file || "",
      artifact_dir: result.artifact_dir || "",
      qa_started_at: result.started_at,
      qa_finished_at: result.finished_at,
      recorded_at: recordedAt
    }
  };
}

/**
 * Everything wrong with a submitted visual review, before any artifact is read.
 *
 * The independence rule is the point of the whole gate: whoever built the screen
 * cannot be the one who signs off on how it looks.
 *
 * @param {object} input
 * @param {object|null} input.run - The latest visual run.
 * @param {string} input.reviewer
 * @param {string} input.implementer
 * @param {string[]} input.scorecardErrors - From `validateProductDesignScorecard`.
 * @returns {string[]}
 */
export function visualReviewEligibilityErrors({ run, reviewer, implementer, scorecardErrors }) {
  const errors = [];
  if (!run) errors.push("No strict Visual Reference QA run exists.");
  else if (run.status !== "awaiting_review") {
    errors.push(`Latest Visual Reference QA status is ${run.status}; expected awaiting_review.`);
  }
  const reviewerName = String(reviewer || "").trim();
  const implementerName = String(implementer || "").trim();
  if (!implementerName) {
    errors.push("Frontend product state must name the implementer before independent review.");
  }
  if (!reviewerName) errors.push("Visual review requires a reviewer.");
  if (
    reviewerName &&
    implementerName &&
    reviewerName.toLowerCase() === implementerName.toLowerCase()
  ) {
    errors.push("Visual reviewer must be independent from the implementer.");
  }
  errors.push(...scorecardErrors);
  return errors;
}

/** Index an inspection list by artifact path, case- and separator-insensitively. */
export function visualInspectionIndex(inspections) {
  return new Map((inspections || []).map((inspection) => [
    String(inspection?.path || "").replaceAll("\\", "/").toLowerCase(),
    inspection
  ]));
}

/**
 * Whether one artifact's inspection is usable evidence: it exists, it says how
 * the artifact was looked at, and it says something concrete about it.
 *
 * @param {{ path: string }} artifact
 * @param {object|undefined} inspection
 * @returns {string[]}
 */
export function visualInspectionErrors(artifact, inspection) {
  if (!inspection) return [`Missing visual inspection for artifact: ${artifact.path}.`];
  const errors = [];
  if (!["browser", "view_image", "human"].includes(String(inspection.inspection_method || ""))) {
    errors.push(`Unsupported inspection method for ${artifact.path}.`);
  }
  if (String(inspection.observations || "").trim().length < 10) {
    errors.push(`Visual inspection needs concrete observations for ${artifact.path}.`);
  }
  return errors;
}

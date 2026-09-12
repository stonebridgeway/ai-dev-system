/**
 * Browser evidence for a frontend change, and the independent review of it.
 *
 * `run_frontend_qa` drives the Playwright runner and reports what it found.
 * `run_visual_reference_qa` is the strict form of the same run, gated on the
 * product being ready for implementation and judged against the approved visual
 * baselines. `record_visual_review` closes the loop: a named reviewer who is not
 * the implementer states what they saw in every artifact, and the artifacts are
 * hashed as they are reviewed so a later edit cannot pass as reviewed.
 *
 * Spawning the runner, writing artifacts and updating the project card happen
 * here through `host`; the runner's input contract, the report, the artifact
 * list and the strict verdict are pure functions in
 * `src/core/frontend-qa-report.mjs`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileWithInput } from "../core/input-process-runner.mjs";
import { atomicWriteFile } from "../core/atomic-files.mjs";
import { slugPart, stripBom } from "../core/text-format.mjs";
import {
  FRONTEND_PRODUCT_PATHS,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS,
  evaluateFrontendProductGate,
  validateProductDesignScorecard
} from "../core/frontend-product-quality.mjs";
import {
  FRONTEND_QA_ARTIFACT_LOCATIONS,
  buildFrontendQaRunnerInput,
  evaluateStrictVisualRun,
  frontendQaDevCommand,
  frontendQaReportMarkdown,
  frontendQaRunnerFailure,
  frontendQaTimeout,
  visualInspectionErrors,
  visualInspectionIndex,
  visualReviewEligibilityErrors
} from "../core/frontend-qa-report.mjs";

/** Default location of a project's checked-in Frontend QA configuration. */
const DEFAULT_CONFIG_PATH = ".ai-dev/frontend-qa.json";

/**
 * Run the browser QA suite against a project.
 *
 * A runner that fails to produce a result is reported as a blocking run rather
 * than an exception: a missing browser is a finding, not a crash.
 */
async function runFrontendQa(host, rawOptions = {}) {
  const projectRoot = await host.safeProjectRoot(rawOptions.project_path);
  const requestedConfigPath = String(rawOptions.config_path || DEFAULT_CONFIG_PATH);
  let projectConfig = {};
  let loadedConfigPath = "";
  if (rawOptions.load_project_config !== false) {
    const candidate = host.safeProjectFile(projectRoot, requestedConfigPath);
    if (await host.pathExists(candidate)) {
      projectConfig = JSON.parse(stripBom(await fs.readFile(candidate, "utf8")));
      if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
        throw new Error(`Frontend QA config must be a JSON object: ${candidate}`);
      }
      loadedConfigPath = candidate;
    }
  }
  const options = { ...projectConfig, ...rawOptions };
  const {
    project_name,
    app_subdir = "",
    url = "",
    routes = ["/"],
    viewports = [],
    artifact_location = "system",
    write_report = true,
    update_registry = true,
    register_if_missing = false,
    timeout_ms = 300000
  } = options;
  if (!(await host.pathExists(host.frontendQaRunnerPath))) {
    throw new Error(`Frontend QA runner not found: ${host.frontendQaRunnerPath}`);
  }

  if (!FRONTEND_QA_ARTIFACT_LOCATIONS.includes(artifact_location)) {
    throw new Error("artifact_location must be system or project.");
  }
  const workingDirectory = await host.safeProjectSubdir(projectRoot, app_subdir);
  let registeredCard = null;
  try {
    registeredCard = await host.findProjectCard(projectRoot);
  } catch {
    registeredCard = null;
  }
  const resolvedProjectName = project_name || registeredCard?.name || path.basename(projectRoot);
  const detected = await host.detectProject(workingDirectory, resolvedProjectName);
  const resolvedDevCommand = frontendQaDevCommand(detected, options.dev_command);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const systemArtifactDir = path.join(
    host.frontendQaArtifactsRoot,
    slugPart(resolvedProjectName, "project"),
    runId
  );
  const input = buildFrontendQaRunnerInput({
    options,
    projectRoot,
    devCommand: resolvedDevCommand,
    configPath: requestedConfigPath,
    loadedConfigPath,
    systemArtifactDir
  });

  let result = null;
  try {
    const output = await execFileWithInput(
      process.execPath,
      [host.frontendQaRunnerPath],
      JSON.stringify(input),
      {
        cwd: projectRoot,
        timeoutMs: frontendQaTimeout(timeout_ms),
        env: { AI_DEV_FRONTEND_QA_ARTIFACT_ROOT: host.frontendQaArtifactsRoot }
      }
    );
    result = JSON.parse(output.stdout);
    if (output.stderr?.trim()) {
      result.setup_warnings = [
        ...(result.setup_warnings || []),
        `Runner stderr: ${host.truncateOutput(output.stderr, 1200)}`
      ];
      if (result.gate === "pass") result.gate = "warn";
    }
  } catch (err) {
    result = frontendQaRunnerFailure({
      projectRoot,
      url,
      devCommand: resolvedDevCommand,
      routes,
      viewports,
      message: err instanceof Error ? err.message : String(err)
    });
  }

  result.project_name = resolvedProjectName;
  result.detected_stack = detected.stack;
  result.app_subdir = app_subdir;
  result.artifact_location = artifact_location;
  result.dev_command = result.dev_command || resolvedDevCommand;
  result.markdown = frontendQaReportMarkdown(result);

  if (write_report) {
    if (artifact_location === "system") {
      const reportPath = path.join(systemArtifactDir, "frontend-qa-report.md");
      await atomicWriteFile(
        reportPath,
        result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`,
        "utf8"
      );
      result.report_file = reportPath;
    } else {
      result.report_file = await host.writeProjectFile(projectRoot, ".ai-dev/frontend-qa-report.md", result.markdown, true);
    }
  }

  if (update_registry) {
    try {
      const card = registeredCard || await host.findProjectCard(projectRoot);
      const report = await host.updateProjectCard({
        name: card.name,
        section: "Last Frontend QA Run",
        mode: "replace",
        content: result.markdown,
        update_index: false
      });
      const synced = await host.syncProjectCard({
        project_path: projectRoot,
        create_if_missing: false,
        update_index: true
      });
      result.registry = { report, synced };
    } catch (err) {
      if (!register_if_missing) {
        result.registry = { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
      } else {
        result.registry = await host.registerProject({
          project_path: projectRoot,
          status: "registered via run_frontend_qa",
          description: "Registered automatically while running frontend QA.",
          notes: result.markdown,
          overwrite: false
        });
      }
    }
  }

  return result;
}

/**
 * The strict visual run: browser QA with every check on, compared against the
 * approved baselines, behind the implementation gate.
 *
 * Passing does not finish anything. It moves the product to `visual-review` and
 * names the artifacts a human has to look at; `record_visual_review` is what
 * closes it.
 */
async function runVisualReferenceQa(host, rawOptions = {}) {
  const projectRoot = await host.safeProjectRoot(rawOptions.project_path);
  const state = await host.readFrontendProductState(projectRoot);
  const documentHashes = await host.frontendProductDocumentHashes(projectRoot).catch(() => ({}));
  const implementationGate = evaluateFrontendProductGate(state, {
    gate: "implementation",
    currentDocumentHashes: documentHashes
  });
  if (!implementationGate.ok) {
    return {
      action: "rejected",
      project_path: projectRoot,
      reason: "implementation_gate_failed",
      implementation_gate: implementationGate
    };
  }

  const requiredStates = state.context?.required_states || [];
  const result = await runFrontendQa(host, {
    ...rawOptions,
    project_path: projectRoot,
    check_console: true,
    check_overflow: true,
    check_accessibility_basic: true,
    check_accessibility_axe: true,
    check_anti_slop: true,
    anti_slop_exceptions: state.anti_slop_exceptions || [],
    required_states: requiredStates,
    check_visual_regression: true,
    visual_baseline_dir: FRONTEND_PRODUCT_PATHS.approvedReferences,
    update_visual_baselines: false,
    take_screenshots: true,
    update_registry: false,
    register_if_missing: false
  });
  const runId = `visual-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const { technicalPassed, visualRun } = evaluateStrictVisualRun({ result, requiredStates, runId });
  const saved = await host.writeFrontendProductState(projectRoot, {
    ...state,
    phase: technicalPassed ? "visual-review" : "visual-qa-failed",
    latest_visual_run: visualRun,
    visual_reviews: []
  });
  return {
    action: technicalPassed ? "awaiting_visual_review" : "visual_qa_failed",
    project_path: projectRoot,
    run_id: runId,
    phase: saved.phase,
    technical_passed: technicalPassed,
    strict_checks: {
      desktop_and_mobile: visualRun.desktop_and_mobile,
      required_states_covered: visualRun.required_states_covered,
      baselines_complete: visualRun.baselines_complete,
      unwaived_anti_slop_findings: visualRun.unwaived_anti_slop_findings
    },
    required_review_artifacts: visualRun.artifacts,
    qa: result,
    next_step: technicalPassed
      ? "Inspect every listed artifact and call record_visual_review with the ten-dimension scorecard."
      : "Fix the blocking evidence, preserve approved baselines, and rerun strict visual QA."
  };
}

/**
 * Record the independent visual review of a strict run.
 *
 * Every artifact is hashed as it is reviewed, so `frontend_product_gate` can
 * tell later whether the files still match what the reviewer saw.
 */
async function recordVisualReview(host, {
  project_path,
  reviewer,
  reviewer_role = "",
  inspections = [],
  scorecard
} = {}) {
  const projectRoot = await host.resolveTaskProjectRoot(project_path);
  const state = await host.readFrontendProductState(projectRoot);
  const run = state.latest_visual_run;
  const errors = visualReviewEligibilityErrors({
    run,
    reviewer,
    implementer: state.implementer,
    scorecardErrors: validateProductDesignScorecard(scorecard)
  });

  const inspectionMap = visualInspectionIndex(inspections);
  const reviewedArtifacts = [];
  for (const artifact of run?.artifacts || []) {
    const key = String(artifact.path).replaceAll("\\", "/").toLowerCase();
    const inspection = inspectionMap.get(key);
    const inspectionErrors = visualInspectionErrors(artifact, inspection);
    errors.push(...inspectionErrors);
    if (!inspection) continue;
    try {
      const absolute = host.resolveFrontendReviewArtifact(projectRoot, artifact.path);
      const content = await fs.readFile(absolute);
      reviewedArtifacts.push({
        ...artifact,
        absolute_path: absolute,
        sha256: host.sha256(content),
        inspection_method: String(inspection.inspection_method || ""),
        observations: String(inspection.observations || "").trim()
      });
    } catch (error) {
      errors.push(`Could not hash reviewed artifact ${artifact.path}: ${error.message}`);
    }
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      run_id: run?.run_id || "",
      errors
    };
  }

  const review = {
    review_id: `visual-review-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    run_id: run.run_id,
    reviewer: String(reviewer || "").trim(),
    reviewer_role: String(reviewer_role || "").trim(),
    independent: true,
    artifact_hashes_current: true,
    artifacts: reviewedArtifacts,
    scorecard,
    reviewed_at: new Date().toISOString()
  };
  const saved = await host.writeFrontendProductState(projectRoot, {
    ...state,
    phase: "handoff-ready",
    latest_visual_run: {
      ...run,
      status: "passed",
      reviewed_at: review.reviewed_at,
      review_id: review.review_id
    },
    visual_reviews: [...(state.visual_reviews || []), review]
  });
  const documentHashes = await host.frontendProductDocumentHashes(projectRoot);
  return {
    action: "visual_review_recorded",
    project_path: projectRoot,
    phase: saved.phase,
    review,
    handoff_gate: evaluateFrontendProductGate(saved, {
      gate: "handoff",
      currentDocumentHashes: documentHashes
    })
  };
}

/**
 * Frontend QA and visual review tools.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createFrontendQaTools(host) {
  return {
    definitions: [
  {
    name: "run_frontend_qa",
    description: "Run browser-based frontend QA with Playwright: desktop/mobile screenshots, interaction scenarios, console/network errors, overflow, axe accessibility, and visual regression baselines.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        app_subdir: { type: "string", description: "Safe project-relative frontend directory such as frontend or apps/web." },
        url: { type: "string" },
        dev_command: { type: "string" },
        start_dev_server: { type: "boolean", default: true },
        routes: {
          type: "array",
          items: { type: "string" },
          default: ["/"]
        },
        viewports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              width: { type: "number" },
              height: { type: "number" }
            }
          },
          default: []
        },
        scenarios: {
          type: "array",
          description: "Optional route-bound interaction journeys. Supported actions: click, fill, press, check, uncheck, select, hover, wait_for, wait, expect_visible, expect_text, expect_url.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              state: { type: "string", description: "Stable UI state name such as loading, empty, error, or success." },
              route: { type: "string", default: "/" },
              capture_screenshot: { type: "boolean", default: true },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    action: { type: "string" },
                    selector: { type: "string" },
                    value: {},
                    text: { type: "string" },
                    key: { type: "string" },
                    contains: { type: "string" },
                    timeout_ms: { type: "number" }
                  },
                  required: ["action"]
                }
              }
            },
            required: ["name", "actions"]
          },
          default: []
        },
        check_console: { type: "boolean", default: true },
        check_overflow: { type: "boolean", default: true },
        check_accessibility_basic: { type: "boolean", default: true },
        check_accessibility_axe: { type: "boolean", default: true },
        check_anti_slop: { type: "boolean", default: false },
        anti_slop_exceptions: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  rule_id: { type: "string" },
                  rationale: { type: "string" },
                  approver: { type: "string" }
                },
                required: ["rule_id"]
              }
            ]
          }
        },
        required_states: {
          type: "array",
          items: { type: "string" },
          default: []
        },
        check_visual_regression: { type: "boolean", default: true },
        visual_baseline_dir: { type: "string", description: "Project-relative baseline directory, or an absolute path inside approved artifact roots." },
        update_visual_baselines: { type: "boolean", default: false, description: "Explicitly replace visual baselines with this run's screenshots." },
        max_pixel_diff_ratio: { type: "number", default: 0.01 },
        scenario_timeout_ms: { type: "number", default: 10000 },
        load_project_config: { type: "boolean", default: true },
        config_path: { type: "string", default: ".ai-dev/frontend-qa.json" },
        take_screenshots: { type: "boolean", default: true },
        screenshot_dir: { type: "string" },
        artifact_location: { type: "string", enum: ["system", "project"], default: "system" },
        allowed_http_errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url_pattern: { type: "string" }
            },
            required: ["status", "url_pattern"]
          },
          default: []
        },
        write_report: { type: "boolean", default: true },
        update_registry: { type: "boolean", default: true },
        register_if_missing: { type: "boolean", default: false },
        server_ready_timeout_ms: { type: "number", default: 60000 },
        navigation_timeout_ms: { type: "number", default: 30000 },
        timeout_ms: { type: "number", default: 300000 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "run_visual_reference_qa",
    description: "Run strict desktop/mobile Playwright QA against approved visual baselines, capture every required UI state, evaluate anti-slop rules, and wait for independent visual review.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        project_name: { type: "string" },
        app_subdir: { type: "string" },
        url: { type: "string" },
        dev_command: { type: "string" },
        start_dev_server: { type: "boolean", default: true },
        routes: { type: "array", items: { type: "string" }, default: ["/"] },
        viewports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              width: { type: "number" },
              height: { type: "number" }
            },
            required: ["name", "width", "height"]
          }
        },
        scenarios: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              state: { type: "string" },
              route: { type: "string", default: "/" },
              capture_screenshot: { type: "boolean", default: true },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    action: { type: "string" },
                    selector: { type: "string" },
                    value: {},
                    text: { type: "string" },
                    key: { type: "string" },
                    contains: { type: "string" },
                    timeout_ms: { type: "number" }
                  },
                  required: ["action"]
                }
              }
            },
            required: ["name", "state", "actions"]
          }
        },
        max_pixel_diff_ratio: { type: "number", default: 0.01 },
        allowed_http_errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "number" },
              url_pattern: { type: "string" }
            },
            required: ["status", "url_pattern"]
          }
        },
        server_ready_timeout_ms: { type: "number", default: 60000 },
        navigation_timeout_ms: { type: "number", default: 30000 },
        timeout_ms: { type: "number", default: 300000 }
      },
      required: ["project_path"]
    }
  },
  {
    name: "record_visual_review",
    description: "Record independent, hash-bound inspection of every screenshot, baseline, and diff plus a ten-dimension Product Design Scorecard. No overall score is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string" },
        reviewer: { type: "string" },
        reviewer_role: { type: "string" },
        inspections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              inspection_method: { type: "string", enum: ["browser", "view_image", "human"] },
              observations: { type: "string" }
            },
            required: ["path", "inspection_method", "observations"]
          }
        },
        scorecard: {
          type: "object",
          properties: Object.fromEntries(PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => [
            dimension.id,
            {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pass", "fail"] },
                score: { type: "integer", minimum: 1, maximum: 5 },
                evidence: { type: "string" },
                findings: { type: "array", items: { type: "string" } }
              },
              required: ["status", "score", "evidence", "findings"]
            }
          ])),
          required: PRODUCT_DESIGN_SCORECARD_DIMENSIONS.map((dimension) => dimension.id),
          additionalProperties: false
        }
      },
      required: ["project_path", "reviewer", "inspections", "scorecard"]
    }
  }
    ],
    handlers: {
      run_frontend_qa: (args) => runFrontendQa(host, args),
      run_visual_reference_qa: (args) => runVisualReferenceQa(host, args),
      record_visual_review: (args) => recordVisualReview(host, args)
    }
  };
}

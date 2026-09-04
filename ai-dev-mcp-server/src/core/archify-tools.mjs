import fs from "node:fs/promises";
import path from "node:path";
import { ARCHIFY_TYPES, archifyCliPath, runArchify } from "./archify.mjs";
import { atomicWriteFile } from "./atomic-files.mjs";
import { isPathInside } from "./path-policy.mjs";

/**
 * Build the `archify_*` MCP tool handlers. The host injects vault paths and the
 * few path-safety helpers so this module carries no server state of its own.
 *
 * @param {{
 *   vaultRoot: string,
 *   archifyArtifactsRoot: string,
 *   safeProjectRoot: (p: string) => Promise<string>,
 *   safeProjectFile: (root: string, rel: string) => string,
 *   slugPart: (value: string, fallback?: string) => string,
 *   readJsonIfExists: (target: string) => Promise<object | null>
 * }} deps
 */
export function createArchifyTools({
  vaultRoot,
  archifyArtifactsRoot,
  safeProjectRoot,
  safeProjectFile,
  slugPart,
  readJsonIfExists
}) {
  function assertArchifyType(value) {
    if (!ARCHIFY_TYPES.includes(value)) throw new Error(`diagram_type must be one of: ${ARCHIFY_TYPES.join(", ")}.`);
    return value;
  }

  function archifyRunId() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  async function archifyWorkspace({ project_path, artifact_location = "system" }) {
    if (!["system", "project"].includes(artifact_location)) throw new Error("artifact_location must be system or project.");
    const projectRoot = project_path ? await safeProjectRoot(project_path) : "";
    if (artifact_location === "project" && !projectRoot) throw new Error("project_path is required when artifact_location is project.");
    const runId = archifyRunId();
    const projectSlug = slugPart(projectRoot ? path.basename(projectRoot) : "vault", "project");
    const runDir = artifact_location === "system"
      ? path.join(archifyArtifactsRoot, projectSlug, runId)
      : safeProjectFile(projectRoot, `.ai-dev/archify/artifacts/${runId}`);
    await fs.mkdir(runDir, { recursive: true });
    return { artifact_location, projectRoot, projectSlug, runId, runDir };
  }

  function archifyProjectPath(projectRoot, candidate, label) {
    if (!candidate || typeof candidate !== "string") throw new Error(`${label} is required.`);
    if (path.isAbsolute(candidate)) {
      const resolved = path.resolve(candidate);
      // Absolute inputs must stay inside a known sandbox: the caller's project,
      // the Archify run directory, or (when no project is given) the vault.
      const roots = projectRoot
        ? [projectRoot, archifyArtifactsRoot]
        : [archifyArtifactsRoot, vaultRoot];
      if (!roots.some((root) => resolved === root || isPathInside(root, resolved))) {
        throw new Error(`${label} must be inside ${projectRoot ? "project_path" : "the vault"} or the Archify run directory.`);
      }
      return resolved;
    }
    if (!projectRoot) throw new Error(`${label} must be absolute when project_path is not provided.`);
    return safeProjectFile(projectRoot, candidate);
  }

  async function resolveArchifySpec({ spec, spec_path, diagram_type, workspace }) {
    const hasSpec = spec !== undefined && spec !== null;
    const hasSpecPath = typeof spec_path === "string" && spec_path.trim();
    if (hasSpec === hasSpecPath) throw new Error("Provide exactly one of spec or spec_path.");
    if (hasSpec) {
      if (typeof spec !== "object" || Array.isArray(spec)) throw new Error("spec must be a JSON object.");
      const target = path.join(workspace.runDir, `${workspace.projectSlug}.${diagram_type}.json`);
      await atomicWriteFile(target, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
      return target;
    }
    return archifyProjectPath(workspace.projectRoot, spec_path, "spec_path");
  }

  function archifyOutputPath({ workspace, output_path, defaultName }) {
    if (workspace.artifact_location === "system") {
      if (output_path) throw new Error("output_path is only supported with artifact_location=project.");
      return path.join(workspace.runDir, defaultName);
    }
    return archifyProjectPath(workspace.projectRoot, output_path, "output_path");
  }

  function archifyArgsWithQuality(args, quality = "showcase", projectRoot = "") {
    if (!["standard", "showcase"].includes(quality)) throw new Error("quality must be standard or showcase.");
    return [...args, "--quality", quality, ...(projectRoot ? ["--repo-root", projectRoot] : [])];
  }

  function archifyFailure(result, details = {}) {
    return {
      status: "failed",
      exit: result.exitCode,
      timed_out: result.timedOut,
      diagnostics: Array.isArray(result.json?.diagnostics) ? result.json.diagnostics : [],
      error: result.json?.error || result.stderr.trim() || result.stdout.trim() || "Archify command failed.",
      stderr: result.stderr,
      ...details
    };
  }

  function archifySuccess(result, details = {}) {
    return { status: "success", exit: result.exitCode, timed_out: result.timedOut, stdout: result.stdout, ...details };
  }

  async function executeArchify({ args, workspace, details = {}, timeoutMs = 120000 }) {
    const result = await runArchify({ vaultRoot, args, cwd: workspace?.projectRoot || workspace?.runDir || vaultRoot, timeoutMs });
    const commandFailed = !result.ok || result.json?.ok === false;
    return { result, response: commandFailed ? archifyFailure(result, details) : archifySuccess(result, details) };
  }

  async function archifyDoctor() {
    const workspace = await archifyWorkspace({ artifact_location: "system" });
    const { result, response } = await executeArchify({
      args: ["doctor"],
      workspace,
      details: {
        cli_path: archifyCliPath(vaultRoot),
        chrome_path: process.env.ARCHIFY_CHROME || "",
        skill_version: (await readJsonIfExists(path.join(vaultRoot, "03-skills-catalog", "sources", "external", "archify", "upstream.json")))?.commit || ""
      }
    });
    return { ...response, ...(result.ok ? { checks: result.stdout } : {}) };
  }

  async function archifyGuide({ scenario, lang = "en" }) {
    if (!scenario || typeof scenario !== "string") throw new Error("scenario is required.");
    if (!["en", "zh"].includes(lang)) throw new Error("lang must be en or zh.");
    const workspace = await archifyWorkspace({ artifact_location: "system" });
    const { response, result } = await executeArchify({ args: ["guide", scenario, "--lang", lang, "--json"], workspace });
    return { ...response, ...(result.json ? { recommendation: result.json } : {}) };
  }

  async function archifyValidate(args) {
    const diagramType = assertArchifyType(args.diagram_type);
    const workspace = await archifyWorkspace(args);
    const specPath = await resolveArchifySpec({ ...args, diagram_type: diagramType, workspace });
    const command = archifyArgsWithQuality(["validate", diagramType, specPath, "--json", ...(args.layout_json ? ["--layout-json"] : [])], args.quality, workspace.projectRoot);
    const { response, result } = await executeArchify({ args: command, workspace, details: { diagram_type: diagramType, spec_path: specPath, run_dir: workspace.runDir, artifact_location: workspace.artifact_location } });
    return { ...response, ...(result.json ? { validation: result.json, diagnostics: result.json.diagnostics || response.diagnostics || [] } : {}) };
  }

  async function archifyRender(args) {
    const diagramType = assertArchifyType(args.diagram_type);
    const workspace = await archifyWorkspace(args);
    const specPath = await resolveArchifySpec({ ...args, diagram_type: diagramType, workspace });
    const outputPath = archifyOutputPath({ workspace, output_path: args.output_path, defaultName: `${workspace.projectSlug}.${diagramType}.html` });
    const command = archifyArgsWithQuality(["render", diagramType, specPath, outputPath], args.quality, workspace.projectRoot);
    const { response } = await executeArchify({ args: command, workspace, details: { diagram_type: diagramType, spec_path: specPath, html_path: outputPath, run_dir: workspace.runDir, artifact_location: workspace.artifact_location } });
    return response;
  }

  function archifyDeliveryReport(receipt, response) {
    const lines = [
      "# Archify Delivery Report",
      "",
      `Status: ${response.status}`,
      `HTML: \`${receipt?.output || response.html_path || ""}\``,
      receipt?.specification?.sha256 ? `Specification SHA-256: \`${receipt.specification.sha256}\`` : "",
      receipt?.artifact?.sha256 ? `Artifact SHA-256: \`${receipt.artifact.sha256}\`` : "",
      receipt?.validation ? `Validation: ${receipt.validation.checksPassed}/${receipt.validation.checkCount} checks; ${receipt.validation.errors} errors, ${receipt.validation.warnings} warnings.` : ""
    ].filter(Boolean);
    return `${lines.join("\n")}\n`;
  }

  async function archifyDeliver(args) {
    const diagramType = assertArchifyType(args.diagram_type);
    const workspace = await archifyWorkspace(args);
    const specPath = await resolveArchifySpec({ ...args, diagram_type: diagramType, workspace });
    const outputPath = archifyOutputPath({ workspace, output_path: args.output_path, defaultName: `${workspace.projectSlug}.${diagramType}.html` });
    const command = archifyArgsWithQuality(["deliver", diagramType, specPath, outputPath, "--json", ...(args.open ? ["--open"] : [])], args.quality, workspace.projectRoot);
    const { response, result } = await executeArchify({ args: command, workspace, details: { diagram_type: diagramType, spec_path: specPath, html_path: outputPath, run_dir: workspace.runDir, artifact_location: workspace.artifact_location } });
    if (response.status !== "success") return response;
    const receipt = result.json;
    const reportPath = path.join(workspace.runDir, "report.md");
    await atomicWriteFile(reportPath, archifyDeliveryReport(receipt, response), "utf8");
    // Ready-to-pass evidence for verify_task / complete_task — the agent should
    // not have to reassemble it from the raw receipt.
    const evidence = receipt?.ok
      ? {
          kind: "archify_deliver",
          html_path: workspace.artifact_location === "project"
            ? path.relative(workspace.projectRoot, outputPath).replaceAll("\\", "/")
            : outputPath,
          spec_sha256: receipt.specification?.sha256,
          artifact_sha256: receipt.artifact?.sha256,
          quality: receipt.validation?.compositionProfile,
          errors: receipt.validation?.errors,
          warnings: receipt.validation?.warnings,
          checks_passed: receipt.validation?.checksPassed,
          check_count: receipt.validation?.checkCount
        }
      : null;
    return { ...response, receipt, evidence, report_path: reportPath };
  }

  async function archifyVisualCheck({ artifact_path, project_path }) {
    const workspace = await archifyWorkspace({ project_path, artifact_location: "system" });
    const artifactPath = archifyProjectPath(workspace.projectRoot, artifact_path, "artifact_path");
    const { response, result } = await executeArchify({ args: ["visual-check", artifactPath, "--json"], workspace, timeoutMs: 300000, details: { artifact_path: artifactPath, visual_review: "pending" } });
    const visualCheck = result.json;
    const evidence = visualCheck
      ? {
          kind: "archify_visual_check",
          html_path: workspace.projectRoot
            ? path.relative(workspace.projectRoot, artifactPath).replaceAll("\\", "/")
            : artifactPath,
          status: visualCheck.status,
          containment_status: visualCheck.containment?.status
        }
      : null;
    return { ...response, evidence, ...(visualCheck ? { visual_check: visualCheck } : {}) };
  }

  async function archifyCompare(args) {
    const workspace = await archifyWorkspace(args);
    const basePath = archifyProjectPath(workspace.projectRoot, args.base_path, "base_path");
    const headPath = archifyProjectPath(workspace.projectRoot, args.head_path, "head_path");
    const outputPath = archifyOutputPath({ workspace, output_path: args.output_path, defaultName: `${workspace.projectSlug}.architecture-delta.html` });
    const command = archifyArgsWithQuality(["compare", "architecture", basePath, headPath, outputPath, "--json"], args.quality, workspace.projectRoot);
    const { response, result } = await executeArchify({ args: command, workspace, details: { base_path: basePath, head_path: headPath, html_path: outputPath, run_dir: workspace.runDir, artifact_location: workspace.artifact_location } });
    return { ...response, ...(result.json ? { receipt: result.json } : {}) };
  }

  async function archifyMigrate({ old_path, new_path, project_path }) {
    const workspace = await archifyWorkspace({ project_path, artifact_location: "system" });
    const oldPath = archifyProjectPath(workspace.projectRoot, old_path, "old_path");
    const newPath = archifyProjectPath(workspace.projectRoot, new_path, "new_path");
    const { response, result } = await executeArchify({ args: ["migrate", "workflow", oldPath, newPath, "--to-schema", "2", "--json"], workspace, details: { old_path: oldPath, new_path: newPath } });
    return { ...response, ...(result.json ? { migration: result.json } : {}) };
  }

  async function archifyBrands({ query = "", capture_url }) {
    const workspace = await archifyWorkspace({ artifact_location: "system" });
    const command = capture_url ? ["brands", "capture", capture_url, "--json"] : ["brands", query, "--json"];
    const { response, result } = await executeArchify({ args: command, workspace });
    return { ...response, ...(result.json ? { brands: result.json } : {}) };
  }

  return {
    archifyProjectPath,
    archifyDoctor,
    archifyGuide,
    archifyValidate,
    archifyRender,
    archifyDeliver,
    archifyVisualCheck,
    archifyCompare,
    archifyMigrate,
    archifyBrands
  };
}

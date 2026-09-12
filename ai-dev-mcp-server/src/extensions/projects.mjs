/**
 * The MCP surface over a project's quality gate.
 *
 * `run_quality_gate` is the one place the server executes commands a project
 * wrote down for itself. The reading and the judging are pure, in
 * `src/core/quality-gate-runner.mjs`; what is here is the part that touches the
 * world — resolving each command's working directory, running it under the
 * command policy, and writing the result back into the project's registry card.
 *
 * The runtime calls this tool too: `verify_task` runs the gate as one of its
 * checks, and reaches it through the extension host rather than keeping a
 * second copy of the runner.
 */
import path from "node:path";
import { validateArchifyDiagramSpecs } from "../core/archify-quality-gate.mjs";
import { runPolicyCommand } from "../core/process-runner.mjs";
import {
  parseQualityGateCommands,
  qualityCommandBlockReason,
  qualityGateMaxCommands,
  qualityGateReportMarkdown,
  qualityGateStatus,
  qualityGateTimeoutMs,
  selectQualityCommands
} from "../core/quality-gate-runner.mjs";

/** The gate file, relative to the project root. */
const QUALITY_GATE_RELATIVE_PATH = ".ai-dev/quality-gate.md";

/**
 * Record the run on the project's card, registering the project first if the
 * caller asked for that and there is no card yet.
 */
async function updateRegistry(host, projectRoot, result, registerIfMissing) {
  try {
    const card = await host.findProjectCard(projectRoot);
    const report = await host.updateProjectCard({
      name: card.name,
      section: "Last Quality Gate Run",
      mode: "replace",
      content: qualityGateReportMarkdown(result),
      update_index: false
    });
    const synced = await host.syncProjectCard({
      project_path: projectRoot,
      create_if_missing: false,
      update_index: true
    });
    return { report, synced };
  } catch (err) {
    if (!registerIfMissing) {
      return { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
    }
    return host.registerProject({
      project_path: projectRoot,
      status: "registered via run_quality_gate",
      description: "Registered automatically while running quality gate.",
      notes: qualityGateReportMarkdown(result),
      overwrite: false
    });
  }
}

/** Run the commands a project's quality gate file offers, and report on them. */
async function runQualityGate(host, {
  project_path,
  labels = [],
  dry_run = false,
  timeout_ms = 120000,
  max_commands = 6,
  diagram_specs = "",
  continue_on_failure = true,
  allow_unsafe_commands = false,
  update_registry = true,
  register_if_missing = false
} = {}) {
  const projectRoot = await host.safeProjectRoot(project_path);
  const gatePath = host.safeProjectFile(projectRoot, QUALITY_GATE_RELATIVE_PATH);
  if (!(await host.pathExists(gatePath))) {
    throw new Error(`Quality gate file not found: ${path.join(projectRoot, ".ai-dev", "quality-gate.md")}`);
  }

  const startedAt = new Date().toISOString();
  const gateText = await host.readProjectTextIfExists(projectRoot, QUALITY_GATE_RELATIVE_PATH);
  const parsed = parseQualityGateCommands(gateText);
  const { selected, skipped } = selectQualityCommands(parsed, labels, qualityGateMaxCommands(max_commands));
  const timeoutMs = qualityGateTimeoutMs(timeout_ms);
  const results = [];
  const blocked = [];

  for (const item of selected) {
    const blockReason = qualityCommandBlockReason(item.command);
    if (blockReason) {
      blocked.push({ ...item, reason: blockReason });
      continue;
    }

    if (dry_run) {
      results.push({
        label: item.label,
        command: item.command,
        cwd: item.cwd || ".",
        status: "dry_run",
        exit_code: null,
        stdout: "",
        stderr: "",
        timed_out: false
      });
      continue;
    }

    const commandRoot = await host.safeProjectSubdir(projectRoot, item.cwd || "");
    const output = await runPolicyCommand({
      command: item.command,
      projectRoot: commandRoot,
      purpose: "quality",
      timeoutMs
    });
    const status = output.timedOut ? "timed_out" : output.exitCode === 0 ? "passed" : "failed";
    results.push({
      label: item.label,
      command: item.command,
      cwd: item.cwd || ".",
      command_adapter: output.command.adapter || output.command.kind,
      execution_adapter: output.invocation?.adapter || "direct",
      status,
      exit_code: output.exitCode,
      stdout: host.truncateOutput(output.stdout),
      stderr: host.truncateOutput(output.stderr),
      timed_out: output.timedOut,
      output_truncated: output.truncated,
      duration_ms: output.durationMs
    });
    if (!continue_on_failure && status !== "passed") break;
  }

  let diagramSpecs = { enabled: false };
  if (diagram_specs) {
    diagramSpecs = dry_run
      ? { enabled: true, pattern: String(diagram_specs), files: [], status: "dry_run" }
      : await validateArchifyDiagramSpecs({
        vaultRoot: host.vaultRoot,
        projectRoot,
        pattern: String(diagram_specs),
        timeoutMs
      });
  }

  const result = {
    project_path: projectRoot,
    quality_gate_path: path.relative(projectRoot, gatePath).replaceAll("\\", "/"),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: qualityGateStatus({ dryRun: dry_run, parsed, results, blocked, diagramSpecs }),
    parsed_commands: parsed,
    selected_commands: selected,
    results,
    blocked,
    skipped,
    diagram_specs: diagramSpecs,
    safety: {
      execution: "argv",
      shell: false,
      unsafe_bypass_honored: false,
      legacy_allow_unsafe_requested: Boolean(allow_unsafe_commands)
    }
  };

  if (update_registry) result.registry = await updateRegistry(host, projectRoot, result, register_if_missing);
  return result;
}

/**
 * @param {object} host - Shared runtime services (see `src/tool-extensions.mjs`).
 * @returns {{ definitions: Array<object>, handlers: object, readOnly: Array<string> }}
 */
export function createProjectTools(host) {
  return {
    definitions: [
      {
        name: "run_quality_gate",
        description: "Run safe verification commands from a project's .ai-dev/quality-gate.md and return a structured report.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            labels: {
              type: "array",
              items: { type: "string" },
              default: []
            },
            dry_run: { type: "boolean", default: false },
            timeout_ms: { type: "number", default: 120000 },
            max_commands: { type: "number", default: 6 },
            diagram_specs: { type: "string", description: "Optional project-relative glob for Archify diagram specs; disabled when omitted." },
            continue_on_failure: { type: "boolean", default: true },
            update_registry: { type: "boolean", default: true },
            register_if_missing: { type: "boolean", default: false }
          },
          required: ["project_path"]
        }
      }
    ],
    handlers: {
      run_quality_gate: (args) => runQualityGate(host, args)
    },
    readOnly: []
  };
}

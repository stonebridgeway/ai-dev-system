import {
  SECURITY_SCANNERS,
  renderSecurityScanMarkdown,
  runSecurityScan
} from "../core/security-scan.mjs";

/**
 * Security scanners as one tool.
 *
 * The adapters, the normalized finding shape and the gate live in
 * `core/security-scan.mjs`; this is the MCP surface and the task plumbing.
 * `verify_task` runs the same scan as its `security_scan` check, next to
 * `change_hygiene`; this tool is for running it early, or for one scanner at a
 * time while fixing what it found.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createSecurityTools(host) {
  return {
    definitions: [
      {
        name: "run_security_scan",
        description: `Run the security scanners this machine has installed over a project: ${SECURITY_SCANNERS.map((scanner) => scanner.id).join(", ")}. Every finding comes back as { tool, kind, severity, file, line, message, rule }, where kind is dependency, secret, sast or misconfig. A scanner that is not installed, has nothing to read in this project, or needs a network this run does not have is reported as skipped with the reason — never as a failure. Critical and high dependency or secret findings block verify_task; everything else warns.`,
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task whose project is scanned." },
            scanners: {
              type: "array",
              items: { type: "string", enum: SECURITY_SCANNERS.map((scanner) => scanner.id) },
              description: "Scanners to run. Omit for auto, which tries all of them and skips the ones that do not apply."
            },
            offline: { type: "boolean", description: "Skip the scanners that need to fetch an advisory database or rule pack. Defaults to the AI_DEV_OFFLINE environment variable." },
            timeout_ms: { type: "number", default: 180000, description: "Per scanner. One that overstays is reported as skipped." },
            record_checkpoint: { type: "boolean", default: false, description: "Attach the report to the task as a checkpoint note." }
          }
        }
      }
    ],
    handlers: {
      async run_security_scan(args) {
        let projectRoot;
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          projectRoot = (await host.resolveProjectIdentity(record.project.path)).project_root;
        } else if (args.project_path) {
          projectRoot = (await host.resolveProjectIdentity(args.project_path)).project_root;
        } else {
          throw new Error("project_path or task_id is required.");
        }
        const scan = await runSecurityScan(projectRoot, {
          scanners: args.scanners ?? "auto",
          offline: args.offline,
          timeoutMs: Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : undefined
        });
        const markdown = renderSecurityScanMarkdown(scan);
        let checkpoint = null;
        if (record && args.record_checkpoint && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Security scan: ${scan.status} (${scan.summary.blocking} blocking, ${scan.summary.findings} findings, ${scan.summary.skipped} scanners skipped)`,
            notes: markdown
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        return {
          ...scan,
          markdown,
          checkpoint,
          next_step: scan.status === "block"
            ? "Fix every critical or high dependency and secret finding — rotate what leaked, upgrade what is vulnerable — before verify_task."
            : scan.summary.checked === 0
              ? "No scanner could run here. Install at least one (gitleaks is the cheapest and needs no network) so this check means something."
              : scan.status === "warn"
                ? "Read the findings and either fix them or say in your checkpoint notes why they stand."
                : "Nothing found by the scanners that ran; continue with verify_task."
        };
      }
    },
    // Not read-only, for the same reason `run_quality_gate` is not: it starts
    // the project's own tools. Most of them only read, but `trivy` downloads a
    // vulnerability database into the user's cache and `npm audit` reaches the
    // registry, and a hint that says otherwise is a hint that is wrong.
    readOnly: []
  };
}

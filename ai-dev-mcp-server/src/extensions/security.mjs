import path from "node:path";
import { atomicWriteJson } from "../core/atomic-files.mjs";
import { ignoreMachineFiles } from "../core/project-ignore.mjs";
import { buildFixPlan, renderFixPlanMarkdown } from "../core/security-fix-plan.mjs";
import { DEFAULT_MIN_RELEASE_AGE_DAYS } from "../core/security-fix-registry.mjs";
import { MALWARE_REMEDIATION } from "../core/security-scan-parsers.mjs";
import {
  SECURITY_SCANNERS,
  renderSecurityScanMarkdown,
  runSecurityScan
} from "../core/security-scan.mjs";

/**
 * Where a scan leaves its time in the project, for the Stop hook
 * (`hooks/stop-check.mjs`): code changed after it has not been reviewed.
 */
export const SECURITY_SCAN_STAMP = path.join(".ai-dev", "security", "last-scan.json");

/**
 * Record that a scan ran, with what it found. An `unchecked` scan is recorded
 * too: its own answer already says nothing was checked, and without a stamp
 * the Stop hook would send the agent back after every turn on a machine where
 * no scanner can run. A stamp that cannot be written costs the scan nothing.
 *
 * @param {string} projectRoot
 * @param {object} scan
 * @param {string} via - The tool that ran it.
 */
async function stampScan(projectRoot, scan, via) {
  // The stamp is this machine's: kept out of the project's history.
  await ignoreMachineFiles(projectRoot);
  await atomicWriteJson(path.join(projectRoot, SECURITY_SCAN_STAMP), {
    at: new Date().toISOString(),
    via,
    status: scan.status,
    findings: scan.summary.findings,
    blocking: scan.summary.blocking,
    scanners: scan.scanners.filter((scanner) => scanner.status === "ok").map((scanner) => scanner.id)
  }).catch(() => undefined);
}

/** The scanners that name packages, which is what a fix plan is made of. */
export const DEPENDENCY_SCANNERS = Object.freeze(["npm_audit", "pnpm_audit", "yarn_audit", "bun_audit", "osv_scanner"]);

/**
 * Security scanners as one tool, and the plan that turns their dependency
 * findings into commands.
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
  async function projectFor(args) {
    if (args.task_id) {
      const record = await host.taskStore.read(args.task_id);
      return { record, projectRoot: (await host.resolveProjectIdentity(record.project.path)).project_root };
    }
    if (args.project_path) return { record: null, projectRoot: (await host.resolveProjectIdentity(args.project_path)).project_root };
    throw new Error("project_path or task_id is required.");
  }

  return {
    definitions: [
      {
        name: "run_security_scan",
        description: `Run the security scanners this machine has installed over a project: ${SECURITY_SCANNERS.map((scanner) => scanner.id).join(", ")}. Every finding comes back as { tool, kind, severity, file, line, message, rule }, where kind is dependency, malware, secret, sast or misconfig; a finding about a package also names package, version, vulnerable, fixed_in and aliases. The npm, pnpm, Yarn and Bun audits run in every directory up to two levels down that holds their lockfile, and one advisory reported by two scanners is one finding. A scanner that is not installed, has nothing to read in this project, or needs a network this run does not have is reported as skipped with the reason — never as a failure. Critical and high dependency, malware or secret findings block verify_task; everything else warns. Malware is critical always: the fix is removal and credential rotation, not an upgrade. A run where not one scanner could run is unchecked, not pass: it does not block, and it does not claim anything was checked.`,
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
      },
      {
        name: "plan_security_fixes",
        description: `Turn a project's dependency and malware findings into a fix plan, and change nothing. Runs the package-naming scanners (${DEPENDENCY_SCANNERS.join(", ")}), then for each vulnerable package in each lockfile says what to do — replace-malware or remove-malware, upgrade-direct, update-in-range, override, or no-fix — to which version, with the exact command for the package manager that owns the lockfile, and whether the upgrade is breaking (below 1.0.0 a minor counts). The target is the first published version outside every advisory's range that has been public for at least min_release_age_days (default ${DEFAULT_MIN_RELEASE_AGE_DAYS}), read from the npm registry; npm commands carry --before so what an upgrade pulls in is held to the same quarantine. Show the plan to the user and run its commands only after they confirm — installs and updates stay behind confirmation.`,
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute repository path. Optional when task_id is given." },
            task_id: { type: "string", description: "Task whose project is planned for." },
            offline: { type: "boolean", description: "Do not ask the registry or the audit endpoints; plan from what the advisories name. Defaults to the AI_DEV_OFFLINE environment variable." },
            min_release_age_days: { type: "number", default: DEFAULT_MIN_RELEASE_AGE_DAYS, description: "Quarantine: a version younger than this is not picked while an older safe one exists. 0 turns it off." },
            record_checkpoint: { type: "boolean", default: false, description: "Attach the plan to the task as a checkpoint note." }
          }
        }
      }
    ],
    handlers: {
      async run_security_scan(args) {
        const { record, projectRoot } = await projectFor(args);
        const scan = await runSecurityScan(projectRoot, {
          scanners: args.scanners ?? "auto",
          offline: args.offline,
          timeoutMs: Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : undefined
        });
        const markdown = renderSecurityScanMarkdown(scan);
        const malware = scan.findings.filter((item) => item.kind === "malware");
        await stampScan(projectRoot, scan, "run_security_scan");
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
          next_step: malware.length
            ? `Malware: ${[...new Set(malware.map((item) => `${item.package || "a package"}${item.version ? `@${item.version}` : ""}`))].join(", ")}. ${MALWARE_REMEDIATION} Do this before anything else, then plan the remaining fixes with plan_security_fixes.`
            : scan.status === "block"
              ? "Fix every critical or high dependency and secret finding — rotate what leaked, upgrade what is vulnerable — before verify_task. plan_security_fixes turns the dependency findings into exact, confirmable commands."
              : scan.status === "unchecked"
                ? "No scanner could run here, so nothing was checked. Install at least one (gitleaks is the cheapest and needs no network) so this check means something."
                : scan.status === "warn"
                  ? "Read the findings and either fix them or say in your checkpoint notes why they stand."
                  : "Nothing found by the scanners that ran; continue with verify_task."
        };
      },

      async plan_security_fixes(args) {
        const { record, projectRoot } = await projectFor(args);
        const scan = await runSecurityScan(projectRoot, { scanners: [...DEPENDENCY_SCANNERS], offline: args.offline });
        await stampScan(projectRoot, scan, "plan_security_fixes");
        const age = Number(args.min_release_age_days);
        const plan = await buildFixPlan({
          projectRoot,
          findings: scan.findings,
          offline: scan.offline,
          minReleaseAgeDays: Number.isFinite(age) && age >= 0 ? Math.min(age, 365) : DEFAULT_MIN_RELEASE_AGE_DAYS
        });
        const markdown = renderFixPlanMarkdown(plan);
        let checkpoint = null;
        if (record && args.record_checkpoint && record.status !== "complete") {
          const updated = await host.taskStore.checkpoint(record.id, {
            summary: `Security fix plan: ${plan.summary.items} item(s), ${plan.summary.malware} malware, ${plan.summary.breaking} breaking`,
            notes: markdown
          });
          checkpoint = { task_id: updated.id, checkpoints: updated.checkpoints.length };
        }
        const checked = scan.scanners.filter((scanner) => scanner.status === "ok").map((scanner) => scanner.id);
        return {
          project_path: projectRoot,
          scan: { status: scan.status, summary: scan.summary, scanners: scan.scanners },
          ...plan,
          markdown,
          checkpoint,
          next_step: !checked.length
            ? "No dependency scanner could run here, so there is nothing to plan from — this is not a clean bill. Install osv-scanner, or run from a machine with the project's package manager and a network."
            : plan.summary.malware
              ? "Malware first: show the user the plan, and once they confirm, replace or remove it, reinstall from the updated lockfile, and rotate the credentials — before any other item."
              : plan.summary.items
                ? "Show the user this plan and wait for their confirmation. Run confirmed items one lockfile at a time, then the verify steps; a breaking item needs its changelog read first."
                : "No dependency findings to fix."
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

/**
 * The setup run: what a fresh install builds, and on request the local model,
 * its vectors and Frontend QA — done here once for `ai-dev setup` at a
 * terminal and for the control tool `setup_run`, which the desktop app calls
 * through the daemon with progress and a cancel button.
 *
 * What to run is `first-run.mjs` (`planFirstRun`); the required steps' actions
 * are `scripts/first-run-steps.mjs`, which the container's entrypoint runs
 * too. This adds the optional steps and runs the plan; asking a person and
 * printing is the caller's.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { SERVER_ROOT } from "./client-connections.mjs";
import { DOCKER_MOUNTED_MODEL_DIR, unreadableModelAdvice } from "./dense-backend.mjs";
import { readDenseManifest } from "./dense-manifest.mjs";
import { defaultOnnxModelDir } from "./dense-onnx.mjs";
import { planFirstRun, setupReason } from "./first-run.mjs";
import { frontendQaInstallCommands, frontendQaInstalled, pinnedPnpmVersion } from "./frontend-qa-install.mjs";
import { LAUNCH_UNKNOWN, classifyFrontendQaLaunchFailure } from "./frontend-qa-launch.mjs";
import { denseRuntimeSupport, installModel, modelStatus } from "./model-manager.mjs";
import { resolveSpawnInvocation } from "./process-runner.mjs";
import { evaluateFrontendQaEnvironment } from "./system-health.mjs";

/** The Frontend QA runner's folder, beside the server. */
export const QA_ROOT = path.join(path.resolve(SERVER_ROOT, ".."), "frontend-qa");

/** The steps module the container's entrypoint runs too. */
export function loadSetupSteps() {
  return import("../../scripts/first-run-steps.mjs");
}

/**
 * The error a stop ends a step with — a stop asked for, or Ctrl-C at a
 * terminal, which reaches the commands setup runs as well as setup — so the
 * step is reported stopped, not failed.
 */
function stopped(signal, what) {
  return signal?.reason ?? Object.assign(new Error(`${what} was stopped with Ctrl-C.`), { name: "AbortError" });
}

/**
 * Run a command and resolve with its exit code. `output: "inherit"` streams it
 * to this process's terminal; `"capture"` keeps its last lines for the error a
 * failure ends with. A signal stops the command.
 */
function runCommand(command, args, { cwd, output = "inherit", signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      ...(signal ? { signal } : {})
    });
    let tail = "";
    const keep = (chunk) => {
      tail = `${tail}${chunk}`.slice(-4000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      if (signal?.aborted || (signal && killedBy === "SIGINT")) return reject(stopped(signal, command));
      resolve({ code: code ?? 1, tail });
    });
  });
}

async function runOrThrow(label, command, args, options) {
  const { code, tail } = await runCommand(command, args, options);
  if (code !== 0) {
    const last = tail.trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error(`${label} exited with code ${code}.${last ? ` Its last lines: ${last}` : ""}`);
  }
}

/**
 * The Frontend QA runner's status, asked exactly as the health check asks it,
 * about the vault, so setup and `doctor` cannot disagree. `launch: false` only
 * looks for the browser on disk. With a `signal`, a stop — asked for, or
 * Ctrl-C at a terminal — rejects with the stop rather than reporting a
 * runner that did not start.
 */
export function frontendQaStatus(vaultRoot, { launch = true, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(QA_ROOT, "frontend_qa_runner.mjs")], {
      cwd: QA_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {})
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const failed = (output) => {
      const failure = classifyFrontendQaLaunchFailure(output);
      settle({ playwright_available: false, chromium_available: false, browser_launch_ok: false, launch_failure: failure.kind, launch_error: failure.summary });
    };
    // As long as the server allows the same question (`runFrontendQaStatus`).
    const timer = setTimeout(() => {
      child.kill();
      failed("The Frontend QA runner did not answer within 60 s.");
    }, 60_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => undefined); // a runner that died early closed it; its exit says why
    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(stopped(signal, "The Frontend QA check"));
    };
    child.on("error", (error) => (error?.name === "AbortError" ? stop() : failed(String(error?.message ?? error))));
    // `close`, not `exit`: only then is everything the runner printed read.
    child.on("close", (code, killedBy) => {
      if (signal?.aborted || (signal && killedBy === "SIGINT")) return stop();
      if (code !== 0) return failed(stderr || `exit code ${code}`);
      try {
        settle(JSON.parse(stdout));
      } catch {
        settle({ playwright_available: false, chromium_available: false, browser_launch_ok: false, launch_failure: LAUNCH_UNKNOWN, launch_error: "The Frontend QA runner answered with something other than JSON." });
      }
    });
    child.stdin.end(JSON.stringify({ action: "status", project_path: vaultRoot, launch }));
  });
}

/**
 * What is on disk before a run: the required artefacts and how current they
 * are, the model, the Frontend QA dependencies.
 *
 * @param {object} options
 * @param {{ callTool: Function, vaultRoot: string, searchIndexPath: string, skillRoutingEvalCasesPath: string }} options.runtime
 * @param {NodeJS.ProcessEnv} options.env
 * @param {object} options.steps - `scripts/first-run-steps.mjs`.
 */
export async function inspectSetup({ runtime, env, steps }) {
  const manifest = readDenseManifest();
  const modelDir = defaultOnnxModelDir({ env });
  const artefacts = steps.requiredArtefactPaths({ vaultRoot: runtime.vaultRoot, searchIndexPath: runtime.searchIndexPath });
  const { indexStatus, present, stale } = await steps.readRequiredState({
    paths: artefacts,
    callTool: runtime.callTool,
    serverRoot: SERVER_ROOT,
    skillRoutingEvalCasesPath: runtime.skillRoutingEvalCasesPath
  });
  return {
    manifest,
    modelDir,
    indexStatus,
    present,
    stale,
    qaDependencies: existsSync(path.join(QA_ROOT, "node_modules")),
    ...await modelInspection({ manifest, dir: modelDir, env })
  };
}

/** Whether the model is in place, and why not when this user cannot read it. */
async function modelInspection({ manifest, dir, env }) {
  const status = await modelStatus({ manifest, dir, env });
  return { modelInstalled: status.installed, modelUnreadable: status.unreadable ?? "" };
}

/**
 * Run the plan: the required steps that are missing or out of date (all of
 * them with `force`), and the optional ones asked for.
 *
 * @param {object} options
 * @param {{ callTool: Function, vaultRoot: string }} options.runtime
 * @param {NodeJS.ProcessEnv} options.env
 * @param {object} options.steps - `scripts/first-run-steps.mjs`.
 * @param {Awaited<ReturnType<typeof inspectSetup>>} options.inspection
 * @param {{ model?: boolean, frontendQa?: boolean }} [options.want]
 * @param {boolean} [options.force]
 * @param {AbortSignal} [options.signal] - Stops after the current piece; what is done is kept.
 * @param {(event: object) => void} [options.onProgress] - Each long step's progress events, `step` naming the step.
 * @param {(step: object) => void} [options.onStep] - Called before each step that runs.
 * @param {(line: string) => void} [options.log] - What a step says while it runs.
 * @param {"inherit" | "capture"} [options.commandOutput] - Where an external command's output goes.
 * @returns {Promise<Array<object>>} Each step with its `status`: done, skipped or failed.
 */
export async function runSetup({ runtime, env, steps, inspection, want = {}, force = false, signal, onProgress, onStep, log = () => undefined, commandOutput = "inherit" }) {
  const { callTool, vaultRoot } = runtime;
  const { manifest, modelDir, indexStatus, qaDependencies, modelInstalled, modelUnreadable = "" } = inspection;
  const stepProgress = (id) => (onProgress ? (event = {}) => onProgress({ ...event, step: id }) : undefined);
  const present = {
    ...inspection.present,
    // Installed means the browser too, and asked for by name it means one that
    // launches — the check `doctor` makes.
    frontend_qa: frontendQaInstalled({
      dependencies: qaDependencies,
      status: qaDependencies ? await frontendQaStatus(vaultRoot, { launch: Boolean(want.frontendQa) }) : null,
      requireLaunch: Boolean(want.frontendQa)
    }),
    dense_model: modelInstalled,
    dense_index: Number(indexStatus?.dense_documents || 0) > 0
  };
  const actions = {
    ...steps.createRequiredActions({ callTool, onProgress, signal }),
    // The lockfile with the pnpm the runner pins, then the Chromium build this
    // Playwright was released with, and a ✓ only when the browser launches.
    async frontend_qa() {
      const pnpmVersion = pinnedPnpmVersion(JSON.parse(await fs.readFile(path.join(QA_ROOT, "package.json"), "utf8")));
      for (const step of frontendQaInstallCommands({ qaRoot: QA_ROOT, pnpmVersion })) {
        signal?.throwIfAborted();
        const invocation = await resolveSpawnInvocation(step.command, step.args);
        await runOrThrow(step.label, invocation.executable, invocation.args, { cwd: step.cwd, output: commandOutput, signal });
      }
      const verdict = evaluateFrontendQaEnvironment(await frontendQaStatus(vaultRoot, { signal }));
      if (verdict.status !== "ok") throw new Error(verdict.summary);
      return `pnpm@${pnpmVersion} install --frozen-lockfile, playwright install chromium; ${verdict.summary}`;
    },
    async dense_model() {
      // A model here this user cannot read is not one to download over.
      if (modelUnreadable) {
        const mounted = String(env.AI_DEV_RUNTIME ?? "") === "docker" && modelDir === DOCKER_MOUNTED_MODEL_DIR;
        throw new Error(`The model in ${modelDir} cannot be read (${modelUnreadable}). ${unreadableModelAdvice(modelUnreadable, { mounted })}`);
      }
      // Where the runtime has no build, 600 MB that cannot load is not a
      // favour; `ai-dev model install` still fetches them for a container.
      const support = denseRuntimeSupport();
      if (!support.supported) throw new Error(support.reason);
      const result = await installModel({ manifest, dir: modelDir, env, signal, onProgress: stepProgress("dense_model"), log });
      if (!result.ready) throw new Error(`Model directory is still incomplete: ${[...result.missing, ...result.mismatched].join(", ")}`);
      return `${manifest.export} @ ${String(manifest.revision).slice(0, 12)} (${manifest.dtype}) `
        + `in ${modelDir}, ${result.downloaded} file(s) fetched${result.resumed ? `, ${result.resumed} continued` : ""}`;
    },
    async dense_index() {
      // The progress listener and the cancellation go with the call, as a
      // request over MCP carries them, not among its JSON arguments.
      const result = await callTool("rebuild_search_index", {
        include_external_project_files: true,
        dense_embeddings: true,
        dense_incremental: true
      }, { onProgress: stepProgress("dense_index"), signal });
      return steps.summarizeToolResult(result, (doc) => (
        `${doc.dense_documents ?? "?"} document(s) embedded, ${doc.dense_pending_documents ?? 0} still pending`
      ));
    }
  };
  // A stop asked for between two steps runs none of the rest.
  const guarded = Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, () => {
    signal?.throwIfAborted();
    return action();
  }]));
  const stale = {
    ...inspection.stale,
    // Documents indexed since the last embedding run have no vector, so the
    // dense half of a hybrid query cannot see them.
    dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0
  };
  const wanted = {
    ...(want.model ? { dense_model: true, dense_index: true } : {}),
    ...(want.frontendQa ? { frontend_qa: true } : {})
  };
  // Not asked for, a model this user cannot read is said as that, not as one to install; the
  // vectors it made before are said as kept.
  const vectors = Number(indexStatus?.dense_documents || 0);
  const unreadableReason = {
    dense_model: `cannot be read (${modelUnreadable})`,
    dense_index: vectors ? `${vectors} kept; none added while the model cannot be read` : "none: the model cannot be read"
  };
  const optionalReason = (step, state) => (modelUnreadable && unreadableReason[step.id]) || setupReason(step, state);
  const plan = planFirstRun({ present, stale, want: wanted, force, optionalReason });
  return steps.runFirstRunPlan(plan, guarded, onStep, { signal });
}

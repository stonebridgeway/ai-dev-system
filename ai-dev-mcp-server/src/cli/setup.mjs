/**
 * `ai-dev setup` (and `npm run setup`) — build what a fresh install does not
 * ship, connect the AI clients, and on request fetch the local model.
 *
 * The server works the moment it is cloned, but four things are built rather
 * than shipped; until then the health check reports them and the search tools
 * answer with a refusal. What to do is decided in `core/first-run.mjs`; this
 * does it and says what happened.
 *
 * At a terminal it asks: connect the clients found here, fetch the model,
 * install Frontend QA. `--yes` takes the defaults without asking (clients yes,
 * the two downloads no); with neither a terminal nor `--yes` (CI, a pipe) no
 * client config is written unless `--clients` names some.
 *
 * Nothing reaches the network unless asked: `--frontend-qa` installs the QA
 * runner's dependencies, `--model` the pinned BGE-M3 ONNX model (about 600 MB,
 * checksum-verified, resumable, no Python) and embeds the documents with it.
 * Ctrl-C during either keeps what is done: the next run continues.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CliUsageError, EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { legacyDenseNotes } from "../core/dense-backend.mjs";
import { describeDenseCoverage, firstRunSucceeded, renderFirstRunReport } from "../core/first-run.mjs";
import { discoverClients, parseClientSelection } from "../core/mcp-clients.mjs";
import { resolveSpawnInvocation } from "../core/process-runner.mjs";
import { createProgressPrinter } from "../core/progress-line.mjs";
import { resolveRuntimeStateRoot } from "../core/runtime-home.mjs";
import { inspectSetup, loadSetupSteps, runSetup } from "../core/setup-runner.mjs";
import { PACKAGE_NAME, currentInstallLayout, hint } from "../core/install-layout.mjs";
import { installClients, renderResults, summarize } from "./clients.mjs";
import { SERVER_ROOT, tildify } from "./context.mjs";

const REPOSITORY_ROOT = path.resolve(SERVER_ROOT, "..");

export function usage() {
  return [
    "Build what a fresh install does not ship, and connect your AI clients.",
    "",
    "Usage: ai-dev setup [options]      (from a clone: npm run setup -- [options])",
    "",
    "  (no options)      skill registry, search index, routing benchmark; at a terminal it",
    "                    also asks about the clients, the model and Frontend QA",
    "  --yes, -y         ask nothing: connect every client found here, skip the downloads",
    "  --clients=<names> connect these clients: all, or some of claude-code, claude-desktop,",
    "                    cursor, vscode, codex, gemini; --no-clients connects none",
    "  --model           also install the pinned BGE-M3 ONNX model (about 600 MB, checksum-",
    "                    verified, resumable, no Python) and embed the documents. Behind a",
    "                    firewall: AI_DEV_MODEL_MIRROR, HTTPS_PROXY, or `ai-dev model import`",
    "                    (--dense is the same)",
    "  --frontend-qa     also install the Frontend QA runner and its Chromium",
    "  --all             both downloads",
    "  --force           rebuild what is already there",
    "  --no-health       skip the closing diagnostic"
  ].join("\n");
}

/** Run a command, streaming its output, and resolve with its exit code. */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPOSITORY_ROOT, stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export function parseSetupArgs(argv) {
  const { values } = parseCommandLine(argv, {
    command: "setup",
    options: {
      yes: { type: "boolean", short: "y" },
      clients: { type: "string" },
      model: { type: "boolean" },
      dense: { type: "boolean" },
      "dense-python": { type: "boolean" },
      "frontend-qa": { type: "boolean" },
      all: { type: "boolean" },
      force: { type: "boolean" },
      health: { type: "boolean", default: true }
    }
  });
  // A misspelt client is a usage mistake, caught before anything is built.
  if (typeof values.clients === "string") {
    try {
      parseClientSelection(values.clients);
    } catch (error) {
      throw new CliUsageError(`\`ai-dev setup\`: ${error.message}`);
    }
  }
  const modelFlag = values.model ?? values.dense ?? (values["dense-python"] || values.all ? true : undefined);
  return {
    help: Boolean(values.help),
    yes: Boolean(values.yes),
    clients: values.clients,
    model: modelFlag,
    densePython: Boolean(values["dense-python"]),
    frontendQa: values["frontend-qa"] ?? (values.all ? true : undefined),
    force: Boolean(values.force),
    health: values.health !== false
  };
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const options = parseSetupArgs(argv);
  if (options.help) {
    io.out(usage());
    return EXIT.ok;
  }
  // npx runs this from its cache, which npm may clear: the app is installed
  // where it stays, and setup goes on from that copy, whose path the client
  // configs will name.
  const layout = currentInstallLayout();
  if (layout.kind === "package" && layout.ephemeral) return continueFromAppHome({ argv, io, layout });

  // Data a 2.x install left one level too deep moves first, so every step
  // below finds it.
  const { prepareRuntimeHome } = await import("../core/runtime-home-migration.mjs");
  await prepareRuntimeHome();
  const { callTool, shutdownBgeWorkers, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath } = await import("../mcp-stdio.mjs");
  const steps = await loadSetupSteps();
  try {
    return await setup({ options, io, runtime: { callTool, vaultRoot, searchIndexPath, skillRoutingEvalCasesPath }, steps });
  } finally {
    await shutdownBgeWorkers();
  }
}

/** Run npm without a shell; its output goes to stderr, beside this command's own. */
async function runNpm(args, { cwd }) {
  const invocation = await resolveSpawnInvocation("npm", args);
  const code = await runCommand(invocation.executable, invocation.args, { cwd, stdio: ["ignore", 2, 2], shell: false });
  if (code !== 0) throw new Error(`npm ${args[0]} exited with code ${code}.`);
}

async function continueFromAppHome({ argv, io, layout }) {
  const { installAppHome } = await import("../core/app-home.mjs");
  io.out(`This copy runs from npx's cache, which npm may clear: installing it into ${tildify(path.join(layout.runtimeRoot, "app"))} `
    + "so that your AI clients keep working.");
  let installed;
  try {
    installed = await installAppHome({ packageRoot: layout.root, runtimeRoot: layout.runtimeRoot, runNpm, env: io.env });
  } catch (error) {
    io.err(`Could not install it: ${error.message}`);
    io.err(`Nothing else was changed. Run the same command again once npm can reach its registry, or install it for good: npm install -g ${PACKAGE_NAME}`);
    return EXIT.failed;
  }
  io.out(`${installed.status === "present" ? "Already there" : "Installed"}: ${tildify(installed.folder)}.`);
  for (const folder of installed.removed) io.out(`Removed an older copy: ${tildify(folder)}.`);
  io.out("");
  // The copy asks its own questions at this terminal, and a Ctrl-C reaches it
  // as it reaches this process: this one only waits for its answer.
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [installed.cli, "setup", ...argv], { stdio: "inherit", env: io.env, windowsHide: true, shell: false });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? EXIT.interrupted : EXIT.failed)));
    });
  } finally {
    process.off("SIGINT", ignore);
  }
}

async function setup({ options, io, runtime, steps }) {
  const { callTool } = runtime;
  const say = io.out;
  const inspection = await inspectSetup({ runtime, env: io.env, steps });
  const { manifest: denseManifest, modelDir: onnxModelDir, indexStatus, qaDependencies, modelInstalled, modelUnreadable } = inspection;
  // The model is the ONNX export and nothing else; what a 2.x install left of
  // the Python backend is named once, with what replaced it.
  const legacyWeightsDir = io.env.BGE_M3_MODEL_DIR || path.join(resolveRuntimeStateRoot("", io.env), "models", "bge-m3");
  const legacyNotes = [
    ...(options.densePython ? ["--dense-python asked for the Python backend, which 3.0 removed; installing the ONNX model instead (the same as --model)."] : []),
    ...legacyDenseNotes(io.env, { legacyWeightsDir: existsSync(path.join(legacyWeightsDir, "pytorch_model.bin")) ? legacyWeightsDir : "" })
  ];
  const progress = createProgressPrinter({ stream: io.stdout });

  say(`Vault: ${runtime.vaultRoot}`);
  say(`Search index: ${runtime.searchIndexPath}`);
  say(`Dense model: ${onnxModelDir} (ONNX, ${denseManifest.export} @ ${String(denseManifest.revision).slice(0, 12)})`);
  if (indexStatus) say(describeDenseCoverage(indexStatus, { modelUnreadable: Boolean(modelUnreadable) }));
  for (const note of legacyNotes) say(`Note: ${note}`);
  say("");

  // What to do beyond the required steps: flags first, then a question at a
  // terminal, then the default.
  const asking = io.interactive && !options.yes;
  let clientSpec = options.clients;
  if (clientSpec === undefined) {
    if (asking) {
      const found = (await discoverClients({ env: io.env })).filter((target) => target.detected);
      const names = [...new Set(found.map((target) => target.label))];
      clientSpec = names.length && await io.ask(`Connect ai-dev to ${names.join(", ")}?`, true) ? "all" : false;
      if (!names.length) say("No AI client found here; `ai-dev clients install --clients=<name>` writes one later.");
    } else {
      clientSpec = options.yes ? "all" : false;
    }
  }
  let wantModel = options.model;
  if (wantModel === undefined) {
    // A model here this user cannot read is not offered for download over it.
    wantModel = !modelInstalled && !modelUnreadable && asking
      ? await io.ask("Download the local search model too? About 600 MB, for semantic search; word search works without it.", false)
      : false;
  }
  let wantQa = options.frontendQa;
  if (wantQa === undefined) {
    wantQa = !qaDependencies && asking ? await io.ask("Install Frontend QA (Playwright and its Chromium) for UI checks?", false) : false;
  }
  if (asking) say("");

  // Ctrl-C stops after the current piece of work and keeps what is done; a
  // second one does not wait.
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) process.exit(EXIT.interrupted);
    progress.end();
    say("   Stopping after the current piece — what is done is kept. Ctrl-C again to quit now.");
    controller.abort();
  };
  process.on("SIGINT", stop);
  let results;
  try {
    results = await runSetup({
      runtime,
      env: io.env,
      steps,
      inspection,
      want: { model: Boolean(wantModel), frontendQa: Boolean(wantQa) },
      force: options.force,
      signal: controller.signal,
      onProgress: progress,
      onStep: (step) => {
        progress.end();
        say(`→ ${step.title}: ${step.detail}`);
      },
      log: (line) => {
        progress.end();
        say(`   ${line}`);
      }
    });
  } finally {
    process.off("SIGINT", stop);
    progress.end();
  }
  say("");
  say(renderFirstRunReport(results));

  let clientsFailed = false;
  if (controller.signal.aborted) {
    // A stop is not a fault, and nothing after it says anything new.
    say("");
    say("Stopped with Ctrl-C. What was done is kept; run setup again to continue from there.");
    return EXIT.interrupted;
  }
  if (clientSpec) {
    say("");
    say("AI clients:");
    const connected = await installClients({ spec: clientSpec, env: io.env });
    for (const line of renderResults(connected)) say(line);
    for (const line of summarize(connected)) say(`  ${line}`);
    clientsFailed = connected.some((result) => result.status === "failed");
  } else {
    say("");
    say(`AI clients: not changed. \`${hint("npm run clients:install")}\` connects them.`);
  }

  if (options.health) {
    say("");
    const health = await callTool("system_health_check", { include_search_smoke: true, include_dense_smoke: false, include_search_eval: false });
    const doc = steps.parseToolResult(health) ?? {};
    const checks = doc.checks ?? [];
    const unhappy = checks.filter((check) => check.status !== "passed" && check.status !== "ok" && check.status !== "skipped");
    say(`Health: ${doc.status} — ${checks.length} check(s), ${unhappy.length} not passing.`);
    for (const check of unhappy) say(`  ${check.status}: ${check.name} — ${String(check.summary).replace(/\s+/g, " ").slice(0, 120)}`);
    // The health check describes the vault, not this run; when a step here
    // failed, "Health: ok" must not be the last word.
    if (!firstRunSucceeded(results)) {
      say("");
      say("That health check describes the vault, not this run — a step above failed. Fix it and run setup again.");
    }
  }
  return firstRunSucceeded(results) && !clientsFailed ? EXIT.ok : EXIT.failed;
}

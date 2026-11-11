/**
 * What the container entrypoint does before the server answers its first call.
 *
 * The same required steps `npm run setup` runs — the skill registry, the search
 * index and the routing benchmark — plus the two artefacts only a container
 * builds. They are all idempotent, so this runs on every container start and
 * rebuilds nothing on the second one.
 *
 * It used to run the registry alone, which left a fresh container with no index
 * and no benchmark: four critical health checks failed, every search tool
 * refused, and the first thing a new user saw was `Health: fail` on a correct
 * install.
 *
 * The image builds all of it into its own /data, which Docker copies into a new
 * volume (`scripts/docker-prepare-data.mjs`): on such a volume's first start the
 * skill folders get back the time the copy took from them, and nothing is rebuilt
 * (`src/core/image-data.mjs`) — a start that finds the copy still going waits for
 * it first.
 *
 *   node scripts/docker-bootstrap.mjs [--json]    --json: the steps' results on stdout
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DOCKER_MOUNTED_MODEL_DIR, containerModelAdvice } from "../src/core/dense-backend.mjs";
import { readDenseManifest } from "../src/core/dense-manifest.mjs";
import { defaultOnnxModelDir } from "../src/core/dense-onnx.mjs";
import { dataPlace, dataVolume } from "../src/core/docker-launch.mjs";
import { acquireFileLock } from "../src/core/file-lock.mjs";
import { planFirstRun, renderFirstRunReport } from "../src/core/first-run.mjs";
import { frontendQaInstalled } from "../src/core/frontend-qa-install.mjs";
import { awaitImageDataCopy, restorePreparedTimes } from "../src/core/image-data.mjs";
import { dockerCommand, dockerEmbedCommand } from "../src/core/install-layout.mjs";
import { modelStatus } from "../src/core/model-manager.mjs";
import { QA_ROOT, frontendQaStatus } from "../src/core/setup-runner.mjs";
import { FILE_CLOCK_MARGIN_MS } from "../src/core/skill-registry-freshness.mjs";
import {
  createRequiredActions,
  readRequiredState,
  requiredArtefactPaths,
  runFirstRunPlan
} from "./first-run-steps.mjs";

/**
 * A start waits for another one building the same volume — a 2.x volume's first
 * start takes 15–20 s — but not past this long from its own start: a client
 * gives `initialize` 60 s (the MCP SDK's default), and a session on what is
 * built beats none.
 */
const START_WAIT_MS = 40_000;

/**
 * The holder beats every 3 s, and one that has not for 20 s is taken for killed:
 * a fifth of a CPU left 6 s between two beats, a tenth 11 s, as the index is
 * built in one piece.
 */
const FIRST_RUN_LOCK = Object.freeze({ staleMs: 20_000, heartbeatMs: 3_000 });

/** At most this long for Docker to finish filling a new volume, out of the start's {@link START_WAIT_MS}. */
const COPY_WAIT_MS = 20_000;

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = path.resolve(process.env.AI_DEV_VAULT_ROOT || "/data/ai-dev-system");

// A new volume Docker is still filling from the image, as another client's start made it, is read only once the
// copy is done — the seed is synced as the server's module loads, so that is loaded after.
// The entrypoint makes the state folder first; the image's data has none.
const copy = await awaitImageDataCopy({
  dataRoot: path.dirname(vaultRoot),
  skip: [path.resolve(process.env.AI_DEV_STATE_ROOT || "/data/runtime-home/.ai-dev/state")],
  timeoutMs: COPY_WAIT_MS
});
// One that waited out its time still uses the record, and removes it: left, it would have the copy's own start date
// back folders this one never saw, and a registry built without them would read as current for good.
if (copy.outcome === "timed-out") {
  process.stderr.write(`→ This new volume still holds less than the image's data after ${Math.round(copy.waited_ms / 1000)} s — `
    + "Docker is still filling it, or its copy stopped: this start goes on with what is there, and a later one finishes the rest.\n");
} else if (copy.waited_ms > 0) {
  process.stderr.write(`→ Docker was still filling this new volume from the image: this start waited ${(copy.waited_ms / 1000).toFixed(1)} s for the copy.\n`);
}
const { callTool, searchIndexPath, seedSync, shutdownBgeWorkers, skillRoutingEvalCasesPath } = await import("../src/mcp-stdio.mjs");

async function tool(name, arguments_ = {}) {
  const result = await callTool(name, arguments_);
  if (result?.isError) {
    throw new Error(`${name}: ${result.content?.[0]?.text || "tool failed"}`);
  }
}

async function exists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

/** A check that only feeds the report: one that cannot be made says why, and the start goes on. */
async function reported(check) {
  try {
    return { value: Boolean(await check()), error: "" };
  } catch (error) {
    return { value: false, error: String(error?.message ?? error).split("\n")[0] };
  }
}

/**
 * The optional steps as `setup` finds them: the model checked against its
 * manifest, the vectors by the index's own count, the browser where the runner
 * looks for it — so a start says what this volume has, not what it might.
 */
async function optionalState(indexStatus) {
  const env = process.env;
  const modelDir = defaultOnnxModelDir({ env });
  const qaDependencies = existsSync(path.join(QA_ROOT, "node_modules"));
  const browser = await reported(async () => frontendQaInstalled({
    dependencies: qaDependencies,
    status: qaDependencies ? await frontendQaStatus(vaultRoot, { launch: false }) : null
  }));
  const model = await reported(async () => {
    const status = await modelStatus({ manifest: readDenseManifest(), dir: modelDir, env });
    // One this user cannot read is a check that could not be made.
    if (status.unreadable) throw new Error(status.unreadable);
    return status.installed;
  });
  return {
    modelDir,
    qaDependencies,
    unchecked: { frontend_qa: browser.error, dense_model: model.error },
    present: { frontend_qa: browser.value, dense_model: model.value, dense_index: Number(indexStatus?.dense_documents || 0) > 0 },
    vectors: Number(indexStatus?.dense_documents || 0),
    // Documents indexed since the last embedding run have no vector yet.
    stale: { dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0 }
  };
}

/**
 * The optional steps in the image's words: it has no setup flags. The model
 * goes into the volume with one run of its own, which embeds the documents too;
 * the browser comes with the `-browser` variant.
 */
function imageReason({ modelDir, qaDependencies, unchecked, present, vectors = 0 }) {
  const install = dockerCommand("model install");
  // A folder of the host's at /models is the model the sessions use, whole or not: what is not whole is put right
  // on the host, as `embedding_status` says, not installed into a volume they would not read.
  const mounted = modelDir === DOCKER_MOUNTED_MODEL_DIR;
  // A model mounted from the host is embedded with, not installed: `setup
  // --model` finds it whole and builds the vectors, downloading nothing.
  const embed = mounted ? dockerEmbedCommand() : install;
  return (step, state) => {
    if (unchecked[step.id]) return `could not be checked: ${unchecked[step.id]}`;
    if (step.id === "frontend_qa") {
      if (state !== "missing") return "comes with the image";
      return qaDependencies
        ? "its packages are here but not the browser they want: this -browser image is not whole"
        : "not in this image — its -browser variant carries it";
    }
    if (step.id === "dense_model") {
      if (state === "present") return `installed in ${modelDir}`;
      // This volume only for a name read at /data: the default by its name, a mount with no name by where it is.
      return mounted ? `not whole — ${containerModelAdvice(modelDir)}` : `not installed — \`${install}\` puts it ${dataPlace(dataVolume())}`;
    }
    if (mounted && !present.dense_model) {
      const why = `the model at /models ${unchecked.dense_model ? "could not be checked" : "is not whole yet"}`;
      // What it embedded before stays.
      return vectors ? `${vectors} kept; none added while ${why}` : `none: ${why}`;
    }
    if (state === "stale") return `documents indexed since have none — \`${embed}\` embeds them`;
    return state === "present" ? "every indexed document has one" : `none yet — \`${embed}\` embeds the documents`;
  };
}

/** The steps, one start at a time: what the first start built, the next finds built. */
async function firstRunSteps() {
  const paths = requiredArtefactPaths({ vaultRoot, searchIndexPath });
  const required = await readRequiredState({
    paths,
    callTool,
    serverRoot,
    skillRoutingEvalCasesPath
  });
  const optional = await optionalState(required.indexStatus);
  // What goes out of date is rebuilt at the next start: there is nothing to force.
  const plan = planFirstRun({
    present: { ...required.present, ...optional.present },
    stale: { ...required.stale, ...optional.stale },
    optionalReason: imageReason(optional),
    builtReason: "already built"
  });
  const actions = createRequiredActions({ callTool });
  const announce = (step) => process.stderr.write(`→ ${step.title}: ${step.detail}\n`);

  // The registry is dated as far back as a file clock may lag: built
  // within that much of a seed sync that changed the catalogue, it would read
  // as stale at the next start and be built again for nothing.
  const changed = seedSync?.status === "synced" && (seedSync.added + seedSync.updated + seedSync.removed) > 0;
  if (changed && plan.some((step) => step.id === "skill_registry" && step.run)) await sleep(FILE_CLOCK_MARGIN_MS);

  // The registry first, because the dashboard below reports what is in it.
  const done = await runFirstRunPlan(plan.filter((step) => step.id === "skill_registry"), actions, announce);

  // Container-only artefacts: a vault a person browses has a dashboard note,
  // and the runtime distribution manifest is written once per volume. Both are
  // written before the index rather than after it — a note that appears after
  // the index was built leaves it stale the moment the entrypoint finishes, and
  // the next container start rebuilt it for nothing.
  if (!await exists(path.join(vaultRoot, "01-system", "System Dashboard.md"))) {
    await tool("rebuild_system_dashboard");
  }
  if (!await exists(path.join(vaultRoot, "09-mcp", "runtime-distribution.json"))) {
    await tool("prepare_runtime_distribution");
  }

  done.push(...await runFirstRunPlan(plan.filter((step) => step.id !== "skill_registry"), actions, announce));
  return done;
}

try {
  const restored = await restorePreparedTimes({ dataRoot: path.dirname(vaultRoot), vaultRoot });
  if (restored.restored) {
    process.stderr.write(restored.refused
      ? `→ A new volume from the image's data, run as another user than the image's: the skill folders keep the copy's time (${restored.refused}), so what reads them is rebuilt once.\n`
      : `→ A new volume from the image's data: ${restored.dated} skill folder(s) given back the time they were built with.\n`);
  }
  for (const relative of [
    "01-system",
    "02-knowledge/Projects",
    "02-knowledge/Task Runs",
    "03-skills-catalog/registries",
    "09-mcp",
    "10-inbox",
    "99-archive"
  ]) {
    await fs.mkdir(path.join(vaultRoot, relative), { recursive: true });
  }

  // Each client session is a container of its own, and three clients started
  // at once build one volume: the steps go one start at a time, and the next
  // finds built what the first built. A start that is
  // still waiting when a client would give up serves what is built — and does
  // not build from a vault another start is still syncing.
  let release = null;
  const syncWaitedOut = seedSync?.status === "failed" && /^Timed out after \d+ ms waiting for the lock/.test(String(seedSync.error ?? ""));
  if (syncWaitedOut) {
    process.stderr.write("→ Another start is still syncing this volume's seed: this one serves what is there now, "
      + "and a later start finishes the rest.\n");
  } else {
    try {
      release = await acquireFileLock(path.join(path.dirname(vaultRoot), ".ai-dev-first-run"), {
        ...FIRST_RUN_LOCK,
        timeoutMs: Math.max(1_000, START_WAIT_MS - Math.round(performance.now()))
      });
    } catch (error) {
      // A volume this start cannot write is said as that.
      if (error?.code) throw error;
      process.stderr.write(`→ Another start is still building this volume after ${Math.round(performance.now() / 1000)} s: `
        + "this one serves what is built so far, and a later start finishes the rest.\n");
    }
  }
  let results = [];
  if (release) {
    try {
      results = await firstRunSteps();
    } finally {
      await release();
    }
    process.stderr.write(`${renderFirstRunReport(results)}\n`);
  }
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ restored, results, waited_out: !release })}\n`);
} finally {
  shutdownBgeWorkers();
}

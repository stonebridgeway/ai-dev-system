/**
 * `ai-dev model <status | install | import | verify | remove | doctor>` — the
 * local BGE-M3 model, by hand. The work is `core/model-manager.mjs` and
 * `core/dense-doctor.mjs`; this is the part that prints.
 *
 * Exit codes: 0 done, 1 failed (or, for status and doctor, not ready), 2 a
 * usage mistake, 130 stopped with Ctrl-C — what was done is kept.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { DOCKER_MOUNTED_MODEL_DIR, containerModelAdvice, legacyDenseNotes, unreadableModelAdvice } from "../core/dense-backend.mjs";
import { denseDoctorStages, renderDenseDoctorReport, runDenseDoctor } from "../core/dense-doctor.mjs";
import { readDenseManifest } from "../core/dense-manifest.mjs";
import { createOnnxDenseRuntime, defaultOnnxModelDir } from "../core/dense-onnx.mjs";
import { formatBytes } from "../core/disk-space.mjs";
import { hint } from "../core/install-layout.mjs";
import { proxyFor } from "../core/http-download.mjs";
import { denseRuntimeSupport, importModel, installModel, modelStatus, removeModel, verifyModel } from "../core/model-manager.mjs";
import { createProgressPrinter } from "../core/progress-line.mjs";
import { resolveRuntimeStateRoot } from "../core/runtime-home.mjs";

const SUBCOMMANDS = ["status", "install", "import", "verify", "remove", "doctor"];

export function usage() {
  return [
    "Usage: ai-dev model <command> [options]      (from a clone: npm run model -- <command>)",
    "",
    "  status            what is installed, what is missing, what stopped partway",
    "  install           download the model (about 600 MB, resumable), then embed the documents",
    "  import <path>     copy it from a folder or a .zip made on another machine, then embed",
    "  verify            hash every file against the manifest",
    "  remove            delete the model's files and nothing else",
    "  doctor            load the model and embed a probe, stage by stage",
    "",
    "  --dir <path>      the model folder (default: BGE_M3_ONNX_DIR, or ~/.ai-dev/models/bge-m3-onnx)",
    "  --mirror <url>    a Hugging Face mirror for this run (as AI_DEV_MODEL_MIRROR, e.g. https://hf-mirror.com)",
    "  --no-index        install or import without embedding the documents",
    "  --json            print the result as JSON",
    "",
    "Behind a proxy, HTTPS_PROXY, HTTP_PROXY and NO_PROXY are honoured."
  ].join("\n");
}

/** Ctrl-C stops after the current piece and keeps what is done; a second one does not wait. */
function interruptible(io, progress, say) {
  const controller = new AbortController();
  const state = { cancelled: false };
  const stop = () => {
    if (controller.signal.aborted) process.exit(EXIT.interrupted);
    progress.end();
    say("   Stopping after the current piece — what is done is kept. Ctrl-C again to quit now.");
    state.cancelled = true;
    controller.abort();
  };
  process.on("SIGINT", stop);
  return { signal: controller.signal, state, release: () => process.off("SIGINT", stop) };
}

/** Embed the documents with the model just put in place, through the server's own runtime. */
async function embedDocuments({ say, progress, signal }) {
  const { callTool, shutdownBgeWorkers } = await import("../mcp-stdio.mjs");
  try {
    say("Embedding the indexed documents (Membrane connectors are left out):");
    const result = await callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: true,
      dense_incremental: true
    }, { onProgress: progress, signal });
    progress.end();
    const document = JSON.parse(result?.content?.[0]?.text ?? "{}");
    say(`   ${document.dense_embedded_documents ?? 0} embedded now, ${document.dense_documents ?? 0} with a vector in all, `
      + `${document.dense_pending_documents ?? 0} waiting.`);
    return document;
  } finally {
    progress.end();
    await shutdownBgeWorkers();
  }
}

/** Every stage of loading the model, from the Node version up to a probe vector. */
async function doctor({ io, dir, json }) {
  let runtime = null;
  const denseRuntime = (manifest) => {
    runtime ??= createOnnxDenseRuntime({
      modelDir: dir,
      manifest,
      spawnWorker: ({ modelDir, manifest: pinned }) => new Worker(
        new URL("../workers/dense-onnx-worker.mjs", import.meta.url),
        { workerData: { modelDir, manifest: { ...pinned } } }
      )
    });
    return runtime;
  };
  try {
    const result = await runDenseDoctor(denseDoctorStages({
      nodeVersion: process.version,
      inContainer: String(io.env.AI_DEV_RUNTIME ?? "") === "docker",
      support: () => denseRuntimeSupport(),
      loadRuntime: () => import("onnxruntime-node"),
      readManifest: () => readDenseManifest(),
      verifyFiles: async (manifest) => ({
        ...await verifyModel({ manifest, dir }),
        partial: (await modelStatus({ manifest, dir, env: io.env })).partial
      }),
      // Loading is not observable on its own, so the cheapest embedding stands in for it.
      loadModel: async (manifest) => {
        const started = Date.now();
        await denseRuntime(manifest).embedTexts({ texts: ["warm"], include_embeddings: false });
        return { seconds: Number(((Date.now() - started) / 1000).toFixed(2)) };
      },
      embedProbe: async (manifest) => {
        const started = Date.now();
        const answer = await denseRuntime(manifest).embedTexts({ texts: ["dense search probe"] });
        return { vector: answer.embeddings[0] ?? [], seconds: Number(((Date.now() - started) / 1000).toFixed(3)) };
      }
    }));
    if (json) {
      io.out(JSON.stringify({ ok: result.ready, dir, ...result }, null, 2));
      return result.ready ? EXIT.ok : EXIT.failed;
    }
    io.out(`Model directory: ${dir}`);
    try {
      const { modelSources } = await import("../core/dense-download.mjs");
      const sources = modelSources(readDenseManifest(), io.env);
      const proxy = sources.length ? proxyFor(sources[0], io.env) : null;
      io.out(`Download from: ${sources.map((source) => new URL(source).host).join(", ") || "nowhere, the manifest lists no sources"}`
        + `${proxy ? ` (through the proxy ${proxy.host})` : ""}`);
    } catch (error) {
      io.out(`Download from: ${error.message}`);
    }
    const legacyDir = io.env.BGE_M3_MODEL_DIR || path.join(resolveRuntimeStateRoot("", io.env), "models", "bge-m3");
    for (const note of legacyDenseNotes(io.env, { legacyWeightsDir: existsSync(path.join(legacyDir, "pytorch_model.bin")) ? legacyDir : "" })) {
      io.out(`Note: ${note}`);
    }
    io.stdout.write(renderDenseDoctorReport(result));
    return result.ready ? EXIT.ok : EXIT.failed;
  } finally {
    if (runtime) await runtime.shutdown();
  }
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
export async function run(argv, io) {
  const { values, positionals } = parseCommandLine(argv, {
    command: "model",
    options: {
      dir: { type: "string" },
      mirror: { type: "string" },
      index: { type: "boolean", default: true },
      json: { type: "boolean" }
    },
    positionals: { max: 2, names: "arguments" }
  });
  if (values.help || positionals[0] === "help") {
    io.out(usage());
    return EXIT.ok;
  }
  const [command = "status", source] = positionals;
  if (!SUBCOMMANDS.includes(command)) {
    const near = closest(command, SUBCOMMANDS);
    throw new CliUsageError(`\`ai-dev model\` has no "${command}".${near ? ` Did you mean \`ai-dev model ${near}\`?` : ""} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  if (command === "import" && !source) throw new CliUsageError("`ai-dev model import` needs a folder or a .zip: `ai-dev model import <path>`.");
  if (command !== "import" && source) throw new CliUsageError(`\`ai-dev model ${command}\` takes no path; only import does.`);
  // The rest of the runtime reads the model folder and the mirror from the
  // environment, so the options set it for this run.
  if (values.dir) io.env.BGE_M3_ONNX_DIR = values.dir;
  if (values.mirror) io.env.AI_DEV_MODEL_MIRROR = values.mirror;
  const json = Boolean(values.json);
  const say = (line = "") => {
    if (!json) io.out(line);
  };
  const dir = defaultOnnxModelDir({ env: io.env });
  if (command === "doctor") return doctor({ io, dir, json });

  const manifest = readDenseManifest();
  const progress = createProgressPrinter({ stream: json ? { isTTY: false, write: () => true } : io.stdout });
  const support = denseRuntimeSupport();
  const stop = interruptible(io, progress, say);
  let outcome;
  try {
    outcome = await perform();
  } catch (error) {
    progress.end();
    if (json) io.out(JSON.stringify({ ok: false, cancelled: stop.state.cancelled, error: error.message }, null, 2));
    else io.err(error.message);
    return stop.state.cancelled || error?.cancelled ? EXIT.interrupted : EXIT.failed;
  } finally {
    stop.release();
  }
  if (json) io.out(JSON.stringify(outcome, null, 2));
  return outcome.ok ? EXIT.ok : EXIT.failed;

  async function perform() {
    switch (command) {
      case "status": {
        const status = await modelStatus({ manifest, dir, env: io.env, support });
        const notes = legacyDenseNotes(io.env);
        if (json) return { ok: status.installed, ...status, legacy: notes };
        say(`Model: ${manifest.export} @ ${String(manifest.revision).slice(0, 12)} (${manifest.dtype}) in ${status.dir}`);
        say(status.installed ? "Installed: yes, every file matches the manifest." : "Installed: no.");
        // A host's folder at /models in the image is put right on the host, not by an install into the volume.
        const mounted = String(io.env.AI_DEV_RUNTIME ?? "") === "docker" && status.dir === DOCKER_MOUNTED_MODEL_DIR;
        if (status.unreadable) say(`Cannot be read: ${status.unreadable}. ${unreadableModelAdvice(status.unreadable, { mounted })}`);
        if (status.missing.length) say(`Missing: ${status.missing.join(", ")}`);
        const install = hint("npm run model -- install");
        if (status.mismatched.length) say(`Not the pinned files: ${status.mismatched.join(", ")} — ${mounted ? `in this container, ${containerModelAdvice(status.dir)}` : `\`${install}\` fetches them again.`}`);
        for (const part of status.partial) say(`Stopped partway: ${part.file}, ${formatBytes(part.bytes)}${part.size ? ` of ${formatBytes(part.size)}` : ""} — ${mounted ? `in this container, ${containerModelAdvice(status.dir)}` : `\`${install}\` continues it.`}`);
        say(`Download from: ${status.sources_error || status.sources.map((url) => new URL(url).host).join(", ") || "nowhere, the manifest lists no sources"}`);
        if (!status.supported) say(status.support_reason);
        for (const note of notes) say(`Note: ${note}`);
        return { ok: status.installed };
      }
      case "verify": {
        const verified = await verifyModel({ manifest, dir, onProgress: progress });
        progress.end();
        if (json) return { ok: verified.ready, ...verified };
        say(verified.ready ? `Every file matches the manifest (${verified.present.length} checked in ${verified.dir}).`
          : `Missing: ${verified.missing.join(", ") || "none"}. Not the pinned files: ${verified.mismatched.join(", ") || "none"}.`);
        return { ok: verified.ready };
      }
      case "install":
      case "import": {
        if (!support.supported) say(`Note: ${support.reason} The files are still put in place, for a container or another machine to use.`);
        const placed = command === "install"
          ? await installModel({ manifest, dir, env: io.env, signal: stop.signal, onProgress: progress, log: (line) => {
            progress.end();
            say(`   ${line}`);
          } })
          : await importModel({ manifest, source, dir, signal: stop.signal, onProgress: progress });
        progress.end();
        // A model that is not whole is a failure, whatever got copied on the way.
        if (!placed.ready) {
          const wrong = [...(placed.missing ?? []), ...(placed.mismatched ?? [])];
          throw new Error(`The model in ${dir} is not complete${wrong.length ? `: ${wrong.join(", ")} missing or not the pinned file` : ""}. `
            + `\`${hint("npm run model -- status")}\` says what is there.`);
        }
        say(command === "install"
          ? `Model in place: ${dir} — ${placed.downloaded} file(s) fetched${placed.resumed ? `, ${placed.resumed} continued` : ""}, ${formatBytes(placed.bytes)} over the network.`
          : `Model in place: ${dir} — ${placed.copied.length} file(s) copied from ${placed.from}, ${placed.skipped.length} already here.`);
        const embedded = values.index && support.supported ? await embedDocuments({ say, progress, signal: stop.signal }) : null;
        if (!values.index) say(`Documents not embedded (--no-index): \`${hint("npm run setup -- --model")}\` does it later.`);
        return { ok: true, model: placed, index: embedded };
      }
      case "remove": {
        const removed = await removeModel({ manifest, dir });
        if (json) return { ok: true, ...removed };
        say(removed.removed.length ? `Removed ${removed.removed.length} file(s) from ${removed.dir}, ${removed.freed_text} freed.` : `Nothing to remove in ${removed.dir}.`);
        if (removed.kept.length) say(`Left in place, not the model's: ${removed.kept.join(", ")}`);
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  }
}

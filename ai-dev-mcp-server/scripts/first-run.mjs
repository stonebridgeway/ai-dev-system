#!/usr/bin/env node
/**
 * `npm run setup` — build what a fresh clone does not ship.
 *
 * The server works the moment it is cloned, but four things are built rather
 * than shipped and one is downloaded; until then the health check reports them
 * and the search tools answer with a refusal. What to do is decided in
 * `src/core/first-run.mjs`; this does it and says what happened.
 *
 * Nothing here reaches the network unless asked: `--frontend-qa` installs the
 * QA runner's dependencies, `--dense` builds the Python environment and
 * downloads the 2.3 GB BGE-M3 weights.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  describeDenseCoverage,
  firstRunSucceeded,
  planFirstRun,
  renderFirstRunReport,
  venvPythonPath
} from "../src/core/first-run.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");

function parseArgs(argv) {
  const options = { want: {}, force: false, health: true };
  for (const argument of argv) {
    if (argument === "--dense") Object.assign(options.want, { dense_model: true, dense_index: true });
    else if (argument === "--frontend-qa") options.want.frontend_qa = true;
    else if (argument === "--all") Object.assign(options.want, { dense_model: true, dense_index: true, frontend_qa: true });
    else if (argument === "--force") options.force = true;
    else if (argument === "--no-health") options.health = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}. Try --help.`);
  }
  return options;
}

function usage() {
  return [
    "Build what a fresh clone does not ship.",
    "",
    "Usage: npm run setup -- [--frontend-qa] [--dense] [--all] [--force] [--no-health]",
    "",
    "  (no flags)      skill registry, search index, routing benchmark",
    "  --frontend-qa   also install the Frontend QA runner's dependencies",
    "  --dense         also build the Python environment, download BGE-M3 (2.3 GB),",
    "                  and embed the indexed documents with it",
    "  --all           everything above",
    "  --force         rebuild what is already there",
    "  --no-health     skip the closing diagnostic"
  ].join("\n");
}

/** Run a command, streaming its output, and resolve with its exit code. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true, ...options });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function runOrThrow(label, command, args, options) {
  const code = await run(command, args, options);
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

const {
  callTool, shutdownBgeWorkers, vaultRoot, searchIndexPath, embeddingsDir, skillRoutingEvalCasesPath
} = await import("../src/mcp-stdio.mjs");

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  // A mistyped flag is a typo, not a crash: say which one and what to try.
  console.error(String(error?.message ?? error));
  process.exit(2);
}
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const modelDir = process.env.BGE_M3_MODEL_DIR
  || path.join(process.env.AI_DEV_HOME || process.env.HOME || process.env.USERPROFILE || "", ".ai-dev", "models", "bge-m3");
const venvDir = path.join(embeddingsDir, ".venv");
const densePython = process.env.AI_DEV_PYTHON || venvPythonPath({ venvDir, exists: existsSync });

const registriesDir = path.join(vaultRoot, "03-skills-catalog", "registries");
const routingReportPath = path.join(registriesDir, "skill-routing-eval.json");

// Asked once and read by both the plan and the report below: a status call
// walks the vault. A machine without a working Python helper cannot answer it,
// and that is a reason to rebuild rather than to stop before the first step.
const indexStatus = existsSync(searchIndexPath)
  ? await callTool("search_index_status", { include_external_project_files: true })
    .then(parseResult)
    .catch(() => null)
  : null;

const present = {
  skill_registry: existsSync(path.join(registriesDir, "skills.index.json")),
  search_index: existsSync(searchIndexPath),
  routing_benchmark: existsSync(routingReportPath),
  frontend_qa: existsSync(path.join(repositoryRoot, "frontend-qa", "node_modules")),
  dense_model: existsSync(path.join(modelDir, "pytorch_model.bin")),
  dense_index: Number(indexStatus?.dense_documents || 0) > 0
};

/** What each step actually does. Every one of them is idempotent. */
const ACTIONS = {
  async skill_registry() {
    const result = await callTool("rebuild_index", {});
    return summarize(result, (doc) => `${doc.total ?? doc.count ?? doc.skills ?? "?"} skill(s) indexed`);
  },
  async search_index() {
    const result = await callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: false,
      preserve_dense: true
    });
    return summarize(result, (doc) => (
      `${doc.indexed_document_count ?? doc.current_document_count ?? doc.documents ?? "?"} document(s) indexed`
    ));
  },
  async routing_benchmark() {
    const result = await callTool("run_skill_routing_eval", {});
    return summarize(result, (doc) => {
      const passed = doc.summary?.passed ?? doc.passed;
      const total = doc.summary?.total ?? doc.total;
      return total === undefined ? "benchmark written" : `${passed}/${total} cases pass`;
    });
  },
  async frontend_qa() {
    const qaRoot = path.join(repositoryRoot, "frontend-qa");
    const hasPnpmLock = existsSync(path.join(qaRoot, "pnpm-lock.yaml"));
    const manager = hasPnpmLock && (await hasCommand("pnpm")) ? "pnpm" : "npm";
    await runOrThrow(`${manager} install`, manager, ["install"], { cwd: qaRoot });
    return `${manager} install in frontend-qa/`;
  },
  async dense_model() {
    if (!existsSync(venvPythonPath({ venvDir, exists: existsSync }))) {
      await runOrThrow("python -m venv", process.env.AI_DEV_PYTHON_BASE || "python3", ["-m", "venv", venvDir]);
    }
    const python = venvPythonPath({ venvDir, exists: existsSync });
    await runOrThrow("pip install", python, [
      "-m", "pip", "install", "--disable-pip-version-check",
      "-r", path.join(embeddingsDir, "requirements-bge-m3.txt")
    ]);
    await fs.mkdir(modelDir, { recursive: true });
    await runOrThrow("model download", python, ["-c", [
      "from huggingface_hub import snapshot_download",
      `snapshot_download("BAAI/bge-m3", local_dir=${JSON.stringify(modelDir)},`,
      ' allow_patterns=["*.json", "*.model", "sentencepiece.bpe.model", "pytorch_model.bin"])'
    ].join("\n")]);
    return `model in ${modelDir}, interpreter ${python}`;
  },
  async dense_index() {
    const result = await callTool("rebuild_search_index", {
      include_external_project_files: true,
      dense_embeddings: true,
      dense_incremental: true
    });
    return summarize(result, (doc) => (
      `${doc.dense_documents ?? "?"} document(s) embedded, ${doc.dense_pending_documents ?? 0} still pending`
    ));
  }
};

async function hasCommand(command) {
  const code = await run(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
  return code === 0;
}

function parseResult(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarize(result, describe) {
  const doc = parseResult(result);
  return doc ? describe(doc) : "done";
}

async function modifiedAt(target) {
  const stat = await fs.stat(target).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

/**
 * What exists but no longer matches what it was built from.
 *
 * Existence was the only question this asked, so a vault whose notes had moved
 * on since the last build was told "already built" and then, two lines later by
 * the diagnostic in the same run, that its index and its benchmark were stale.
 * Both answers came from the same command. These are the signals the health
 * check itself grades, asked before rather than after.
 */
async function findStale(present) {
  const stale = {
    search_index: Boolean(indexStatus?.stale),
    // Documents indexed since the last embedding run have no vector, so the
    // dense half of a hybrid query cannot see them.
    dense_index: Number(indexStatus?.dense_pending_documents || 0) > 0
  };
  if (present.routing_benchmark) {
    const report = await modifiedAt(routingReportPath);
    const inputs = await Promise.all([
      modifiedAt(skillRoutingEvalCasesPath),
      modifiedAt(path.join(serverRoot, "src", "core", "skill-router.mjs"))
    ]);
    stale.routing_benchmark = report < Math.max(...inputs);
  }
  return stale;
}

const stale = await findStale(present);
const plan = planFirstRun({ present, stale, want: options.want, force: options.force });
console.log(`Vault: ${vaultRoot}`);
console.log(`Search index: ${searchIndexPath}`);
console.log(`Dense model: ${modelDir} (interpreter ${densePython})`);
if (indexStatus) console.log(describeDenseCoverage(indexStatus));
console.log("");

const results = [];
for (const step of plan) {
  if (!step.run) {
    results.push({ ...step, status: "skipped" });
    continue;
  }
  process.stdout.write(`→ ${step.title}: ${step.detail}\n`);
  const started = Date.now();
  try {
    const reason = await ACTIONS[step.id]();
    results.push({ ...step, status: "done", reason, duration_ms: Date.now() - started });
  } catch (error) {
    results.push({
      ...step,
      status: "failed",
      error: String(error?.message ?? error).split("\n")[0],
      duration_ms: Date.now() - started
    });
  }
}

console.log("");
console.log(renderFirstRunReport(results));

if (options.health) {
  console.log("");
  const health = await callTool("system_health_check", {
    include_search_smoke: true,
    include_dense_smoke: false,
    include_search_eval: false
  });
  const doc = parseResult(health) ?? {};
  const checks = doc.checks ?? [];
  const unhappy = checks.filter((check) => check.status !== "passed" && check.status !== "ok" && check.status !== "skipped");
  console.log(`Health: ${doc.status} — ${checks.length} check(s), ${unhappy.length} not passing.`);
  for (const check of unhappy) {
    console.log(`  ${check.status}: ${check.name} — ${String(check.summary).replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

await shutdownBgeWorkers();
process.exitCode = firstRunSucceeded(results) ? 0 : 1;

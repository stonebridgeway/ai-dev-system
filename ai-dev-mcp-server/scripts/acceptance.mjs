#!/usr/bin/env node
/**
 * `npm run acceptance` — the check a change is finished with.
 *
 * Ten consecutive `npm run check` runs and the line "N failures out of 10". One green
 * run is not proof: the failure this is built around appears in about two runs
 * out of ten and in none of the other eight.
 *
 * Usage: npm run acceptance [-- --runs 10] [--keep-logs]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acceptanceVerdict,
  renderAcceptanceReport,
  summarizeAcceptanceRun
} from "../src/core/acceptance.mjs";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { runs: 10, keepLogs: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runs") options.runs = Math.max(1, Math.min(Number(argv[index += 1]) || 10, 50));
    else if (argument === "--keep-logs") options.keepLogs = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}. Try --help.`);
  }
  return options;
}

/**
 * One `npm run check`, with its output captured rather than streamed.
 *
 * The command goes through `resolveSpawnInvocation` because on Windows `npm`
 * is `npm.cmd`, and Node refuses to spawn a `.cmd` without a shell — plain
 * `spawn("npm", …)` dies with `ENOENT` before the first run finishes. The
 * resolver rewrites it to `node <npm-cli.js>`, which needs no shell and so
 * carries no quoting risk.
 *
 * @param {string} logFile - Where this run's combined output is written.
 * @param {{ executable: string, args: string[] }} invocation - From `resolveSpawnInvocation`.
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
function runCheck(logFile, invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, { cwd: serverRoot, windowsHide: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", async (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      await fs.writeFile(logFile, output, "utf8").catch(() => {});
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}
if (options.help) {
  console.log("Usage: npm run acceptance [-- --runs 10] [--keep-logs]");
  process.exit(0);
}

// Resolved once: the answer cannot change between runs, and failing here says
// so before ten runs are announced rather than during the first one.
let invocation;
try {
  invocation = await resolveSpawnInvocation("npm", ["run", "check"]);
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}

const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-acceptance-"));
const runs = [];
for (let index = 1; index <= options.runs; index += 1) {
  const started = Date.now();
  process.stdout.write(`run ${index}/${options.runs} … `);
  const result = await runCheck(path.join(logDir, `run-${index}.log`), invocation);
  const summary = { ...summarizeAcceptanceRun(result), duration_ms: Date.now() - started };
  runs.push(summary);
  process.stdout.write(`${summary.ok ? "ok" : summary.kind} (${(summary.duration_ms / 1000).toFixed(0)}s)\n`);
}

console.log("");
console.log(renderAcceptanceReport(runs));
const verdict = acceptanceVerdict(runs);
if (!verdict.passed) console.log(`\nThe runs' logs: ${logDir}`);
else if (!options.keepLogs) await fs.rm(logDir, { recursive: true, force: true });

process.exitCode = verdict.passed ? 0 : 1;

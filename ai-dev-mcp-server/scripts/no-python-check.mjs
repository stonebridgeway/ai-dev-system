/**
 * The install as a machine without Python sees it: `npm ci`, the first run,
 * the health check and the MCP protocol smoke, each run with every PATH
 * directory that holds a Python interpreter taken out. CI runs it on Linux,
 * macOS and Windows, whose runners all carry Python and so never noticed that
 * search needed it.
 *
 * It refuses to start while an interpreter can still be found by name, and
 * fails when a step fails or the health check is not `ok`. The health check
 * must also report `ui_ux_knowledge` as skipped — the one tool that wants
 * Python saying it found none is the server's own word that the PATH is clean.
 *
 *   node scripts/no-python-check.mjs [--skip-install]
 *
 * It runs in this checkout and the current HOME, as a first run would; give it
 * an empty HOME to see what a new user sees.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { environmentWithoutPython, isPythonShebang, planPythonFreePath } from "../src/core/python-free-path.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";

/** `npm` as its own shim runs it: this Node and npm's CLI script, no shell. */
function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    windows
      ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const found = candidates.find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
  if (!found) throw new Error(`npm's CLI script is not next to ${process.execPath}; looked at ${candidates.filter(Boolean).join(", ")}.`);
  return found;
}

/** The first line's worth of a regular file, or "" for anything else. */
function readHead(file) {
  let handle;
  try {
    if (!fs.statSync(file).isFile()) return "";
    handle = fs.openSync(file, "r");
    const buffer = Buffer.alloc(128);
    return buffer.toString("latin1", 0, fs.readSync(handle, buffer, 0, buffer.length, 0));
  } catch {
    return "";
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * The PATH the steps run with: this Node's folder first — npm runs package
 * scripts as `node …` — then every entry of the current PATH, each kept,
 * dropped or mirrored without its interpreters as the plan says. Mirrors live
 * in `scratch`, which the caller removes.
 */
function pythonFreePath(scratch) {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const plan = planPythonFreePath({
    pathValue: [path.dirname(process.execPath), process.env[key] ?? ""].join(path.delimiter),
    listDirectory: (directory) => fs.readdirSync(directory),
    isPythonScript: (directory, name) => isPythonShebang(readHead(path.join(directory, name)))
  });
  if (plan[0].action === "drop") {
    throw new Error(`node.exe shares a folder with Python (${plan[0].directory}), so Python cannot be hidden from it.`);
  }
  const entries = [];
  plan.forEach((step, index) => {
    if (step.action === "keep") entries.push(step.directory);
    if (step.action !== "mirror") return;
    const mirror = path.join(scratch, String(index));
    fs.mkdirSync(mirror);
    for (const name of step.names) fs.symlinkSync(path.join(step.directory, name), path.join(mirror, name));
    entries.push(mirror);
  });
  return { pathValue: entries.join(path.delimiter), plan };
}

/** Throws unless every name an interpreter goes by fails to start. */
function assertNoPython(env) {
  for (const name of ["python3", "python", "py"]) {
    const result = spawnSync(name, ["--version"], { env, shell: false, encoding: "utf8" });
    if (result.error?.code !== "ENOENT") {
      const said = String(result.stdout || result.stderr || result.error?.message || "").trim();
      throw new Error(`"${name}" still starts on the cleaned PATH (${said || `exit ${result.status}`}).`);
    }
  }
}

function run(label, args, env, { capture = false } = {}) {
  console.log(`\n▶ ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli(), ...args], {
      cwd: serverRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"]
    });
    const chunks = [];
    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${label} exited with ${code}.`));
    });
  });
}

/** The health report must be `ok`, and must not have found Python itself. */
function judgeHealth(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error(`doctor did not print a health report: ${text.slice(0, 400)}`);
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const check of checks) console.log(`  ${check.status.padEnd(7)} ${check.name}`);
  const unhappy = checks.filter((check) => !["ok", "passed", "skipped"].includes(check.status));
  if (report.status !== "ok" || unhappy.length) {
    throw new Error(`health is ${report.status}: ${unhappy.map((check) => `${check.name} (${check.status}: ${check.summary})`).join("; ")}`);
  }
  const uiUx = checks.find((check) => check.name === "ui_ux_knowledge");
  if (uiUx?.status !== "skipped") {
    throw new Error(`ui_ux_knowledge is ${uiUx?.status ?? "missing"}, not skipped: the server still found a Python (${uiUx?.summary ?? "no check"}).`);
  }
  return checks.length;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-no-python-"));
try {
  const { pathValue, plan } = pythonFreePath(scratch);
  const env = environmentWithoutPython(process.env, pathValue);
  assertNoPython(env);
  for (const step of plan.filter((item) => item.action !== "keep")) {
    console.log(step.action === "drop" ? `Left out ${step.directory} (${step.reason}).` : `Mirrored ${step.directory} without its Python and Python scripts.`);
  }
  console.log("No Python on PATH: python3, python and py do not start.");
  if (!process.argv.includes("--skip-install")) await run("npm ci", ["ci", "--no-audit", "--no-fund"], env);
  await run("npm run setup", ["run", "setup"], env);
  const checkCount = judgeHealth(await run("npm run doctor", ["run", "-s", "doctor"], env, { capture: true }));
  await run("npm run protocol:smoke", ["run", "protocol:smoke"], env);
  console.log(`\nNo Python: install, setup, ${checkCount} health checks and the protocol smoke all passed.`);
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

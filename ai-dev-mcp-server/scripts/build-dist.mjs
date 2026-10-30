#!/usr/bin/env node
/**
 * `npm run dist` — the folder every installed form of the system is made from:
 * `dist/ai-dev/`, the npm package `ai-dev-system`, the Windows installer and
 * the Docker image, whose build context
 * holds this very folder (`npm run docker:prepare`).
 *
 *   node scripts/build-dist.mjs [--output <folder below dist/>] [--no-deps] [--pack]
 *
 * What it holds comes from `distribution.allowlist.json`, laid out as the
 * repository is — the server in `ai-dev-mcp-server/`, the Frontend QA runner in
 * `frontend-qa/`, the search cases in `search-eval/` — plus the seed in `seed/`,
 * which the server copies into the user's vault (`src/core/seed-sync.mjs`):
 *
 * - `package.json` for the package, with the CLI as its bin, and the server's
 *   lockfile as `npm-shrinkwrap.json`, so a user installs the tree the gates ran;
 * - `distribution.json`: every file with its size and sha256, the marker the
 *   server recognises a package layout by (`src/core/install-layout.mjs`);
 * - `node_modules/` with the production dependencies, unless `--no-deps`;
 * - with `--pack`, the tarball beside the folder, checked against the list.
 *
 * Nothing is published: `npm publish` is the owner's.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertSeedMatchesManifest, npmLeavesOut, packageManifest, planDistribution, shrinkwrapFrom, verifyDistribution } from "../src/core/distribution-build.mjs";
import { isDirectExecution } from "../src/core/direct-execution.mjs";
import { DISTRIBUTION_MARKER, PACKAGE_NAME } from "../src/core/install-layout.mjs";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";
import {
  assertCleanDistribution,
  auditDistributionTree,
  copyDistributionFile,
  distributionContentFingerprint,
  findDanglingImports,
  ownerUsername
} from "../src/core/public-distribution.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const distRoot = path.join(repositoryRoot, "dist");

function parseArgs(argv) {
  const options = { output: path.join(distRoot, "ai-dev"), deps: true, pack: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--no-deps") options.deps = false;
    else if (argv[index] === "--pack") options.pack = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function belowDist(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(distRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`The distribution must stay below ${distRoot}: ${resolved}`);
  return resolved;
}

/** Run npm without a shell (on Windows its `.cmd` shim is turned into `node <npm-cli.js>`). */
async function npm(args, { cwd, capture = false }) {
  const invocation = await resolveSpawnInvocation("npm", args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      // stdout is this script's answer; npm's own chatter goes to stderr.
      stdio: ["ignore", capture ? "pipe" : 2, 2]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`npm ${args[0]} exited with code ${code} in ${cwd}.`))));
  });
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** What the tarball holds, by top-level folder: the composition the pack report carries. */
function composition(files) {
  const groups = new Map();
  for (const file of files) {
    const top = file.path.includes("/") ? file.path.split("/")[0] : "(top level)";
    const group = groups.get(top) ?? { files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += Number(file.size ?? file.bytes ?? 0);
    groups.set(top, group);
  }
  return Object.fromEntries([...groups].sort((left, right) => right[1].bytes - left[1].bytes));
}

async function pack(output) {
  const raw = await npm(["pack", "--json", "--pack-destination", distRoot], { cwd: output, capture: true });
  // Lifecycle output may precede npm's JSON; the answer is the last array.
  const report = JSON.parse(raw.slice(raw.lastIndexOf("\n[") + 1 || raw.indexOf("[")))[0];
  const marker = await readJson(path.join(output, DISTRIBUTION_MARKER));
  const expected = new Set([DISTRIBUTION_MARKER, ...marker.files.map((file) => file.path)]);
  const packed = new Set(report.files.map((file) => file.path));
  const missing = [...expected].filter((file) => !packed.has(file));
  const extra = [...packed].filter((file) => !expected.has(file));
  if (missing.length || extra.length) {
    throw new Error(`The tarball is not the distribution: ${missing.length} file(s) left out (${missing.slice(0, 5).join(", ")}), `
      + `${extra.length} added (${extra.slice(0, 5).join(", ")}).`);
  }
  // Unpacked, the tarball must be the same tree byte for byte — npm may rewrite package.json.
  const tarball = path.join(distRoot, report.filename);
  const unpacked = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-dist-unpack-"));
  try {
    // Windows' own bsdtar by its path: a GNU tar from Git Bash first on PATH reads
    // `C:` in `C:\…` as a remote host.
    const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const tarCommand = process.platform === "win32" && await fs.access(systemTar).then(() => true, () => false) ? systemTar : "tar";
    const tar = await resolveSpawnInvocation(tarCommand, ["-xzf", tarball, "-C", unpacked]);
    await new Promise((resolve, reject) => {
      const child = spawn(tar.executable, tar.args, { shell: false, windowsHide: true, stdio: ["ignore", 2, 2] });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}.`))));
    });
    const check = await verifyDistribution(path.join(unpacked, "package"));
    if (!check.ok) throw new Error(`The unpacked tarball does not verify: ${JSON.stringify({ missing: check.missing, changed: check.changed, extra: check.extra })}`);
  } finally {
    await fs.rm(unpacked, { recursive: true, force: true });
  }
  return {
    tarball,
    tarball_bytes: report.size,
    unpacked_bytes: report.unpackedSize,
    entries: report.entryCount,
    integrity: report.integrity,
    composition: composition(report.files)
  };
}

/**
 * The distribution's files in `stage`, a folder the caller made and owns: what
 * the allowlist ships, the seed checked against its manifest, `package.json`,
 * the shrinkwrap and `distribution.json` — and the dependencies, when asked.
 * The Docker build context holds exactly this (`prepare-docker-context.mjs`).
 *
 * @param {string} stage
 * @param {{ deps?: boolean }} [options]
 * @returns {Promise<{ name: string, version: string, files: number, bytes: number, fingerprint: string }>}
 */
export async function stageDistribution(stage, { deps = true } = {}) {
  const plan = await planDistribution({ repositoryRoot, target: "dist" });
  // Said before anything is copied: a file npm leaves out of the tarball is
  // one every installed package would be missing.
  const dropped = plan.filter((item) => npmLeavesOut(item.destination)).map((item) => item.destination);
  if (dropped.length) throw new Error(`npm pack would leave out ${dropped.length} file(s) the distribution needs: ${dropped.join(", ")}.`);
  for (const item of plan) await copyDistributionFile(item.source, path.join(stage, ...item.destination.split("/")));
  await assertSeedMatchesManifest(path.join(stage, "seed"));

  const dangling = [
    ...await findDanglingImports(path.join(stage, "ai-dev-mcp-server")),
    ...await findDanglingImports(path.join(stage, "frontend-qa"))
  ];
  if (dangling.length) {
    throw new Error(`Shipped modules import files the distribution does not carry: ${dangling.slice(0, 5).map((item) => `${item.file} → ${item.specifier}`).join("; ")}.`);
  }

  const server = await readJson(path.join(serverRoot, "package.json"));
  const lock = await readJson(path.join(serverRoot, "package-lock.json"));
  // npm packs package.json by itself, but a shrinkwrap only when `files` names it.
  const entries = new Set([...plan.map((item) => item.destination.split("/")[0]), DISTRIBUTION_MARKER, "npm-shrinkwrap.json"]);
  const manifest = packageManifest({ server, entries, name: PACKAGE_NAME });
  await writeJson(path.join(stage, "package.json"), manifest);
  await writeJson(path.join(stage, "npm-shrinkwrap.json"), shrinkwrapFrom(lock, manifest));

  const forbiddenTerms = [os.homedir(), ...(process.env.CI ? [] : [ownerUsername()])];
  const audit = assertCleanDistribution(await auditDistributionTree(stage, { forbiddenTerms }), "npm distribution");
  const fingerprint = distributionContentFingerprint(audit.files);
  await writeJson(path.join(stage, DISTRIBUTION_MARKER), {
    schema_version: 1,
    name: manifest.name,
    version: manifest.version,
    policy: "generated from distribution.allowlist.json and the public-seed manifest",
    // Outside the fingerprint, which is over `files` alone: the same tree built twice fingerprints the same.
    built_at: new Date().toISOString(),
    total_files: audit.total_files,
    total_bytes: audit.total_bytes,
    content_fingerprint: fingerprint,
    files: audit.files
  });

  if (deps) await npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: stage });
  const check = await verifyDistribution(stage);
  if (!check.ok) throw new Error(`The staged distribution does not verify: ${JSON.stringify(check)}`);
  return { name: manifest.name, version: manifest.version, files: audit.total_files, bytes: audit.total_bytes, fingerprint };
}

export async function buildDistribution({ output, deps = true, pack: wantPack = false } = {}) {
  const outputRoot = belowDist(output ?? path.join(distRoot, "ai-dev"));
  const stage = path.join(distRoot, `.stage-${process.pid}`);
  await fs.mkdir(distRoot, { recursive: true });
  await fs.rm(stage, { recursive: true, force: true });
  try {
    const staged = await stageDistribution(stage, { deps });

    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await fs.rename(stage, outputRoot);
    return {
      status: "built",
      output: outputRoot,
      name: staged.name,
      version: staged.version,
      files: staged.files,
      bytes: staged.bytes,
      dependencies: deps ? "installed (npm ci --omit=dev --ignore-scripts)" : "not installed (--no-deps)",
      ...(wantPack ? { pack: await pack(outputRoot) } : {})
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (await isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await buildDistribution(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

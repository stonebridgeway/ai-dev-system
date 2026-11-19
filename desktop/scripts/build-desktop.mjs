#!/usr/bin/env node
/**
 * The desktop app, in one command per system (docs/DESKTOP.md,
 * "The desktop install"):
 *
 *   node scripts/build-desktop.mjs [--target win32-x64|darwin-arm64|linux-x64] [--dir] [--check]
 *   npm run dist:win | dist:mac | dist:linux
 *
 * 1. the server's distribution (`ai-dev-mcp-server/scripts/build-dist.mjs`)
 *    into `dist/<target>/runtime`;
 * 2. its production dependencies for the target (`npm ci --os --cpu`, so one
 *    machine builds another's tree where the native packages allow), less
 *    what the runtime never loads there (`runtime-bundle.mjs`, `TRIMMED`);
 * 3. Node 24 LTS for the target, by the version and sha256 pinned in
 *    `build/node-<target>.json`, and the command beside it (`ai-dev.cmd`, or
 *    the `ai-dev` shell script);
 * 4. `bundle.json`: every file with its sha256, which the app checks as it
 *    copies the runtime — read back by the app's own parser — and the app's
 *    version, which must be the runtime's;
 * 5. electron-builder: the app in `app.asar`, the runtime in
 *    `resources/runtime`, and the target's packages — an NSIS installer for
 *    the current user on Windows, a `.dmg` and a `.zip` on macOS, an AppImage
 *    and a `.deb` on Linux — in `dist/<target>/installer`; with `--dir`, only
 *    the unpacked app;
 * 6. the runtime as it landed in the packed app, checked against `bundle.json`.
 *
 * `--check` stops after step 4 and prints the runtime's composition. The
 * target is this machine's when not named. A `.dmg` is made on macOS only; on
 * Linux and macOS the NSIS installer needs Wine (32-bit too): its uninstaller
 * is made by running the installer. Nothing is published: a release is the
 * owner's.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { circlePng, TRAY_COLOURS } from "../src/main/tray-icon.mjs";
import {
  builderConfig,
  commandFile,
  compositionProblems,
  compositionReport,
  danglingDependencies,
  dropEmptySigning,
  extractTarGz,
  hostTarget,
  icoFrom,
  listFiles,
  targetOf,
  trimRuntime,
  versionProblem,
  writeBundleMarker
} from "./runtime-bundle.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const serverRoot = path.join(repositoryRoot, "ai-dev-mcp-server");

const fromServer = (relative) => import(pathToFileURL(path.join(serverRoot, ...relative.split("/"))).href);
const say = (line) => process.stderr.write(`${line}\n`);
const megabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function parseArgs(argv) {
  const options = { dir: false, check: false, target: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") options.dir = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--target") options.target = targetOf(argv[(index += 1)] ?? "");
    else if (argument.startsWith("--target=")) options.target = targetOf(argument.slice("--target=".length));
    else throw new Error(`Unknown argument: ${argument}. It takes --target <system-processor>, --dir and --check.`);
  }
  options.target ??= hostTarget();
  if (!options.target) throw new Error(`This machine (${process.platform}-${process.arch}) is no target: name one with --target.`);
  return options;
}

/** Where a target's build goes: `dist/windows` for Windows, as it always has, `dist/<target>` for the others. */
function folders(target) {
  const root = path.join(repositoryRoot, "dist", target.platform === "win32" ? "windows" : target.id);
  return { root, runtime: path.join(root, "runtime"), cache: path.join(root, "cache"), output: path.join(root, "installer") };
}

/** Run a command without a shell; npm and node through the server's adapter, which turns npm's `.cmd` shim into `node <npm-cli.js>` on Windows. */
async function run(command, args, { cwd }) {
  const { resolveSpawnInvocation } = await fromServer("src/core/process-runner.mjs");
  const invocation = await resolveSpawnInvocation(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code} in ${cwd}.`))));
  });
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Fetch `url` into `file` over HTTPS, following redirects, unless it is there with the pinned sha256. */
async function download(url, file, sha256, pinFile) {
  if (await sha256Of(file).then((sum) => sum === sha256, () => false)) return "cached";
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  const fetchTo = (address, hops = 0) => new Promise((resolve, reject) => {
    https.get(address, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && hops < 5) {
        response.resume();
        resolve(fetchTo(new URL(response.headers.location, address).href, hops + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${address} answered HTTP ${response.statusCode}.`));
        return;
      }
      pipeline(response, createWriteStream(partial)).then(resolve, reject);
    }).on("error", reject);
  });
  await fetchTo(url);
  const sum = await sha256Of(partial);
  if (sum !== sha256) {
    await fs.rm(partial, { force: true });
    throw new Error(`${url} has sha256 ${sum}, not the pinned ${sha256}: not the file build/${pinFile} names.`);
  }
  await fs.rename(partial, file);
  return "downloaded";
}

/** Node for the target, by its pin: the archive's sha256, then the binary's own, as it lands in the runtime. */
async function addNode(pin, target, { runtime, cache }) {
  const archive = path.join(cache, path.basename(new URL(pin.url).pathname));
  say(`Node ${pin.version} for ${target.id}: ${await download(pin.url, archive, pin.sha256, target.pin)}.`);
  const binary = path.join(runtime, ...target.node.split("/"));
  const license = path.join(runtime, "node", "LICENSE");
  if (archive.endsWith(".zip")) {
    const { openZipEntry, readZipEntries } = await fromServer("src/core/model-archive.mjs");
    const entries = await readZipEntries(archive);
    for (const [entry, file] of [[pin.entry, binary], [pin.license, license]]) {
      const found = entries.get(entry);
      if (!found) throw new Error(`${archive} has no ${entry}.`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await pipeline(await openZipEntry(archive, found), createWriteStream(file));
    }
  } else {
    const written = await extractTarGz(archive, new Map([[pin.entry, binary], [pin.license, license]]));
    for (const entry of [pin.entry, pin.license]) if (!written.includes(entry)) throw new Error(`${archive} has no ${entry}.`);
  }
  const nodeSum = await sha256Of(binary);
  if (nodeSum !== pin.binary_sha256) throw new Error(`${target.node} from ${archive} has sha256 ${nodeSum}, not the pinned ${pin.binary_sha256}.`);
}

/** The runtime, ready to ship: steps 1 to 4. */
async function buildRuntime(pin, target, where) {
  const { runtime } = where;
  await fs.rm(runtime, { recursive: true, force: true });
  say("1. The server's distribution…");
  await run("node", [path.join(serverRoot, "scripts", "build-dist.mjs"), "--output", runtime, "--no-deps"], { cwd: serverRoot });
  say(`2. Its dependencies for ${target.id}…`);
  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", `--os=${target.platform}`, `--cpu=${target.arch}`, "--no-audit", "--no-fund"], { cwd: runtime });
  const trimmed = await trimRuntime(runtime, { target });
  for (const item of trimmed) say(`   cut ${item.path} (${megabytes(item.bytes)}): ${item.why}`);
  const dangling = await danglingDependencies(path.join(runtime, "node_modules"));
  if (dangling.length) throw new Error(`The cut went too far: ${dangling.map((item) => `${item.package} needs ${item.missing}`).join("; ")}.`);
  say(`3. Node for ${target.id}…`);
  await addNode(pin, target, where);
  const command = commandFile(target);
  await fs.writeFile(path.join(runtime, command.name), command.text, { mode: command.mode });
  await fs.chmod(path.join(runtime, command.name), command.mode);
  say("4. bundle.json…");
  const { bundleFingerprint, parseBundle } = await fromServer("src/core/app-bundle.mjs");
  const distribution = JSON.parse(await fs.readFile(path.join(runtime, "distribution.json"), "utf8"));
  // Read back by the app's own parser: what it would refuse does not ship.
  const marker = await writeBundleMarker({ runtimeDir: runtime, name: distribution.name, version: distribution.version, node: { version: pin.version, sha256: pin.binary_sha256 }, fingerprintOf: bundleFingerprint, parse: parseBundle, target });
  return { trimmed, marker };
}

/** Where electron-builder puts the runtime in the unpacked app. */
function packedRuntime(target, output) {
  if (target.platform === "darwin") return path.join(output, `mac-${target.arch}`, "AI Dev.app", "Contents", "Resources", "runtime");
  return path.join(output, `${target.platform === "win32" ? "win" : "linux"}-unpacked`, "resources", "runtime");
}

/** The runtime as it landed in the packed app: every file `bundle.json` lists, with its sha256 — and, off Windows, the Node and the command still runnable. */
async function checkShipped(packed, marker, target) {
  const landed = new Map((await listFiles(packed)).map((file) => [file.path, file]));
  const missing = marker.files.filter((file) => landed.get(file.path)?.sha256 !== file.sha256).map((file) => file.path);
  if (missing.length) throw new Error(`${missing.length} runtime file(s) did not land in the app as built, such as ${missing.slice(0, 3).join(", ")}.`);
  if (target.platform !== "win32") {
    for (const file of [target.node, target.command]) {
      const mode = (await fs.stat(path.join(packed, ...file.split("/")))).mode;
      if (!(mode & 0o100)) throw new Error(`${file} lost its execute bit in the packed app (mode ${(mode & 0o777).toString(8)}).`);
    }
  }
  return landed.size;
}

/** The app's icon for the target, drawn at build time — the repository keeps binaries out. */
async function writeIcon(target, root) {
  const folder = path.join(root, "build");
  await fs.mkdir(folder, { recursive: true });
  if (target.platform === "win32") {
    const icon = path.join(folder, "icon.ico");
    await fs.writeFile(icon, icoFrom([256, 48, 32, 16].map((size) => ({ size, data: circlePng(TRAY_COLOURS.ok, size) }))));
    return icon;
  }
  const icon = path.join(folder, "icon.png");
  await fs.writeFile(icon, circlePng(TRAY_COLOURS.ok, target.platform === "darwin" ? 1024 : 512));
  return icon;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { target } = options;
  const where = folders(target);
  const pin = JSON.parse(await fs.readFile(path.join(desktopRoot, "build", target.pin), "utf8"));
  const started = Date.now();
  const { trimmed, marker } = await buildRuntime(pin, target, where);
  const report = { target: target.id, runtime: compositionReport(marker.files), trimmed, fingerprint: marker.fingerprint, version: marker.version, node: marker.node };
  const app = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const problems = [...compositionProblems(marker.files, { nodeSha256: pin.binary_sha256, target }), versionProblem({ app: app.version, runtime: marker.version })].filter(Boolean);
  if (problems.length) throw new Error(`The runtime is not what ships:\n- ${problems.join("\n- ")}`);
  if (!options.check) {
    const dropped = dropEmptySigning(process.env);
    if (dropped.length) say(`   ${dropped.join(", ")} set but empty: taken as not set.`);
    const config = builderConfig({ desktopRoot, runtimeDir: where.runtime, icon: await writeIcon(target, where.root), output: where.output, target });
    const kinds = options.dir ? ["dir"] : config[{ win32: "win", darwin: "mac", linux: "linux" }[target.platform]].target.map((item) => item.target);
    say(`5. electron-builder (${kinds.join(", ")})…`);
    const builder = createRequire(import.meta.url)("electron-builder");
    const platform = { win32: builder.Platform.WINDOWS, darwin: builder.Platform.MAC, linux: builder.Platform.LINUX }[target.platform];
    const artifacts = await builder.build({
      projectDir: desktopRoot,
      targets: platform.createTarget(kinds, builder.Arch[target.arch]),
      config,
      publish: "never"
    });
    say("6. The runtime in the packed app…");
    report.shipped_files = await checkShipped(packedRuntime(target, where.output), marker, target);
    report.artifacts = [];
    for (const artifact of artifacts) report.artifacts.push({ file: path.relative(repositoryRoot, artifact), bytes: (await fs.stat(artifact)).size });
  }
  report.seconds = Math.round((Date.now() - started) / 1000);
  // electron-builder writes its own lines to stdout: the report is a file too.
  await fs.writeFile(path.join(where.root, "build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// A build that ends before it finishes failed: electron-builder can log an
// error and leave its promise unsettled, and Node would end with 0.
let finished = false;
process.on("exit", () => {
  if (finished) return;
  say("The build stopped before it finished: electron-builder gave no answer after the error above.");
  process.exitCode = 1;
});
main().then(() => {
  finished = true;
}, (error) => {
  finished = true;
  say(String(error?.stack ?? error));
  process.exitCode = 1;
});

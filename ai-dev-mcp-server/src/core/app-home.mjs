/**
 * A copy of the app that outlives the package manager's cache.
 *
 * `npx ai-dev-system setup` runs the package from npm's `_npx`
 * cache, which npm may clear at any time; a client config that names a file
 * there stops working the day it is cleared. So `setup` run from such a place
 * installs the package into `<runtime>/app/<version>-<fingerprint>/` and goes
 * on from there, and the client configs it writes name that copy.
 *
 * The copy is the files `distribution.json` lists, checked against their
 * sha256, plus its dependencies installed by `npm ci --ignore-scripts` from the
 * package's own `npm-shrinkwrap.json`: the tree the gates ran, and no
 * onnxruntime-node postinstall — which on Linux x64 fetches a 236 MB CUDA
 * provider the server never loads, and fails behind a proxy. The npm cache npx
 * just filled serves it, so nothing is downloaded twice.
 *
 * The folder carries the content fingerprint, not just the version: a rebuilt
 * package of the same version gets a folder of its own instead of replacing
 * one a running server may hold open (Windows refuses that). The newest two
 * copies stay — a client still running the previous one keeps its files.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DISTRIBUTION_MARKER } from "./install-layout.mjs";
import { atomicWriteJson } from "./atomic-files.mjs";
import { verifyDistribution } from "./distribution-build.mjs";
import { LEGACY_SERVER_NAMES, SERVER_NAME, discoverClients, readServerEntries } from "./mcp-clients.mjs";

/** Written last into a finished copy; a folder without it is an install that stopped. */
export const APP_MARKER = ".ai-dev-app.json";

/** How many installed copies stay. */
export const KEPT_APP_COPIES = 2;

/** The Windows install's stable link in the app home (`app-bundle.mjs`): a link, not a copy. */
export const CURRENT_LINK = "current";

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

/** Two real paths of one folder: Windows and macOS ignore case in a name. */
const samePath = (left, right) => (["win32", "darwin"].includes(process.platform) ? left.toLowerCase() === right.toLowerCase() : left === right);

/**
 * Where a package of this content lives in the app home.
 *
 * @param {string} runtimeRoot
 * @param {{ version: string, content_fingerprint: string }} distribution - The package's `distribution.json`.
 * @returns {string}
 */
export function appFolder(runtimeRoot, distribution) {
  const version = String(distribution.version || "0.0.0").replace(/[^0-9A-Za-z.+-]/g, "_");
  // Hex only: a fingerprint of `../../..` named the runtime folder itself,
  // which an install then removed.
  const fingerprint = String(distribution.content_fingerprint || "").replace(/[^0-9a-f]/gi, "").slice(0, 8) || "unknown";
  return path.join(runtimeRoot, "app", `${version}-${fingerprint}`);
}

/**
 * Rename a folder, again while Windows says a file in it is busy: an
 * antivirus scanner opens what `npm ci` just wrote.
 */
async function renameFolder(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 9 || !["EACCES", "EPERM", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** The CLI inside a copy: what client configs run, with `mcp`. */
export function appCli(folder) {
  return path.join(folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs");
}

async function finished(folder, fingerprint) {
  try {
    const marker = await readJson(path.join(folder, APP_MARKER));
    if (marker.content_fingerprint !== fingerprint) return false;
    await fs.access(appCli(folder));
    return true;
  } catch {
    return false;
  }
}

/** An install that stopped this long ago is not still running. */
const STOPPED_INSTALL_MS = 60 * 60 * 1000;

/**
 * Keep the copies setup chose last — not the ones installed last: choosing an
 * installed copy again makes it the current one — and remove the rest
 * and any install that stopped partway. A copy goes aside as `.partial` before
 * it is removed, so one Windows refuses to remove completely (a running
 * server holds it) is finished off by a later install instead of staying,
 * without its marker, for good. A folder without a marker that is not a
 * partial install is not this module's, and stays.
 *
 * Each kind of copy is kept by its own count: the packages `setup` installs
 * and the runtimes the Windows install copies (`kind: "bundle"` in the
 * marker) are chosen at different times, and one kind's newer copies must not
 * push out the other's. The copy the Windows
 * install's stable link `current` names is never removed, however long ago it
 * was chosen: every AI client config of that install runs it
 * (`app-bundle.mjs`); nor is a copy an AI client's entry names by its own
 * folder (`named`). The link itself is not a folder, and is left alone.
 *
 * @param {string} appsRoot - `<runtime>/app`.
 * @param {number} keep - How many copies of this kind stay, the one `current` names among them.
 * @param {number} nowMs
 * @param {{ kind?: "package"|"bundle", named?: string[] }} [options] - `named`: copies a client runs, which stay besides.
 * @returns {Promise<string[]>} the copies removed
 */
export async function pruneAppCopies(appsRoot, keep, nowMs, { kind = "package", named = [] } = {}) {
  const entries = await fs.readdir(appsRoot, { withFileTypes: true }).catch(() => []);
  const linked = await fs.realpath(path.join(appsRoot, CURRENT_LINK)).catch(() => "");
  const spared = (await Promise.all(named.map((folder) => fs.realpath(folder).catch(() => "")))).filter(Boolean);
  const copies = [];
  const partials = [];
  let linkedHere = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(appsRoot, entry.name);
    if (entry.name.endsWith(".partial")) {
      partials.push(folder);
      continue;
    }
    const marker = await readJson(path.join(folder, APP_MARKER)).catch(() => null);
    if (!marker || (marker.kind === "bundle" ? "bundle" : "package") !== kind) continue;
    const real = await fs.realpath(folder).catch(() => folder);
    if (linked && samePath(real, linked)) {
      linkedHere = true;
      continue;
    }
    if (spared.some((other) => samePath(real, other))) continue;
    copies.push({ folder, at: Date.parse(marker.chosen_at ?? marker.installed_at ?? "") || 0 });
  }
  copies.sort((left, right) => right.at - left.at);
  const removed = [];
  // The linked copy is one of the kept ones: it is the current install's.
  for (const { folder } of copies.slice(linkedHere ? Math.max(0, keep - 1) : keep)) {
    const aside = `${folder}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.partial`;
    // In use on Windows: it cannot even be renamed, and stays until the next time.
    if (!await fs.rename(folder, aside).then(() => true, () => false)) continue;
    removed.push(folder);
    await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const folder of partials) {
    const stat = await fs.stat(folder).catch(() => null);
    if (stat && nowMs - stat.mtimeMs > STOPPED_INSTALL_MS) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}

/**
 * The folder of `<runtime>/app/` an absolute path lies in, by its name; ""
 * for a path elsewhere, and for a word that is not an absolute path: a bare
 * word of a client's entry (`mcp`, `docker`) names no folder, wherever the
 * process that reads it runs.
 *
 * @param {unknown} word
 * @param {string} appsRoot
 * @returns {string}
 */
export function appEntryOf(word, appsRoot) {
  if (typeof word !== "string" || !word || !path.isAbsolute(word)) return "";
  const relative = path.relative(appsRoot, path.resolve(word));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep)[0];
}

/** The words of a client's entry that can name a file: its command and its arguments. */
export function entryWords(entry) {
  if (!entry || typeof entry !== "object") return [];
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((word) => typeof word === "string" && word);
}

/**
 * The copies in `<runtime>/app/` an AI client's entry names by their own
 * folder rather than through `current`: what a client runs when the drive
 * holds no link, or when its entry was written by hand. A prune
 * leaves them, however old.
 *
 * @param {{ appsRoot: string, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {Promise<string[]>}
 */
export async function copiesNamedByClients({ appsRoot, env = process.env, home = os.homedir() }) {
  const named = new Set();
  for (const row of await readServerEntries(await discoverClients({ home, env }))) {
    for (const name of [SERVER_NAME, ...LEGACY_SERVER_NAMES]) {
      for (const word of entryWords(row.entries?.[name])) {
        const folder = appEntryOf(word, appsRoot);
        if (folder && folder !== CURRENT_LINK) named.add(path.join(appsRoot, folder));
      }
    }
  }
  return [...named].sort();
}

/**
 * Install the package at `packageRoot` into the app home, or find it there.
 *
 * @param {object} input
 * @param {string} input.packageRoot - The package as npx unpacked it (holds `distribution.json`).
 * @param {string} input.runtimeRoot - `~/.ai-dev`, or `AI_DEV_HOME`.
 * @param {(args: string[], options: { cwd: string }) => Promise<void>} input.runNpm - Runs npm without a shell.
 * @param {() => Date} [input.now]
 * @param {NodeJS.ProcessEnv} [input.env] - Where the AI clients' configs are found: a copy one of them names stays.
 * @param {string} [input.home]
 * @returns {Promise<{ status: "installed"|"present", folder: string, cli: string, version: string, removed: string[] }>}
 */
export async function installAppHome({ packageRoot, runtimeRoot, runNpm, now = () => new Date(), env = process.env, home = os.homedir() }) {
  const distribution = await readJson(path.join(packageRoot, DISTRIBUTION_MARKER));
  const folder = appFolder(runtimeRoot, distribution);
  const result = (status, removed = []) => ({ status, folder, cli: appCli(folder), version: String(distribution.version ?? ""), removed });
  if (await finished(folder, distribution.content_fingerprint)) {
    // Chosen again: it is the current copy now, and the one a prune keeps.
    const marker = await readJson(path.join(folder, APP_MARKER));
    await atomicWriteJson(path.join(folder, APP_MARKER), { ...marker, chosen_at: now().toISOString() });
    return result("present");
  }

  const stage = `${folder}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.partial`;
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const file of [...distribution.files.map((item) => item.path), DISTRIBUTION_MARKER]) {
      const target = path.join(stage, ...String(file).split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(packageRoot, ...String(file).split("/")), target);
    }
    // What was copied is what was built: a cache npm half-cleared, or a file
    // edited in it, does not become the app clients run.
    const check = await verifyDistribution(stage);
    if (!check.ok) {
      throw new Error(`The package in ${packageRoot} is not the one its distribution.json describes `
        + `(${[...check.missing, ...check.changed].slice(0, 3).join(", ")}); install it again.`);
    }
    await runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: stage });
    const stamp = now().toISOString();
    await fs.writeFile(path.join(stage, APP_MARKER), `${JSON.stringify({
      schema_version: 1,
      name: distribution.name,
      version: distribution.version,
      content_fingerprint: distribution.content_fingerprint,
      installed_at: stamp,
      chosen_at: stamp,
      installed_from: packageRoot
    }, null, 2)}\n`);
    // A folder left by an install that stopped is replaced; a finished one of
    // this fingerprint was returned above.
    await fs.rm(folder, { recursive: true, force: true });
    await renameFolder(stage, folder);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // A client a later setup did not connect again still runs its copy: the prune leaves it.
  const named = await copiesNamedByClients({ appsRoot: path.dirname(folder), env, home }).catch(() => []);
  return result("installed", await pruneAppCopies(path.dirname(folder), KEPT_APP_COPIES, now().getTime(), { named }));
}

/**
 * The installed app's runtime, and the one path AI clients start it by.
 *
 * The app's build (`desktop/`, `npm run dist:win`, `dist:mac`, `dist:linux`)
 * ships the package with its dependencies and a Node of its own in
 * `resources/runtime/`, described by `bundle.json`: every file with its size
 * and sha256. AI clients must not run it there: an update replaces the app's
 * folder — an AppImage's mount is gone when the app quits — and Windows will
 * not replace a file a running process holds — the
 * Node of every client's bridge, the daemon, the model's DLLs — and the
 * installer's update moves the whole install folder aside before writing the
 * new one, so one busy file stops the update ("File is busy, aborting").
 *
 * So the app copies the runtime into `<runtime>/app/<version>-<fingerprint>/`
 * (the app home `app-home.mjs` keeps for npx installs) and points the link
 * `<runtime>/app/current` at it — a directory junction on Windows, which needs
 * neither an administrator nor Developer Mode, a symbolic link elsewhere. A
 * client config names `current\node\node.exe` (`current/node/bin/node` on
 * macOS and Linux) and `current\ai-dev-mcp-server\bin\ai-dev.mjs`, and never
 * changes.
 *
 * An update ships a new runtime: the app copies it beside the old one and
 * moves the link. A client already running keeps the files it opened, in the
 * old copy, and its daemon serves it until it leaves; the next session a
 * client starts runs the new copy. No running file is ever written over, and
 * the old copy is removed by a later prune once nothing holds it.
 *
 * At every start the app checks its copy against `bundle.json`, file by file,
 * and puts back from the installer what went missing or changed size since.
 */
import crypto from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { APP_MARKER, CURRENT_LINK, KEPT_APP_COPIES, appFolder, copiesNamedByClients, pruneAppCopies } from "./app-home.mjs";
import { atomicWriteJson } from "./atomic-files.mjs";
import { BUNDLE_MARKER, bundleCommand } from "./install-layout.mjs";

export { CURRENT_LINK };

/** `<runtime>/app/current`: the path every client config of the Windows install runs. */
export function currentLink(runtimeRoot) {
  return path.join(runtimeRoot, "app", CURRENT_LINK);
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A path inside the bundle, as `bundle.json` writes it: relative, `/`-separated, never leaving the folder. */
function safeRelative(value) {
  const text = String(value ?? "");
  if (!text || text.includes("\\") || text.includes("\0") || text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  const parts = text.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..") ? null : text;
}

/**
 * Read and check a `bundle.json`: a marker that names a file outside its
 * folder, or a fingerprint that is not one, is refused before anything is
 * copied by it.
 *
 * @param {string} text
 * @param {string} where - For the error.
 * @returns {{ schema_version: 1, name: string, version: string, platform: string, arch: string, fingerprint: string, node: { version: string, file: string, sha256: string }, files: Array<{ path: string, bytes: number, sha256: string }> }}
 */
export function parseBundle(text, where) {
  let marker;
  try {
    marker = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${error.message}`);
  }
  const problem = (what) => new Error(`${where} is not a runtime this AI Dev can install: ${what}.`);
  if (marker?.schema_version !== 1) throw problem(`schema_version ${JSON.stringify(marker?.schema_version)}`);
  if (typeof marker.version !== "string" || !marker.version) throw problem("no version");
  if (!HEX64.test(String(marker.fingerprint ?? ""))) throw problem("no fingerprint");
  if (!Array.isArray(marker.files) || !marker.files.length) throw problem("no files");
  const seen = new Set();
  for (const file of marker.files) {
    const relative = safeRelative(file?.path);
    if (!relative) throw problem(`a file outside the runtime (${JSON.stringify(file?.path)})`);
    if (seen.has(relative.toLowerCase())) throw problem(`${relative} listed twice`);
    seen.add(relative.toLowerCase());
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HEX64.test(String(file.sha256 ?? ""))) throw problem(`${relative} without its size or sha256`);
  }
  const node = marker.node ?? {};
  const nodeFile = safeRelative(node.file);
  if (!nodeFile || !seen.has(nodeFile.toLowerCase())) throw problem("no Node among its files");
  for (const required of ["distribution.json", "ai-dev-mcp-server/bin/ai-dev.mjs"]) {
    if (!seen.has(required)) throw problem(`no ${required}`);
  }
  if (marker.fingerprint !== bundleFingerprint(marker.files)) throw problem("a fingerprint that is not its files'");
  return marker;
}

/**
 * The fingerprint of a runtime: its files' names and sha256, in order. Two
 * builds that ship the same bytes are one runtime, whatever their dates.
 *
 * @param {Array<{ path: string, sha256: string }>} files
 * @returns {string}
 */
export function bundleFingerprint(files) {
  const lines = files.map((file) => `${file.path}\0${file.sha256}`).sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The runtime at `root`, or null when there is none or it cannot be read. */
export function readBundleSync(root) {
  try {
    return parseBundle(readFileSync(path.join(root, BUNDLE_MARKER), "utf8"), path.join(root, BUNDLE_MARKER));
  } catch {
    return null;
  }
}

/** @param {string} root */
export async function readBundle(root) {
  const file = path.join(root, BUNDLE_MARKER);
  return parseBundle(await fs.readFile(file, "utf8"), file);
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** What Windows answers when a running process holds a file or a folder. */
const BUSY = new Set(["EACCES", "EPERM", "EBUSY"]);

/** The files a copy of `bundle` holds: those `bundle.json` lists, and `bundle.json` itself. */
async function expectedFiles(bundleRoot, bundle) {
  const marker = path.join(bundleRoot, BUNDLE_MARKER);
  const { size } = await fs.stat(marker);
  return [...bundle.files, { path: BUNDLE_MARKER, bytes: size, sha256: await sha256Of(marker) }];
}

/**
 * What the folder a runtime is copied to holds: nothing, something that is
 * not this runtime's finished copy (a copy that stopped before its marker, a
 * folder not AI Dev's), or this runtime's copy — with the files that went
 * missing or changed size since it was made: an antivirus that took a DLL
 * away, an edit by hand. The size, not the sha256,
 * is checked at every start — hashing the whole runtime would take seconds —
 * so a change that keeps a file's size is not seen.
 *
 * @returns {Promise<{ state: "absent"|"foreign"|"finished", damaged: Array<{ path: string, bytes: number, sha256: string }> }>}
 */
async function inspectCopy(folder, bundle, expected) {
  // A marker that cannot be read, or is not JSON, is not a finished copy's: it is copied again.
  const marker = await fs.readFile(path.join(folder, APP_MARKER), "utf8").then((text) => JSON.parse(text)).catch(() => null);
  if (marker?.kind !== "bundle" || marker.content_fingerprint !== bundle.fingerprint) {
    return { state: await fs.lstat(folder).then(() => "foreign", () => "absent"), damaged: [] };
  }
  const damaged = [];
  // A few dozen at a time: thousands of files, one stat each.
  for (let at = 0; at < expected.length; at += 64) {
    await Promise.all(expected.slice(at, at + 64).map(async (file) => {
      const stat = await fs.stat(path.join(folder, ...file.path.split("/"))).catch(() => null);
      if (!stat?.isFile() || stat.size !== file.bytes) damaged.push(file);
    }));
  }
  return { state: "finished", damaged };
}

/**
 * A file's bytes and mode, and nothing else. On macOS `fs.copyFile` is
 * copyfile(3), which carries the extended attributes along: the quarantine a
 * downloaded app's files hold among them, and a quarantined library is
 * refused by Gatekeeper once it is loaded from outside the app it came in.
 * What lands is checked against bundle.json, which
 * the app's signature seals, as every copy is.
 */
async function copyBytes(from, to) {
  const { mode } = await fs.stat(from);
  await pipeline(createReadStream(from), createWriteStream(to, { mode }));
  await fs.chmod(to, mode & 0o7777);
}

/** Copy one file of the runtime and check it against its size and sha256: a copy is never trusted unread. */
async function copyChecked(bundleRoot, file, target, platform) {
  const shipped = path.join(bundleRoot, ...file.path.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await (platform === "darwin" ? copyBytes : fs.copyFile)(shipped, target);
  } catch (error) {
    if (error?.code !== "ENOENT" || await fs.lstat(shipped).then(() => true, () => false)) throw error;
    throw new Error(`${file.path} in ${bundleRoot} is missing: the installer's copy is damaged; run the installer again.`);
  }
  const { size } = await fs.stat(target);
  if (size !== file.bytes || await sha256Of(target) !== file.sha256) {
    throw new Error(`${file.path} in ${bundleRoot} is not the file the installer shipped; run the installer again.`);
  }
}

/**
 * Put back the files a copy lost, each checked as the copy was, each moved
 * into place from a file beside it. A file that is missing holds nothing; one
 * a running client holds cannot be replaced on Windows, and the start stops
 * saying so.
 */
async function repairCopy({ bundleRoot, folder, files, platform }) {
  for (const file of files) {
    const target = path.join(folder, ...file.path.split("/"));
    const partial = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.partial`;
    try {
      await copyChecked(bundleRoot, file, partial, platform);
      await fs.rename(partial, target);
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => undefined);
      if (!BUSY.has(error?.code)) throw error;
      throw new Error(`${target}, a file of AI Dev's runtime, is damaged and in use: close your AI clients and try again.`);
    }
  }
}

/**
 * Move a folder aside, then remove it. Removed in place, a folder a client
 * holds a file of would be half removed by Windows; moved, it is either gone
 * whole or left whole. What cannot be removed after the move is a
 * `.partial` folder, which a later prune finishes off.
 */
async function removeAside(folder) {
  const aside = `${folder}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.partial`;
  try {
    await fs.rename(folder, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (!BUSY.has(error?.code)) throw error;
    throw new Error(`${folder} is in use and cannot be replaced: close your AI clients and try again.`);
  }
  await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/** Rename, again while Windows says a file in it is busy: a scanner opens what was just written. */
async function renameBusy(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 9 || !BUSY.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Copy the runtime into a staging folder, every file checked against its
 * size and sha256 as it lands, and move the finished copy into place. A copy
 * that stopped — a full disk, a closed app — is a `.partial` folder, never a
 * runtime a client is pointed at.
 */
async function copyBundle({ bundleRoot, bundle, expected, folder, now, onProgress, platform }) {
  const stage = `${folder}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.partial`;
  const total = bundle.files.reduce((sum, file) => sum + file.bytes, 0);
  let done = 0;
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const file of expected) {
      await copyChecked(bundleRoot, file, path.join(stage, ...file.path.split("/")), platform);
      if (file.path === BUNDLE_MARKER) continue;
      done += file.bytes;
      onProgress?.({ progress: done, total, file: file.path });
    }
    const stamp = now().toISOString();
    await atomicWriteJson(path.join(stage, APP_MARKER), {
      schema_version: 1,
      kind: "bundle",
      name: bundle.name ?? "",
      version: bundle.version,
      content_fingerprint: bundle.fingerprint,
      node_version: bundle.node.version ?? "",
      installed_at: stamp,
      chosen_at: stamp,
      installed_from: bundleRoot
    });
    // A folder an earlier copy left unfinished is replaced; a finished one was found before.
    await removeAside(folder);
    await renameBusy(stage, folder);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a link — never what it points at. A junction is a folder to Windows: `rmdir` takes it when `unlink` will not. */
async function removeLink(link) {
  try {
    await fs.unlink(link);
  } catch (error) {
    if (!["EPERM", "EISDIR", "EACCES"].includes(error?.code)) throw error;
    await fs.rmdir(link);
  }
}

/** A link a move of `current` left beside it when it stopped half-way. */
const STALE_LINK = /^current\.\d+\.[0-9a-f]{8}\.(?:next|old)$/;

/**
 * Remove the links a move of `current` that stopped left in `<runtime>/app/`
 * — never what they point at.
 *
 * @param {string} appsRoot
 * @returns {Promise<string[]>} the links removed
 */
export async function removeStaleLinks(appsRoot) {
  const removed = [];
  for (const entry of await fs.readdir(appsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!STALE_LINK.test(entry.name) || !entry.isSymbolicLink()) continue;
    const link = path.join(appsRoot, entry.name);
    if (await removeLink(link).then(() => true, () => false)) removed.push(link);
  }
  return removed;
}

/** Two paths of one folder, compared as the platform compares names. */
function samePlace(left, right, platform) {
  return platform === "win32" || platform === "darwin" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Point `<runtime>/app/current` at `folder`. The new link is made beside the
 * old one first, so the only moment without a link is a rename apart; on a
 * POSIX system the rename replaces the old link in one step. Links left by a
 * move that stopped are cleared first.
 *
 * A drive that cannot hold a link says so in its own words when the link is
 * made — `ENOTSUP` under Wine, `EISDIR` from FAT32 and exFAT, `EPERM` from
 * some shares — and whatever it says, the error carries `cannotLink`.
 *
 * @param {{ runtimeRoot: string, folder: string, platform?: string, symlink?: typeof fs.symlink }} options
 * @returns {Promise<boolean>} whether the link moved
 */
export async function pointCurrent({ runtimeRoot, folder, platform = process.platform, symlink = fs.symlink }) {
  const current = currentLink(runtimeRoot);
  const target = await fs.realpath(folder);
  await removeStaleLinks(path.dirname(current));
  const stat = await fs.lstat(current).catch(() => null);
  if (stat && !stat.isSymbolicLink()) {
    throw new Error(`${current} is not the link AI Dev keeps there; move it aside and start AI Dev again.`);
  }
  if (stat && samePlace(await fs.realpath(current).catch(() => ""), target, platform)) return false;
  const tag = `${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
  const next = `${current}.${tag}.next`;
  try {
    // A junction on Windows: a symbolic link needs Developer Mode or an administrator.
    await symlink(target, next, platform === "win32" ? "junction" : "dir");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { cannotLink: true });
  }
  if (!stat || platform !== "win32") {
    await fs.rename(next, current);
    return true;
  }
  // Windows renames neither a folder nor a junction over another: the old link goes aside first.
  const old = `${current}.${tag}.old`;
  await fs.rename(current, old);
  try {
    await fs.rename(next, current);
  } catch (error) {
    await fs.rename(old, current).catch(() => undefined);
    await removeLink(next).catch(() => undefined);
    throw error;
  }
  await removeLink(old).catch(() => undefined);
  return true;
}

/**
 * Install the runtime the installer shipped — or find it installed, and put
 * back what it lost — and make it the one AI clients run.
 *
 * @param {object} input
 * @param {string} input.bundleRoot - The installer's `resources/runtime`.
 * @param {string} input.runtimeRoot - `~/.ai-dev`, or `AI_DEV_HOME`.
 * @param {string} [input.platform]
 * @param {() => Date} [input.now]
 * @param {typeof fs.symlink} [input.symlink]
 * @param {NodeJS.ProcessEnv} [input.env] - Where the AI clients' configs are found: a copy one of them names stays.
 * @param {string} [input.home]
 * @param {(progress: { progress: number, total: number, file: string }) => void} [input.onProgress]
 * @returns {Promise<{ status: "installed"|"present"|"repaired", version: string, folder: string, current: string, serverRoot: string, node: string, cli: string, command: string, moved: boolean, linkError?: string, repaired: string[], removed: string[] }>}
 *   `current` is "" and the paths name the copy itself when the drive cannot hold the link (`linkError` says why).
 */
export async function provisionBundle({ bundleRoot, runtimeRoot, platform = process.platform, now = () => new Date(), symlink = fs.symlink, env = process.env, home = os.homedir(), onProgress }) {
  const bundle = await readBundle(bundleRoot);
  const expected = await expectedFiles(bundleRoot, bundle);
  const folder = appFolder(runtimeRoot, { version: bundle.version, content_fingerprint: bundle.fingerprint });
  const copy = await inspectCopy(folder, bundle, expected);
  let status = "present";
  if (copy.state === "finished") {
    if (copy.damaged.length) {
      status = "repaired";
      await repairCopy({ bundleRoot, folder, files: copy.damaged, platform });
    }
    // Chosen again: the copy a prune keeps.
    const markerFile = path.join(folder, APP_MARKER);
    const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
    await atomicWriteJson(markerFile, { ...marker, chosen_at: now().toISOString() });
  } else {
    status = "installed";
    await copyBundle({ bundleRoot, bundle, expected, folder, now, onProgress, platform });
  }
  // A drive that cannot hold the link — exFAT, FAT32, some network shares, Wine
  // — still runs the copy: its configs name the copy itself, and change when
  // the clients are connected again (docs/DESKTOP.md, "The Windows install").
  let moved = false;
  let linkError = "";
  try {
    moved = await pointCurrent({ runtimeRoot, folder, platform, symlink });
  } catch (error) {
    if (!error?.cannotLink) throw error;
    const said = String(error.message ?? "").split("\n")[0];
    // Node's message starts with the code already: it is said once.
    linkError = error.code && !said.startsWith(`${error.code}:`) ? `${error.code}: ${said}` : said;
  }
  const appsRoot = path.dirname(folder);
  // A client config that cannot be read does not stop the start: the link and the age keep copies then.
  const named = await copiesNamedByClients({ appsRoot, env, home }).catch(() => []);
  const removed = await pruneAppCopies(appsRoot, KEPT_APP_COPIES, now().getTime(), { kind: "bundle", named });
  const current = currentLink(runtimeRoot);
  const base = linkError ? folder : current;
  return {
    status,
    version: bundle.version,
    folder,
    current: linkError ? "" : current,
    serverRoot: path.join(base, "ai-dev-mcp-server"),
    node: path.join(base, ...bundle.node.file.split("/")),
    cli: path.join(base, "ai-dev-mcp-server", "bin", "ai-dev.mjs"),
    command: path.join(base, bundleCommand(platform)),
    moved,
    ...(linkError ? { linkError } : {}),
    repaired: status === "repaired" ? copy.damaged.map((file) => file.path) : [],
    removed
  };
}

/**
 * What a client config of the Windows install runs: its stable link's Node
 * and CLI. Null for every other install, and for a bundle whose link is
 * missing or points at something that is not a runtime — then the config
 * names this copy, as any other install's does.
 *
 * @param {{ root: string, runtimeRoot: string, bundle?: boolean }} layout
 * @returns {{ command: string, cli: string } | null}
 */
export function stableLaunch(layout) {
  if (!layout?.bundle) return null;
  const current = currentLink(layout.runtimeRoot);
  let target;
  try {
    target = realpathSync(current);
  } catch {
    return null;
  }
  const bundle = readBundleSync(target);
  if (!bundle) return null;
  return {
    command: path.join(current, ...bundle.node.file.split("/")),
    cli: path.join(current, "ai-dev-mcp-server", "bin", "ai-dev.mjs")
  };
}

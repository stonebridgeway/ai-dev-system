/**
 * Taking the Windows install off a computer: what its uninstaller runs —
 * `ai-dev uninstall`, from `desktop/build/installer.nsh` — before it removes
 * the program's own folder.
 *
 * The program's folder is the installer's to remove. What the app made
 * outside it is this module's: the runtime copies in `<runtime>/app/` and the
 * stable link AI clients run (`app-bundle.mjs`), the clients' `ai-dev` entries
 * that run them (when asked), and — only when asked, and only a folder that
 * holds nothing but what AI Dev makes — the runtime home with the person's
 * data.
 *
 * Every daemon of the runtime home is stopped first: on Windows a running
 * daemon holds its copy's Node and DLLs, and nothing it holds can be removed.
 * A folder still held is reported as in use and left whole; nothing is forced.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentLink, removeStaleLinks } from "./app-bundle.mjs";
import { APP_MARKER, CURRENT_LINK, appEntryOf, entryWords } from "./app-home.mjs";
import { clientStatePath, listClients } from "./client-connections.mjs";
import { stopDaemons } from "./daemon-client.mjs";
import { removeServer } from "./mcp-clients.mjs";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/**
 * What AI Dev makes at the top of a runtime home — and `--data` deletes a
 * folder only when nothing else is there: its
 * folders (`python` and `.ai-dev` are what 2.x left), its settings with their
 * lock and the files a write that stopped leaves (`atomic-files.mjs`), the
 * locks of the moves 3.0 makes, and what Windows and macOS put in any folder
 * once opened. A folder of these names must be a folder, a file a file.
 */
const OWN_FOLDERS = new Set(["app", "artifacts", "backups", "cache", "logs", "models", "python", "run", "state", "vault", ".ai-dev"]);
const OWN_FILE = /^(?:config\.json|\.config\.json\.\d+\.[0-9a-f-]+\.tmp|config\.json\.\d+\.[0-9a-f-]+\.bak|(?:config\.json|\.ai-dev|codex-migration)\.lock(?:\.break)?|desktop\.ini|thumbs\.db|\.ds_store)$/i;

/**
 * What AI Dev makes inside the folders whose names a person may use for
 * their own as well, when `AI_DEV_HOME` names a folder of theirs:
 * the models and their locks, the search index and the model's stamp (and the
 * 2.x cache), the archives `ai-dev backup` writes with their checksums.
 * Anything else in them keeps the whole runtime home.
 */
const OWN_INSIDE = Object.freeze({
  models: /^(?:bge-m3-onnx|bge-m3)(?:\.lock(?:\.break)?)?$/i,
  cache: /^(?:search-index|dense-model|ai-dev-system)$/i,
  backups: /^ai-dev-system_[^\\/]+\.zip(?:\.sha256|\.\d+\.tmp)?$/i
});

/** A folder or a file of AI Dev's own name, of the kind it makes; a link stands for either. */
const ownKind = (entry, folder) => entry.isSymbolicLink() || (folder ? entry.isDirectory() : entry.isFile());

/** What Windows answers when a running process holds a file or a folder. */
const BUSY = new Set(["EBUSY", "EPERM", "EACCES"]);

const fold = (value, platform) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
const exists = (target) => fs.lstat(target).then(() => true, () => false);

/** The runtime copies the Windows install made: folders in `<runtime>/app/` whose marker says `bundle`. */
export async function bundleCopies(appsRoot) {
  const copies = [];
  for (const entry of await fs.readdir(appsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(appsRoot, entry.name);
    // A marker that cannot be read, or is not JSON, is not a copy's: it stops nothing.
    const marker = await fs.readFile(path.join(folder, APP_MARKER), "utf8").then((text) => JSON.parse(text)).catch(() => null);
    if (marker?.kind === "bundle") copies.push(folder);
  }
  return copies.sort();
}

/**
 * Whether a client's `ai-dev` entry runs the Windows install: its command or
 * an argument is an absolute path under the stable link or in one of its
 * copies. An entry of a clone, of an npx copy, of Docker is someone else's,
 * and stays — whatever folder the uninstall runs in.
 *
 * @param {{ command?: unknown, args?: unknown } | undefined} entry
 * @param {{ appsRoot: string, copies: string[], platform?: string }} where
 * @returns {boolean}
 */
export function runsBundle(entry, { appsRoot, copies, platform = process.platform }) {
  const owned = new Set([CURRENT_LINK, ...copies.map((folder) => path.basename(folder))].map((name) => fold(name, platform)));
  return entryWords(entry).some((word) => {
    const name = appEntryOf(word, appsRoot);
    return Boolean(name) && owned.has(fold(name, platform));
  });
}

/** Whether `folder` is `inner` or holds it. */
function holds(folder, inner) {
  const relative = path.relative(folder, inner);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Where the runtime home is, and whether `--data` may delete it: the folder it
 * names or, when it is a link, the folder the link points at.
 * Never a drive's root, the home folder or one above it, and never a folder
 * that holds anything AI Dev did not make — then `reason` names what is not
 * AI Dev's, and nothing is deleted.
 *
 * @param {string} folder
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {Promise<{ folder: string, real: string, link: boolean, absent: boolean, reason: string }>}
 */
export async function inspectDataFolder(folder, { home = os.homedir(), platform = process.platform } = {}) {
  const resolved = path.resolve(folder);
  const stat = await fs.lstat(resolved).catch(() => null);
  const real = stat ? await fs.realpath(resolved).catch(() => resolved) : resolved;
  const answer = (reason) => ({ folder: resolved, real, link: Boolean(stat?.isSymbolicLink()), absent: !stat, reason });
  if (!stat) return answer("");
  const homes = [path.resolve(home), await fs.realpath(home).catch(() => path.resolve(home))];
  for (const candidate of new Set([resolved, real])) {
    if (path.parse(candidate).root === candidate) return answer(`${candidate} is the root of a drive.`);
    if (homes.some((inner) => holds(candidate, inner))) return answer(`${candidate} holds the home folder ${home}.`);
  }
  const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => null);
  if (!entries) return answer(`${real} is not a folder AI Dev can read.`);
  const foreign = [];
  for (const entry of entries) {
    const name = fold(entry.name, platform);
    if (OWN_FOLDERS.has(name) && ownKind(entry, true)) {
      const inside = OWN_INSIDE[name];
      if (!inside || entry.isSymbolicLink()) continue;
      for (const inner of await fs.readdir(path.join(real, entry.name)).catch(() => [])) {
        if (!inside.test(inner)) foreign.push(`${entry.name}/${inner}`);
      }
    } else if (!(OWN_FILE.test(entry.name) && ownKind(entry, false))) foreign.push(entry.name);
  }
  if (!foreign.length) return answer("");
  foreign.sort();
  const shown = `${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? `, and ${foreign.length - 5} more` : ""}`;
  return answer(`${real} also holds what AI Dev did not make (${shown}); delete AI Dev's own folders in it yourself.`);
}

/** Why `folder` must not be deleted as a runtime home, or "" when it may be: `inspectDataFolder`, in words. */
export async function refuseDataRemoval(folder, options = {}) {
  return (await inspectDataFolder(folder, options)).reason;
}

/**
 * Remove a folder by moving it aside first: one a running process holds a
 * file of stays whole, rather than half removed, and says it is in use.
 *
 * @returns {Promise<{ reason: string, busy?: boolean } | null>} null when it is gone
 */
async function removeFolder(folder, move = fs.rename) {
  const aside = `${folder}.${process.pid}.removing.partial`;
  try {
    await move(folder, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return BUSY.has(error?.code) ? { reason: "in use", busy: true } : { reason: String(error?.message ?? error) };
  }
  await fs.rm(aside, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  return await exists(aside) ? { reason: `moved to ${aside}, which could not be deleted completely` } : null;
}

/**
 * Finish off what an earlier uninstall moved aside and could not delete —
 * `<name>.<pid>.removing.partial` folders, its own by their name.
 *
 * @param {string} parent
 * @param {string} name - What was moved: a copy's folder, or the runtime home.
 */
async function removeLeftovers(parent, name) {
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.removing\\.partial$`);
  for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && pattern.test(entry.name)) await fs.rm(path.join(parent, entry.name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/** Remove a link, never what it names. */
async function removeLink(link) {
  const stat = await fs.lstat(link).catch(() => null);
  if (!stat) return "absent";
  if (!stat.isSymbolicLink()) return "left";
  try {
    await fs.unlink(link);
  } catch {
    await fs.rmdir(link).catch(() => undefined);
  }
  return await exists(link) ? "left" : "removed";
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.platform]
 * @param {boolean} [options.clients] - Take the install's `ai-dev` entries out of the clients.
 * @param {boolean} [options.data] - Delete the runtime home with everything in it.
 * @param {boolean} [options.apply] - Without it, only say what would happen.
 * @param {typeof stopDaemons} [options.stop]
 * @param {typeof fs.rename} [options.move] - How a folder is moved aside before it is removed; a test makes one busy.
 * @returns {Promise<{ apply: boolean, runtime_home: string, daemons: object[], clients: object[], copies: { removed: string[], left: Array<{ folder: string, reason: string, busy?: boolean }> }, link: string, stale_links: string[], data: { asked: boolean, removed: boolean, target?: string, absent?: boolean, refused?: boolean, busy?: boolean, reason?: string } }>}
 *   `data.target`: the folder the runtime home links to, deleted with the link; `refused`: kept, as `reason` says; `busy`: kept whole, in use.
 */
export async function uninstallBundle({ env = process.env, home = os.homedir(), platform = process.platform, clients = false, data = false, apply = false, stop = stopDaemons, move = fs.rename } = {}) {
  const runtimeHome = resolveRuntimeStateRoot("", env);
  const appsRoot = path.join(runtimeHome, "app");
  const copies = await bundleCopies(appsRoot);
  const result = {
    apply,
    runtime_home: runtimeHome,
    daemons: [],
    clients: [],
    copies: { removed: [], left: [] },
    link: "absent",
    stale_links: [],
    data: { asked: data, removed: false }
  };
  if (apply) result.daemons = (await stop({ env })).daemons;

  if (clients) {
    const rows = await listClients({ env, home });
    const targets = rows.filter((row) => runsBundle(row.row?.entries?.["ai-dev"], { appsRoot, copies, platform })).map((row) => row.row);
    result.clients = await removeServer({ targets, apply, statePath: clientStatePath(env) });
  }

  if (apply) {
    result.link = await removeLink(currentLink(runtimeHome));
    // And the links an update that stopped half-way left beside it.
    result.stale_links = await removeStaleLinks(appsRoot);
    for (const folder of copies) {
      const left = await removeFolder(folder, move);
      if (left) result.copies.left.push({ folder, ...left });
      else result.copies.removed.push(folder);
    }
    for (const folder of copies) await removeLeftovers(appsRoot, path.basename(folder));
  } else {
    result.link = await exists(currentLink(runtimeHome)) ? "would-remove" : "absent";
    result.copies.removed = copies;
  }

  if (data) {
    const where = await inspectDataFolder(runtimeHome, { home, platform });
    if (where.link) result.data.target = where.real;
    if (apply) await removeLeftovers(path.dirname(where.real), path.basename(where.real));
    if (where.reason) Object.assign(result.data, { refused: true, reason: where.reason });
    else if (result.copies.left.some((left) => left.busy)) {
      // A copy a client still runs: its files are in the runtime home, which
      // goes only whole — after the clients are closed and it is run again.
      Object.assign(result.data, { busy: true, reason: "AI Dev's runtime in it is still in use" });
    } else if (where.absent) Object.assign(result.data, { removed: apply, absent: true });
    else if (apply) {
      const left = await removeFolder(where.real, move);
      if (!left && where.link && await removeLink(where.folder) === "left") Object.assign(result.data, { reason: `the link ${where.folder} could not be removed` });
      else if (left) Object.assign(result.data, left.busy ? { busy: true, reason: "some of its files are in use" } : { reason: left.reason });
      else result.data.removed = true;
    }
  }
  return result;
}

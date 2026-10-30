/**
 * The MCP clients on this machine, and the `ai-dev` entry in each one's config.
 *
 * One module writes the configuration of every client the server supports, for
 * the CLI (`ai-dev clients …`, `ai-dev setup`) and for the Docker installer.
 * Before it there were two installers with two server names (`ai-dev-system`
 * and `ai-dev`) and two sets of clients, so a machine that ran both listed the
 * server twice; the Docker one stopped halfway on an
 * empty file and broke Codex's config, and both rewrote a config in
 * place, so an interrupted run left `~/.claude.json` empty.
 *
 * What happens to a file:
 * - it is edited as text (`jsonc-edit.mjs`, `toml-edit.mjs`): other servers,
 *   comments and formatting stay byte for byte;
 * - it is written through a temp file and a rename, after checking it did not
 *   change since it was read — the client may be saving it at that moment;
 * - before a change its bytes are kept as `<file>.backup-<time>`;
 * - `ai-dev-system`, the name the 2.x local installer used, goes;
 * - what was written is remembered (`state/mcp-clients.json` in the runtime
 *   home), so `remove` gives back the file exactly as it was when nothing else
 *   has touched it since, and cuts the entry out of it otherwise.
 *
 * A symlinked config (a dotfiles repository) is written through the link.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJson, flushFile, keepMode, renameOver } from "./atomic-files.mjs";
import { isDirectDockerEntry } from "./docker-launch.mjs";
import { processAlive } from "./file-lock.mjs";
import { readMember, removeMember, setMember } from "./jsonc-edit.mjs";
import { parseTomlLite } from "./toml-lite.mjs";
import { removeTables, renderTable, scanToml, upsertTables } from "./toml-edit.mjs";

/** The name the server is registered under in every client. */
export const SERVER_NAME = "ai-dev";

/** Names 2.x registered it under, removed when `ai-dev` is written. */
export const LEGACY_SERVER_NAMES = Object.freeze(["ai-dev-system"]);

/** Every client written for, in the order they are listed. */
export const MCP_CLIENTS = Object.freeze([
  { id: "claude-code", label: "Claude Code", format: "json", container: ["mcpServers"], stdioType: true },
  { id: "claude-desktop", label: "Claude Desktop", format: "json", container: ["mcpServers"], stdioType: false },
  { id: "cursor", label: "Cursor", format: "json", container: ["mcpServers"], stdioType: false },
  { id: "vscode", label: "VS Code", format: "json", container: ["servers"], stdioType: true },
  { id: "codex", label: "Codex", format: "toml", container: ["mcp_servers"], stdioType: false },
  { id: "gemini", label: "Gemini CLI", format: "json", container: ["mcpServers"], stdioType: false }
].map((client) => Object.freeze(client)));

/** Names `--clients` takes besides the ids, the 2.x installers' among them. */
export const CLIENT_ALIASES = Object.freeze({
  claude: ["claude-code", "claude-desktop"],
  code: ["vscode"],
  "vs-code": ["vscode"],
  "gemini-cli": ["gemini"]
});

/**
 * The client ids a `--clients` value names; `all` means every client found on
 * this machine.
 *
 * @param {string} spec - Comma-separated ids or aliases, or `all`.
 * @returns {{ all: boolean, ids: string[] }}
 * @throws {Error} Naming what is not a client.
 */
export function parseClientSelection(spec) {
  const known = MCP_CLIENTS.map((client) => client.id);
  const words = String(spec ?? "").split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  if (!words.length) throw new Error(`No client named: give all, or some of ${known.join(", ")}.`);
  if (words.includes("all")) return { all: true, ids: known };
  const ids = [];
  const unknown = [];
  for (const word of words) {
    const named = CLIENT_ALIASES[word] ?? (known.includes(word) ? [word] : null);
    if (!named) unknown.push(word);
    else for (const id of named) if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length) {
    throw new Error(`Not a client: ${unknown.join(", ")}. The clients are ${known.join(", ")} (or all).`);
  }
  return { all: false, ids };
}

/**
 * Where each client keeps its servers, and the folder whose presence says the
 * client is installed. Platform and environment are parameters so the
 * Windows and macOS answers are testable anywhere.
 *
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {Record<string, { file: string, markers: string[] }>}
 */
export function clientLocations({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const appData = platform === "darwin"
    ? paths.join(home, "Library", "Application Support")
    : platform === "win32"
      ? env.APPDATA || paths.join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || paths.join(home, ".config");
  const codexHome = env.CODEX_HOME ? paths.resolve(env.CODEX_HOME) : paths.join(home, ".codex");
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps its global config — user
  // servers included — in that folder's .claude.json and never reads
  // ~/.claude.json (measured with Claude Code 2.1.296).
  const claudeHome = env.CLAUDE_CONFIG_DIR ? paths.resolve(env.CLAUDE_CONFIG_DIR) : "";
  return {
    "claude-code": claudeHome
      ? { file: paths.join(claudeHome, ".claude.json"), markers: [claudeHome] }
      : { file: paths.join(home, ".claude.json"), markers: [paths.join(home, ".claude.json"), paths.join(home, ".claude")] },
    "claude-desktop": { file: paths.join(appData, "Claude", "claude_desktop_config.json"), markers: [paths.join(appData, "Claude")] },
    cursor: { file: paths.join(home, ".cursor", "mcp.json"), markers: [paths.join(home, ".cursor")] },
    vscode: { file: paths.join(appData, "Code", "User", "mcp.json"), markers: [paths.join(appData, "Code")] },
    codex: { file: paths.join(codexHome, "config.toml"), markers: [codexHome] },
    gemini: { file: paths.join(home, ".gemini", "settings.json"), markers: [paths.join(home, ".gemini")] }
  };
}

async function pathExists(target) {
  return fs.lstat(target).then(() => true, () => false);
}

/**
 * The Microsoft Store build of Claude Desktop reads its config from inside its
 * package (MSIX redirects `%APPDATA%`); each such config that exists is a
 * target of its own, next to the usual one.
 */
async function storeClaudeConfigs({ env, home, exists, listDirectory }) {
  const packages = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Packages");
  const names = await listDirectory(packages).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!name.startsWith("Claude_")) continue;
    const file = path.win32.join(packages, name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
    // A Store profile has no config until the app's first launch.
    if (await exists(file)) files.push(file);
  }
  return files;
}

/**
 * @typedef {object} ClientTarget
 * @property {string} client - The client's id.
 * @property {string} label
 * @property {"json"|"toml"} format
 * @property {string[]} container - Where the servers are inside the file.
 * @property {boolean} stdioType - The entry carries `type: "stdio"`.
 * @property {string} file
 * @property {boolean} detected - The client looks installed.
 * @property {string} marker - What says so, or would.
 * @property {string} [variant] - `store` for the Microsoft Store build of Claude Desktop.
 */

/**
 * Every config file a client could read the server from, and whether that
 * client is installed here.
 *
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: string, exists?: (target: string) => Promise<boolean>, listDirectory?: (target: string) => Promise<string[]> }} [options]
 * @returns {Promise<ClientTarget[]>}
 */
export async function discoverClients({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  exists = pathExists,
  listDirectory = (target) => fs.readdir(target)
} = {}) {
  const locations = clientLocations({ home, env, platform });
  const targets = [];
  for (const { id, ...client } of MCP_CLIENTS) {
    const location = locations[id];
    let marker = "";
    for (const candidate of location.markers) {
      if (await exists(candidate)) {
        marker = candidate;
        break;
      }
    }
    targets.push({ client: id, ...client, file: location.file, detected: Boolean(marker), marker: marker || location.markers.at(-1) });
    if (id === "claude-desktop" && platform === "win32") {
      for (const file of await storeClaudeConfigs({ env, home, exists, listDirectory })) {
        targets.push({ client: id, ...client, file, detected: true, marker: file, variant: "store" });
      }
    }
  }
  return targets;
}

/**
 * The entry a client gets for a command line: `type: "stdio"` where the client
 * expects it, `env` only when it holds something, and for Codex the two
 * timeouts (a first index build can take longer than its default ten seconds).
 *
 * @param {Pick<ClientTarget, "format" | "stdioType">} target
 * @param {{ command: string, args: string[], env?: Record<string, string> }} launch
 * @returns {Record<string, unknown>}
 */
export function clientEntry(target, { command, args, env = {} }) {
  const environment = Object.keys(env).length ? { env } : {};
  if (target.format === "toml") {
    return { command, args, ...environment, startup_timeout_sec: 120, tool_timeout_sec: 3600 };
  }
  return { ...(target.stdioType ? { type: "stdio" } : {}), command, args, ...environment };
}

/**
 * What an entry runs: this install exactly, another local install of the
 * server, a Docker launcher, or something else.
 *
 * @param {unknown} entry
 * @param {unknown} [expected] - The entry this install would write.
 * @returns {{ kind: "current"|"local"|"docker"|"other"|"invalid", command?: string, script?: string, direct?: boolean }}
 *   `direct`: a 3.0 entry running `docker run` itself, not a 2.x launcher.
 */
export function describeEntry(entry, expected) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { kind: "invalid" };
  if (expected !== undefined && isDeepStrictEqual(entry, expected)) return { kind: "current" };
  const command = String(entry.command ?? "");
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const env = entry.env && typeof entry.env === "object" ? entry.env : {};
  if (isDirectDockerEntry(entry)) return { kind: "docker", command, direct: true };
  if (env.AI_DEV_IMAGE || env.AI_DEV_MCP_LAUNCHER || args.some((arg) => /run-mcp\.(?:sh|ps1)$/i.test(arg)) || /ClaudeMcpProxy\.exe$/i.test(command)) {
    return { kind: "docker", command };
  }
  const script = args.find((arg) => /(?:^|[\\/])(?:ai-dev|server|mcp-stdio)\.mjs$/i.test(arg));
  if (script) return { kind: "local", command, script };
  return { kind: "other", command };
}

/** The entries of `names` in a config's text: value, or undefined when absent. */
function readEntries(target, text, names) {
  if (target.format === "toml") {
    const servers = parseTomlLite(text).data?.[target.container[0]];
    return Object.fromEntries(names.map((name) => [name, servers && typeof servers === "object" ? servers[name] : undefined]));
  }
  return Object.fromEntries(names.map((name) => [name, readMember(text, target.container, name)]));
}

/**
 * The text of a config with the server's entry set to `value`, and the 2.x
 * name gone. Pure: nothing is read or written.
 *
 * @param {Pick<ClientTarget, "format" | "container">} target
 * @param {string} text - The file as it is ("" when there is none).
 * @param {Record<string, unknown>} value
 * @returns {{ next: string, changed: boolean, previous: unknown, migrated: string[] }}
 */
export function planInstall(target, text, value) {
  const previous = readEntries(target, text, [SERVER_NAME])[SERVER_NAME];
  const migrated = [];
  let next = text;
  if (target.format === "toml") {
    for (const name of LEGACY_SERVER_NAMES) {
      const after = removeTables(next, [target.container[0], name]);
      if (after !== next) migrated.push(name);
      next = after;
    }
    if (!isDeepStrictEqual(previous, value)) {
      next = upsertTables(next, [target.container[0], SERVER_NAME], renderTable([target.container[0], SERVER_NAME], value, scanToml(next).eol));
    }
  } else {
    for (const name of LEGACY_SERVER_NAMES) {
      const after = removeMember(next, target.container, name);
      if (after !== next) migrated.push(name);
      next = after;
    }
    if (!isDeepStrictEqual(previous, value)) next = setMember(next, target.container, SERVER_NAME, value);
  }
  return { next, changed: next !== text, previous, migrated };
}

/**
 * The text of a config without the server, under either name. Pure.
 *
 * @param {Pick<ClientTarget, "format" | "container">} target
 * @param {string} text
 * @returns {{ next: string, changed: boolean, removed: string[] }}
 */
export function planRemove(target, text) {
  const removed = [];
  let next = text;
  for (const name of [SERVER_NAME, ...LEGACY_SERVER_NAMES]) {
    const after = target.format === "toml"
      ? removeTables(next, [target.container[0], name])
      : removeMember(next, target.container, name);
    if (after !== next) removed.push(name);
    next = after;
  }
  return { next, changed: next !== text, removed };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * The file a path names, through symlinks: a dangling one, and the folders of
 * a file not written yet. A client folder linked from a dotfiles repository
 * was recorded under the link's path at install and looked up under the real
 * one at remove, which then took the entry out instead of giving the file
 * back.
 */
async function realTarget(file) {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const link = await fs.readlink(file).catch(() => "");
  if (link) return realTarget(path.resolve(path.dirname(file), link));
  const parent = path.dirname(file);
  return parent === file ? file : path.join(await realTarget(parent), path.basename(file));
}

async function readBytes(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A config's text. A file that is not UTF-8 — a comment saved from an editor
 * in cp1251, a UTF-16 file from Notepad — is refused: decoded anyway, its
 * bytes came back as U+FFFD and were written over the original.
 */
function decode(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error("not UTF-8 text, so it is left as it is. Save it as UTF-8 (a comment in another encoding is the usual cause) and run this again.");
  }
}

function sameBytes(left, right) {
  if (!left || !right) return left === right;
  return Buffer.compare(left, right) === 0;
}

/**
 * Who is to own what is written for `file`: the owner of the file, or of the
 * nearest folder above it that exists — when root writes it. `sudo` with the
 * user's HOME left every config, backup and folder it touched to root, and
 * the user's own client could no longer read its config. Anyone but root
 * creates what is theirs already: null.
 */
async function ownerFor(file) {
  if (process.getuid?.() !== 0) return null;
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    const stat = await fs.stat(at).catch(() => null);
    if (stat) return stat.uid === 0 && stat.gid === 0 ? null : { uid: stat.uid, gid: stat.gid };
    if (path.dirname(at) === at) return null;
  }
}

/** `mkdir -p`, with the folders it made given to `owner`. */
async function makeDirectory(directory, owner) {
  const first = await fs.mkdir(directory, { recursive: true });
  if (!first || !owner) return;
  for (let at = directory; ; at = path.dirname(at)) {
    await fs.chown(at, owner.uid, owner.gid);
    if (at === first || path.dirname(at) === at) return;
  }
}

/** Keep `bytes` next to `file`, under a name no earlier backup has. */
async function writeBackup(file, bytes, date, owner = null) {
  const stamp = date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${file}.backup-${stamp}${attempt > 1 ? `-${attempt}` : ""}`;
    try {
      // A config can hold tokens: the copy is the owner's alone.
      await fs.writeFile(candidate, bytes, { flag: "wx", mode: 0o600 });
      if (owner) await fs.chown(candidate, owner.uid, owner.gid);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}

/**
 * Temp files a run killed between writing and renaming left next to `file` —
 * as big as the config, tens of megabytes for `~/.claude.json`. One whose
 * writer is gone is removed; a live writer's is its own business.
 */
async function sweepStaleTemps(file) {
  const prefix = `.${path.basename(file)}.`;
  const names = await fs.readdir(path.dirname(file)).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const pid = Number(name.slice(prefix.length).split(".")[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)) {
      await fs.unlink(path.join(path.dirname(file), name)).catch(() => undefined);
    }
  }
}

/**
 * Write `next` over `file` unless the file no longer holds `expected` — a
 * client that saved it since then keeps its change, and the caller plans
 * again from what is there now. `expected` null means "there is no file".
 *
 * @returns {Promise<boolean>} Whether the file was replaced.
 */
async function replaceIfUnchanged(file, expected, next, mode, owner = null) {
  const directory = path.dirname(file);
  await makeDirectory(directory, owner);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", mode ?? 0o666);
    await handle.writeFile(next, "utf8");
    if (owner) await handle.chown(owner.uid, owner.gid);
    if (mode !== undefined) await keepMode(handle, mode);
    await flushFile(handle);
    await handle.close();
    handle = null;
    if (!sameBytes(await readBytes(file), expected)) return false;
    await renameOver(temp, file);
    return true;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function deleteIfUnchanged(file, expected) {
  if (!sameBytes(await readBytes(file), expected)) return false;
  await fs.unlink(file);
  return true;
}

/** The remembered writes; a missing or unreadable record is an empty one. */
async function readState(statePath) {
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    const files = parsed?.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : {};
    return { files, dirty: false };
  } catch {
    return { files: {}, dirty: false };
  }
}

/**
 * Keep the record. It only makes a later `remove` exact, so a home that
 * cannot take it (a container whose HOME is `/`) costs that, not the install.
 */
async function saveState(statePath, state) {
  if (!statePath || !state?.dirty) return;
  try {
    const owner = await ownerFor(statePath);
    await makeDirectory(path.dirname(statePath), owner);
    await atomicWriteJson(statePath, { version: 1, files: state.files });
    if (owner) await fs.chown(statePath, owner.uid, owner.gid);
  } catch {
    // Kept or not, the configs are written.
  }
}

/**
 * Remember a write. While the file is still exactly what was last written
 * here, the record keeps the original from before the first write, so a
 * second install (a new Node path, say) does not make the first one's output
 * the thing `remove` goes back to.
 */
function remember(state, file, { before, written, backup, at }) {
  if (!state) return;
  const previous = state.files[file];
  const untouched = previous && before && sha256(before) === previous.sha256;
  state.files[file] = {
    original: untouched ? previous.original : before ? backup : null,
    sha256: sha256(Buffer.from(written, "utf8")),
    at
  };
  state.dirty = true;
}

function forget(state, file) {
  if (state && state.files[file]) {
    delete state.files[file];
    state.dirty = true;
  }
}

function resultBase(target) {
  return {
    client: target.client,
    label: target.label,
    file: target.file,
    ...(target.variant ? { variant: target.variant } : {})
  };
}

function failure(target, error) {
  return { ...resultBase(target), status: "failed", error: String(error?.message ?? error) };
}

const ATTEMPTS = 3;

function stillChanging(target) {
  return new Error(`it changed again each time it was about to be written (is ${target.label} saving it right now?). `
    + "Nothing was changed; run the command again.");
}

async function installOne(target, value, { apply, state, now }) {
  const file = await realTarget(target.file);
  if (apply) await sweepStaleTemps(file);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await readBytes(file);
    const plan = planInstall(target, before ? decode(before) : "", value);
    const base = {
      ...resultBase(target),
      ...(plan.previous !== undefined ? { previous: describeEntry(plan.previous, value).kind } : {}),
      ...(plan.migrated.length ? { migrated: plan.migrated } : {})
    };
    if (!plan.changed) return { ...base, status: "unchanged" };
    const status = plan.previous === undefined ? "added" : "updated";
    if (!apply) return { ...base, status: status === "added" ? "would-add" : "would-update" };
    const mode = before ? (await fs.stat(file)).mode & 0o7777 : undefined;
    const owner = await ownerFor(file);
    const backup = before ? await writeBackup(target.file, before, now(), owner) : null;
    if (await replaceIfUnchanged(file, before, plan.next, mode, owner)) {
      remember(state, file, { before, written: plan.next, backup, at: now().toISOString() });
      return { ...base, status, ...(backup ? { backup } : {}) };
    }
    if (backup) await fs.unlink(backup).catch(() => undefined);
  }
  throw stillChanging(target);
}

async function removeOne(target, { apply, state, now }) {
  const file = await realTarget(target.file);
  if (apply) await sweepStaleTemps(file);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const before = await readBytes(file);
    if (!before) {
      forget(state, file);
      return { ...resultBase(target), status: "absent" };
    }
    const record = state?.files[file];
    let next;
    let restore = false;
    if (record && record.sha256 === sha256(before)) {
      // Nothing has touched the file since it was written here: give back the
      // original (without either name, should it have held the 2.x one).
      if (record.original === null) {
        next = null;
        restore = true;
      } else {
        const original = await readBytes(record.original);
        if (original) {
          next = planRemove(target, decode(original)).next;
          restore = true;
        }
      }
    }
    let removed = [];
    if (!restore) {
      const plan = planRemove(target, decode(before));
      if (!plan.changed) {
        forget(state, file);
        return { ...resultBase(target), status: "absent" };
      }
      next = plan.next;
      removed = plan.removed;
    }
    const base = { ...resultBase(target), ...(removed.length ? { removed } : {}) };
    if (!apply) return { ...base, status: restore ? "would-restore" : "would-remove" };
    const owner = await ownerFor(file);
    const backup = await writeBackup(target.file, before, now(), owner);
    const mode = (await fs.stat(file)).mode & 0o7777;
    const done = next === null ? await deleteIfUnchanged(file, before) : await replaceIfUnchanged(file, before, next, mode, owner);
    if (done) {
      forget(state, file);
      return { ...base, status: restore ? "restored" : "removed", backup };
    }
    await fs.unlink(backup).catch(() => undefined);
  }
  throw stillChanging(target);
}

/**
 * @typedef {object} ClientResult
 * @property {string} client
 * @property {string} label
 * @property {string} file
 * @property {string} status - install: added, updated, unchanged, would-add,
 *   would-update; remove: removed, restored, absent, would-remove,
 *   would-restore; either: failed.
 * @property {string} [variant]
 * @property {string} [backup] - Where the file's previous bytes are.
 * @property {string} [previous] - What the replaced `ai-dev` entry ran (`describeEntry`).
 * @property {string[]} [migrated] - 2.x names removed on the way.
 * @property {string[]} [removed]
 * @property {string} [error]
 */

/**
 * Put the server's entry into each target. One target's failure is its own
 * result line; the rest are still written.
 *
 * @param {object} options
 * @param {ClientTarget[]} options.targets
 * @param {(target: ClientTarget) => Record<string, unknown>} options.entryFor
 * @param {boolean} [options.apply=true] - false: say what would change, write nothing.
 * @param {string} [options.statePath] - The record of writes; empty: keep none.
 * @param {() => Date} [options.now]
 * @returns {Promise<ClientResult[]>}
 */
export async function installServer({ targets, entryFor, apply = true, statePath = "", now = () => new Date() }) {
  const state = await readState(statePath);
  const results = [];
  for (const target of targets) {
    try {
      results.push(await installOne(target, entryFor(target), { apply, state, now }));
    } catch (error) {
      results.push(failure(target, error));
    }
  }
  if (apply) await saveState(statePath, state);
  return results;
}

/**
 * Take the server out of each target, under either name.
 *
 * @param {object} options
 * @param {ClientTarget[]} options.targets
 * @param {boolean} [options.apply=true]
 * @param {string} [options.statePath]
 * @param {() => Date} [options.now]
 * @returns {Promise<ClientResult[]>}
 */
export async function removeServer({ targets, apply = true, statePath = "", now = () => new Date() }) {
  const state = await readState(statePath);
  const results = [];
  for (const target of targets) {
    try {
      results.push(await removeOne(target, { apply, state, now }));
    } catch (error) {
      results.push(failure(target, error));
    }
  }
  if (apply) await saveState(statePath, state);
  return results;
}

/**
 * The server's entries as each target holds them now.
 *
 * @param {ClientTarget[]} targets
 * @returns {Promise<Array<ClientTarget & { exists: boolean, entries: Record<string, unknown>, error?: string }>>}
 */
export async function readServerEntries(targets) {
  const rows = [];
  for (const target of targets) {
    try {
      const bytes = await readBytes(await realTarget(target.file));
      rows.push({
        ...target,
        exists: Boolean(bytes),
        entries: bytes ? readEntries(target, decode(bytes), [SERVER_NAME, ...LEGACY_SERVER_NAMES]) : {}
      });
    } catch (error) {
      rows.push({ ...target, exists: true, entries: {}, error: String(error?.message ?? error) });
    }
  }
  return rows;
}

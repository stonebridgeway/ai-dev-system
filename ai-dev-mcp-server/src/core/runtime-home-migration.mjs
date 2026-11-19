import fs from "node:fs/promises";
import path from "node:path";
import { explicitRuntimeHome, legacyDoubledRuntimeRoot, resolveRuntimeStateRoot, resolveUserHome, sameDirectory } from "./runtime-home.mjs";
import { atomicWriteFile, atomicWriteJson, withExclusiveFile } from "./atomic-files.mjs";
import { withFileLock } from "./file-lock.mjs";

/**
 * Two clients starting at once both run the migration; the second waits for
 * the first rather than racing it — racing, it read a JSONL ledger the first
 * was merging and merged it again, or aborted on a file the first had moved.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/** Link errors that mean "this filesystem or this pair of paths cannot hard-link", not "the destination exists". */
const LINK_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EINVAL"]);

/**
 * Move what 2.x wrote into `<AI_DEV_HOME>/.ai-dev` up into `<AI_DEV_HOME>`.
 *
 * Before 3.0 the code appended `.ai-dev` to `AI_DEV_HOME` while every document
 * and the Docker image treated the variable as the runtime folder itself, so the
 * data of everyone who set it landed one level deeper than they were told.
 * 3.0 keeps the documented meaning, and this moves the data to match.
 * Nothing is lost:
 *
 * - a file or link that does not exist at the destination is moved — never
 *   over one that appears meanwhile;
 * - an identical file is dropped from the old tree;
 * - a JSONL ledger is merged into the one already there, in time order;
 * - anything else that exists on both sides stays where it is, and is reported;
 * - an entry that cannot be moved (another disk, a file in use) stays where it
 *   is, is reported with its error, and the rest of the tree moves anyway.
 *
 * Re-running is safe; a 2.x hook that still writes the old tree is picked up by
 * the next run.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "not-applicable"|"clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, conflicts: string[], errors: Array<{ path: string, code: string, message: string }> }>}
 */
export async function migrateDoubledRuntimeHome({ env = process.env, now = () => new Date() } = {}) {
  const empty = () => ({ moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] });
  const legacy = legacyDoubledRuntimeRoot(env);
  if (!legacy) return { status: "not-applicable", ...empty() };
  if (!(await isDirectory(legacy))) return { status: "clean", ...empty() };
  const target = resolveRuntimeStateRoot("", env);
  return withFileLock(legacy, async () => {
    // The process that held the lock before may have moved everything.
    if (!(await isDirectory(legacy))) return { status: "clean", ...empty() };
    const counts = empty();
    await mergeTree(legacy, target, legacy, counts);
    await removeEmptyDirectories(legacy);
    const result = { status: "migrated", from: legacy, to: target, ...counts };
    if (counts.moved || counts.merged || counts.duplicates || counts.conflicts.length || counts.errors.length) {
      await recordMigration(target, { ...result, at: now().toISOString() }, env);
    }
    return result;
  }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
}

/**
 * Where 2.x kept AI Dev's data under `.codex` — `~/.codex`, or the one
 * {@link codexRoot} names — by the variable that names each place now. The
 * runtime that came with Codex desktop kept it there, and 2.x
 * read a `~/.codex` folder whenever its `~/.ai-dev` twin did not exist yet — so
 * the first hook, or `ai-dev clients install`, that created `~/.ai-dev/state`
 * made the server leave the Codex-era tasks and sessions behind without a word,
 * while the hooks had never read them at all. Only
 * these folders are AI Dev's; the rest of `~/.codex` is Codex's own and stays.
 *
 * `cache` marks what is rebuilt or checked rather than kept: the search index
 * and the model. A Codex-era copy of a file that the runtime tree already has is
 * dropped, not a conflict for the user to settle — a binary index or half a
 * download has nothing to compare.
 */
export const CODEX_LEGACY_FOLDERS = Object.freeze([
  { variable: "AI_DEV_STATE_ROOT", from: ["state", "ai-dev-system"], to: ["state"] },
  { variable: "AI_DEV_ARCHIFY_RECEIPTS_ROOT", from: ["state", "archify-receipts"], to: ["state", "archify-receipts"] },
  { variable: "AI_DEV_SEARCH_INDEX_DIR", from: ["cache", "ai-dev-system", "search-index"], to: ["cache", "search-index"], cache: true },
  { variable: "AI_DEV_FRONTEND_QA_ARTIFACT_ROOT", from: ["artifacts", "frontend-qa"], to: ["artifacts", "frontend-qa"] },
  { variable: "AI_DEV_ARCHIFY_ARTIFACT_ROOT", from: ["artifacts", "archify"], to: ["artifacts", "archify"] },
  { variable: "BGE_M3_ONNX_DIR", from: ["models", "bge-m3-onnx"], to: ["models", "bge-m3-onnx"], cache: true }
]);

/** The Codex-era folders this environment looks for: a place named by its variable was never looked for in `.codex`. */
function unnamedCodexFolders(env) {
  return CODEX_LEGACY_FOLDERS.filter((folder) => !env[folder.variable]);
}

/**
 * The `.codex` folder 2.x read for this install: under its own `AI_DEV_HOME`
 * when one was set — 2.x took that variable for the home and looked for
 * `.codex` beside `.ai-dev` there — else under the user's home. Taking the
 * user's `~/.codex` into any `AI_DEV_HOME` handed one install's history to
 * another, and to a demo's temporary home that is then deleted.
 *
 * One value of `AI_DEV_HOME` can have been either: `<home>/.ai-dev`, the runtime
 * folder 3.0 uses by default, which client entries carry when it is exported.
 * A 2.x install with that variable kept its Codex-era data in
 * `<home>/.ai-dev/.codex`, one without it in `~/.codex`; so there the first is
 * taken when it holds any of AI Dev's folders, and the second otherwise.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>}
 */
async function codexRoot(env) {
  const home = resolveUserHome("", env);
  const explicit = explicitRuntimeHome(env);
  if (!explicit) return path.join(home, ".codex");
  const own = path.join(explicit, ".codex");
  if (!isHomeRuntime(explicit, home)) return own;
  for (const folder of unnamedCodexFolders(env)) {
    if (await isDirectory(path.join(own, ...folder.from))) return own;
  }
  return path.join(home, ".codex");
}

/**
 * Whether a folder is `<home>/.ai-dev`: through links, and in the letter case
 * the filesystem ignores. On the first start that folder need not exist, and a
 * path that is not there resolves to itself — so a home that is a link did not
 * match its real path until something made the folder, and `~/.codex` waited
 * for the next start. The parent, which is there, is
 * resolved instead, and the name compared on its own.
 *
 * @param {string} folder
 * @param {string} home
 * @returns {boolean}
 */
function isHomeRuntime(folder, home) {
  const caseBlind = process.platform === "win32" || process.platform === "darwin";
  const name = path.basename(folder);
  return sameDirectory(folder, path.join(home, ".ai-dev"))
    || ((caseBlind ? name.toLowerCase() : name) === ".ai-dev" && sameDirectory(path.dirname(folder), home));
}

/** The `.codex` folders of AI Dev's under `codex` that this environment would read, existing or not. */
function codexLegacyFolders(env, codex) {
  const target = resolveRuntimeStateRoot("", env);
  return unnamedCodexFolders(env).map((folder) => ({
    ...folder,
    codex,
    source: path.join(codex, ...folder.from),
    destination: path.join(target, ...folder.to)
  }));
}

/**
 * Move AI Dev's Codex-era folders into the runtime tree, once, from the
 * `.codex` folder 2.x read for this install — `~/.codex`, or
 * `<AI_DEV_HOME>/.codex` ({@link codexRoot}). The same rules as
 * {@link migrateDoubledRuntimeHome}: nothing is replaced, identical files are
 * dropped, JSONL ledgers are merged, anything else on both sides stays in that
 * `.codex` and is reported; the move is recorded.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, superseded: number, conflicts: string[], errors: Array<{ path: string, code: string, message: string }> }>}
 */
export async function migrateCodexRuntime({ env = process.env, now = () => new Date() } = {}) {
  return migrateCodexFrom(await codexRoot(env), { env, now });
}

// The move out of one `.codex` folder, found once by the caller: once a move that failed half-way has emptied it,
// finding it again names another — the start log blamed ~/.codex for a move out of <AI_DEV_HOME>/.codex.
async function migrateCodexFrom(codex, { env, now = () => new Date() }) {
  const empty = () => ({ moved: 0, merged: 0, duplicates: 0, superseded: 0, conflicts: [], errors: [] });
  const present = async () => {
    const found = [];
    for (const folder of codexLegacyFolders(env, codex)) if (await isDirectory(folder.source)) found.push(folder);
    return found;
  };
  if (!(await present()).length) return { status: "clean", ...empty() };
  const target = resolveRuntimeStateRoot("", env);
  await fs.mkdir(target, { recursive: true });
  return withFileLock(path.join(target, "codex-migration"), async () => {
    // The process that held the lock before may have moved everything.
    const folders = await present();
    if (!folders.length) return { status: "clean", ...empty() };
    const counts = empty();
    for (const folder of folders) {
      await mergeTree(folder.source, folder.destination, folder.codex, counts, { supersede: Boolean(folder.cache) });
      await removeEmptyDirectories(folder.source);
    }
    const result = { status: "migrated", kind: "codex", from: folders[0].codex, to: target, ...counts };
    if (counts.moved || counts.merged || counts.duplicates || counts.superseded || counts.conflicts.length || counts.errors.length) {
      await recordMigration(target, { ...result, at: now().toISOString() }, env);
    }
    return result;
  }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
}

/**
 * In the image: the state the server kept in the volume — all of it in 2.x, and
 * what a session a 2.x launcher started writes there still — moved into the
 * folder the client entry mounts from the host (`AI_DEV_STATE_ROOT`), which the
 * hooks on the host keep their state in too. Before, the hooks never saw the
 * server's tasks nor the server the hooks' handoffs.
 * Merged as the other migrations merge; re-run on every start, so the second
 * place never holds anything for long.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {Promise<{ status: "not-applicable"|"clean"|"migrated", from?: string, to?: string, moved: number, merged: number, duplicates: number, conflicts: string[], errors: Array<{ path: string, code: string, message: string }> }>}
 */
export async function migrateVolumeState({ env = process.env, now = () => new Date() } = {}) {
  const empty = () => ({ moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] });
  if (String(env.AI_DEV_RUNTIME ?? "").trim().toLowerCase() !== "docker" || !String(env.AI_DEV_STATE_ROOT ?? "").trim()) {
    return { status: "not-applicable", ...empty() };
  }
  const runtimeRoot = resolveRuntimeStateRoot("", env);
  const volume = path.join(runtimeRoot, "state");
  const target = path.resolve(env.AI_DEV_STATE_ROOT);
  if (path.relative(volume, target) === "" || !(await isDirectory(volume))) return { status: path.relative(volume, target) === "" ? "not-applicable" : "clean", ...empty() };
  await fs.mkdir(target, { recursive: true });
  return withFileLock(path.join(target, "volume-migration"), async () => {
    if (!(await isDirectory(volume))) return { status: "clean", ...empty() };
    const counts = empty();
    await mergeTree(volume, target, volume, counts, { acrossDevices: true });
    await removeEmptyDirectories(volume);
    const result = { status: "migrated", kind: "volume", from: volume, to: target, ...counts };
    if (counts.moved || counts.merged || counts.duplicates || counts.conflicts.length || counts.errors.length) {
      await recordMigration(runtimeRoot, { ...result, at: now().toISOString() }, env);
    }
    return result;
  }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
}

async function isDirectory(candidate) {
  return fs.stat(candidate).then((stat) => stat.isDirectory()).catch(() => false);
}

/**
 * Byte-for-byte equality, sizes first and then in chunks: a legacy model file
 * is 2.3 GB, and reading both copies whole failed past 2 GiB (ERR_FS_FILE_TOO_LARGE).
 */
async function sameContent(left, right) {
  const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (a.size !== b.size) return false;
  const [first, second] = await Promise.all([fs.open(left, "r"), fs.open(right, "r")]);
  try {
    const one = Buffer.alloc(1 << 20);
    const two = Buffer.alloc(1 << 20);
    for (let position = 0; position < a.size;) {
      const [{ bytesRead: read }, { bytesRead: readToo }] = await Promise.all([
        first.read(one, 0, one.length, position),
        second.read(two, 0, two.length, position)
      ]);
      if (read !== readToo || !one.subarray(0, read).equals(two.subarray(0, readToo))) return false;
      if (read === 0) break;
      position += read;
    }
    return true;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

async function mergeTree(sourceDir, targetDir, legacyRoot, counts, options = {}) {
  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
    await fs.mkdir(targetDir, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") counts.errors.push(entryError(legacyRoot, sourceDir, error));
    return;
  }
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    try {
      if (entry.isDirectory()) await mergeTree(source, destination, legacyRoot, counts, options);
      else if (entry.isFile() || entry.isSymbolicLink()) await mergeEntry(source, destination, entry, legacyRoot, counts, options);
      // A socket or a pipe a 2.x daemon left behind is not data.
    } catch (error) {
      if (error?.code !== "ENOENT") counts.errors.push(entryError(legacyRoot, source, error));
    }
  }
}

function entryError(legacyRoot, file, error) {
  return { path: path.relative(legacyRoot, file) || ".", code: String(error?.code ?? ""), message: String(error?.message ?? error).slice(0, 240) };
}

async function mergeEntry(source, destination, entry, legacyRoot, counts, options = {}) {
  const existing = await fs.lstat(destination).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (!existing) {
    try {
      await moveWithoutReplacing(source, destination, entry, options);
      counts.moved += 1;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Something wrote the destination meanwhile: judge it like any other pair.
      return mergeEntry(source, destination, entry, legacyRoot, counts, options);
    }
  }
  if (entry.isFile() && existing.isFile()) {
    if (await sameContent(source, destination)) {
      await fs.rm(source, { force: true });
      counts.duplicates += 1;
      return;
    }
    if (entry.name.endsWith(".jsonl")) {
      await mergeJsonl(source, destination);
      counts.merged += 1;
      return;
    }
  }
  if (options.supersede && entry.isFile() && existing.isFile()) {
    // A cache the runtime tree has its own of: the older copy is not data.
    await fs.rm(source, { force: true });
    counts.superseded += 1;
    return;
  }
  counts.conflicts.push(path.relative(legacyRoot, source));
}

/**
 * Move a file or a link to a destination that does not exist, without ever
 * replacing one that appears in between: a hard link fails with EEXIST where a
 * rename would overwrite. Links themselves, and filesystems that cannot
 * hard-link, are renamed after one more check. Across disks both fail with
 * EXDEV, and the entry is reported rather than copied behind the user's back —
 * unless crossing is the point (`acrossDevices`: a container's volume into the
 * host's folder), where a file is copied without replacing, then removed.
 */
async function moveWithoutReplacing(source, destination, entry, { acrossDevices = false } = {}) {
  if (entry.isFile()) {
    try {
      await fs.link(source, destination);
      await fs.unlink(source);
      return;
    } catch (error) {
      if (error?.code === "EXDEV" && acrossDevices) {
        await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        await fs.unlink(source);
        return;
      }
      if (!LINK_UNSUPPORTED.has(error?.code) || error?.code === "EXDEV") throw error;
    }
  }
  const present = await fs.lstat(destination).then(() => true, (error) => (error?.code === "ENOENT" ? false : Promise.reject(error)));
  if (present) throw Object.assign(new Error(`${destination} appeared meanwhile`), { code: "EEXIST" });
  await fs.rename(source, destination);
}

/**
 * The ISO time a ledger record carries, or NaN. Only ISO strings count: V8's
 * `Date.parse` reads "old-1" as 1 January 2001.
 */
function recordTime(line) {
  try {
    const record = JSON.parse(line);
    const value = record.at ?? record.timestamp ?? record.ts ?? record.time ?? record.created_at;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function isJson(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** Complete records only: a last line without its newline that does not parse was cut off by a killed writer. */
function ledgerLines(text) {
  const lines = text.split("\n");
  const tail = lines.pop();
  if (tail && isJson(tail)) lines.push(tail);
  return lines.filter((line) => line.trim());
}

/**
 * Two append-only ledgers as one, in time order: each is already ordered, so
 * this is a merge, and a record without a time keeps its place before the
 * newer ledger's. Appending the old ledger after the new one put 2.x's records
 * last, and the ledger's pruning, which keeps the last lines, dropped the
 * newest ones first.
 *
 * @param {string} older - The 2.x ledger.
 * @param {string} current - The one already at the destination.
 * @returns {string}
 */
export function mergeLedgers(older, current) {
  const left = ledgerLines(older);
  const right = ledgerLines(current);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (j >= right.length) merged.push(left[i++]);
    else if (i >= left.length) merged.push(right[j++]);
    else if (recordTime(right[j]) < recordTime(left[i])) merged.push(right[j++]);
    else merged.push(left[i++]);
  }
  return merged.length ? `${merged.join("\n")}\n` : "";
}

/** Merge the 2.x ledger into the current one under the ledger's own lock, which every writer takes. */
async function mergeJsonl(source, destination) {
  await withExclusiveFile(destination, async () => {
    const [older, current] = await Promise.all([fs.readFile(source, "utf8"), fs.readFile(destination, "utf8").catch(() => "")]);
    await atomicWriteFile(destination, mergeLedgers(older, current));
    await fs.rm(source, { force: true });
  });
}

async function removeEmptyDirectories(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
  }
  if ((await fs.readdir(directory).catch(() => ["keep"])).length === 0) {
    await fs.rmdir(directory).catch(() => undefined);
  }
}

/**
 * Where `doctor` reads what the last migration did: in the state folder —
 * `AI_DEV_STATE_ROOT` when the environment names one. In the image that is the
 * host's folder the client entry mounts, and a record kept in the volume's
 * state was itself moved out by the next start's migration of that state.
 *
 * @param {string} runtimeRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function migrationRecordPath(runtimeRoot, env = {}) {
  const named = String(env.AI_DEV_STATE_ROOT ?? "").trim();
  return path.join(named ? path.resolve(named) : path.join(runtimeRoot, "state"), "runtime-home-migration.json");
}

async function recordMigration(runtimeRoot, entry, env) {
  const target = migrationRecordPath(runtimeRoot, env);
  await withExclusiveFile(target, async () => {
    const history = (await readMigrationRecord(runtimeRoot, env)).history;
    history.push(entry);
    await atomicWriteJson(target, { schema_version: 1, history: history.slice(-20) });
  });
}

/**
 * What earlier migrations did, newest last.
 *
 * @param {string} runtimeRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ history: object[] }>}
 */
export async function readMigrationRecord(runtimeRoot, env = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(migrationRecordPath(runtimeRoot, env), "utf8"));
    return { history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch {
    return { history: [] };
  }
}

let prepared = null;

/**
 * Bring the runtime tree to the layout this version reads, once per process.
 *
 * `mcp-stdio.mjs` awaits it before it chooses a single path, so every entry
 * that loads the server — the stdio server, the daemon, `npm run setup`, the
 * CLI, the tests — has the data a 2.x install left behind in place first. A
 * failure is reported on stderr and does not stop the server: the old tree
 * stays where it was, and `doctor` names it.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [options]
 * @returns {Promise<object>} the migration result
 */
export function prepareRuntimeHome({ env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const report = (result, why) => {
    if (result.status === "migrated" && (result.moved || result.merged)) {
      log(`ai-dev: moved ${result.moved + result.merged} file(s) from ${result.from} to ${result.to} (${why}).`);
    }
    if (result.conflicts.length) {
      log(`ai-dev: ${result.conflicts.length} file(s) exist in both places and were left in ${result.from}; ai-dev doctor lists them.`);
    }
    if (result.errors.length) {
      log(`ai-dev: ${result.errors.length} file(s) could not be moved out of ${result.from} (${result.errors[0].code || "error"}: ${result.errors[0].path}); ai-dev doctor lists them.`);
    }
    return result;
  };
  const failed = (what) => (error) => {
    log(`ai-dev: could not move ${what}: ${error.message}`);
    return { status: "failed", error: error.message, moved: 0, merged: 0, duplicates: 0, conflicts: [], errors: [] };
  };
  prepared ??= migrateDoubledRuntimeHome({ env })
    .then((result) => report(result, "AI_DEV_HOME is the runtime folder itself now"), failed("the runtime tree out of AI_DEV_HOME/.ai-dev"))
    .then(async (result) => {
      // The folder it moves from is the one 2.x read for this install, which is not always ~/.codex:
      // found once, before the move, so a move that fails half-way names the folder it moved from.
      const codexFrom = await codexRoot(env);
      return {
        ...result,
        codex: await migrateCodexFrom(codexFrom, { env })
          .then((codex) => report(codex, "the Codex-era folder is not read any more"), failed(`AI Dev's data out of ${codexFrom}`)),
        volume: await migrateVolumeState({ env })
          .then((volume) => report(volume, "the state is the one folder the server and the hooks share"), failed("the volume's state into the host's state folder"))
      };
    });
  return prepared;
}

async function listFiles(directory, root = directory, limit = 50, found = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= limit) break;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(full, root, limit, found);
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(path.relative(root, full));
  }
  return found;
}

/**
 * Where the runtime tree is and what the last migration did, for `doctor`.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ root: string, ai_dev_home: string, ai_dev_home_names_home: boolean, legacy_root: string, legacy_files: string[], last_migration: object|null }>}
 */
export async function describeRuntimeHome({ env = process.env } = {}) {
  const root = resolveRuntimeStateRoot("", env);
  const raw = String(env.AI_DEV_HOME ?? "").trim();
  const legacy = legacyDoubledRuntimeRoot(env);
  const { history } = await readMigrationRecord(root, env);
  const codex = await codexRoot(env);
  const codexFiles = [];
  for (const folder of codexLegacyFolders(env, codex)) {
    for (const file of await listFiles(folder.source, folder.codex, 50 - codexFiles.length)) codexFiles.push(file);
  }
  return {
    root,
    ai_dev_home: raw,
    ai_dev_home_names_home: Boolean(raw) && !explicitRuntimeHome(env),
    legacy_root: legacy,
    legacy_files: legacy ? await listFiles(legacy) : [],
    codex_root: codex,
    codex_files: codexFiles,
    last_migration: history.at(-1) ?? null
  };
}

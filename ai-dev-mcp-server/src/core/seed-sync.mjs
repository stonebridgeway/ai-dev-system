/**
 * The user's vault, kept current with the seed an install ships.
 *
 * A package's folder belongs to npm (or the installer) and is replaced on the
 * next update, so the server cannot write its notes, registries and project
 * cards there. Outside a clone the seed is copied into a vault of the user's
 * own, `~/.ai-dev/vault`, and each later version brings its changes by the
 * seed's sha256 manifest:
 *
 * - a file the user has not touched since it was shipped is replaced;
 * - a file the user changed stays — and when the update changed it too, that is
 *   a conflict: the update's version is written beside it as
 *   `<file>.seed-new` (pacman's `.pacnew`), and `doctor` names it until the
 *   user has merged what they want and deleted the `.seed-new` file;
 * - a file the user deleted stays deleted;
 * - a file the seed dropped goes, unless the user changed it.
 *
 * An older version never rolls a vault back: two versions can share one vault
 * for a while (a client whose config still names the previous one), and each
 * start of the older would undo the newer's update.
 *
 * Docker's entrypoint copied with `cp -n`, which never updates a file that is
 * there; this is the update that `cp -n` was not.
 *
 * What was shipped is remembered in `<vault>/.ai-dev-seed.json`, beside the
 * files it describes, so a vault restored from a backup carries its own record.
 * A vault without one — a 2.x Docker volume, or a record the user deleted — is
 * read against the seed's history (`data/seed-history.json`): a file exactly as
 * some earlier seed shipped it is the seed's and is updated or removed as any
 * other; every other file is the user's and is kept, and named as a conflict
 * when this seed changed it. So is a vault a 2.x image has run on since its
 * last sync — rolled back to `:2` and returned from — which that image's
 * `cp -n` filled with its seed again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { withFileLock } from "./file-lock.mjs";
import { atomicWriteJson, renameOver } from "./atomic-files.mjs";

export const SEED_STATE_FILE = ".ai-dev-seed.json";

/** Beside a file the user changed, the version an update shipped of it. */
export const SEED_NEW_SUFFIX = ".seed-new";

/** Every version of a seed file shipped before vaults kept a record (`scripts/seed-history.mjs`). */
export const SEED_HISTORY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "seed-history.json");

const MANIFEST = "public-seed.manifest.json";

/**
 * Whether a file is a seed's manifest — JSON with a `files` list — and not the
 * user's own file of that name. 2.x's `cp -n` put its manifest beside its seed,
 * and finding one is how a sync tells that 2.x ran here; the layout asks the
 * same before it treats a vault named by `AI_DEV_VAULT_ROOT` as seeded.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isSeedManifest(file) {
  try {
    return Array.isArray(JSON.parse(fs.readFileSync(file, "utf8"))?.files);
  } catch {
    return false;
  }
}

/**
 * How often the holder of a sync says it is alive, and how long another start
 * waits for it: a 2.x volume's first sync takes seconds here and a minute on a
 * slow machine, which a lock taken for stale after 30 s let a second start
 * break into. A start still waiting after 15 s goes on
 * without the sync — the vault as it is, the next start syncs — rather than past
 * the 60 s a client gives `initialize`; in the image it then builds nothing
 * either.
 */
const SYNC_LOCK = Object.freeze({ timeoutMs: 15_000, staleMs: 20_000, heartbeatMs: 3_000 });

/**
 * How the history names one version of one file: the path and its sha256,
 * hashed, so the list of files 2.x shipped is 50 KB instead of 250.
 *
 * @param {string} relative - `/`-separated path inside the seed.
 * @param {string} sha - The file's sha256.
 * @returns {string}
 */
export function seedHistoryKey(relative, sha) {
  return crypto.createHash("sha256").update(`${relative}\0${sha}`).digest("hex").slice(0, 16);
}

/** The history's keys; a package without the file knows no earlier seed. */
export async function readSeedHistory(file = SEED_HISTORY_FILE) {
  const history = await readJson(file, null);
  return new Set(Array.isArray(history?.pairs) ? history.pairs.map(String) : []);
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * What is at a path: a regular file, nothing, or something of the user's that
 * is neither — a link, a folder, a file where a folder of the seed's should be.
 */
async function entryKind(target) {
  try {
    return (await fsp.lstat(target)).isFile() ? "file" : "other";
  } catch (error) {
    // A file where the path needs a folder: POSIX says ENOTDIR, Windows ENOENT,
    // and the copy's mkdir then failed the whole update with EEXIST.
    if (error?.code === "ENOENT") return await underFile(path.dirname(target)) ? "other" : "absent";
    if (error?.code === "ENOTDIR") return "other";
    throw error;
  }
}

/** Whether the nearest part of this path that exists is something other than a folder. */
async function underFile(folder) {
  const stat = await fsp.lstat(folder).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (stat) return !stat.isDirectory() && !stat.isSymbolicLink();
  const parent = path.dirname(folder);
  return parent !== folder && underFile(parent);
}

/** The sha256 of a regular file, or null when there is none at the path. */
async function fileSha(target) {
  return await entryKind(target) === "file" ? sha256File(target) : null;
}

/** A manifest path, checked to stay inside the folder it names a file of. */
function inside(root, relative) {
  if (!relative || /^[\\/]/.test(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`The seed manifest names ${JSON.stringify(relative)}, which is not a path inside the seed.`);
  }
  return path.join(root, ...relative.split("/"));
}

/** Copy over a file only once the copy is whole: an interrupted update leaves the old file, not half a new one. */
async function copyOver(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.copyFile(source, temp);
    await renameOver(temp, target);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

/** Remove a file only while it still holds one of the versions this module wrote there. */
async function removeIfSha(target, ...shas) {
  const current = await fileSha(target);
  if (current !== null && shas.includes(current)) await fsp.rm(target, { force: true });
}

/**
 * Whether a folder between the vault and this path is a link — a folder of the
 * user's own, linked in. Nothing is written or removed through one: an update
 * rewrote and deleted files in the repository a user had linked as a skills
 * folder.
 */
function linkedFolders(contentRoot) {
  const known = new Map();
  const linked = async (folder) => {
    if (folder === contentRoot || !folder.startsWith(contentRoot + path.sep)) return false;
    if (!known.has(folder)) {
      known.set(folder, (async () => {
        const stat = await fsp.lstat(folder).catch(() => null);
        return Boolean(stat?.isSymbolicLink()) || linked(path.dirname(folder));
      })());
    }
    return known.get(folder);
  };
  return (target) => linked(path.dirname(target));
}

/**
 * Whether two paths are one file: on Windows and macOS `x/skill.md` and
 * `x/SKILL.md` are, and removing the old name of a file the seed renamed by
 * case removed the file itself.
 */
async function sameFile(left, right) {
  const [a, b] = await Promise.all([fsp.stat(left).catch(() => null), fsp.stat(right).catch(() => null)]);
  return Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
}

/**
 * What of a vault with no record a seed shipped: each file whose content is the
 * manifest's own version or a version the history names for that path, as
 * `{ path: sha256 }` — the record the sync would have kept. Links are not
 * followed (a 2.x volume links `09-mcp/` into the image), and nothing here is
 * the user's unless the history says otherwise.
 */
async function recogniseShipped(contentRoot, manifest, history) {
  const listed = new Map(manifest.files.map((entry) => [String(entry.path), String(entry.sha256)]));
  const shipped = {};
  let earlier = 0;
  const walk = async (folder) => {
    const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(SEED_NEW_SUFFIX)) continue;
      const relative = path.relative(contentRoot, full).split(path.sep).join("/");
      if (relative === SEED_STATE_FILE) continue;
      const sha = await sha256File(full);
      if (listed.get(relative) === sha) {
        shipped[relative] = sha;
      } else if (history.has(seedHistoryKey(relative, sha))) {
        shipped[relative] = sha;
        earlier += 1;
      }
    }
  };
  await walk(contentRoot);
  return { shipped, earlier };
}

/** Folders a removal left empty go too, up to the vault itself. */
async function pruneEmptyParents(file, root) {
  for (let folder = path.dirname(file); folder.startsWith(root + path.sep); folder = path.dirname(folder)) {
    try {
      await fsp.rmdir(folder);
    } catch {
      return;
    }
  }
}

/**
 * `-1`, `0` or `1` as version `left` is older than, the same as or newer than
 * `right`; a prerelease is older than its release. Unreadable parts count as 0.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    // Build metadata (`+build.1`) does not order versions (semver, rule 10).
    const [core, pre = ""] = String(value ?? "").trim().replace(/^v/, "").replace(/\+.*$/s, "").split(/-(.*)/s);
    return { numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre || !b.pre) return a.pre ? -1 : 1;
  return a.pre.localeCompare(b.pre, "en", { numeric: true }) < 0 ? -1 : 1;
}

/**
 * The conflicts still open: the user's file is there, still differs from what
 * was shipped, and the `.seed-new` beside it has not been deleted.
 */
async function openConflicts(contentRoot, state) {
  const files = state?.files && typeof state.files === "object" ? state.files : {};
  const open = [];
  for (const relative of Array.isArray(state?.conflicts) ? state.conflicts : []) {
    const target = inside(contentRoot, String(relative));
    const current = await fileSha(target);
    if (current !== null && current !== files[relative] && await entryKind(target + SEED_NEW_SUFFIX) === "file") open.push(String(relative));
  }
  return open;
}

/**
 * Bring the vault up to the seed.
 *
 * @param {object} input
 * @param {string} input.seedRoot - The shipped seed: `<package>/seed`.
 * @param {string} input.contentRoot - The user's vault.
 * @param {string} [input.version] - The shipping package's version; an older one leaves a newer vault alone.
 * @param {() => Date} [input.now]
 * @param {() => Promise<Set<string>>} [input.history] - The earlier seeds' versions, for a vault with no record ({@link readSeedHistory}).
 * @returns {Promise<{ status: "current"|"synced"|"newer", version: string, fingerprint: string, added: number, updated: number, unchanged: number, removed: number, recognised: number, kept: string[], conflicts: string[], missing: string[] }>}
 */
export async function syncSeed({ seedRoot, contentRoot, version = "", now = () => new Date(), history = readSeedHistory }) {
  const manifest = await readJson(path.join(seedRoot, MANIFEST), null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error(`${seedRoot} has no readable ${MANIFEST}.`);
  const fingerprint = String(manifest.content_fingerprint ?? "");
  const statePath = path.join(contentRoot, SEED_STATE_FILE);
  const result = async (status, state, counts = {}) => ({
    status,
    version: String(state?.seed_version ?? version),
    fingerprint: String(state?.seed_fingerprint ?? fingerprint),
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    recognised: 0,
    kept: [],
    missing: Array.isArray(state?.missing) ? state.missing : [],
    conflicts: counts.conflicts ?? await openConflicts(contentRoot, state),
    ...counts
  });
  // A 2.x image copies its seed into the vault with `cp -n` at every start,
  // its manifest with it, and no sync leaves that manifest there: finding it
  // means 2.x ran here since the last sync. A file of
  // that name that is no seed manifest is the user's, and stays.
  const legacyRan = async () => isSeedManifest(path.join(contentRoot, MANIFEST));
  const settled = async (state) => {
    if (fingerprint && state?.seed_fingerprint === fingerprint) return await legacyRan() ? "" : "current";
    if (version && state?.seed_version && compareVersions(state.seed_version, version) > 0) return "newer";
    return "";
  };
  // Every start of the server asks; only a new seed costs more than a read and a stat.
  const quick = await readJson(statePath, null);
  const quickStatus = await settled(quick);
  if (quickStatus) return result(quickStatus, quick);
  await fsp.mkdir(contentRoot, { recursive: true });
  return withFileLock(statePath, async () => {
    const state = await readJson(statePath, null);
    const status = await settled(state);
    if (status) return result(status, state);
    // No record, or 2.x put its seed back since: what an earlier seed shipped
    // is told from the user's own by the history; the record, where there is
    // one, still says what this line shipped.
    const returned = Boolean(state) && await legacyRan();
    const legacy = !state || returned;
    const recognised = legacy ? await recogniseShipped(contentRoot, manifest, await history()) : { shipped: {}, earlier: 0 };
    const recorded = state?.files && typeof state.files === "object" ? state.files : {};
    const shipped = { ...recognised.shipped, ...recorded };
    const before = new Set(Array.isArray(state?.conflicts) ? state.conflicts.map(String) : []);
    const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, recognised: recognised.earlier, returned, kept: [], conflicts: [], missing: [] };
    const files = {};
    const throughLink = linkedFolders(contentRoot);
    for (const entry of manifest.files) {
      const relative = String(entry.path);
      const sha = String(entry.sha256);
      const source = inside(seedRoot, relative);
      const target = inside(contentRoot, relative);
      const previous = shipped[relative];
      // A damaged package — or one npm packed without a file — still brings
      // everything else; what it lacks keeps its old
      // record, so the next complete seed treats it as before.
      if (await entryKind(source) !== "file") {
        counts.missing.push(relative);
        if (previous !== undefined) files[relative] = previous;
        continue;
      }
      files[relative] = sha;
      if (await throughLink(target)) {
        counts.kept.push(relative);
        continue;
      }
      const kind = await entryKind(target);
      if (kind === "absent") {
        // Shipped before and gone now: the user deleted it, and it stays
        // deleted — with the update's version, if one was waiting beside it.
        if (previous !== undefined) {
          if (before.has(relative)) await removeIfSha(target + SEED_NEW_SUFFIX, sha, previous);
          continue;
        }
        await copyOver(source, target);
        counts.added += 1;
        continue;
      }
      if (kind === "other") {
        counts.kept.push(relative);
        continue;
      }
      const current = await sha256File(target);
      if (current === sha || current === previous) {
        if (current === sha) {
          counts.unchanged += 1;
        } else {
          await copyOver(source, target);
          counts.updated += 1;
        }
        // The user took a shipped version: the copy beside it has nothing left to say.
        if (before.has(relative)) await removeIfSha(target + SEED_NEW_SUFFIX, sha, previous);
      } else {
        // The user's file: changed since it was shipped, or there before the
        // seed was. It stays; when this update changed it too, its version
        // goes beside it.
        counts.kept.push(relative);
        if (previous !== sha) {
          await copyOver(source, target + SEED_NEW_SUFFIX);
          counts.conflicts.push(relative);
        } else if (before.has(relative) && await entryKind(target + SEED_NEW_SUFFIX) === "file") {
          counts.conflicts.push(relative);
        }
      }
    }
    const byCase = new Map(Object.keys(files).map((relative) => [relative.toLowerCase(), relative]));
    for (const [relative, previous] of Object.entries(shipped)) {
      if (Object.hasOwn(files, relative)) continue;
      const target = inside(contentRoot, relative);
      if (await throughLink(target)) continue;
      // Renamed by case only: on a file system that ignores case it is the
      // file the new name stands for.
      const renamed = byCase.get(relative.toLowerCase());
      if (renamed && await sameFile(target, inside(contentRoot, renamed))) continue;
      // A version of a file the seed no longer has is nothing to merge.
      await removeIfSha(target + SEED_NEW_SUFFIX, previous);
      const current = await fileSha(target);
      if (current === null) continue;
      if (current === previous) {
        await fsp.rm(target, { force: true });
        await pruneEmptyParents(target, contentRoot);
        counts.removed += 1;
      } else {
        counts.kept.push(relative);
      }
    }
    // 2.x's manifest is no file of this seed's, whatever version of it that was.
    if (legacy && await legacyRan()) {
      await fsp.rm(path.join(contentRoot, MANIFEST), { force: true });
      counts.removed += 1;
    }
    const next = {
      schema_version: 1,
      seed_version: version,
      // An incomplete seed is not current: the next start looks again, and a
      // reinstalled package fills in what this one lacked.
      seed_fingerprint: counts.missing.length ? "" : fingerprint,
      synced_at: now().toISOString(),
      seed_root: seedRoot,
      conflicts: counts.conflicts,
      missing: counts.missing,
      files
    };
    await atomicWriteJson(statePath, next);
    return result("synced", next, counts);
  }, SYNC_LOCK);
}

/**
 * What the last sync left for the user to look at, for `doctor`.
 *
 * @param {string} contentRoot
 * @returns {Promise<{ synced: boolean, version: string, synced_at: string, seed_root: string, missing: string[], conflicts: string[] }>}
 */
export async function describeSeedSync(contentRoot) {
  const state = await readJson(path.join(contentRoot, SEED_STATE_FILE), null);
  return {
    synced: Boolean(state),
    version: String(state?.seed_version ?? ""),
    synced_at: String(state?.synced_at ?? ""),
    seed_root: String(state?.seed_root ?? ""),
    missing: Array.isArray(state?.missing) ? state.missing.map(String) : [],
    conflicts: state ? await openConflicts(contentRoot, state) : []
  };
}

/** One line for a log: what a sync changed. */
export function describeSyncResult(result) {
  if (!result) return "";
  if (result.status === "failed") return `not brought up to the seed: ${result.error}`;
  if (result.status === "newer") return `left as it is: it was brought up to ${result.version}, newer than this install`;
  const conflicts = result.conflicts.length
    ? `; ${result.conflicts.length} file(s) you changed were changed by this version too — yours were kept, and this version's is beside each as <file>${SEED_NEW_SUFFIX}`
    : "";
  const missing = result.missing?.length ? `; ${result.missing.length} file(s) of the seed are missing from this install — reinstall it` : "";
  if (result.status === "current") return `seed ${result.version || "current"}${conflicts}${missing}`;
  const recognised = result.recognised
    ? ` (${result.recognised} file(s) recognised as an earlier seed's, ${result.returned ? "put back by a 2.x image since the last sync" : "with no record of the last sync"})`
    : "";
  return `seed ${result.version || "synced"}: ${result.added} added, ${result.updated} updated, ${result.removed} removed, `
    + `${result.kept.length} of yours kept${recognised}${conflicts}${missing}`;
}

/**
 * Before the server reads its vault: a package's vault is brought up to the
 * seed the package ships. Every other layout reads its content where it is.
 * A failure is reported, not thrown: the server still starts, on the vault as
 * it was, and the health check says what is missing.
 *
 * @param {{ seedRoot: string, contentRoot: string }} layout - From `install-layout.mjs`.
 * @param {{ version?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<object|null>} The sync's result, `{ status: "failed", error }`, or null when there is no seed to sync.
 */
export async function prepareUserVault(layout, { version = "", log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (!layout?.seedRoot) return null;
  let result;
  try {
    result = await syncSeed({ seedRoot: layout.seedRoot, contentRoot: layout.contentRoot, version });
  } catch (error) {
    result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (result.status !== "current") log(`ai-dev: vault ${layout.contentRoot} — ${describeSyncResult(result)}.`);
  return result;
}

/**
 * The health check's view of a package's vault: filled from the seed, and
 * whether an update left files for the user to merge.
 *
 * @param {{ root: string, synced: boolean, version: string, synced_at: string, missing?: string[], conflicts: string[] }} info
 * @returns {{ status: "ok"|"warn", summary: string, details: object }}
 */
export function evaluateVaultSeed(info) {
  const details = { ...info };
  if (!info.synced) {
    return { status: "warn", summary: `The vault ${info.root} has not been filled from the seed yet: restart the server, or run setup.`, details };
  }
  if (info.missing?.length) {
    return {
      status: "warn",
      summary: `${info.missing.length} file(s) of the seed are missing from this install (${info.missing.slice(0, 3).join(", ")}${info.missing.length > 3 ? ", …" : ""}), `
        + "so the vault lacks them too: reinstall the package.",
      details
    };
  }
  if (info.conflicts.length) {
    const named = info.conflicts.slice(0, 3).join(", ") + (info.conflicts.length > 3 ? `, and ${info.conflicts.length - 3} more` : "");
    return {
      status: "warn",
      summary: `${info.conflicts.length} file(s) you changed in ${info.root} were changed by an update too: ${named}. `
        + `Yours were kept; the update's version is beside each as <file>${SEED_NEW_SUFFIX}. Merge what you want, then delete the ${SEED_NEW_SUFFIX} file.`,
      details
    };
  }
  return { status: "ok", summary: `Vault ${info.root}: seed ${info.version || "of this install"}, brought up to date ${String(info.synced_at).slice(0, 10)}.`, details };
}

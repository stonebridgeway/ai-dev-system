/**
 * Whether the generated skill registry still describes the skills on disk, and
 * a reader that rebuilds it when it does not.
 *
 * `03-skills-catalog/registries/skills.index.json` is built by `rebuild_index`
 * from the `SKILL.md` files under `03-skills-catalog/sources/`, and routing,
 * skill search and the search index all read the registry, not the files. A
 * `git pull` that removes, adds or rewrites skills changes the files and leaves
 * the registry as it was, so the removed skills went on being recommended and
 * found. Three signals tell, without reading a skill:
 *
 * - an entry whose `SKILL.md` is gone;
 * - an entry whose `SKILL.md` is newer than the registry;
 * - a directory between `sources/` and a skill that is newer than the
 *   registry — something was added, removed or renamed in it.
 *
 * A file stamped with the registry's own time counts as newer: the kernel
 * stamps writes from a clock that moves in ticks of a few milliseconds, so a
 * change in the tick the registry was written in has the same time — the cost
 * of counting it is one rebuild too many, the cost of not counting it a change
 * never seen. A time in the future says nothing about the order of two writes
 * (a tree unpacked from a machine whose clock ran ahead), so it is not counted:
 * otherwise no rebuild could ever make the registry current again. The future
 * starts after the current millisecond: files are stamped finer than
 * `Date.now()` counts, and a change in this very millisecond is not one from
 * the future.
 *
 * The registry's time is the moment its sources were read, not the moment it
 * was written: `rebuild_index` dates it back to its own start
 * ({@link dateSkillRegistry}), and a rewrite from the registry itself — the
 * taxonomy, the overlays — keeps the date it had ({@link keepSkillRegistryDate}).
 * A skill changed while a rebuild ran is then newer than the registry, and the
 * next look sees it. It is dated a little earlier
 * still, by {@link FILE_CLOCK_MARGIN_MS}: the clock that stamps files lags the
 * process's own, and a skill rewritten just after the rebuild noted its time
 * was stamped before that time in 284 runs of 300.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";

/** How long a verdict on the registry is trusted before the files are looked at again. */
export const SKILL_REGISTRY_CHECK_INTERVAL_MS = 5_000;

/**
 * How far a file's stamp may sit before the moment it was written, as the
 * process's clock tells it: Linux before 6.13 stamps from a clock that moves
 * in ticks (4 ms), Windows in ~16 ms ones, HFS+ keeps seconds and FAT two. The
 * registry is dated this much before its sources were read; the cost is one
 * rebuild too many when a skill changed in the two seconds before a rebuild
 * began.
 */
export const FILE_CLOCK_MARGIN_MS = 2_000;

/**
 * Pauses before a rebuild that failed, or left the registry naming files that
 * are not there, is tried again while the registry stays the same. A pull that
 * removed a skill under a running rebuild is put right by the next one; a
 * rebuild that cannot succeed is not run in a loop.
 */
export const SKILL_REGISTRY_RETRY_DELAYS_MS = Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000]);

const EXAMPLES = 5;

function statOrUndefined(target) {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Compare the registry's entries with the files they were built from.
 *
 * @param {object} input
 * @param {string} input.catalogRoot - `<vault>/03-skills-catalog`; entry paths are relative to it.
 * @param {number} input.builtAtMs - When the registry was written (its mtime).
 * @param {string[]} input.paths - The `path` of every registry entry.
 * @param {number} [input.nowMs] - Times after this are not trusted.
 * @param {(target: string) => (fs.Stats|undefined)} [input.stat]
 * @returns {{ stale: boolean, missing: number, changed: number, directories: number, examples: string[] }}
 */
export function skillRegistryStaleness({ catalogRoot, builtAtMs, paths, nowMs = Date.now(), stat = statOrUndefined }) {
  const sourcesRoot = path.join(catalogRoot, "sources");
  // Up to the end of the current millisecond: a stamp finer than Date.now() in
  // the same millisecond is now, not the future.
  const newer = (info) => info.mtimeMs >= builtAtMs && info.mtimeMs < nowMs + 1;
  const examples = [];
  const note = (text) => {
    if (examples.length < EXAMPLES) examples.push(text);
  };
  const directories = new Set();
  let missing = 0;
  let changed = 0;
  for (const relative of paths) {
    const file = path.resolve(catalogRoot, relative);
    const info = stat(file);
    if (!info) {
      missing += 1;
      note(`missing ${relative}`);
      continue;
    }
    if (newer(info)) {
      changed += 1;
      note(`changed ${relative}`);
    }
    // The skill's own directory holds more than the skill — Python caches,
    // vendored node_modules — so only the directories above it are watched.
    for (let directory = path.dirname(path.dirname(file)); inside(sourcesRoot, directory); directory = path.dirname(directory)) {
      directories.add(directory);
      if (directory === sourcesRoot) break;
    }
  }
  let newerDirectories = 0;
  for (const directory of directories) {
    const info = stat(directory);
    if (info && newer(info)) {
      newerDirectories += 1;
      note(`directory ${path.relative(catalogRoot, directory).replaceAll("\\", "/")}`);
    }
  }
  return { stale: missing + changed + newerDirectories > 0, missing, changed, directories: newerDirectories, examples };
}

/**
 * Date a freshly written registry by when its sources were read, less the
 * margin the file clock may lag by.
 *
 * @param {string} registryPath
 * @param {Date} sourcesReadAt - Taken before the first `SKILL.md` was read.
 * @param {{ marginMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function dateSkillRegistry(registryPath, sourcesReadAt, { marginMs = FILE_CLOCK_MARGIN_MS } = {}) {
  const at = new Date(sourcesReadAt.getTime() - marginMs);
  try {
    await fs.promises.utimes(registryPath, at, at);
  } catch (error) {
    // No registry on disk (a host that keeps it elsewhere): nothing to date.
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Rewrite the registry from itself without making it look newer than the
 * sources it describes.
 *
 * @template T
 * @param {string} registryPath
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
export async function keepSkillRegistryDate(registryPath, write) {
  const before = statOrUndefined(registryPath);
  const result = await write();
  // In seconds, a microsecond early: a Date would round to the millisecond,
  // possibly up, and a registry dated even a little late hides a change.
  if (before && statOrUndefined(registryPath)) {
    await fs.promises.utimes(registryPath, before.atimeMs / 1000, (before.mtimeMs - 0.001) / 1000);
  }
  return result;
}

/**
 * Read a registry file the way the server always has: UTF-8, BOM tolerated.
 *
 * @param {string} registryPath
 * @returns {Promise<object[]>}
 */
export async function readSkillRegistryFile(registryPath) {
  const raw = await fs.promises.readFile(registryPath, "utf8");
  return JSON.parse(raw.replace(/^﻿/, ""));
}

/**
 * Whether a registry on disk is out of date, for callers that look once (the
 * setup command) rather than keep a reader.
 *
 * @param {{ registryPath: string, catalogRoot: string, nowMs?: number }} input
 * @returns {Promise<ReturnType<typeof skillRegistryStaleness> | null>} null when there is no registry
 */
export async function checkSkillRegistry({ registryPath, catalogRoot, nowMs = Date.now() }) {
  const info = statOrUndefined(registryPath);
  if (!info) return null;
  const items = await readSkillRegistryFile(registryPath);
  const paths = (Array.isArray(items) ? items : []).map((item) => String(item?.path ?? "")).filter(Boolean);
  return skillRegistryStaleness({ catalogRoot, builtAtMs: info.mtimeMs, paths, nowMs });
}

/**
 * Inside a rebuild of the registry, whoever started it: its own reads go
 * straight to the file. A freshness check there would start a rebuild that
 * waits for the one running — its own.
 */
const rebuilding = new AsyncLocalStorage();

/** Inside a writer that holds the registry's lock: another writer it calls runs at once. */
const holding = new AsyncLocalStorage();

/**
 * The registry's writers go one at a time across processes: in Docker each
 * session is a container of one volume, and two rebuilds at once removed each
 * other's folders. The holder beats every 3 s; one silent
 * for 20 s is taken for killed.
 */
export const SKILL_REGISTRY_LOCK = Object.freeze({ timeoutMs: 120_000, staleMs: 20_000, heartbeatMs: 3_000 });

/**
 * Run a writer of the registry under its lock, as a rebuild: its reads skip
 * the freshness check, and a writer it calls in turn does not wait for it.
 *
 * @template T
 * @param {string} registryDir - `<catalog>/registries`.
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export function withSkillRegistryLock(registryDir, operation) {
  if (holding.getStore()) return operation();
  return withFileLock(path.join(registryDir, "skills.index.json"), () => holding.run(true, () => rebuilding.run(true, operation)), SKILL_REGISTRY_LOCK);
}

/**
 * Run a writer that builds from the registry — the taxonomy — on a current
 * one: the registry is rebuilt first when its skills changed, then the writer
 * runs under the lock and reads it as it stands. The
 * look comes before the lock: a rebuild another call already started takes
 * the lock itself, and waiting for that rebuild while holding the lock would
 * be waiting for itself again.
 *
 * @template T
 * @param {{ ensureFresh: () => Promise<unknown> }} reader - {@link createSkillRegistryReader}'s.
 * @param {string} registryDir - `<catalog>/registries`.
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function withCurrentSkillRegistry(reader, registryDir, operation) {
  await reader.ensureFresh();
  return withSkillRegistryLock(registryDir, operation);
}

/**
 * The registry, rebuilt first when its skills changed on disk.
 *
 * At most one look at the files per `intervalMs` while the registry file stays
 * the same; at most one rebuild at a time, which concurrent readers wait for.
 * Reads made by the rebuild itself go straight to the file — waiting there
 * would be the rebuild waiting for itself. A rebuild that fails, or that writes
 * a registry still naming a file that is not there, is tried again after the
 * next of `retryDelays`, or at once when the registry file changes; until then
 * the registry on disk is served as it is, and `onError` hears why. Files that
 * changed while a rebuild ran are newer than the registry it wrote, so the
 * next look rebuilds again. A registry that is not there at all is built the
 * same way: a server started without `ai-dev setup` — a client entry written by
 * hand, a new user of a shared server — routed nothing and failed `begin_task`
 * on a missing file.
 *
 * @param {object} input
 * @param {string} input.registryPath
 * @param {string} input.catalogRoot
 * @param {(verdict: ReturnType<typeof skillRegistryStaleness>) => Promise<unknown>} input.rebuild
 * @param {number} [input.intervalMs]
 * @param {() => number} [input.now]
 * @param {(error: Error) => void} [input.onError]
 * @param {readonly number[]} [input.retryDelays] - Milliseconds before the 1st, 2nd, … retry.
 * @returns {{ read: () => Promise<object[]>, ensureFresh: () => Promise<{ action: string, verdict?: object, error?: string }> }}
 */
export function createSkillRegistryReader({
  registryPath,
  catalogRoot,
  rebuild,
  intervalMs = SKILL_REGISTRY_CHECK_INTERVAL_MS,
  now = Date.now,
  onError = () => {},
  retryDelays = SKILL_REGISTRY_RETRY_DELAYS_MS
}) {
  let inFlight = null;
  let checkedKey = "";
  let checkedAt = -Infinity;
  let pathsKey = "";
  let paths = [];
  // The registry a rebuild could not put right, and when to try it again.
  let failedKey = "";
  let failures = 0;
  let retryAt = 0;

  function failed(key) {
    failedKey = key;
    failures += 1;
    retryAt = now() + retryDelays[Math.min(failures, retryDelays.length) - 1];
  }

  const keyOf = (info) => `${info.mtimeMs}:${info.size}`;

  async function verdictFor(info) {
    const key = keyOf(info);
    if (key !== pathsKey) {
      const items = await readSkillRegistryFile(registryPath);
      paths = (Array.isArray(items) ? items : []).map((item) => String(item?.path ?? "")).filter(Boolean);
      pathsKey = key;
    }
    return skillRegistryStaleness({ catalogRoot, builtAtMs: info.mtimeMs, paths, nowMs: now() });
  }

  async function runRebuild(verdict) {
    try {
      await rebuild(verdict);
    } catch (error) {
      const info = statOrUndefined(registryPath);
      failed(info ? keyOf(info) : "");
      onError(error instanceof Error ? error : new Error(String(error)));
      return { action: "failed", verdict, error: String(error?.message ?? error) };
    }
    const info = statOrUndefined(registryPath);
    if (!info) return { action: "rebuilt", verdict };
    const after = await verdictFor(info);
    checkedKey = keyOf(info);
    checkedAt = now();
    if (after.missing > 0) {
      failed(checkedKey);
      onError(new Error(`skill registry still out of date after a rebuild: ${after.examples.join("; ")}`));
    } else {
      failedKey = "";
      failures = 0;
    }
    return { action: "rebuilt", verdict };
  }

  async function ensureFresh() {
    if (rebuilding.getStore()) return { action: "current" };
    if (inFlight) return inFlight;
    const info = statOrUndefined(registryPath);
    if (!info) {
      // `failed` keys a registry that is not there as "".
      if (failures > 0 && failedKey === "" && now() < retryAt) return { action: "absent" };
      const verdict = { stale: true, missing: 0, changed: 0, directories: 0, examples: ["no registry yet"] };
      inFlight = rebuilding.run(true, () => runRebuild(verdict)).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    const key = keyOf(info);
    if (key === checkedKey && now() - checkedAt < intervalMs) return { action: "current" };
    const verdict = await verdictFor(info);
    checkedKey = key;
    checkedAt = now();
    if (!verdict.stale) return { action: "current", verdict };
    if (key === failedKey && now() < retryAt) return { action: "stale", verdict };
    if (inFlight) return inFlight;
    inFlight = rebuilding.run(true, () => runRebuild(verdict)).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function read() {
    await ensureFresh();
    return readSkillRegistryFile(registryPath);
  }

  return { read, ensureFresh };
}

import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

export const WORKTREES_DIR = ".worktrees";
export const TASK_BRANCH_PREFIX = "task/";

/**
 * What a task worktree is, in the order the states are decided.
 *
 * - `orphan` — git still registers it and the directory is gone. Nothing to
 *   lose; `git worktree prune` is the whole fix.
 * - `dirty` — uncommitted work in it. First in line after orphan because it is
 *   the only state where removing costs something that exists nowhere else.
 * - `merged` — every commit on its branch is reachable from the main checkout's
 *   HEAD. The work is in; the worktree is a leftover.
 * - `stale` — has commits of its own, none of them recent. Might be abandoned,
 *   might be waiting on review, so it is never cleaned up by default.
 * - `active` — unmerged commits and recent work. Leave it alone.
 */
export const WORKTREE_STATES = Object.freeze(["orphan", "dirty", "merged", "stale", "active"]);

/** How long a worktree's newest commit may be, before it reads as stale. */
export const STALE_AFTER_DAYS = 14;

/** States {@link planWorktreeCleanup} offers to remove without being asked twice. */
export const CLEANABLE_STATES = Object.freeze(["merged", "orphan"]);
const HANDOFF_FILES = ["AGENTS.md", ".ai-dev/README.md", ".ai-dev/project-brief.md", ".ai-dev/project-map.md", ".ai-dev/quality-gate.md"];
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

async function git(cwd, args, { timeoutMs = 60_000 } = {}) {
  const result = await runProcess({
    executable: "git",
    args: ["-C", cwd, ...args],
    cwd,
    timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024
  }).catch((error) => ({ ok: false, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  return result;
}

function assertOk(result, label) {
  if (result.ok) return result;
  throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown git error").trim().slice(0, 500)}`);
}

async function pathExists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

/**
 * Build a filesystem- and branch-safe worktree name from free text (task id,
 * task title). Falls back to `task` when nothing usable remains.
 *
 * @param {string} value
 * @param {number} [maxLength=48]
 * @returns {string}
 */
export function worktreeName(value, maxLength = 48) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(8, maxLength))
    .replace(/-+$/g, "");
  return slug || "task";
}

function assertName(name) {
  if (!NAME_PATTERN.test(String(name || "")) || String(name).includes("..")) {
    throw new Error(`Invalid worktree name: ${name}`);
  }
  return name;
}

async function mainRepositoryRoot(projectRoot) {
  const toplevel = assertOk(await git(projectRoot, ["rev-parse", "--show-toplevel"]), "git rev-parse");
  const commonDir = assertOk(await git(projectRoot, ["rev-parse", "--git-common-dir"]), "git rev-parse --git-common-dir");
  const rawCommon = commonDir.stdout.trim();
  const commonAbsolute = path.isAbsolute(rawCommon) ? rawCommon : path.resolve(toplevel.stdout.trim(), rawCommon);
  // The main working tree is the parent of the common .git directory.
  const mainRoot = path.basename(commonAbsolute) === ".git" ? path.dirname(commonAbsolute) : toplevel.stdout.trim();
  return { mainRoot: await fs.realpath(mainRoot), currentRoot: await fs.realpath(toplevel.stdout.trim()), commonDir: commonAbsolute };
}

async function ensureExcluded(commonDir, entry) {
  const excludePath = path.join(commonDir, "info", "exclude");
  const current = await fs.readFile(excludePath, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return false;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
  return true;
}

/**
 * Uncommitted changes in a worktree, ignoring the untracked handoff files that
 * {@link createTaskWorktree} copies on purpose.
 *
 * @param {string} worktreePath
 * @returns {Promise<{ dirty: boolean, dirty_files: number, files: string[] }>}
 */
export async function worktreeStatus(worktreePath) {
  const status = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = status.ok
    ? status.stdout.split("\n").filter(Boolean).filter((line) => {
      const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
      return !(line.startsWith("??") && HANDOFF_FILES.includes(filePath));
    }).map((line) => line.slice(3).trim())
    : [];
  return { dirty: files.length > 0, dirty_files: files.length, files };
}

async function copyHandoffFiles(mainRoot, worktreePath) {
  const copied = [];
  for (const relative of HANDOFF_FILES) {
    const source = path.join(mainRoot, ...relative.split("/"));
    const target = path.join(worktreePath, ...relative.split("/"));
    if (!(await pathExists(source)) || await pathExists(target)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    copied.push(relative);
  }
  return copied;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * @param {string} text
 * @returns {Array<{ path: string, head: string, branch: string, bare: boolean, detached: boolean, locked: boolean, prunable: boolean }>}
 */
export function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9).trim(), head: "", branch: "", bare: false, detached: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Create an isolated git worktree plus branch for one task:
 * `<main>/.worktrees/<name>` on `task/<name>` from `baseRef`. The `.worktrees`
 * directory is excluded through `.git/info/exclude` (no tracked file changes)
 * and untracked agent handoff files (`AGENTS.md`, `.ai-dev/*.md`) are copied so
 * the task starts with the same context as the main checkout.
 *
 * @param {{ projectRoot: string, name: string, baseRef?: string, worktreesDir?: string, branchPrefix?: string }} input
 * @returns {Promise<{ path: string, branch: string, base_ref: string, main_root: string, created: boolean, copied_files: string[] }>}
 */
export async function createTaskWorktree({ projectRoot, name, baseRef = "HEAD", worktreesDir = WORKTREES_DIR, branchPrefix = TASK_BRANCH_PREFIX }) {
  assertName(name);
  const { mainRoot, commonDir } = await mainRepositoryRoot(path.resolve(projectRoot));
  const worktreePath = path.join(mainRoot, worktreesDir, name);
  const branch = `${branchPrefix}${name}`;
  const existing = parseWorktreeList((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)
    .find((item) => path.resolve(item.path) === path.resolve(worktreePath));
  if (existing) {
    return { path: worktreePath, branch: existing.branch || branch, base_ref: baseRef, main_root: mainRoot, created: false, copied_files: [] };
  }
  if (await pathExists(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
  const branchExists = (await git(mainRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, baseRef];
  assertOk(await git(mainRoot, args), "git worktree add");
  await ensureExcluded(commonDir, `/${worktreesDir}/`);
  const copied = await copyHandoffFiles(mainRoot, worktreePath);
  return { path: worktreePath, branch, base_ref: baseRef, main_root: mainRoot, created: true, copied_files: copied };
}

/**
 * Which of {@link WORKTREE_STATES} a worktree is in, and why in one sentence.
 *
 * Pure, so the precedence is testable without a repository. The order matters:
 * a worktree can be several of these at once, and the answer has to be the one
 * that decides whether it is safe to remove.
 *
 * @param {object} input
 * @param {boolean} [input.prunable] - git's own verdict from `worktree list`.
 * @param {boolean} [input.exists] - Whether the directory is still there.
 * @param {boolean} [input.dirty]
 * @param {number} [input.dirtyFiles]
 * @param {number | null} [input.commitsAheadOfMain] - `null` when it could not be measured.
 * @param {number | null} [input.lastCommitDays] - Age of the newest commit, `null` when unknown.
 * @param {number} [input.staleAfterDays]
 * @returns {{ state: string, reason: string }}
 */
export function worktreeStateOf({
  prunable = false,
  exists = true,
  dirty = false,
  dirtyFiles = 0,
  commitsAheadOfMain = null,
  lastCommitDays = null,
  staleAfterDays = STALE_AFTER_DAYS
} = {}) {
  if (prunable || !exists) {
    return { state: "orphan", reason: "git still registers this worktree and its directory is gone; `git worktree prune` removes the registration." };
  }
  if (dirty) {
    return { state: "dirty", reason: `${dirtyFiles} uncommitted change(s) live only here. Commit, stash or discard them before removing it.` };
  }
  if (commitsAheadOfMain === 0) {
    return { state: "merged", reason: "every commit on this branch is reachable from the main checkout, so removing the worktree loses nothing." };
  }
  if (commitsAheadOfMain === null) {
    return { state: "active", reason: "how far this branch is from the main checkout could not be measured, so it is left alone." };
  }
  if (Number.isFinite(lastCommitDays) && lastCommitDays >= staleAfterDays) {
    return { state: "stale", reason: `${commitsAheadOfMain} unmerged commit(s), newest one ${Math.round(lastCommitDays)} days old. It may be abandoned, or waiting on a review.` };
  }
  return { state: "active", reason: `${commitsAheadOfMain} unmerged commit(s) and recent work.` };
}

/**
 * List task worktrees of a repository (branches under `branchPrefix` or paths
 * under `worktreesDir`), optionally with each one's lifecycle state.
 *
 * @param {{ projectRoot: string, worktreesDir?: string, branchPrefix?: string, includeStatus?: boolean, staleAfterDays?: number, now?: string }} input
 * @returns {Promise<{ main_root: string, worktrees: object[] }>}
 */
export async function listTaskWorktrees({
  projectRoot,
  worktreesDir = WORKTREES_DIR,
  branchPrefix = TASK_BRANCH_PREFIX,
  includeStatus = false,
  staleAfterDays = STALE_AFTER_DAYS,
  now = new Date().toISOString()
}) {
  const { mainRoot } = await mainRepositoryRoot(path.resolve(projectRoot));
  const entries = parseWorktreeList(assertOk(await git(mainRoot, ["worktree", "list", "--porcelain"]), "git worktree list").stdout);
  const container = path.resolve(mainRoot, worktreesDir);
  const mainHead = entries.find((entry) => path.resolve(entry.path) === mainRoot)?.head || "";
  const worktrees = [];
  for (const entry of entries) {
    const inside = path.resolve(entry.path).startsWith(`${container}${path.sep}`);
    if (!inside && !entry.branch.startsWith(branchPrefix)) continue;
    const item = { ...entry, name: path.basename(entry.path), main_root: mainRoot };
    if (includeStatus) {
      const exists = await pathExists(entry.path);
      if (!entry.prunable && exists) {
        const status = await worktreeStatus(entry.path);
        item.dirty = status.dirty;
        item.dirty_files = status.dirty_files;
        const ahead = mainHead ? await git(entry.path, ["rev-list", "--count", `${mainHead}..HEAD`]) : { ok: false };
        item.commits_ahead_of_main = ahead.ok ? Number(ahead.stdout.trim()) || 0 : null;
        const lastCommit = await git(entry.path, ["log", "-1", "--format=%cI"]);
        item.last_commit_at = lastCommit.ok ? lastCommit.stdout.trim() : "";
      }
      const lastCommitAt = Date.parse(item.last_commit_at || "");
      Object.assign(item, worktreeStateOf({
        prunable: entry.prunable,
        exists,
        dirty: Boolean(item.dirty),
        dirtyFiles: item.dirty_files ?? 0,
        commitsAheadOfMain: item.commits_ahead_of_main ?? null,
        lastCommitDays: Number.isFinite(lastCommitAt) ? (Date.parse(now) - lastCommitAt) / 86_400_000 : null,
        staleAfterDays
      }));
    }
    worktrees.push(item);
  }
  return { main_root: mainRoot, worktrees };
}

/**
 * What a cleanup would remove and what it would leave, with a reason for each.
 *
 * `merged` and `orphan` worktrees are offered by default: the first has its work
 * in the main checkout and the second has no directory left. `stale` is offered
 * only when asked for, because "no commits for two weeks" is also what a branch
 * waiting on review looks like. `dirty` is never offered — `remove_task_worktree`
 * with `force` is the deliberate way to throw away uncommitted work.
 *
 * @param {object[]} worktrees - From {@link listTaskWorktrees} with `includeStatus`.
 * @param {{ includeStale?: boolean }} [options]
 * @returns {{ remove: object[], keep: object[], by_state: Record<string, number> }}
 */
export function planWorktreeCleanup(worktrees, { includeStale = false } = {}) {
  const cleanable = new Set([...CLEANABLE_STATES, ...(includeStale ? ["stale"] : [])]);
  const list = Array.isArray(worktrees) ? worktrees : [];
  const remove = [];
  const keep = [];
  const byState = {};
  for (const item of list) {
    const state = String(item?.state ?? "active");
    byState[state] = (byState[state] ?? 0) + 1;
    const entry = {
      path: item?.path ?? "",
      name: item?.name ?? "",
      branch: item?.branch ?? "",
      state,
      reason: item?.reason ?? "",
      dirty_files: item?.dirty_files ?? 0,
      commits_ahead_of_main: item?.commits_ahead_of_main ?? null
    };
    (cleanable.has(state) ? remove : keep).push(entry);
  }
  return { remove, keep, by_state: byState };
}

/**
 * Plan a cleanup, and carry it out when `dryRun` is false.
 *
 * Nothing is removed unless the caller says so: `dryRun` defaults to true, and
 * even then only the states {@link planWorktreeCleanup} offers are touched.
 *
 * @param {{ projectRoot: string, dryRun?: boolean, includeStale?: boolean, deleteBranch?: boolean, staleAfterDays?: number, worktreesDir?: string, branchPrefix?: string, now?: string }} input
 * @returns {Promise<object>}
 */
export async function cleanupTaskWorktrees({
  projectRoot,
  dryRun = true,
  includeStale = false,
  deleteBranch = false,
  staleAfterDays = STALE_AFTER_DAYS,
  worktreesDir = WORKTREES_DIR,
  branchPrefix = TASK_BRANCH_PREFIX,
  now = new Date().toISOString()
}) {
  const listed = await listTaskWorktrees({ projectRoot, worktreesDir, branchPrefix, includeStatus: true, staleAfterDays, now });
  const plan = planWorktreeCleanup(listed.worktrees, { includeStale });
  const problems = [];
  const removed = [];
  if (!dryRun) {
    for (const entry of plan.remove) {
      try {
        const outcome = await removeTaskWorktree({
          projectRoot: listed.main_root,
          worktreePath: entry.path,
          force: entry.state === "orphan",
          deleteBranch
        });
        // What it was, then what happened to it. The outcome alone carries no
        // `name` and no `state`, so a report of the cleanup could only list
        // paths — `removed.map((item) => item.name)` answered with undefined
        // for every entry (docs/ecc-upgrades/DEBTS.md, Д-27).
        removed.push({ ...entry, ...outcome });
      } catch (error) {
        problems.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {
    main_root: listed.main_root,
    dry_run: Boolean(dryRun),
    stale_after_days: staleAfterDays,
    include_stale: Boolean(includeStale),
    ...plan,
    removed,
    problems
  };
}

/**
 * Remove a task worktree. Refuses while the worktree has uncommitted changes
 * unless `force` is set; optionally deletes the task branch afterwards.
 *
 * @param {{ projectRoot: string, worktreePath: string, force?: boolean, deleteBranch?: boolean }} input
 * @returns {Promise<{ removed: string, branch: string, branch_deleted: boolean, dirty_files: number }>}
 */
export async function removeTaskWorktree({ projectRoot, worktreePath, force = false, deleteBranch = false }) {
  const { mainRoot } = await mainRepositoryRoot(path.resolve(projectRoot));
  const target = path.resolve(worktreePath);
  if (target === mainRoot) throw new Error("Refusing to remove the main working tree.");
  const entry = parseWorktreeList((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)
    .find((item) => path.resolve(item.path) === target);
  if (!entry) throw new Error(`Not a registered worktree: ${worktreePath}`);
  let dirtyFiles = 0;
  if (!entry.prunable) {
    dirtyFiles = (await worktreeStatus(target)).dirty_files;
    if (dirtyFiles && !force) {
      throw new Error(`Worktree has ${dirtyFiles} uncommitted change(s). Commit or stash them, or pass force=true to discard.`);
    }
  }
  // Our own dirty guard already ran (it ignores the copied handoff files, which
  // git would otherwise refuse to delete), so git itself is always forced here.
  assertOk(await git(mainRoot, ["worktree", "remove", "--force", target]), "git worktree remove");
  await git(mainRoot, ["worktree", "prune"]);
  let branchDeleted = false;
  if (deleteBranch && entry.branch) {
    branchDeleted = (await git(mainRoot, ["branch", "-D", entry.branch])).ok;
  }
  return { removed: target, branch: entry.branch, branch_deleted: branchDeleted, dirty_files: dirtyFiles };
}

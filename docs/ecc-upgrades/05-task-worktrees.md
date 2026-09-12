# 05. Git worktree на задачу

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01 (и lifecycle-инструменты `begin_task`/`complete_task`, которые уже есть).

## Идея из ECC

`worktree-manager` и `parallel-tasks`: каждая задача агента живёт в своём `git worktree` на своей
ветке, чтобы параллельные агенты и рискованные правки не трогали основной checkout. В
`ai-dev-system` задача уже привязана к `project_path`, поэтому достаточно создать worktree и
запустить `begin_task` внутри него:

- `begin_task_in_worktree` — создаёт `<repo>/.worktrees/<name>` на ветке `task/<name>` от
  `base_ref`, добавляет `.worktrees/` в `.git/info/exclude`, копирует незакоммиченные handoff-файлы
  (`AGENTS.md`, `.ai-dev/README.md`, `project-brief.md`, `project-map.md`, `quality-gate.md`), затем вызывает `begin_task` с `project_path`
  worktree и сохраняет описание worktree в `task.context.worktree`;
- `list_task_worktrees` — ветка, dirty-состояние, коммиты впереди основного checkout;
- `remove_task_worktree` — отказывается удалять с незакоммиченными изменениями (кроме `force`),
  опционально удаляет ветку;
- `complete_task` возвращает подсказку `next_step` («смержить/открыть PR из task/<name>, затем
  `remove_task_worktree`»), если задача шла в worktree.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/task-worktrees.mjs`** (230 строк)

```js
import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process-runner.mjs";

export const WORKTREES_DIR = ".worktrees";
export const TASK_BRANCH_PREFIX = "task/";
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
 * List task worktrees of a repository (branches under `branchPrefix` or paths
 * under `worktreesDir`), optionally with dirty-state information.
 *
 * @param {{ projectRoot: string, worktreesDir?: string, branchPrefix?: string, includeStatus?: boolean }} input
 * @returns {Promise<{ main_root: string, worktrees: object[] }>}
 */
export async function listTaskWorktrees({ projectRoot, worktreesDir = WORKTREES_DIR, branchPrefix = TASK_BRANCH_PREFIX, includeStatus = false }) {
  const { mainRoot } = await mainRepositoryRoot(path.resolve(projectRoot));
  const entries = parseWorktreeList(assertOk(await git(mainRoot, ["worktree", "list", "--porcelain"]), "git worktree list").stdout);
  const container = path.resolve(mainRoot, worktreesDir);
  const mainHead = entries.find((entry) => path.resolve(entry.path) === mainRoot)?.head || "";
  const worktrees = [];
  for (const entry of entries) {
    const inside = path.resolve(entry.path).startsWith(`${container}${path.sep}`);
    if (!inside && !entry.branch.startsWith(branchPrefix)) continue;
    const item = { ...entry, name: path.basename(entry.path), main_root: mainRoot };
    if (includeStatus && !entry.prunable) {
      const status = await worktreeStatus(entry.path);
      item.dirty = status.dirty;
      item.dirty_files = status.dirty_files;
      const ahead = mainHead ? await git(entry.path, ["rev-list", "--count", `${mainHead}..HEAD`]) : { ok: false };
      item.commits_ahead_of_main = ahead.ok ? Number(ahead.stdout.trim()) || 0 : null;
    }
    worktrees.push(item);
  }
  return { main_root: mainRoot, worktrees };
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
```

**Файл: `ai-dev-mcp-server/src/core/task-worktrees.test.mjs`** (106 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createTaskWorktree,
  listTaskWorktrees,
  parseWorktreeList,
  removeTaskWorktree,
  worktreeName
} from "./task-worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function repoFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-worktrees-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, ".ai-dev"), { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  await fs.writeFile(path.join(repo, "AGENTS.md"), "# AGENTS\n");
  await fs.writeFile(path.join(repo, ".ai-dev", "quality-gate.md"), "# Quality Gate\n\n- Tests: `node --test`\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "index.js"]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return await fs.realpath(repo);
}

test("worktreeName and parseWorktreeList normalise input", () => {
  assert.equal(worktreeName("Исправить форму: Login / Signup!"), "login-signup");
  assert.equal(worktreeName("task-20260910T111806-280cf829"), "task-20260910t111806-280cf829");
  assert.equal(worktreeName("!!!"), "task");
  const parsed = parseWorktreeList([
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/one",
    "HEAD def",
    "branch refs/heads/task/one",
    "locked",
    "",
    "worktree /repo/.worktrees/gone",
    "HEAD 000",
    "detached",
    "prunable gitdir file points to non-existent location",
    ""
  ].join("\n"));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1], { path: "/repo/.worktrees/one", head: "def", branch: "task/one", bare: false, detached: false, locked: true, prunable: false });
  assert.equal(parsed[2].prunable, true);
  assert.equal(parsed[2].detached, true);
});

test("create, list, and remove task worktrees with handoff files and dirty guard", async (t) => {
  const repo = await repoFixture(t);
  const created = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(created.created, true);
  assert.equal(created.branch, "task/login-form");
  assert.equal(created.path, path.join(repo, ".worktrees", "login-form"));
  assert.deepEqual(created.copied_files, ["AGENTS.md", ".ai-dev/quality-gate.md"]);
  assert.equal(runGit(created.path, ["branch", "--show-current"]), "task/login-form");
  assert.match(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8"), /^\/\.worktrees\/$/m);
  assert.equal(runGit(repo, ["status", "--porcelain"]).includes(".worktrees"), false, ".worktrees is excluded");

  const again = await createTaskWorktree({ projectRoot: repo, name: "login-form" });
  assert.equal(again.created, false);
  await assert.rejects(createTaskWorktree({ projectRoot: repo, name: "../escape" }), /Invalid worktree name/);

  // A worktree can be created from inside another worktree; it still lands under the main root.
  const nested = await createTaskWorktree({ projectRoot: created.path, name: "second", baseRef: "main" });
  assert.equal(nested.main_root, repo);
  assert.equal(nested.path, path.join(repo, ".worktrees", "second"));

  const listed = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.deepEqual(listed.worktrees.map((item) => item.name).sort(), ["login-form", "second"]);
  assert.equal(listed.worktrees.every((item) => item.dirty === false), true, "copied handoff files do not count as dirty");
  assert.equal(listed.worktrees.every((item) => item.commits_ahead_of_main === 0), true);
  await fs.writeFile(path.join(nested.path, "feature.js"), "export const f = 1;\n");
  runGit(nested.path, ["add", "feature.js"]);
  runGit(nested.path, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "feat: add"]);
  const ahead = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(ahead.worktrees.find((item) => item.name === "second").commits_ahead_of_main, 1);

  await fs.writeFile(path.join(created.path, "index.js"), "export const one = 2;\n");
  const dirtyList = await listTaskWorktrees({ projectRoot: repo, includeStatus: true });
  assert.equal(dirtyList.worktrees.find((item) => item.name === "login-form").dirty, true);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: created.path }), /uncommitted change/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: repo }), /main working tree/);
  await assert.rejects(removeTaskWorktree({ projectRoot: repo, worktreePath: path.join(repo, "nope") }), /Not a registered worktree/);

  const removed = await removeTaskWorktree({ projectRoot: repo, worktreePath: created.path, force: true, deleteBranch: true });
  assert.equal(removed.dirty_files, 1);
  assert.equal(removed.branch_deleted, true);
  assert.equal(await fs.access(created.path).then(() => true).catch(() => false), false);
  assert.equal(runGit(repo, ["branch", "--list", "task/login-form"]), "");
  const clean = await removeTaskWorktree({ projectRoot: repo, worktreePath: nested.path });
  assert.equal(clean.branch_deleted, false);
  assert.equal(runGit(repo, ["branch", "--list", "task/second"]).trim().endsWith("task/second"), true, "branch kept");
});
```

**Файл: `ai-dev-mcp-server/src/extensions/worktrees.mjs`** (154 строк)

```js
import path from "node:path";
import {
  TASK_BRANCH_PREFIX,
  WORKTREES_DIR,
  createTaskWorktree,
  listTaskWorktrees,
  removeTaskWorktree,
  worktreeName
} from "../core/task-worktrees.mjs";

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected tool result: ${text.slice(0, 200)}`);
  }
}

/**
 * Task worktree tools: one git worktree + branch per task so parallel tasks
 * never share a working tree, and the task record remembers where its code lives.
 *
 * @param {{ callTool: Function, taskStore: { read: Function, update: Function }, resolveProjectIdentity: Function }} host
 */
export function createWorktreeTools(host) {
  return {
    definitions: [
      {
        name: "begin_task_in_worktree",
        description: "Create an isolated git worktree and branch (task/<name> under .worktrees/) from base_ref, copy the agent handoff files into it, then start begin_task inside the worktree. Use for parallel or risky work so the main checkout stays untouched.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string", description: "Absolute path of the main repository (or any of its worktrees)." },
            task: { type: "string" },
            project_name: { type: "string" },
            acceptance_criteria: { type: "array", items: { type: "string" }, default: [] },
            base_ref: { type: "string", default: "HEAD", description: "Commit, branch, or tag the task branch starts from." },
            name: { type: "string", description: "Optional worktree/branch slug; derived from the task text when omitted." }
          },
          required: ["project_path", "task"]
        }
      },
      {
        name: "list_task_worktrees",
        description: "List task worktrees of a repository with branch, dirty state, and commits ahead of the main checkout.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            include_status: { type: "boolean", default: true }
          },
          required: ["project_path"]
        }
      },
      {
        name: "remove_task_worktree",
        description: "Remove a task worktree after its branch was merged or abandoned. Refuses while uncommitted changes exist unless force=true; optionally deletes the task branch.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task whose worktree is removed (from its record)." },
            worktree_path: { type: "string", description: "Explicit worktree path when no task id is available." },
            force: { type: "boolean", default: false },
            delete_branch: { type: "boolean", default: false }
          }
        }
      }
    ],
    handlers: {
      async begin_task_in_worktree(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const stamp = new Date().toISOString().replace(/\D/g, "").slice(4, 12);
        const name = args.name ? worktreeName(args.name) : `${worktreeName(args.task, 36)}-${stamp}`;
        const worktree = await createTaskWorktree({
          projectRoot: identity.project_root,
          name,
          baseRef: args.base_ref || "HEAD"
        });
        const begun = parseToolText(await host.callTool("begin_task", {
          project_path: worktree.path,
          task: args.task,
          project_name: args.project_name || "",
          acceptance_criteria: args.acceptance_criteria || []
        }));
        const record = await host.taskStore.update(begun.id, (current) => {
          current.context = {
            ...current.context,
            worktree: {
              path: worktree.path,
              branch: worktree.branch,
              base_ref: worktree.base_ref,
              main_root: worktree.main_root,
              created: worktree.created
            }
          };
          return current;
        });
        return {
          ...begun,
          context: record.context,
          worktree,
          next_actions: [
            `Work only inside ${worktree.path} (branch ${worktree.branch}); commit there.`,
            ...(begun.next_actions ?? []),
            "After complete_task, merge or open a PR from the task branch, then call remove_task_worktree."
          ]
        };
      },
      async list_task_worktrees(args) {
        const identity = await host.resolveProjectIdentity(args.project_path);
        const listed = await listTaskWorktrees({
          projectRoot: identity.project_root,
          includeStatus: args.include_status !== false
        });
        return {
          ...listed,
          worktrees_dir: WORKTREES_DIR,
          branch_prefix: TASK_BRANCH_PREFIX,
          count: listed.worktrees.length
        };
      },
      async remove_task_worktree(args) {
        let worktreePath = args.worktree_path ? path.resolve(args.worktree_path) : "";
        let record = null;
        if (args.task_id) {
          record = await host.taskStore.read(args.task_id);
          worktreePath = record.context?.worktree?.path || worktreePath;
          if (!worktreePath) throw new Error(`Task ${args.task_id} has no recorded worktree.`);
          if (record.status !== "complete" && !args.force) {
            throw new Error(`Task ${args.task_id} is ${record.status}; complete it first or pass force=true.`);
          }
        }
        if (!worktreePath) throw new Error("task_id or worktree_path is required.");
        const projectRoot = record?.context?.worktree?.main_root || path.dirname(path.dirname(worktreePath));
        const removed = await removeTaskWorktree({
          projectRoot,
          worktreePath,
          force: Boolean(args.force),
          deleteBranch: Boolean(args.delete_branch)
        });
        if (record) {
          await host.taskStore.update(record.id, (current) => {
            current.context = { ...current.context, worktree: { ...current.context.worktree, removed_at: new Date().toISOString() } };
            return current;
          });
        }
        return { action: "worktree_removed", task_id: record?.id || null, ...removed };
      }
    },
    readOnly: ["list_task_worktrees"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/worktrees.test.mjs`** (77 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createWorktreeTools } from "./worktrees.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("begin_task_in_worktree starts the task inside a fresh worktree and remove cleans it up", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "index.js"), "export const one = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const realRepo = await fs.realpath(repo);

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const calls = [];
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-test" }),
    async callTool(name, args) {
      calls.push({ name, args });
      const record = await taskStore.begin({
        task: args.task,
        project: { project_name: "fixture", project_path: args.project_path },
        skills: [],
        baseline: { fingerprint: "a" }
      });
      return { content: [{ type: "text", text: JSON.stringify({ ...record, next_actions: ["verify"] }) }] };
    }
  };
  const registry = createExtensionTools(host, [createWorktreeTools]);

  const begun = await registry.handlers.get("begin_task_in_worktree")({
    project_path: repo,
    task: "Add login form validation",
    name: "login-validation"
  });
  assert.equal(calls[0].name, "begin_task");
  assert.equal(calls[0].args.project_path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.equal(begun.worktree.branch, "task/login-validation");
  assert.equal(begun.context.worktree.path, path.join(realRepo, ".worktrees", "login-validation"));
  assert.match(begun.next_actions[0], /Work only inside/);
  assert.equal(runGit(begun.worktree.path, ["branch", "--show-current"]), "task/login-validation");

  const listed = await registry.handlers.get("list_task_worktrees")({ project_path: repo });
  assert.equal(listed.count, 1);
  assert.equal(listed.worktrees[0].name, "login-validation");

  await assert.rejects(
    registry.handlers.get("remove_task_worktree")({ task_id: begun.id }),
    /complete it first or pass force=true/
  );
  const removed = await registry.handlers.get("remove_task_worktree")({ task_id: begun.id, force: true, delete_branch: true });
  assert.equal(removed.branch, "task/login-validation");
  assert.equal(removed.branch_deleted, true);
  const record = await taskStore.read(begun.id);
  assert.ok(record.context.worktree.removed_at);
  assert.equal((await registry.handlers.get("list_task_worktrees")({ project_path: repo })).count, 0);
  await assert.rejects(registry.handlers.get("remove_task_worktree")({}), /task_id or worktree_path is required/);

  // Auto-generated names are derived from the task text plus a timestamp.
  const auto = await registry.handlers.get("begin_task_in_worktree")({ project_path: repo, task: "Починить форму логина" });
  assert.match(auto.worktree.branch, /^task\/[a-z0-9-]+-\d{8}$/);
});
```

## Изменения существующих файлов

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index 9239d92..a0696b0 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -8741,7 +8741,8 @@ async function completeTask({
       overwrite: true
     });
   }
-  return { task: record, report, skill_outcomes: skillOutcomes };
+  const worktree = record.context?.worktree && !record.context.worktree.removed_at ? record.context.worktree : null;
+  return { task: record, report, skill_outcomes: skillOutcomes, ...(worktree ? { worktree, next_step: `Merge or open a PR from ${worktree.branch}, then call remove_task_worktree.` } : {}) };
 }
 
 // Extension tools live in src/extensions/* and receive shared runtime services
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index 879c71d..8213d2d 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -23,11 +23,13 @@
 import { createDecisionTools } from "./extensions/decisions.mjs";
 import { createHygieneTools } from "./extensions/hygiene.mjs";
 import { createUsageTools } from "./extensions/usage.mjs";
+import { createWorktreeTools } from "./extensions/worktrees.mjs";
 
 export const EXTENSION_FACTORIES = [
   createDecisionTools,
   createHygieneTools,
-  createUsageTools
+  createUsageTools,
+  createWorktreeTools
 ];
 
 /**
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/task-worktrees.test.mjs src/extensions/worktrees.test.mjs
```

## Использование

```json
{ "tool": "begin_task_in_worktree", "args": { "project_path": "/repo",
  "task": "Add rate limiting to the login endpoint", "base_ref": "main" } }
```

Ответ: обычный результат `begin_task` плюс `worktree: { path, branch, name, base_ref }`.
Дальше все инструменты задачи используют `project_path` worktree (он же сохранён в задаче).

## Замечания

- Identity проекта (`project_id`) для worktree отличается от основного checkout, потому что
  вычисляется от realpath. Это сознательно: состояние задачи и контекст-пак привязаны к
  конкретному дереву. Закоммиченные `.ai-dev/decisions` и правила и так есть в worktree (это тот же репозиторий), а
  новые попадут обратно вместе с веткой после merge.
- `.worktrees/` исключён через `.git/info/exclude`, а не через `.gitignore`, чтобы не менять
  файлы репозитория.

## Для Argentum

Естественная единица изоляции для «одна задача = одна сессия `claude -p`»: воркспейс может
держать несколько задач по одному репозиторию одновременно и показывать их через
`list_task_worktrees`.

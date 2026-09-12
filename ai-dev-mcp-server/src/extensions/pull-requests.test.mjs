import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createPullRequestTools } from "./pull-requests.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeFile(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

/**
 * A repository with one commit on `main` and a task branch that changes a
 * source file, adds a test and deletes a file — the shape a pull request
 * usually has.
 */
async function fixtureRepo(t, { template = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await writeFile(repo, "src/report.js", "export const report = 1;\n");
  await writeFile(repo, "src/legacy.js", "export const legacy = 1;\n");
  if (template) await writeFile(repo, ".github/pull_request_template.md", template);
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  runGit(repo, ["checkout", "-q", "-b", "task/csv-export"]);
  await writeFile(repo, "src/report.js", "export const report = 2;\n");
  await writeFile(repo, "src/report.test.js", "test('report', () => {});\n");
  await fs.rm(path.join(repo, "src", "legacy.js"));
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", "feat(report): add CSV export"]);
  return { root, repo: await fs.realpath(repo) };
}

function hostFor(root, taskStore) {
  const written = [];
  return {
    written,
    host: {
      taskStore,
      resolveProjectIdentity: async (projectPath) => ({ project_root: await fs.realpath(projectPath), project_id: "project-test" }),
      async writeProjectFile(projectRoot, relative, content, overwrite) {
        await writeFile(projectRoot, relative, content);
        written.push({ projectRoot, relative, overwrite });
        return { action: "created", path: relative };
      },
      async readProjectTextIfExists(projectRoot, relative) {
        return fs.readFile(path.join(projectRoot, ...relative.split("/")), "utf8").catch(() => "");
      }
    }
  };
}

async function beginFixtureTask(taskStore, repo, overrides = {}) {
  const record = await taskStore.begin({
    task: "Add CSV export to the report screen",
    project: { project_name: "fixture", project_path: repo, project_types: ["api"] },
    skills: [{ name: "verification-loop" }],
    baseline: { fingerprint: "base" },
    ...overrides
  });
  await taskStore.checkpoint(record.id, {
    summary: "Export wired up",
    changedFiles: ["src/report.js"],
    criteria: record.acceptance_criteria.map((item) => ({ id: item.id, status: "met", evidence: ["verification-1"], note: "" }))
  });
  await taskStore.addVerification(record.id, {
    id: "verification-1",
    at: "2026-09-11T06:20:00.000Z",
    passed: true,
    checks: [
      { type: "quality_gate", result: { status: "passed", results: [{ label: "unit", command: "npm test", cwd: ".", status: "passed" }] } },
      { type: "change_hygiene", result: { status: "pass", findings: [], summary: { files_changed: 3, added_lines: 2, block: 0, warn: 0, info: 0 } } }
    ]
  });
  await taskStore.update(record.id, (current) => {
    current.status = "complete";
    current.completion = {
      at: "2026-09-11T06:30:00.000Z",
      summary: "Export ships behind the existing toolbar button.",
      verification_ids: ["verification-1"]
    };
    return current;
  });
  return taskStore.read(record.id);
}

test("prepare_pull_request fills the repository template and writes the description", async (t) => {
  const { root, repo } = await fixtureRepo(t, {
    template: [
      "<!-- Thanks for contributing! -->",
      "",
      "## What and why",
      "",
      "<!-- describe your change -->",
      "",
      "## Type",
      "",
      "- [ ] Bug fix",
      "- [ ] Feature",
      "",
      "## Testing",
      "",
      "<!-- how did you test this? -->",
      "- [ ] `npm run check` passes",
      ""
    ].join("\n")
  });
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const { host, written } = hostFor(root, taskStore);
  const registry = createExtensionTools(host, [createPullRequestTools]);
  assert.deepEqual(registry.definitions.map((item) => item.name), ["prepare_pull_request"]);
  assert.deepEqual(registry.readOnly, []);

  const task = await beginFixtureTask(taskStore, repo);
  await writeFile(repo, ".ai-dev/decisions/0001-stream-the-csv.md", [
    "---",
    "id: ADR-0001",
    'title: "Stream the CSV"',
    "status: accepted",
    `task: ${task.id}`,
    "---",
    "",
    "# ADR-0001: Stream the CSV",
    "",
    "## Decision",
    "",
    "Rows are streamed instead of buffered.",
    ""
  ].join("\n"));

  const result = await registry.handlers.get("prepare_pull_request")({ task_id: task.id });
  assert.equal(result.action, "pull_request_prepared");
  assert.equal(result.path, `.ai-dev/pr/${task.id}.md`);
  assert.equal(result.base_ref, "main");
  assert.equal(result.base_ref_source, "detected");
  assert.equal(result.branch, "task/csv-export");
  assert.equal(result.title, "feat(src): add CSV export to the report screen");
  assert.equal(result.template.found, true);
  assert.equal(result.template.path, ".github/pull_request_template.md");
  assert.deepEqual(result.template.filled, [
    { key: "summary", heading: "What and why" },
    { key: "test_plan", heading: "Testing" }
  ]);
  assert.deepEqual(result.template.kept, ["Type"]);
  assert.ok(result.template.appended.includes("acceptance"));
  assert.deepEqual(result.outstanding, []);
  assert.deepEqual(result.decisions, ["ADR-0001"]);
  assert.deepEqual(result.checks, [{ type: "quality_gate", status: "passed" }, { type: "change_hygiene", status: "pass" }]);
  assert.deepEqual(result.checks_not_run, ["frontend_qa"]);
  // The recorded decision is an untracked file that belongs with the code, so
  // it is part of the change; the generated description under .ai-dev/pr is not.
  assert.deepEqual(
    result.changed_files.groups.map((group) => [group.id, group.files]),
    [
      ["tests", ["src/report.test.js"]],
      ["docs", [".ai-dev/decisions/0001-stream-the-csv.md"]],
      ["source", ["src/legacy.js", "src/report.js"]]
    ]
  );
  assert.deepEqual(result.commands, [
    "git push -u origin task/csv-export",
    `gh pr create --base main --head task/csv-export --title "feat(src): add CSV export to the report screen" --body-file .ai-dev/pr/${task.id}.md`
  ]);

  // The template's own headings and checklists survive; the evidence fills them.
  assert.match(result.body, /^## What and why\n\nAdd CSV export to the report screen\n/);
  assert.ok(!result.body.includes("<!--"), "template instructions are stripped");
  assert.match(result.body, /## Type\n\n- \[ \] Bug fix\n- \[ \] Feature/);
  assert.match(result.body, /## Testing\n\n[\s\S]*- `npm test` — passed\n\n- \[ \] `npm run check` passes/);
  assert.match(result.body, /## Acceptance criteria\n\n\| ID \| Status \| Criterion \| Evidence \|/);
  assert.match(result.body, /\*\*Commits\*\* \(1\)\n\n- `[0-9a-f]+` feat\(report\): add CSV export/);
  assert.match(result.body, /\*\*ADR-0001 Stream the CSV\*\* \(accepted\) — Rows are streamed instead of buffered\./);
  assert.ok(!/## Outstanding/.test(result.body), "nothing is outstanding for a fully met task");

  assert.deepEqual(written.map((item) => item.relative), [`.ai-dev/pr/${task.id}.md`]);
  assert.equal(written[0].overwrite, true);
  assert.equal(await fs.readFile(path.join(repo, ".ai-dev", "pr", `${task.id}.md`), "utf8"), result.body);
  assert.equal(runGit(repo, ["status", "--porcelain=v1", "--", "src"]), "", "the tool changes no tracked source file");
});

test("prepare_pull_request renders its own sections when the repository has no template", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const { host } = hostFor(root, taskStore);
  const registry = createExtensionTools(host, [createPullRequestTools]);
  const task = await beginFixtureTask(taskStore, repo);
  const decision = (id, taskLine) => [
    "---",
    `id: ADR-${id}`,
    `title: "Decision ${id}"`,
    "status: accepted",
    ...(taskLine ? [`task: ${taskLine}`] : []),
    "---",
    "",
    "## Decision",
    "",
    `Decision ${id} body.`,
    ""
  ].join("\n");
  // Untagged but part of this change: it is an untracked file in the diff.
  await writeFile(repo, ".ai-dev/decisions/0001-untagged.md", decision("0001", ""));
  // Another task's decision is context, not this pull request's content.
  await writeFile(repo, ".ai-dev/decisions/0002-other-task.md", decision("0002", "task-20260101T000000-0000beef"));

  const result = await registry.handlers.get("prepare_pull_request")({ task_id: task.id, base_ref: "main" });
  assert.deepEqual(result.decisions, ["ADR-0001"]);
  assert.match(result.body, /## Decisions\n\n- \*\*ADR-0001 Decision 0001\*\* \(accepted\) — Decision 0001 body\./);
  assert.ok(!result.body.includes("ADR-0002"), "another task's decision stays out");
  assert.equal(result.base_ref_source, "requested");
  assert.equal(result.template.found, false);
  assert.equal(result.template.path, "");
  assert.match(result.body, /^## Summary\n\nAdd CSV export to the report screen\n/);
  assert.match(result.body, /## Changed files\n\n5 file\(s\) changed against `main`\./);
  assert.match(result.body, /## Verification\n\nLatest run `verification-1`/);
  assert.match(result.body, /## Checkpoints\n\n- `[^`]+` — Export wired up \(1 file\(s\)\)/);
  assert.deepEqual(
    result.template.appended,
    ["summary", "changes", "acceptance", "verification", "test_plan", "decisions", "checkpoints", "hygiene"]
  );
  assert.match(result.next_step, /Review \.ai-dev\/pr\//);

  await assert.rejects(
    registry.handlers.get("prepare_pull_request")({ task_id: task.id, base_ref: "no-such-branch" }),
    /base_ref does not resolve/
  );
});

test("prepare_pull_request lists unmet criteria under Outstanding and can skip the file", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const { host, written } = hostFor(root, taskStore);
  const registry = createExtensionTools(host, [createPullRequestTools]);
  const record = await taskStore.begin({
    task: "Add CSV export to the report screen",
    project: { project_name: "fixture", project_path: repo, project_types: ["api"] },
    skills: [],
    acceptanceCriteria: ["Export is documented in the README"],
    baseline: { fingerprint: "base" }
  });
  await taskStore.checkpoint(record.id, {
    summary: "Export wired up, docs still missing",
    changedFiles: ["src/report.js"],
    criteria: [{ id: "AC-1", status: "blocked", note: "README rewrite lands separately", evidence: [] }]
  });
  await taskStore.addVerification(record.id, {
    id: "verification-2",
    at: "2026-09-11T06:25:00.000Z",
    passed: false,
    checks: [
      { type: "quality_gate", result: { status: "failed" } },
      { type: "change_hygiene", result: { status: "block", findings: [{ rule: "secret:aws", severity: "block", file: "src/report.js", line: 3, message: "AWS key in an added line.", excerpt: "" }], summary: { files_changed: 3, added_lines: 2, block: 1, warn: 0, info: 0 } } }
    ]
  });

  const result = await registry.handlers.get("prepare_pull_request")({ task_id: record.id, write_file: false });
  const open = await taskStore.read(record.id);
  assert.equal(result.file.action, "skipped");
  assert.deepEqual(written, []);
  // Every criterion is still unmet (AC-1 blocked, the rest pending), plus the
  // failed verification, the blocking hygiene finding and the unfinished task.
  assert.equal(result.outstanding.length, open.acceptance_criteria.length + 3);
  assert.match(result.outstanding[0], /\*\*AC-1\*\* \(blocked\): Export is documented in the README — README rewrite lands separately/);
  assert.ok(result.outstanding.some((item) => /verification-2` failed: `quality_gate` failed, `change_hygiene` block/.test(item)));
  assert.ok(result.outstanding.some((item) => /Change hygiene blocks on 1 finding/.test(item)));
  assert.ok(result.outstanding.some((item) => /still `active`/.test(item)));
  assert.match(result.body, /## Outstanding\n\n- \*\*AC-1\*\* \(blocked\)/);
  assert.match(result.body, /## Change hygiene\n\nStatus: block/);
  assert.match(result.next_step, new RegExp(`${result.outstanding.length} item\\(s\\) are still open`));
  await assert.rejects(fs.stat(path.join(repo, ".ai-dev", "pr")), /ENOENT/);
});

test("prepare_pull_request describes a worktree task against the branch it was cut from", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  runGit(repo, ["checkout", "-q", "main"]);
  const worktree = path.join(repo, ".worktrees", "csv-export");
  runGit(repo, ["worktree", "add", "-q", "-b", "task/csv-export-wt", worktree, "main"]);
  await writeFile(worktree, "src/report.js", "export const report = 3;\n");
  runGit(worktree, ["add", "-A"]);
  runGit(worktree, ["commit", "-q", "-m", "feat(report): export rows"]);
  await writeFile(worktree, "src/uncommitted.js", "export const pending = 1;\n");

  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const { host } = hostFor(root, taskStore);
  const registry = createExtensionTools(host, [createPullRequestTools]);
  const task = await beginFixtureTask(taskStore, worktree);
  await taskStore.update(task.id, (current) => {
    current.context = {
      ...current.context,
      worktree: { path: worktree, branch: "task/csv-export-wt", base_ref: "main", main_root: repo, created: true }
    };
    return current;
  });

  const result = await registry.handlers.get("prepare_pull_request")({ task_id: task.id });
  assert.equal(result.base_ref, "main");
  assert.equal(result.branch, "task/csv-export-wt");
  assert.equal(result.project_path, await fs.realpath(worktree));
  assert.deepEqual(result.changed_files.groups.map((group) => group.files).flat(), ["src/report.js", "src/uncommitted.js"]);
  assert.match(result.body, /Prepared in the task worktree/);
  assert.match(result.body, /- `src\/uncommitted\.js` — added/);
  assert.equal(
    await fs.readFile(path.join(worktree, ".ai-dev", "pr", `${task.id}.md`), "utf8"),
    result.body,
    "the description is written inside the worktree, next to the branch it describes"
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildPullRequestSections,
  collectPullRequestChanges,
  groupChangedFiles,
  outstandingItems,
  parseNameStatus,
  prRelativePath,
  pullRequestCommands,
  pullRequestTitle,
  pullRequestType,
  resolveBaseRef,
  scopeFromFiles
} from "./pull-request.mjs";

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function taskFixture(overrides = {}) {
  return {
    id: "task-20260911T060000-abcdef12",
    status: "complete",
    task: "Add CSV export to the report screen",
    risk: "medium",
    project: { name: "fixture", path: "/tmp/fixture", types: ["frontend"] },
    skills: [{ name: "verification-loop" }],
    context: {},
    plan: null,
    acceptance_criteria: [
      { id: "AC-1", text: "CSV export works", status: "met", evidence: ["verification-1"], note: "" },
      { id: "AC-2", text: "Relevant automated checks pass", status: "pending", evidence: [], note: "gate never ran" }
    ],
    checkpoints: [{ at: "2026-09-11T06:10:00.000Z", summary: "Export wired up", changed_files: ["src/export.js"], notes: "" }],
    verifications: [{
      id: "verification-1",
      at: "2026-09-11T06:20:00.000Z",
      passed: true,
      checks: [
        { type: "quality_gate", result: { status: "passed", results: [{ label: "unit", command: "npm test", cwd: ".", status: "passed" }] } },
        { type: "change_hygiene", result: { status: "warn", findings: [{ rule: "console_log", severity: "warn", file: "src/export.js", line: 12, message: "console.log left in non-test code." }], summary: { files_changed: 1, added_lines: 4, block: 0, warn: 1, info: 0 } } }
      ]
    }],
    completion: { at: "2026-09-11T06:30:00.000Z", summary: "Export ships behind the existing toolbar button." },
    ...overrides
  };
}

test("parseNameStatus reads adds, deletes and renames", () => {
  assert.deepEqual(
    parseNameStatus("A\tsrc/a.js\nD\tsrc/b.js\nR094\tsrc/old.js\tsrc/new.js\n\n"),
    [
      { path: "src/a.js", status: "added" },
      { path: "src/b.js", status: "deleted" },
      { path: "src/new.js", status: "renamed", from: "src/old.js" }
    ]
  );
});

test("groupChangedFiles sorts files into the documented groups", () => {
  const groups = groupChangedFiles([
    { path: "src/core/export.mjs", status: "modified" },
    { path: "src/core/export.test.mjs", status: "added" },
    { path: "docs/TOOLS.md", status: "modified" },
    { path: ".github/workflows/ci.yml", status: "modified" },
    { path: "package.json", status: "modified" },
    { path: "web/logo.svg", status: "added" }
  ]);
  assert.deepEqual(groups.map((group) => [group.id, group.files.map((file) => file.path)]), [
    ["tests", ["src/core/export.test.mjs"]],
    ["ci", [".github/workflows/ci.yml"]],
    ["docs", ["docs/TOOLS.md"]],
    ["config", ["package.json"]],
    ["assets", ["web/logo.svg"]],
    ["source", ["src/core/export.mjs"]]
  ]);
});

test("pullRequestType and scopeFromFiles read the task and the diff", () => {
  assert.equal(pullRequestType("Fix the broken CSV export"), "fix");
  assert.equal(pullRequestType("Document the new tool"), "docs");
  assert.equal(pullRequestType("Add CSV export"), "feat");
  assert.equal(pullRequestType("Speed up the report query"), "perf");
  assert.equal(pullRequestType("Исправь падение экспорта"), "fix");
  assert.equal(pullRequestType("Upgrade the pinned dependencies"), "chore");

  assert.equal(scopeFromFiles(["server/src/core/a.mjs", "server/src/core/b.mjs"]), "core");
  assert.equal(scopeFromFiles(["src/core/a.mjs", "src/api/b.mjs", "src/core/c.mjs"]), "core");
  assert.equal(scopeFromFiles(["src/core/a.mjs", "src/api/b.mjs", "web/c.js", "cli/d.js"]), "");
  assert.equal(scopeFromFiles(["README.md"]), "");
  assert.equal(scopeFromFiles([]), "");
});

test("pullRequestTitle builds a conventional title within the length budget", () => {
  assert.equal(
    pullRequestTitle({ task: "Add CSV export to the report screen.", files: ["src/report/export.js", "src/report/export.test.js"] }),
    "feat(report): add CSV export to the report screen"
  );
  assert.equal(pullRequestTitle({ task: "Add CSV export", files: [], type: "chore", scope: "build" }), "chore(build): add CSV export");
  const long = pullRequestTitle({
    task: "Add a CSV export button to the report screen and stream the rows straight to the browser",
    files: []
  });
  assert.ok(long.length <= 72, long);
  assert.ok(long.startsWith("feat: add a CSV export button to the report screen"), long);
  assert.ok(!/[\s,;:-]$/.test(long), long);
  assert.equal(pullRequestTitle({ task: "   ", files: [] }), "feat: update");
});

test("outstandingItems reports unmet criteria, a missing verification and blocking hygiene", () => {
  const record = taskFixture({ status: "active", verifications: [], completion: null });
  const items = outstandingItems(record, { findings: [{ severity: "block", rule: "secret:aws" }] });
  assert.equal(items.length, 4);
  assert.match(items[0], /\*\*AC-2\*\* \(pending\): Relevant automated checks pass — gate never ran/);
  assert.match(items[1], /No verification is recorded/);
  assert.match(items[2], /Change hygiene blocks on 1 finding/);
  assert.match(items[3], /still `active`/);

  const failed = outstandingItems(
    taskFixture({ verifications: [{ id: "verification-9", at: "x", passed: false, checks: [{ type: "quality_gate", result: { status: "failed" } }] }] }),
    null
  );
  assert.match(failed.find((item) => item.includes("verification-9")), /failed: `quality_gate` failed/);
});

test("buildPullRequestSections turns a task record into reviewable sections", () => {
  const record = taskFixture();
  const changes = {
    git: true,
    base_ref: "main",
    branch: "task/csv-export",
    head: "abc1234",
    files: [{ path: "src/export.js", status: "modified" }, { path: "src/export.test.js", status: "added" }],
    commits: [{ hash: "abc1234", subject: "feat(export): add CSV" }],
    truncated: false
  };
  const built = buildPullRequestSections({
    record,
    decisions: [{ id: "ADR-0001", title: "Stream the CSV", status: "accepted", decision: "Rows are streamed.\nMore detail.", path: ".ai-dev/decisions/0001-stream-the-csv.md" }],
    plan: { overview: "Export in three phases.", testing_strategy: "Unit tests per phase.", phases: [{ title: "Wire the button", steps: [{ action: "a" }], tests: ["export unit test"] }] },
    changes,
    baseRef: "main"
  });
  const byKey = Object.fromEntries(built.sections.map((section) => [section.key, section.lines.join("\n")]));

  assert.match(byKey.summary, /Add CSV export to the report screen/);
  assert.match(byKey.summary, /Export ships behind the existing toolbar button/);
  assert.match(byKey.summary, /Branch `task\/csv-export` against `main`/);
  assert.match(byKey.summary, /Skills routed: `verification-loop`/);
  assert.match(byKey.changes, /2 file\(s\) changed against `main`/);
  assert.match(byKey.changes, /\*\*Tests\*\* \(1\)\n\n- `src\/export\.test\.js` — added/);
  assert.match(byKey.changes, /\*\*Commits\*\* \(1\)\n\n- `abc1234` feat\(export\): add CSV/);
  assert.match(byKey.acceptance, /\| AC-1 \| met \| CSV export works \| `verification-1` \|/);
  assert.match(byKey.acceptance, /\| AC-2 \| pending \| Relevant automated checks pass — gate never ran \| — \|/);
  assert.match(byKey.outstanding, /- \*\*AC-2\*\* \(pending\)/);
  assert.match(byKey.verification, /Latest run `verification-1` at 2026-09-11T06:20:00\.000Z: \*\*passed\*\*/);
  assert.match(byKey.verification, /\| `quality_gate` \| passed \|/);
  assert.match(byKey.verification, /Not run: `frontend_qa`/);
  assert.match(byKey.test_plan, /Unit tests per phase/);
  assert.match(byKey.test_plan, /- \*\*Wire the button\*\* — export unit test/);
  assert.match(byKey.test_plan, /- `npm test` — passed/);
  assert.match(byKey.decisions, /\*\*ADR-0001 Stream the CSV\*\* \(accepted\) — Rows are streamed\./);
  assert.match(byKey.plan, /Export in three phases/);
  assert.match(byKey.checkpoints, /- `2026-09-11T06:10:00\.000Z` — Export wired up \(1 file\(s\)\)/);
  assert.match(byKey.hygiene, /Status: warn/);
  assert.match(byKey.hygiene, /console_log/);

  assert.deepEqual(built.checks, [{ type: "quality_gate", status: "passed" }, { type: "change_hygiene", status: "warn" }]);
  assert.deepEqual(built.checks_not_run, ["frontend_qa"]);
  assert.equal(built.outstanding.length, 1);
});

test("buildPullRequestSections falls back to checkpoint files and stays empty where there is nothing to say", () => {
  const record = taskFixture({
    plan: null,
    verifications: [],
    completion: null,
    status: "active",
    checkpoints: [{ at: "2026-09-11T06:10:00.000Z", summary: "", changed_files: ["src/a.js", "src/b.js"], notes: "" }]
  });
  const built = buildPullRequestSections({
    record,
    changes: { git: false, base_ref: "", branch: "", head: "", files: [], commits: [], truncated: false }
  });
  const byKey = Object.fromEntries(built.sections.map((section) => [section.key, section.lines]));
  assert.match(byKey.changes.join("\n"), /No Git diff was available/);
  assert.match(byKey.changes.join("\n"), /- `src\/a\.js`/);
  assert.deepEqual(byKey.decisions, []);
  assert.deepEqual(byKey.plan, []);
  assert.deepEqual(byKey.test_plan, []);
  assert.deepEqual(byKey.hygiene, []);
  assert.match(byKey.verification.join("\n"), /No verification run is recorded/);
  assert.match(byKey.checkpoints.join("\n"), /\(no summary\)/);
});

test("pullRequestCommands returns push and create commands without running anything", () => {
  assert.deepEqual(
    pullRequestCommands({ branch: "task/csv", baseRef: "origin/main", title: "feat: add CSV", bodyPath: ".ai-dev/pr/task-1.md" }),
    ["git push -u origin task/csv", 'gh pr create --base main --head task/csv --title "feat: add CSV" --body-file .ai-dev/pr/task-1.md']
  );
  assert.match(pullRequestCommands({ branch: "", baseRef: "", title: "x", bodyPath: "p" })[0], /<branch>/);
  assert.equal(prRelativePath("task-1"), ".ai-dev/pr/task-1.md");
});

test("resolveBaseRef and collectPullRequestChanges read a real repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-changes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src", "keep.js"), "export const keep = 1;\n");
  await fs.writeFile(path.join(repo, "src", "drop.js"), "export const drop = 1;\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  runGit(repo, ["checkout", "-q", "-b", "task/export"]);
  await fs.writeFile(path.join(repo, "src", "keep.js"), "export const keep = 2;\n");
  await fs.rm(path.join(repo, "src", "drop.js"));
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", "feat(export): rework"]);
  await fs.writeFile(path.join(repo, "src", "new.js"), "export const added = 1;\n");
  await fs.mkdir(path.join(repo, ".ai-dev", "pr"), { recursive: true });
  await fs.writeFile(path.join(repo, ".ai-dev", "pr", "task-1.md"), "generated\n");

  const base = await resolveBaseRef({ projectRoot: repo });
  assert.equal(base.base_ref, "main");
  assert.equal(base.source, "detected");
  assert.equal((await resolveBaseRef({ projectRoot: repo, requested: "main" })).source, "requested");
  assert.equal((await resolveBaseRef({ projectRoot: repo, candidates: ["HEAD"] })).base_ref, "main");
  await assert.rejects(resolveBaseRef({ projectRoot: repo, requested: "no-such-ref" }), /does not resolve/);

  const changes = await collectPullRequestChanges({ projectRoot: repo, baseRef: "main" });
  assert.equal(changes.git, true);
  assert.equal(changes.branch, "task/export");
  assert.deepEqual(changes.files, [
    { path: "src/drop.js", status: "deleted" },
    { path: "src/keep.js", status: "modified" },
    { path: "src/new.js", status: "added" }
  ]);
  assert.deepEqual(changes.commits.map((commit) => commit.subject), ["feat(export): rework"]);

  const capped = await collectPullRequestChanges({ projectRoot: repo, baseRef: "main", maxFiles: 1 });
  assert.equal(capped.total, 3);
  assert.equal(capped.files.length, 1);
  assert.equal(capped.truncated, true);
  const cappedSection = buildPullRequestSections({ record: taskFixture(), changes: capped, baseRef: "main" })
    .sections.find((section) => section.key === "changes");
  assert.match(cappedSection.lines[0], /^3 file\(s\) changed against `main`; the first 1 are listed\.$/);

  const outside = await collectPullRequestChanges({ projectRoot: root });
  assert.equal(outside.git, false);
  assert.deepEqual((await resolveBaseRef({ projectRoot: root })).base_ref, "");
});

import path from "node:path";
import { IGNORED_CHANGE_PATH, renderChangeHygieneMarkdown } from "./change-hygiene.mjs";
import { runProcess } from "./process-runner.mjs";

/**
 * Pull-request description built from a task's own evidence.
 *
 * Everything a reviewer needs is already recorded by the task lifecycle:
 * the goal, the acceptance criteria and their status, the checkpoints, the
 * verification runs with the checks they executed, the decisions taken along
 * the way and the plan the work followed. This module turns that record plus
 * the repository's diff into the sections of a pull-request body. It reads
 * git, writes nothing, and never talks to a forge: the text is the deliverable.
 */

export const PR_RELATIVE_DIR = ".ai-dev/pr";

/** Checks `verify_task` can run for any task, so their absence is worth stating. */
export const REPORTED_CHECKS = Object.freeze(["quality_gate", "change_hygiene", "frontend_qa"]);

/** Changed-file groups, first match wins. */
export const FILE_GROUPS = Object.freeze([
  { id: "tests", title: "Tests", pattern: /(?:^|\/)(?:tests?|__tests__|spec|e2e)\/|\.(?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rb)$/i },
  { id: "ci", title: "CI and automation", pattern: /(?:^|\/)\.github\/|(?:^|\/)\.gitlab-ci\.yml$|(?:^|\/)(?:Jenkinsfile|Makefile)$|(?:^|\/)scripts?\//i },
  { id: "docs", title: "Docs", pattern: /\.(?:md|mdx|rst|adoc|txt)$|(?:^|\/)docs?\//i },
  { id: "config", title: "Configuration", pattern: /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.(?:ya?ml|toml|ini|cfg|conf)|\.[^/]*rc(?:\.[a-z]+)?|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/i },
  { id: "assets", title: "Assets", pattern: /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm|css|scss|less)$/i },
  { id: "source", title: "Source", pattern: /./ }
]);

/**
 * Conventional-commit type, first match wins; `feat` is the default. English
 * words are bounded so "document" is not read as "doc"; Russian stems are
 * prefixes, because JavaScript word boundaries are ASCII-only.
 */
export const TYPE_PATTERNS = Object.freeze([
  ["fix", /\b(?:fix(?:es|ed)?|bug(?:fix)?|broken|regression|crash)\b|исправ|почин|баг|ошибк/i],
  ["docs", /\b(?:docs?|document(?:s|ed|ation)?|readme|changelog)\b|документ/i],
  ["test", /\b(?:tests?|testing|coverage)\b|тест|покрыти/i],
  ["refactor", /\b(?:refactor(?:ing)?|cleanup|clean up|simplify|rename|extract)\b|рефактор|упрост|вынес/i],
  ["perf", /\b(?:perf|performance|optimi[sz]\w*|speed up|faster|latency)\b|производительн|ускор/i],
  ["ci", /\b(?:ci|pipeline|workflow|github actions)\b/i],
  ["build", /\b(?:build|bundle|packaging|docker|release)\b|сборк|упаковк/i],
  ["chore", /\b(?:chore|bump|upgrade|dependenc(?:y|ies))\b|зависимост/i]
]);

const GENERIC_DIRS = new Set(["src", "lib", "app", "source", "sources", "packages", "pkg"]);
const MAX_FILES_PER_GROUP = 40;
const MAX_COMMITS = 20;
const MAX_CHECKPOINTS = 12;
const MAX_HYGIENE_FINDINGS = 15;

/**
 * @param {string} taskId
 * @returns {string} Repository-relative path of the prepared description.
 */
export function prRelativePath(taskId) {
  return `${PR_RELATIVE_DIR}/${taskId}.md`;
}

async function git(projectRoot, args, { timeoutMs = 30_000 } = {}) {
  return runProcess({
    executable: "git",
    args: ["-C", path.resolve(projectRoot), "-c", "core.quotepath=false", ...args],
    cwd: projectRoot,
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024
  }).catch(() => ({ ok: false, exitCode: null, stdout: "", stderr: "" }));
}

function unquote(value) {
  const text = String(value).trim();
  return /^".*"$/.test(text) ? text.slice(1, -1).replace(/\\(.)/g, "$1") : text;
}

const NAME_STATUS = Object.freeze({ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "retyped", U: "unmerged" });

/**
 * Parse `git diff --name-status` output into `{ path, status, from }` entries.
 *
 * @param {string} text
 * @returns {Array<{ path: string, status: string, from?: string }>}
 */
export function parseNameStatus(text) {
  const entries = [];
  for (const line of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0].trim();
    const status = NAME_STATUS[code[0]] || "modified";
    if ((code[0] === "R" || code[0] === "C") && parts.length >= 3) {
      entries.push({ path: unquote(parts[2]), status, from: unquote(parts[1]) });
      continue;
    }
    if (parts.length >= 2) entries.push({ path: unquote(parts[1]), status });
  }
  return entries;
}

/**
 * Pick the branch a pull request should target.
 *
 * An explicit `requested` ref must resolve or the call fails — silently
 * describing a change against the wrong base is worse than an error. Otherwise
 * the task's worktree base is tried first (unless it is the useless literal
 * `HEAD`), then the remote default branch, then `main` and `master`.
 *
 * @param {{ projectRoot: string, requested?: string, candidates?: string[] }} input
 * @returns {Promise<{ base_ref: string, commit: string, source: "requested" | "detected" | "none", tried: string[] }>}
 */
export async function resolveBaseRef({ projectRoot, requested = "", candidates = [] }) {
  const verify = async (ref) => {
    const result = await git(projectRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.ok ? result.stdout.trim() : "";
  };
  if (requested) {
    const commit = await verify(requested);
    if (!commit) throw new Error(`base_ref does not resolve in this repository: ${requested}`);
    return { base_ref: requested, commit, source: "requested", tried: [requested] };
  }
  const tried = [];
  for (const ref of [...candidates, "origin/HEAD", "origin/main", "main", "origin/master", "master"]) {
    if (!ref || ref === "HEAD" || tried.includes(ref)) continue;
    tried.push(ref);
    const commit = await verify(ref);
    if (commit) return { base_ref: ref, commit, source: "detected", tried };
  }
  return { base_ref: "", commit: "", source: "none", tried };
}

/**
 * Read the change set a pull request would carry: every file that differs from
 * `baseRef` (committed or not), plus untracked files, plus the commits on top
 * of the base. Server-generated paths under `.ai-dev/` are left out — they are
 * not part of the change under review.
 *
 * @param {{ projectRoot: string, baseRef?: string, maxFiles?: number }} input
 * @returns {Promise<{ git: boolean, base_ref: string, branch: string, head: string, files: Array<{ path: string, status: string, from?: string }>, total: number, commits: Array<{ hash: string, subject: string }>, truncated: boolean }>}
 */
export async function collectPullRequestChanges({ projectRoot, baseRef = "", maxFiles = 200 }) {
  const empty = { git: false, base_ref: baseRef, branch: "", head: "", files: [], total: 0, commits: [], truncated: false };
  const inside = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return empty;
  const [branch, head] = await Promise.all([
    git(projectRoot, ["branch", "--show-current"]),
    git(projectRoot, ["rev-parse", "--short", "HEAD"])
  ]);
  const files = new Map();
  if (baseRef) {
    const diff = await git(projectRoot, ["diff", "--name-status", "--find-renames", baseRef, "--"]);
    if (diff.ok) {
      for (const entry of parseNameStatus(diff.stdout)) files.set(entry.path, entry);
    }
  }
  const status = await git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.ok) {
    for (const line of status.stdout.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const filePath = unquote(line.slice(3).split(" -> ").at(-1));
      if (!filePath || files.has(filePath)) continue;
      files.set(filePath, { path: filePath, status: code === "??" ? "added" : code.includes("D") ? "deleted" : "modified" });
    }
  }
  const commits = [];
  if (baseRef) {
    const log = await git(projectRoot, ["log", "--no-merges", "--format=%h%x09%s", `${baseRef}..HEAD`]);
    if (log.ok) {
      for (const line of log.stdout.split("\n")) {
        const [hash, ...subject] = line.split("\t");
        if (hash?.trim() && subject.length) commits.push({ hash: hash.trim(), subject: subject.join("\t").trim() });
      }
    }
  }
  const all = [...files.values()]
    .filter((item) => !IGNORED_CHANGE_PATH.test(item.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const limit = Math.max(1, Math.min(Number(maxFiles) || 200, 2000));
  return {
    git: true,
    base_ref: baseRef,
    branch: branch.ok ? branch.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    files: all.slice(0, limit),
    total: all.length,
    commits: commits.slice(0, MAX_COMMITS),
    truncated: all.length > limit
  };
}

/**
 * @param {Array<{ path: string, status?: string }>} files
 * @returns {Array<{ id: string, title: string, files: Array<{ path: string, status?: string }> }>} Non-empty groups in `FILE_GROUPS` order.
 */
export function groupChangedFiles(files) {
  const groups = new Map(FILE_GROUPS.map((group) => [group.id, []]));
  for (const file of files) {
    const group = FILE_GROUPS.find((item) => item.pattern.test(file.path)) ?? FILE_GROUPS.at(-1);
    groups.get(group.id).push(file);
  }
  return FILE_GROUPS
    .filter((group) => groups.get(group.id).length)
    .map((group) => ({ id: group.id, title: group.title, files: groups.get(group.id) }));
}

/**
 * @param {string} task - Task text.
 * @returns {string} Conventional-commit type.
 */
export function pullRequestType(task) {
  const text = String(task || "");
  for (const [type, pattern] of TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return "feat";
}

/**
 * Derive a conventional-commit scope from the changed files: drop the directory
 * prefix every file shares, drop generic wrappers (`src`, `lib`, …), and take
 * the directory that at least half of the remaining files sit under. Returns
 * `""` when the change is too scattered for one honest scope.
 *
 * @param {string[]} files - Repository-relative paths.
 * @returns {string}
 */
export function scopeFromFiles(files) {
  const paths = files.map((item) => String(item).replaceAll("\\", "/")).filter(Boolean);
  if (!paths.length) return "";
  const split = paths.map((item) => item.split("/").filter(Boolean));
  let shared = 0;
  while (split.every((segments) => segments.length > shared + 1 && segments[shared] === split[0][shared])) shared += 1;
  const counts = new Map();
  let candidates = 0;
  for (const segments of split) {
    const last = segments.length - 1;
    let index = 0;
    while (index < last && (index < shared || GENERIC_DIRS.has(segments[index].toLowerCase()))) index += 1;
    // Never skip past the directory the file sits in: a shared prefix that
    // covers the whole path is the scope, not something to strip.
    if (index >= last) index = last - 1;
    if (index < 0) continue;
    const candidate = segments[index].toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    if (!candidate) continue;
    candidates += 1;
    counts.set(candidate, (counts.get(candidate) || 0) + 1);
  }
  if (!candidates) return "";
  const [best, count] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  return count * 2 >= candidates ? best : "";
}

/**
 * Build a conventional-commit pull-request title: `type(scope): subject`,
 * lower-case after the colon, no trailing period, at most `maxLength`
 * characters — the shape `commitlint` and this project's own commit rule ask
 * for.
 *
 * @param {{ task: string, files?: string[], type?: string, scope?: string, maxLength?: number }} input
 * @returns {string}
 */
export function pullRequestTitle({ task, files = [], type = "", scope = "", maxLength = 72 }) {
  const kind = String(type || "").trim() || pullRequestType(task);
  const area = scope === "" ? scopeFromFiles(files) : String(scope).trim();
  const prefix = area ? `${kind}(${area}): ` : `${kind}: `;
  let subject = String(task || "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (subject && !/^[A-Z][a-z]*[A-Z]/.test(subject) && !/^\S*[._/]/.test(subject)) {
    subject = subject[0].toLowerCase() + subject.slice(1);
  }
  const room = Math.max(12, maxLength - prefix.length);
  if (subject.length > room) {
    const cut = subject.slice(0, room);
    const boundary = cut.lastIndexOf(" ");
    subject = (boundary > room * 0.5 ? cut.slice(0, boundary) : cut).replace(/[\s,;:-]+$/, "");
  }
  return `${prefix}${subject || "update"}`;
}

function cell(text) {
  return String(text ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function statusLabel(check) {
  return check?.result?.status || check?.result?.gate || (check?.result?.ok === true ? "ok" : check?.result?.ok === false ? "failed" : "unknown");
}

function summaryLines(record, changes, baseRef) {
  const lines = [String(record.task || "").trim()];
  const completion = String(record.completion?.summary || "").trim();
  if (completion) lines.push("", completion);
  const facts = [`- Task \`${record.id}\` — status \`${record.status}\`, risk \`${record.risk}\`.`];
  if (changes.branch || baseRef) {
    facts.push(`- Branch \`${changes.branch || "(detached)"}\`${baseRef ? ` against \`${baseRef}\`` : ""}.`);
  }
  if (record.context?.worktree?.path) facts.push(`- Prepared in the task worktree \`${record.context.worktree.path}\`.`);
  const skills = (record.skills || []).map((item) => item?.name).filter(Boolean);
  if (skills.length) facts.push(`- Skills routed: ${skills.map((name) => `\`${name}\``).join(", ")}.`);
  return [...lines, "", ...facts];
}

function changesLines(changes, checkpointFiles) {
  if (!changes.git || !changes.files.length) {
    if (!checkpointFiles.length) return [];
    return [
      "No Git diff was available, so these are the files the task checkpoints recorded:",
      "",
      ...checkpointFiles.slice(0, MAX_FILES_PER_GROUP).map((file) => `- \`${file}\``),
      ...(checkpointFiles.length > MAX_FILES_PER_GROUP ? [`- …and ${checkpointFiles.length - MAX_FILES_PER_GROUP} more.`] : [])
    ];
  }
  const total = changes.total ?? changes.files.length;
  const lines = [
    `${total} file(s) changed${changes.base_ref ? ` against \`${changes.base_ref}\`` : ""}${changes.truncated ? `; the first ${changes.files.length} are listed` : ""}.`
  ];
  for (const group of groupChangedFiles(changes.files)) {
    lines.push("", `**${group.title}** (${group.files.length})`, "");
    for (const file of group.files.slice(0, MAX_FILES_PER_GROUP)) {
      lines.push(`- \`${file.path}\` — ${file.status}${file.from ? ` (from \`${file.from}\`)` : ""}`);
    }
    if (group.files.length > MAX_FILES_PER_GROUP) {
      lines.push(`- …and ${group.files.length - MAX_FILES_PER_GROUP} more.`);
    }
  }
  if (changes.commits.length) {
    lines.push("", `**Commits** (${changes.commits.length})`, "");
    for (const commit of changes.commits) lines.push(`- \`${commit.hash}\` ${cell(commit.subject)}`);
  }
  return lines;
}

function acceptanceLines(record) {
  const criteria = record.acceptance_criteria || [];
  if (!criteria.length) return [];
  const lines = ["| ID | Status | Criterion | Evidence |", "| --- | --- | --- | --- |"];
  for (const item of criteria) {
    const evidence = (item.evidence || []).map((value) => `\`${cell(value)}\``).join(", ");
    lines.push(`| ${item.id} | ${item.status} | ${cell(item.text)}${item.note ? ` — ${cell(item.note)}` : ""} | ${evidence || "—"} |`);
  }
  return lines;
}

/**
 * Everything a reviewer must not be allowed to miss: criteria that are not met,
 * a missing or failed verification, and blocking hygiene findings.
 *
 * @param {object} record - Task record.
 * @param {object | null} hygiene - `change_hygiene` check result of the latest verification.
 * @returns {string[]} One line per open item.
 */
export function outstandingItems(record, hygiene) {
  const items = [];
  for (const item of record.acceptance_criteria || []) {
    if (item.status === "met") continue;
    items.push(`**${item.id}** (${item.status}): ${cell(item.text)}${item.note ? ` — ${cell(item.note)}` : ""}`);
  }
  const latest = (record.verifications || []).at(-1);
  if (!latest) {
    items.push("No verification is recorded — run `verify_task` before asking for review.");
  } else if (!latest.passed) {
    const failed = (latest.checks || []).filter((check) => !["passed", "pass", "ok", "warn"].includes(statusLabel(check)));
    items.push(`The latest verification \`${latest.id}\` failed${failed.length ? `: ${failed.map((check) => `\`${check.type}\` ${statusLabel(check)}`).join(", ")}` : "."}`);
  }
  const blocking = (hygiene?.findings || []).filter((finding) => finding.severity === "block");
  if (blocking.length) items.push(`Change hygiene blocks on ${blocking.length} finding(s); fix them before merge.`);
  if (record.status !== "complete") items.push(`The task is still \`${record.status}\` — \`complete_task\` has not accepted it.`);
  return items;
}

function verificationLines(record) {
  const verifications = record.verifications || [];
  const latest = verifications.at(-1);
  if (!latest) return ["No verification run is recorded for this task."];
  const ran = new Set((latest.checks || []).map((check) => check.type));
  const lines = [
    `Latest run \`${latest.id}\` at ${latest.at}: **${latest.passed ? "passed" : "failed"}**.`,
    "",
    "| Check | Result |",
    "| --- | --- |"
  ];
  for (const check of latest.checks || []) lines.push(`| \`${check.type}\` | ${cell(statusLabel(check))} |`);
  if (!latest.checks?.length) lines.push("| — | no checks recorded |");
  const missing = REPORTED_CHECKS.filter((name) => !ran.has(name));
  if (missing.length) lines.push("", `Not run: ${missing.map((name) => `\`${name}\``).join(", ")}.`);
  if (verifications.length > 1) lines.push("", `${verifications.length} verification run(s) recorded; the latest one is the one that counts.`);
  return lines;
}

function testPlanLines(record, plan) {
  const lines = [];
  const strategy = String(plan?.testing_strategy || "").trim();
  if (strategy) lines.push(strategy);
  const phaseTests = (plan?.phases || [])
    .map((phase, index) => ({ title: phase.title || `Phase ${index + 1}`, tests: (phase.tests || []).filter(Boolean) }))
    .filter((phase) => phase.tests.length);
  if (phaseTests.length) {
    if (lines.length) lines.push("");
    lines.push("Tests the plan asked for:", "");
    for (const phase of phaseTests) lines.push(`- **${cell(phase.title)}** — ${phase.tests.map(cell).join("; ")}`);
  }
  const gate = (record.verifications || []).at(-1)?.checks?.find((check) => check.type === "quality_gate");
  const commands = (gate?.result?.results || []).filter((item) => item?.command);
  if (commands.length) {
    if (lines.length) lines.push("");
    lines.push("Commands the quality gate ran:", "");
    for (const item of commands) lines.push(`- \`${cell(item.command)}\` — ${cell(item.status)}${item.cwd && item.cwd !== "." ? ` (in \`${cell(item.cwd)}\`)` : ""}`);
  } else if (gate) {
    if (lines.length) lines.push("");
    lines.push(`The quality gate reported \`${cell(gate.result?.status || "unknown")}\` with no command output.`);
  }
  return lines;
}

function decisionLines(decisions) {
  return decisions.map((item) => {
    const summary = String(item.decision || "").split("\n")[0].trim();
    return `- **${item.id} ${cell(item.title)}** (${item.status})${summary ? ` — ${cell(summary)}` : ""} · \`${item.path || item.file}\``;
  });
}

function planLines(record, plan) {
  const summary = record.plan;
  if (!summary && !plan) return [];
  const lines = [];
  if (summary) {
    lines.push(`\`${summary.path}\` — ${summary.phases} phase(s), ${summary.steps} step(s), recorded ${summary.recorded_at}.`);
  }
  const phases = plan?.phases || [];
  if (phases.length) {
    if (lines.length) lines.push("");
    phases.forEach((phase, index) => {
      lines.push(`${index + 1}. **${cell(phase.title || `Phase ${index + 1}`)}** — ${(phase.steps || []).length} step(s).`);
    });
  }
  const overview = String(plan?.overview || "").trim();
  if (overview) lines.unshift(overview, "");
  return lines;
}

function checkpointLines(record) {
  const checkpoints = record.checkpoints || [];
  if (!checkpoints.length) return [];
  const shown = checkpoints.slice(-MAX_CHECKPOINTS);
  const lines = shown.map((item) => {
    const files = item.changed_files?.length ? ` (${item.changed_files.length} file(s))` : "";
    return `- \`${item.at}\` — ${cell(item.summary) || "(no summary)"}${files}`;
  });
  if (checkpoints.length > shown.length) {
    lines.unshift(`- …${checkpoints.length - shown.length} earlier checkpoint(s) omitted.`);
  }
  return lines;
}

function hygieneLines(hygiene) {
  if (!hygiene) return [];
  const trimmed = { ...hygiene, findings: (hygiene.findings || []).slice(0, MAX_HYGIENE_FINDINGS) };
  const lines = renderChangeHygieneMarkdown(trimmed).split("\n");
  if ((hygiene.findings || []).length > MAX_HYGIENE_FINDINGS) {
    lines.push(`- …and ${hygiene.findings.length - MAX_HYGIENE_FINDINGS} more finding(s).`);
  }
  return lines;
}

/**
 * Build every section of the pull-request body from a task record and its
 * repository state. Sections with nothing to say come back empty and are
 * dropped by the renderer; `outstanding` is the exception a reviewer needs.
 *
 * @param {{ record: object, decisions?: object[], plan?: object | null, changes: object, baseRef?: string }} input
 * @returns {{ sections: Array<{ key: string, title: string, lines: string[] }>, outstanding: string[], hygiene: object | null, checks: Array<{ type: string, status: string }>, checks_not_run: string[] }}
 */
export function buildPullRequestSections({ record, decisions = [], plan = null, changes, baseRef = "" }) {
  const latest = (record.verifications || []).at(-1);
  const hygiene = (latest?.checks || []).find((check) => check.type === "change_hygiene")?.result ?? null;
  const checkpointFiles = [...new Set((record.checkpoints || []).flatMap((item) => item.changed_files || []))];
  const outstanding = outstandingItems(record, hygiene);
  const sections = [
    { key: "summary", title: "Summary", lines: summaryLines(record, changes, baseRef) },
    { key: "changes", title: "Changed files", lines: changesLines(changes, checkpointFiles) },
    { key: "acceptance", title: "Acceptance criteria", lines: acceptanceLines(record) },
    { key: "outstanding", title: "Outstanding", lines: outstanding.map((item) => `- ${item}`) },
    { key: "verification", title: "Verification", lines: verificationLines(record) },
    { key: "test_plan", title: "Test plan", lines: testPlanLines(record, plan) },
    { key: "decisions", title: "Decisions", lines: decisionLines(decisions) },
    { key: "plan", title: "Implementation plan", lines: planLines(record, plan) },
    { key: "checkpoints", title: "Checkpoints", lines: checkpointLines(record) },
    { key: "hygiene", title: "Change hygiene", lines: hygieneLines(hygiene) }
  ];
  const checks = (latest?.checks || []).map((check) => ({ type: check.type, status: statusLabel(check) }));
  return {
    sections,
    outstanding,
    hygiene,
    checks,
    checks_not_run: REPORTED_CHECKS.filter((name) => !checks.some((check) => check.type === name))
  };
}

/**
 * The commands that turn the prepared text into a pull request. They are
 * returned, never executed: pushing a branch and opening a pull request are the
 * developer's calls, not the server's.
 *
 * @param {{ branch: string, baseRef: string, title: string, bodyPath: string }} input
 * @returns {string[]}
 */
export function pullRequestCommands({ branch, baseRef, title, bodyPath }) {
  const head = branch || "<branch>";
  const base = (baseRef || "").replace(/^origin\//, "") || "<base-branch>";
  return [
    `git push -u origin ${head}`,
    `gh pr create --base ${base} --head ${head} --title ${JSON.stringify(title)} --body-file ${bodyPath}`
  ];
}

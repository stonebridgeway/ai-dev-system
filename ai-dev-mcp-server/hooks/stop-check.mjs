#!/usr/bin/env node
// Stop: cheap end-of-response checks on git-modified files — console.log and
// debugger leftovers, secrets in modified files, and a verify_task reminder
// when a task is active with uncommitted changes. Diagnostics go to stderr.
//
// One check can send the agent back: when back- or front-end code or a
// dependency manifest changed after the last run_security_scan (its stamp is
// .ai-dev/security/last-scan.json), `security_review_on_stop: "block"` stops
// the stop and asks for the security review first. Claude Code runs the Stop
// hook again after that turn with stop_hook_active set, and this hook then
// says nothing, so it can never hold a session in a loop.
import fs from "node:fs";
import path from "node:path";
import { activeTaskFor, compileRegex, git, hooksDisabled, identityRootOf, isCursor, loadPolicy, log, normalizeInput, profileAllows, projectRootOf, readJson, readStdin } from "./lib.mjs";

/** Where run_security_scan leaves the time of its last run in a project. */
export const SECURITY_SCAN_STAMP = path.join(".ai-dev", "security", "last-scan.json");

/** Files whose change a security review should look at: code, manifests, lockfiles, containers. */
const SECURITY_RELEVANT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|go|rb|php|java|kt|cs|rs|sql|graphql|prisma)$|(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|Dockerfile|docker-compose\.ya?ml|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/i;
const NOT_REVIEWED = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)(__tests__|__mocks__|docs)\//, /(^|\/)\.ai-dev\//];

/**
 * The changed files a security review has not seen: relevant, and modified
 * after the last scan's stamp (all of them when there is no stamp).
 *
 * @param {string} projectRoot
 * @param {string[]} files - Repository-relative, from git status.
 * @returns {string[]}
 */
export function unreviewedChanges(projectRoot, files) {
  const stamp = readJson(path.join(projectRoot, SECURITY_SCAN_STAMP), null);
  const scannedAt = Date.parse(stamp?.at ?? "") || 0;
  return files.filter((file) => SECURITY_RELEVANT.test(file) && !NOT_REVIEWED.some((pattern) => pattern.test(file))).filter((file) => {
    try {
      return fs.statSync(path.join(projectRoot, file)).mtimeMs > scannedAt;
    } catch {
      return false;
    }
  });
}

const EXCLUDED = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)(tests?|__tests__|__mocks__|scripts|docs)\//, /\.config\.[cm]?[jt]s$/];

/**
 * Paths from `git status --porcelain=v1`.
 *
 * The status column is read by pattern, not by position: `git()` trims its
 * output, which takes the leading space off the first line when that file is
 * modified only in the worktree (` M src/api.ts` arrives as `M src/api.ts`),
 * and slicing three characters off it read `rc/api.ts` — a file that does not
 * exist, so the first changed file skipped every check here.
 *
 * @param {string} status
 * @returns {string[]}
 */
export function porcelainPaths(status) {
  return String(status ?? "").split("\n").map((line) => /^[ MADRCTU?!]{1,2} (.+)$/.exec(line)?.[1] ?? "").filter(Boolean)
    .map((entry) => entry.trim().replace(/^"|"$/g, "").split(" -> ").at(-1));
}

function modifiedFiles(projectRoot) {
  return porcelainPaths(git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]));
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("stop:check")) process.exit(0);
  const input = normalizeInput(raw);
  if (input.payload.stop_hook_active) process.exit(0);
  const projectRoot = projectRootOf(input.cwd);
  const policy = loadPolicy(projectRoot);
  if (!profileAllows(policy.profile, ["standard", "strict"])) process.exit(0);
  const files = modifiedFiles(projectRoot);
  if (!files.length) process.exit(0);
  const secrets = (policy.patterns?.secrets || []).map((item) => ({ ...item, regex: compileRegex(item.source, item.flags || "") })).filter((item) => item.regex && !item.placeholder_aware);
  const findings = [];
  for (const file of files) {
    const absolute = path.join(projectRoot, file);
    let content = "";
    try {
      if (fs.statSync(absolute).size > 512 * 1024) continue;
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (/\.[cm]?[jt]sx?$/.test(file) && !EXCLUDED.some((pattern) => pattern.test(file))) {
      if (/\bconsole\.(log|debug)\(/.test(content)) findings.push(`console.log in ${file}`);
      if (/^\s*debugger\s*;?\s*$/m.test(content)) findings.push(`debugger in ${file}`);
    }
    for (const item of secrets) if (item.regex.test(content)) findings.push(`possible ${item.id.replaceAll("_", " ")} in ${file}`);
  }
  for (const finding of findings) log(`[ai-dev stop-check] WARNING: ${finding}`);
  const task = activeTaskFor(identityRootOf(input.cwd));
  if (task) log(`[ai-dev stop-check] Task ${task.id} is ${task.status} with ${files.length} uncommitted file(s): run checkpoint_task and verify_task before claiming completion.`);
  const mode = ["block", "remind", "off"].includes(policy.security_review_on_stop) ? policy.security_review_on_stop : "block";
  const unreviewed = mode === "off" ? [] : unreviewedChanges(projectRoot, files);
  if (unreviewed.length) {
    const named = `${unreviewed.slice(0, 5).join(", ")}${unreviewed.length > 5 ? ` and ${unreviewed.length - 5} more` : ""}`;
    const reason = `[ai-dev security] ${unreviewed.length} changed file(s) no security scan has seen: ${named}. Run the ar-security-review skill before finishing: run_security_scan on this project, plan_security_fixes for any dependency finding (confirm before installing anything), and review the changed code for injection, auth and secrets. If the ai-dev tools are not connected, say so instead of claiming the change is safe.`;
    if (mode === "block" && !isCursor()) {
      process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    } else {
      log(reason);
    }
  }
  process.exit(0);
}

// Run as the hook; imported by the tests for unreviewedChanges.
if (process.argv[1] && path.basename(process.argv[1]) === "stop-check.mjs") {
  main().catch((error) => {
    log(`[ai-dev stop-check] error: ${error.message}`);
    process.exit(0);
  });
}

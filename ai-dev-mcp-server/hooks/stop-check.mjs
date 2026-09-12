#!/usr/bin/env node
// Stop: cheap end-of-response checks on git-modified files — console.log and
// debugger leftovers, secrets in modified files, and a verify_task reminder
// when a task is active with uncommitted changes. Diagnostics go to stderr;
// nothing blocks.
import fs from "node:fs";
import path from "node:path";
import { activeTaskFor, compileRegex, git, hooksDisabled, loadPolicy, log, normalizeInput, profileAllows, projectRootOf, readStdin } from "./lib.mjs";

const EXCLUDED = [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)(tests?|__tests__|__mocks__|scripts|docs)\//, /\.config\.[cm]?[jt]s$/];

function modifiedFiles(projectRoot) {
  const status = git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return status.split("\n").filter(Boolean).map((line) => line.slice(3).trim().replace(/^"|"$/g, "").split(" -> ").at(-1));
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
  const task = activeTaskFor(projectRoot);
  if (task) log(`[ai-dev stop-check] Task ${task.id} is ${task.status} with ${files.length} uncommitted file(s): run checkpoint_task and verify_task before claiming completion.`);
  process.exit(0);
}

main().catch((error) => {
  log(`[ai-dev stop-check] error: ${error.message}`);
  process.exit(0);
});

#!/usr/bin/env node
// Git hooks, installed through `core.hooksPath` so they run for every client
// and for a human at a terminal, not only for an agent whose harness has a hook
// API: `node git-hooks.mjs pre-commit` scans what is staged, and
// `node git-hooks.mjs pre-push` reads the active task's latest verification.
//
// Ported from ECC's `scripts/codex-git-hooks/{pre-commit,pre-push}` and
// `scripts/codex/install-global-git-hooks.sh`.
//
// Like every hook here, this one does not import the server: it is copied into
// other repositories and may run while the server sits in a container. The
// rules it applies are the server's own, written out to `.ai-dev/hooks/
// patterns.json` by `install_agent_hooks` (`renderHookPatterns`). The diff
// reader below is the one piece with a twin in `src/core/change-hygiene.mjs`
// (`parseAddedLines`); `agent-hooks.test.mjs` feeds one diff to both and
// compares, so the two cannot drift apart unnoticed.
import path from "node:path";
import { activeTaskFor, compileRegex, git, hooksDisabled, loadPolicy, log, projectRootOf } from "./lib.mjs";

/** What each hook does when it finds something: refuse, say so, or stay out of the way. */
export const GIT_HOOK_MODES = ["block", "warn", "off"];

/** Defaults for the `git_hooks` block of `.ai-dev/policy.json`. */
export const GIT_HOOK_DEFAULTS = Object.freeze({ pre_commit: "block", pre_push: "warn" });

function mode(value, fallback) {
  const text = String(value ?? "").toLowerCase();
  return GIT_HOOK_MODES.includes(text) ? text : fallback;
}

/**
 * Git hook settings for this project.
 *
 * @param {object} [policy] - From `loadPolicy`.
 * @returns {typeof GIT_HOOK_DEFAULTS}
 */
export function gitHookSettings(policy = {}) {
  const configured = policy.git_hooks && typeof policy.git_hooks === "object" ? policy.git_hooks : {};
  return {
    pre_commit: mode(configured.pre_commit, GIT_HOOK_DEFAULTS.pre_commit),
    pre_push: mode(configured.pre_push, GIT_HOOK_DEFAULTS.pre_push)
  };
}

/**
 * Added lines per file from `git diff --unified=0` output. The twin of
 * `parseAddedLines` in `src/core/change-hygiene.mjs`.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<{ line: number, text: string }>>}
 */
export function parseAddedLines(diffText) {
  const files = new Map();
  let currentPath = null;
  let lineNumber = 0;
  let skipFile = false;
  for (const raw of String(diffText ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null;
      skipFile = false;
      continue;
    }
    if (raw.startsWith("Binary files ")) {
      skipFile = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null") {
        skipFile = true;
        continue;
      }
      currentPath = target.replace(/^b\//, "").replace(/^"|"$/g, "");
      if (!files.has(currentPath)) files.set(currentPath, []);
      continue;
    }
    if (skipFile || !currentPath) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      files.get(currentPath).push({ line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // removed line: new-file numbering does not advance
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (!raw.startsWith("---")) {
      lineNumber += 1;
    }
  }
  return files;
}

/** The language a rule's `languages` list is matched against. */
function languageOf(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"].includes(extension)) return "js";
  if (extension === ".py") return "py";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rs";
  return "other";
}

/** Compile the block-severity half of `patterns.json` once. */
function blockingRules(policy) {
  const placeholder = compileRegex(policy.patterns?.placeholder_value || "", "i");
  return {
    secretFile: compileRegex(policy.patterns?.secret_file || "", "i"),
    placeholder,
    secrets: (policy.patterns?.secrets || [])
      .filter((item) => item.severity === "block")
      .map((item) => ({ ...item, regex: compileRegex(item.source, item.flags || "") }))
      .filter((item) => item.regex),
    leftovers: (policy.patterns?.leftovers || [])
      .filter((item) => item.severity === "block")
      .map((item) => ({ ...item, regex: compileRegex(item.source, item.flags || "") }))
      .filter((item) => item.regex)
  };
}

/**
 * Scan a staged change set for the findings that stop a commit: a secret-bearing
 * path, a secret in an added line, a merge-conflict marker, a focused test, a
 * left-behind debugger.
 *
 * @param {Map<string, Array<{ line: number, text: string }>>} added - From {@link parseAddedLines}.
 * @param {object} rules - From `blockingRules`.
 * @returns {Array<{ rule: string, file: string, line: number, message: string }>}
 */
export function scanStaged(added, rules) {
  const findings = [];
  for (const [relativePath, lines] of added) {
    if (rules.secretFile?.test(relativePath)) {
      findings.push({ rule: "secret_file_in_change_set", file: relativePath, line: 0, message: "A secret-bearing file is staged. Keep it out of Git and load the value from the environment." });
    }
    const language = languageOf(relativePath);
    for (const { line, text } of lines) {
      for (const item of rules.secrets) {
        const match = text.match(item.regex);
        if (!match) continue;
        // A placeholder-aware rule matches the shape `name = "value"`; only the
        // value decides, and a stand-in for a secret is not one.
        if (item.placeholder_aware && rules.placeholder?.test(match[1] ?? "")) continue;
        findings.push({ rule: `secret:${item.id}`, file: relativePath, line, message: `Possible ${item.id.replaceAll("_", " ")} in a staged line. Rotate it if it is real and load it from the environment.` });
      }
      for (const item of rules.leftovers) {
        if (item.languages?.length && !item.languages.includes(language)) continue;
        if (item.regex.test(text)) findings.push({ rule: item.id, file: relativePath, line, message: item.message });
      }
    }
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function preCommit(projectRoot, policy, settings) {
  if (settings.pre_commit === "off") return 0;
  const diff = git(projectRoot, ["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"]);
  const findings = scanStaged(parseAddedLines(diff), blockingRules(policy));
  if (!findings.length) return 0;
  const refusing = settings.pre_commit === "block";
  log(`[ai-dev pre-commit] ${findings.length} blocking hygiene finding(s)${refusing ? "; the commit is refused" : ""}:`);
  for (const item of findings) log(`  ${item.file}${item.line ? `:${item.line}` : ""} ${item.rule}: ${item.message}`);
  if (refusing) log("[ai-dev pre-commit] Fix them, or set git_hooks.pre_commit to \"warn\" in .ai-dev/policy.json if this is the wrong call.");
  return refusing ? 1 : 0;
}

/**
 * What the active task's latest verification says, in one line, or an empty
 * string when there is nothing to say.
 *
 * @param {object | null} task - From `activeTaskFor`.
 * @returns {string}
 */
export function verificationReminder(task) {
  if (!task) return "";
  const latest = Array.isArray(task.verifications) ? task.verifications.at(-1) : null;
  if (!latest) return `Task ${task.id} has no recorded verification. Run verify_task before pushing.`;
  if (!latest.passed) return `The latest verification of task ${task.id} (${latest.id}) failed. Run verify_task again before pushing.`;
  return "";
}

function prePush(projectRoot, settings) {
  if (settings.pre_push === "off") return 0;
  const reminder = verificationReminder(activeTaskFor(projectRoot));
  if (!reminder) return 0;
  const refusing = settings.pre_push === "block";
  log(`[ai-dev pre-push] ${reminder}${refusing ? " The push is refused." : ""}`);
  if (refusing) log("[ai-dev pre-push] Set git_hooks.pre_push to \"warn\" in .ai-dev/policy.json to make this a reminder instead.");
  return refusing ? 1 : 0;
}

function main() {
  const hook = process.argv[2] === "pre-push" ? "pre-push" : "pre-commit";
  if (hooksDisabled(`git:${hook}`)) return 0;
  const projectRoot = projectRootOf(process.cwd());
  const policy = loadPolicy(projectRoot);
  const settings = gitHookSettings(policy);
  return hook === "pre-push" ? prePush(projectRoot, settings) : preCommit(projectRoot, policy, settings);
}

// Imported by the tests, run by git. Only the second case exits.
if (process.argv[1] && path.basename(process.argv[1]) === "git-hooks.mjs") {
  try {
    process.exit(main());
  } catch (error) {
    // A broken hook must never wedge a commit: say what happened and let it through.
    log(`[ai-dev git-hooks] error: ${error.message}`);
    process.exit(0);
  }
}

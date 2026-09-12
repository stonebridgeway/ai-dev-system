#!/usr/bin/env node
// PreToolUse guard: `node guard.mjs bash` for shell commands, `node guard.mjs file`
// for Write/Edit/MultiEdit. Blocks git hook bypasses, destructive commands,
// secret-bearing files, linter-config weakening, and secrets in new content;
// warns about oversized files and ad-hoc scratch documents. Extra rules come
// from .ai-dev/policy.json (hookify-style regex rules), and `fact_force` there
// adds the grounding gate in fact-force.mjs.
import fs from "node:fs";
import path from "node:path";
import { evaluateFactForce } from "./fact-force.mjs";
import {
  block,
  compileRegex,
  emitContext,
  hooksDisabled,
  loadPolicy,
  matchWithBudget,
  normalizeInput,
  POLICY_MATCH_BUDGET_MS,
  POLICY_MATCH_DEADLINE_MS,
  profileAllows,
  projectRootOf,
  readStdin,
  shellSegments,
  tokensOf
} from "./lib.mjs";

const NO_VERIFY_SUBCOMMANDS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const COMMIT_OPTIONS_WITH_VALUE = new Set(["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date", "--template", "--fixup", "--squash", "--pathspec-from-file"]);
const DESTRUCTIVE_TEXT = [
  { id: "sql-destructive", pattern: /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+\s*(;|$))/i, message: "Destructive SQL statement." },
  { id: "dd-mkfs", pattern: /\b(dd\s+if=|mkfs(\.\w+)?\s|diskpart|format\s+[a-z]:)/i, message: "Disk-level destructive command." },
  { id: "chmod-777", pattern: /\bchmod\s+(-R\s+)?777\b/, message: "World-writable permissions." },
  { id: "curl-pipe-shell", pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, message: "Piping a download into a shell." },
  { id: "docker-prune", pattern: /\bdocker\s+(system|volume|image|container)\s+prune\b/, message: "Docker prune removes data." },
  { id: "kubectl-delete", pattern: /\bkubectl\s+delete\b/, message: "kubectl delete against a cluster." },
  { id: "publish", pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bdocker\s+push\b|\bgem\s+push\b|\btwine\s+upload\b|\bflutter\s+pub\s+publish\b/, message: "Publishing artifacts is outside a task; ask first." },
  { id: "sudo-rm", pattern: /\bsudo\s+rm\b/, message: "sudo rm." }
];

function stripAfterDoubleDash(tokens) {
  const index = tokens.indexOf("--");
  return index === -1 ? tokens : tokens.slice(0, index);
}

function gitInvocation(tokens) {
  const base = path.basename(tokens[0] || "").toLowerCase().replace(/\.exe$/, "");
  if (base !== "git") return null;
  let index = 1;
  let hooksPathOverride = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      const value = String(tokens[index + 1] || "").toLowerCase();
      if (token === "-c" && value.startsWith("core.hookspath=")) hooksPathOverride = true;
      index += 2;
      continue;
    }
    if (/^-c/i.test(token) && token.length > 2) {
      if (token.slice(2).toLowerCase().startsWith("core.hookspath=")) hooksPathOverride = true;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return { subcommand: token, rest: tokens.slice(index + 1), hooksPathOverride };
  }
  return null;
}

function hasNoVerify(subcommand, rest) {
  const relevant = stripAfterDoubleDash(rest);
  for (let index = 0; index < relevant.length; index += 1) {
    const token = relevant[index];
    if (token === "--no-verify") return true;
    if (subcommand === "commit" && COMMIT_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (subcommand === "commit" && /^-[a-zA-Z]+$/.test(token) && !token.startsWith("--")) {
      const cluster = token.slice(1);
      const valueIndex = cluster.search(/[mFCc]/);
      const checked = valueIndex === -1 ? cluster : cluster.slice(0, valueIndex);
      if (checked.includes("n")) return true;
    }
    if (subcommand !== "commit" && token === "-n") return true;
  }
  return false;
}

function destructiveGit(subcommand, rest) {
  const short = (token) => /^-[a-zA-Z]+$/.test(token);
  if (subcommand === "reset" && rest.includes("--hard")) return "git reset --hard discards uncommitted work.";
  if (subcommand === "checkout" && rest.some((token) => token === "--" || token === "." || token === "--force" || (short(token) && token.includes("f")))) return "git checkout that discards working-tree changes.";
  if (subcommand === "restore" && rest.some((token) => token === "." || token === "--worktree" || token === "-W")) return "git restore that discards working-tree changes.";
  if (subcommand === "clean" && rest.some((token) => token === "--force" || (short(token) && token.includes("f")))) return "git clean deletes untracked files.";
  if (subcommand === "push") {
    const lease = rest.some((token) => token.startsWith("--force-with-lease"));
    const force = rest.some((token) => token === "--force" || token.startsWith("--force=") || (short(token) && token.includes("f")) || /^\+\S/.test(token));
    if (force && !lease) return "git push --force without --force-with-lease rewrites shared history.";
  }
  if (subcommand === "branch" && rest.some((token) => token === "-D" || token === "--delete" && rest.includes("--force"))) return "git branch -D deletes an unmerged branch.";
  if (subcommand === "stash" && rest.includes("drop")) return "git stash drop loses stashed work.";
  return "";
}

function destructiveRm(tokens) {
  const base = path.basename(tokens[0] || "").toLowerCase();
  if (base !== "rm") return "";
  let recursive = false;
  let force = false;
  for (const token of tokens.slice(1)) {
    if (token === "--recursive") recursive = true;
    else if (token === "--force") force = true;
    else if (/^-[a-zA-Z]+$/.test(token)) {
      if (/[rR]/.test(token)) recursive = true;
      if (/f/.test(token)) force = true;
    }
  }
  return recursive && force ? "rm -rf deletes recursively without confirmation." : "";
}

// Project rules from .ai-dev/policy.json, matched under a time budget.
//
// The budget is not an optimization. A pattern that backtracks catastrophically
// holds this thread for as long as it takes — 38.8 seconds for `(a|a)+$` against
// twenty-eight characters — and the client kills the hook at ten, so the write
// or the command goes unchecked. `upsert_policy_rule` refuses such a pattern,
// but policy.json is a file anyone can edit, so the guard does not rely on that:
// every rule match runs in a worker thread that is killed when it overstays, and
// a rule that overstays is reported instead of evaluated.
//
// The per-rule budget bounds one rule, not one event: thirty slow rules cost
// thirty budgets, which is past the ten seconds the client allows (Д-22). So
// all of an event's rules share one deadline, and the ones it cuts off are
// counted in a single line instead of being matched.
async function applyCustomRules(rules, event, text, filePath) {
  const blocks = [];
  const warns = [];
  const applicable = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (rule.event !== event && rule.event !== "all") continue;
    if (!compileRegex(String(rule.pattern || ""))) continue;
    applicable.push(rule);
  }
  if (!applicable.length) return { blocks, warns };
  const haystack = event === "file" ? `${filePath}\n${text}` : text;
  const answers = await matchWithBudget(applicable.map((rule) => ({ pattern: String(rule.pattern || ""), flags: "i", haystack })));
  const unchecked = [];
  applicable.forEach((rule, index) => {
    const name = rule.id || rule.name || "rule";
    const answer = answers[index] || { matched: null, checked: false };
    if (!answer.checked) {
      unchecked.push(name);
      return;
    }
    if (answer.matched === null) {
      warns.push(`[policy:${name}] this rule was not evaluated: matching its pattern took longer than ${POLICY_MATCH_BUDGET_MS} ms. Fix the pattern with upsert_policy_rule — until then the rule protects nothing.`);
      return;
    }
    if (!answer.matched) return;
    const message = `[policy:${name}] ${rule.message || "Matched a project policy rule."}`;
    if (rule.action === "block") blocks.push(message);
    else warns.push(message);
  });
  if (unchecked.length) {
    const named = unchecked.slice(0, 5).join(", ");
    const rest = unchecked.length > 5 ? `, and ${unchecked.length - 5} more` : "";
    warns.push(`[policy] ${unchecked.length} rule(s) were never matched: the ${POLICY_MATCH_DEADLINE_MS} ms this event gets for all its rules together ran out before their turn. Not evaluated: ${named}${rest}. A rule ahead of them is spending the budget — find it with list_policy_rules and fix it with upsert_policy_rule; until then these rules protect nothing.`);
  }
  return { blocks, warns };
}

async function checkBash(input, policy) {
  const command = input.command;
  if (!command.trim()) return { blocks: [], warns: [] };
  const blocks = [];
  const warns = [];
  const allow = (policy.allow_commands ?? []).map((source) => compileRegex(source)).filter(Boolean);
  if (allow.some((regex) => regex.test(command))) return { blocks: [], warns: [] };
  for (const segment of shellSegments(command)) {
    const tokens = tokensOf(segment);
    if (!tokens.length) continue;
    const invocation = gitInvocation(tokens);
    if (invocation) {
      if (invocation.hooksPathOverride && NO_VERIFY_SUBCOMMANDS.has(invocation.subcommand)) blocks.push("BLOCKED: core.hooksPath override bypasses git hooks.");
      if (NO_VERIFY_SUBCOMMANDS.has(invocation.subcommand) && hasNoVerify(invocation.subcommand, invocation.rest)) blocks.push(`BLOCKED: --no-verify is not allowed with git ${invocation.subcommand}. Git hooks must not be bypassed; fix the failing check instead.`);
      const reason = destructiveGit(invocation.subcommand, invocation.rest);
      if (reason) blocks.push(`BLOCKED: ${reason} Present the rollback plan and quote the user's instruction, then ask before retrying.`);
      if (policy.profile === "strict" && invocation.subcommand === "push") warns.push("Review the diff (git diff --stat, git log origin/HEAD..HEAD) before pushing.");
      if (policy.profile === "strict" && invocation.subcommand === "commit" && invocation.rest.includes("--amend")) warns.push("Amending rewrites the last commit; make sure it was not pushed.");
    }
    const rm = destructiveRm(tokens);
    if (rm) blocks.push(`BLOCKED: ${rm} List what would be deleted and confirm with the user first.`);
  }
  // Text rules see both the whole command (pipelines such as curl | sh) and each segment.
  for (const text of new Set([command, ...shellSegments(command)])) {
    for (const rule of DESTRUCTIVE_TEXT) {
      if (rule.pattern.test(text)) blocks.push(`BLOCKED (${rule.id}): ${rule.message} Confirm explicitly before running this.`);
    }
  }
  const custom = await applyCustomRules(policy.rules, "bash", command, "");
  return { blocks: [...blocks, ...custom.blocks], warns: [...warns, ...custom.warns] };
}

/** Every file one Write/Edit/MultiEdit call would touch, with the content it would get. */
function editTargets(input) {
  if (input.edits.length) return input.edits.map((edit) => ({ filePath: String(edit.file_path || ""), content: String(edit.new_string || "") }));
  return [{ filePath: input.filePath, content: input.content }];
}

/** Repository-relative, POSIX-separated paths of an edit, for policy globs and state keys. */
function relativeTargets(input, projectRoot) {
  return editTargets(input)
    .map((target) => target.filePath)
    .filter(Boolean)
    .map((filePath) => {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
      const relative = path.relative(projectRoot, absolute).replaceAll("\\", "/");
      return relative && !relative.startsWith("..") ? relative : String(filePath).replaceAll("\\", "/");
    });
}

async function checkFile(input, policy, projectRoot) {
  const blocks = [];
  const warns = [];
  const targets = editTargets(input);
  const secretFile = compileRegex(policy.patterns?.secret_file || "(^|/)(\\.env(?!\\.(?:example|sample|template|dist)$)(?:\\.[^/]+)?|[^/]*\\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$");
  const protectedConfigs = new Set(policy.patterns?.protected_config_files || []);
  const secretPatterns = (policy.patterns?.secrets || []).map((item) => ({ ...item, regex: compileRegex(item.source, item.flags || "") })).filter((item) => item.regex);
  for (const target of targets) {
    if (!target.filePath) continue;
    const relative = target.filePath.replaceAll("\\", "/");
    const base = path.basename(relative);
    if (secretFile.test(relative)) blocks.push(`BLOCKED: ${relative} is a secret-bearing file. Use environment variables or a secret manager; never write secrets into the repository.`);
    if (protectedConfigs.has(base) && !policy.allow_config_edits) {
      const absolute = path.isAbsolute(target.filePath) ? target.filePath : path.join(projectRoot, target.filePath);
      if (fs.existsSync(absolute)) blocks.push(`BLOCKED: ${base} is a linter/formatter/type-checker config. Fix the code instead of weakening the config; set allow_config_edits in .ai-dev/policy.json if the change is intentional.`);
    }
    for (const item of secretPatterns) {
      if (!target.content || !item.regex.test(target.content)) continue;
      if (item.placeholder_aware) continue;
      blocks.push(`BLOCKED: the new content for ${relative} looks like it contains a ${item.id.replaceAll("_", " ")}. Load it from the environment instead.`);
    }
    if (target.content && target.content.split("\n").length > 800 && !/\.(test|spec)\./.test(base)) warns.push(`${relative} would exceed 800 lines; consider splitting it by feature.`);
    if (/^(NOTES|TODO|SCRATCH|TEMP|DRAFT|BRAINSTORM|SPIKE|DEBUG|WIP)\.(md|txt)$/.test(base) && !/(^|\/)(docs|\.ai-dev|\.claude|\.github)\//.test(relative)) warns.push(`${relative} looks like an ad-hoc scratch document; put durable notes in docs/ or record_decision / save_session instead.`);
    const custom = await applyCustomRules(policy.rules, "file", target.content, relative);
    blocks.push(...custom.blocks);
    warns.push(...custom.warns);
  }
  return { blocks, warns };
}

async function main() {
  const mode = process.argv[2] === "file" ? "file" : "bash";
  const hookId = `pre:${mode}:guard`;
  const { raw, truncated } = await readStdin();
  if (hooksDisabled(hookId)) process.exit(0);
  const input = normalizeInput(raw);
  const projectRoot = projectRootOf(input.cwd);
  const policy = loadPolicy(projectRoot);
  if (truncated) block("BLOCKED: hook input exceeded 1 MiB; refusing to evaluate a truncated payload.");
  const result = mode === "bash" ? await checkBash(input, policy) : await checkFile(input, policy, projectRoot);
  if (result.blocks.length) block([...new Set(result.blocks)].join("\n"));
  // Fact forcing runs after the hard rules: a command that is refused outright
  // is refused for its own reason, not for a missing rollback line.
  const forced = evaluateFactForce({ mode, hookInput: input, policy, targets: mode === "file" ? relativeTargets(input, projectRoot) : [] });
  if (forced.deny) block(forced.deny);
  if (forced.note) result.warns.push(forced.note);
  if (result.warns.length && profileAllows(policy.profile, ["standard", "strict"])) emitContext("PreToolUse", [...new Set(result.warns)].map((line) => `[ai-dev guard] ${line}`).join("\n"));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev guard] error: ${error.message}\n`);
  process.exit(0);
});

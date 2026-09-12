#!/usr/bin/env node
// SessionStart: inject the last handoff, open tasks, high-confidence instincts,
// and the installed rules index into the first turn (bounded, historical-only).
import fs from "node:fs";
import path from "node:path";
import { emitContext, git, hooksDisabled, loadPolicy, memoryKeysOf, normalizeInput, projectRootOf, readJson, readStdin, samePath, sessionsDirectory, stateRoot } from "./lib.mjs";

const MAX_CHARS = Number(process.env.AI_DEV_SESSION_START_MAX_CHARS || 8000);

function latestHandoff(keys) {
  for (const key of keys) {
    const directory = sessionsDirectory(key);
    let names = [];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names.slice(0, 20)) {
      const record = readJson(path.join(directory, name));
      if (record && (record.next_step || (record.building && record.building.length > 40))) return record;
    }
  }
  return null;
}

function openTasks(projectRoot) {
  const directory = path.join(stateRoot(), "tasks");
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = [];
  for (const name of names) {
    const record = readJson(path.join(directory, name));
    if (!record || !["active", "verified"].includes(record.status)) continue;
    if (!samePath(record.project?.path, projectRoot)) continue;
    tasks.push(record);
  }
  return tasks.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))).slice(0, 5);
}

function instincts(keys) {
  const store = readJson(path.join(stateRoot(), "instincts.json"), { instincts: [] }) || { instincts: [] };
  return (store.instincts || [])
    .filter((item) => item.status === "active" && item.confidence >= 0.7
      && (item.scope === "global" || keys.includes(item.repository_id) || keys.includes(item.project_id)))
    .sort((left, right) => (right.confidence + (right.scope === "project" ? 0.25 : 0)) - (left.confidence + (left.scope === "project" ? 0.25 : 0)))
    .slice(0, 6);
}

function rulesIndex(projectRoot) {
  const directory = path.join(projectRoot, ".ai-dev", "rules");
  const files = [];
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(`.ai-dev/rules/${entry.name}`);
      if (entry.isDirectory()) for (const nested of fs.readdirSync(path.join(directory, entry.name))) if (nested.endsWith(".md")) files.push(`.ai-dev/rules/${entry.name}/${nested}`);
    }
  } catch {
    return [];
  }
  return files;
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("session:start")) process.exit(0);
  const input = normalizeInput(raw);
  if (input.source && !["startup", "resume", "clear", "compact"].includes(input.source)) process.exit(0);
  const projectRoot = projectRootOf(input.cwd);
  // Repository key first, then the project key older records used: memory
  // written in a task worktree is read from the main checkout and back.
  const keys = memoryKeysOf(projectRoot, Boolean(git(projectRoot, ["rev-parse", "--show-toplevel"])));
  const policy = loadPolicy(projectRoot);
  const parts = [];
  const handoff = latestHandoff(keys);
  if (handoff) {
    // A capture the session-end hook distilled from a transcript is a draft:
    // say so, or the next session reads heuristics as established fact.
    const draft = handoff.source === "hook" && handoff.confirmed !== true;
    const lines = [
      "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. Verify against git before acting; prior work may already be done.",
      draft ? `UNCONFIRMED HOOK DRAFT (${handoff.id}): distilled from the transcript by the session-end hook, not written by an agent. Treat every line below as a guess; confirm it with save_session(confirm_hook_draft: true) once you know what actually happened.` : "",
      `Last session (${handoff.saved_at}${handoff.task_id ? `, task ${handoff.task_id}` : ""}): ${handoff.topic || ""}`,
      handoff.next_step ? `Next step: ${handoff.next_step}` : "",
      ...(handoff.failed || []).slice(0, 3).map((item) => `Do not retry: ${item.approach} (${item.reason || "reason not recorded"})`),
      ...(handoff.blockers || []).slice(0, 3).map((item) => `Blocker: ${item}`)
    ].filter(Boolean);
    parts.push(lines.join("\n"));
  }
  const tasks = openTasks(projectRoot);
  if (tasks.length) parts.push(["Open AI Dev tasks (use get_task / checkpoint_task / verify_task):", ...tasks.map((task) => `- ${task.id} [${task.status}] ${task.task}`)].join("\n"));
  const learned = instincts(keys);
  if (learned.length) parts.push(["Active instincts (learned; apply when the trigger matches):", ...learned.map((item) => `- [${item.scope} ${Math.round(item.confidence * 100)}%] ${item.action} (when ${String(item.trigger).replace(/^when\s+/i, "")})`)].join("\n"));
  const rules = rulesIndex(projectRoot);
  if (rules.length) parts.push(`Engineering rules installed: ${rules.join(", ")}. Profile: ${policy.profile}.`);
  const branch = git(projectRoot, ["branch", "--show-current"]);
  const dirty = git(projectRoot, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  parts.push(`Git: ${branch || "detached"}, ${dirty} uncommitted file(s). For substantive work call begin_task; before ending or compacting call save_session.`);
  let text = parts.join("\n\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 60).trimEnd()}\n\n[context truncated by AI_DEV_SESSION_START_MAX_CHARS]`;
  emitContext("SessionStart", text);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev session-start] error: ${error.message}\n`);
  process.exit(0);
});

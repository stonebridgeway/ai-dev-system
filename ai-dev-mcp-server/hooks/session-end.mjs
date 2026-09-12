#!/usr/bin/env node
// Stop / SessionEnd / PreCompact: distill the transcript into a session record
// (user requests, files modified, tools used) so resume_session and the next
// SessionStart have something even when the agent forgot to call save_session.
//
// What this writes is a draft, not a handoff: every field comes from heuristics
// over the transcript, nobody checked it, and it carries `confirmed: false` for
// that reason. resume_session and session-start show such a record with the
// caveat, and `save_session` with `confirm_hook_draft: true` turns it into a
// real record.
//
// It also writes an observation log beside the draft: what the user said, what
// tools ran with what, and which calls came back as errors. That file is raw
// material, not a conclusion — `propose_instincts` reads it on the server side,
// where the patterns live (src/core/instinct-proposals.mjs). Keeping the
// pattern matching out of here is deliberate: the hook is copied into other
// repositories and cannot be updated with the server, so it stays a recorder.
import fs from "node:fs";
import path from "node:path";
import { git, hooksDisabled, memoryKeysOf, migrateSessions, normalizeInput, projectIdOf, projectRootOf, readStdin, relativePosix, sessionsDirectory } from "./lib.mjs";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/** Caps on the observation log: newest events win, and one file stays small enough to read whole. */
const MAX_OBSERVATION_EVENTS = 600;
const MAX_OBSERVATION_TEXT = 300;
const MAX_OBSERVATION_COMMAND = 200;

function clip(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The part of a tool call worth remembering: the command it ran, or the file it touched. */
function commandOf(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return clip(input.command, MAX_OBSERVATION_COMMAND);
  return clip(input.file_path ?? input.path ?? input.pattern ?? "", MAX_OBSERVATION_COMMAND);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((item) => item && item.type === "text").map((item) => item.text || "").join(" ");
  return "";
}

function extract(transcriptPath) {
  let text = "";
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size > MAX_TRANSCRIPT_BYTES) return null;
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const userMessages = [];
  const tools = new Set();
  const files = new Set();
  const events = [];
  const calls = new Map();
  const push = (event) => {
    events.push({ ...event, i: events.length });
    if (events.length > MAX_OBSERVATION_EVENTS) events.shift();
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.type || entry.message?.role || entry.role;
    if (role === "user") {
      const content = entry.message?.content ?? entry.content;
      // A failed tool call comes back inside the *user* turn that follows it,
      // so the error is matched to its call through the id recorded below.
      const results = (Array.isArray(content) ? content : []).filter((item) => item?.type === "tool_result");
      for (const blockItem of results) {
        if (blockItem.is_error !== true) continue;
        const call = calls.get(blockItem.tool_use_id) ?? { name: "", command: "" };
        push({ k: "error", n: call.name, c: call.command, t: clip(textOf(blockItem.content), MAX_OBSERVATION_TEXT) });
      }
      // A turn that carries a result is the harness speaking, not the user.
      if (results.length) continue;
      const cleaned = textOf(content).replace(/\s+/g, " ").trim();
      if (cleaned && !/^<(local-command|command-|system-reminder|task-notification)/i.test(cleaned)) {
        userMessages.push(cleaned.slice(0, 240));
        push({ k: "user", t: clip(cleaned, MAX_OBSERVATION_TEXT) });
      }
    }
    if (role === "assistant" && Array.isArray(entry.message?.content)) {
      for (const blockItem of entry.message.content) {
        if (blockItem?.type !== "tool_use") continue;
        if (blockItem.name) tools.add(blockItem.name);
        const filePath = blockItem.input?.file_path;
        if (filePath && ["Edit", "Write", "MultiEdit"].includes(blockItem.name)) files.add(String(filePath));
        const command = commandOf(blockItem.name, blockItem.input);
        if (blockItem.id) calls.set(blockItem.id, { name: String(blockItem.name || ""), command });
        push({ k: "tool", n: String(blockItem.name || ""), c: command });
      }
    }
  }
  if (userMessages.length === 0) return null;
  return { userMessages, tools: [...tools].slice(0, 20), files: [...files].slice(0, 30), events };
}

function writeJson(target, value) {
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

async function main() {
  const compact = process.argv.includes("--compact");
  const { raw } = await readStdin();
  if (hooksDisabled(compact ? "pre:compact" : "session:end")) process.exit(0);
  const input = normalizeInput(raw);
  if (input.payload.stop_hook_active) process.exit(0);
  if (!input.transcriptPath) process.exit(0);
  const summary = extract(input.transcriptPath);
  if (!summary || summary.userMessages.length < 2) process.exit(0);
  const projectRoot = projectRootOf(input.cwd);
  const isGit = Boolean(git(projectRoot, ["rev-parse", "--show-toplevel"]));
  // Captures land under the repository key so a task worktree and the main
  // checkout share one memory; the project key stays on the record.
  const keys = memoryKeysOf(projectRoot, isGit);
  const [memoryKey] = keys;
  const projectId = projectIdOf(projectRoot, isGit);
  migrateSessions(keys);
  const directory = sessionsDirectory(memoryKey);
  fs.mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    schema_version: 1,
    id: `session-hook-${input.sessionId}`,
    saved_at: now,
    repository_id: memoryKey === projectId ? "" : memoryKey,
    project_id: projectId,
    project_path: projectRoot,
    project_name: path.basename(projectRoot),
    task_id: "",
    branch: git(projectRoot, ["branch", "--show-current"]),
    worktree: projectRoot,
    source: "hook",
    // Heuristics wrote this, so nothing here is confirmed until the agent
    // confirms it through save_session(confirm_hook_draft: true).
    confirmed: false,
    confirmed_from: "",
    client: process.argv.includes("--cursor") ? "cursor" : "claude-code",
    session_id: input.sessionId,
    topic: summary.userMessages[0].slice(0, 120),
    building: `Requests in this session (${summary.userMessages.length}):\n${summary.userMessages.slice(-8).map((item) => `- ${item}`).join("\n")}`,
    worked: [],
    failed: [],
    untried: [],
    // Repository-relative and POSIX-separated: the record is read back by the
    // server and by session-start on any platform.
    files: summary.files.map((filePath) => ({ path: path.isAbsolute(filePath) ? relativePosix(projectRoot, filePath) : String(filePath).replaceAll("\\", "/"), status: "in_progress", notes: "touched this session (hook capture)" })),
    decisions: [],
    blockers: [],
    next_step: "",
    environment: "",
    tools_used: summary.tools,
    captured_by: compact ? "pre-compact" : "stop"
  };
  writeJson(path.join(directory, `hook-${input.sessionId}.json`), record);
  // The observation log is rewritten whole on every capture: the transcript is
  // append-only and read from the top, so the newest file is the complete one.
  writeJson(path.join(directory, `observe-${input.sessionId}.json`), {
    schema_version: 1,
    session_id: input.sessionId,
    updated_at: now,
    project_path: projectRoot,
    project_id: projectId,
    repository_id: memoryKey === projectId ? "" : memoryKey,
    client: record.client,
    events: summary.events
  });
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev session-end] error: ${error.message}\n`);
  process.exit(0);
});

#!/usr/bin/env node
// Stop: read what the turn cost out of the transcript and write it to the usage
// ledger (`~/.ai-dev/state/usage/events.jsonl`), so `usage_report` can show cost
// per day, per model and per task without the client reporting anything.
//
// Tokens only, no prices: the ledger stores `input_tokens`, `output_tokens`,
// `cache_read_tokens` and `cache_creation_tokens` per model and leaves
// `cost_usd` at 0. The server prices them at read time from the rate table in
// `src/core/usage-ledger.mjs` (overridable in `.ai-dev/policy.json`), so a price
// change re-prices history instead of freezing yesterday's rate into the ledger.
//
// The transcript cursor is a byte offset kept per session, so the same message
// is never billed twice however often Stop fires.
import fs from "node:fs";
import path from "node:path";
import { activeTaskFor, appendUsageEvents, hooksDisabled, normalizeInput, projectRootOf, readJson, readStdin, stateRoot, sumAssistantUsage } from "./lib.mjs";

function cursorFile(sessionId) {
  return path.join(stateRoot(), "usage", "sessions", `${sessionId}.json`);
}

function readCursor(sessionId, transcriptPath) {
  const state = readJson(cursorFile(sessionId), null);
  // A cursor that belongs to another transcript says nothing about this one.
  if (!state || state.transcript !== transcriptPath) return 0;
  return Math.max(0, Number(state.offset) || 0);
}

function writeCursor(sessionId, transcriptPath, offset) {
  const target = cursorFile(sessionId);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ transcript: transcriptPath, offset, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
  } catch {
    // Without a cursor the next run re-reads from the same place; the ledger
    // would double-count, so a failure here is worth one stderr line.
    process.stderr.write(`[ai-dev cost-capture] could not record the transcript cursor for ${sessionId}\n`);
  }
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("stop:cost-capture")) process.exit(0);
  const input = normalizeInput(raw);
  // Cursor sends conversation_id, not a transcript: nothing to read there yet.
  if (!input.transcriptPath) process.exit(0);
  // `stop_hook_active` (a Stop that follows a blocking hook) is not skipped the
  // way session-end skips it: the capture is a delta, so running it again costs
  // nothing and skipping it would only postpone the same numbers.
  const offset = readCursor(input.sessionId, input.transcriptPath);
  const summary = sumAssistantUsage(input.transcriptPath, { fromOffset: offset });
  // The cursor moves before the events are written, so a failed append
  // undercounts rather than billing the same turn twice on the next Stop.
  if (summary.offset !== offset) writeCursor(input.sessionId, input.transcriptPath, summary.offset);
  if (!summary.models.length) process.exit(0);
  const projectRoot = projectRootOf(input.cwd);
  const task = activeTaskFor(projectRoot);
  const at = new Date().toISOString();
  appendUsageEvents(summary.models.map((row) => ({
    at,
    kind: "usage",
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    // Priced by the server from the rate table, not here: see the header.
    cost_usd: 0,
    duration_ms: 0,
    turns: row.messages,
    task_id: String(task?.id || ""),
    project_path: projectRoot,
    session_id: input.sessionId,
    source: "hook:cost-capture",
    note: ""
  })));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev cost-capture] error: ${error.message}\n`);
  process.exit(0);
});

#!/usr/bin/env node
// PreToolUse (Edit|Write): strategic-compaction advisor. Two signals: the real
// context size from the transcript's newest assistant usage record (primary)
// and a per-session tool-call counter (secondary). Every threshold comes from
// `.ai-dev/policy.json`. Suggests /compact at a logical boundary; never blocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compactSettings,
  contextThresholdFor,
  contextWindowFor,
  emitContext,
  hooksDisabled,
  latestAssistantUsage,
  loadPolicy,
  normalizeInput,
  profileAllows,
  projectRootOf,
  readStdin
} from "./lib.mjs";

function counter(file) {
  let count = 1;
  try {
    count = (Number.parseInt(fs.readFileSync(file, "utf8"), 10) || 0) + 1;
  } catch {
    count = 1;
  }
  try {
    fs.writeFileSync(file, String(count));
  } catch {
    // Counter is best-effort.
  }
  return count;
}

/** Advise once per `interval` tokens past the threshold, not on every edit. */
function bucketReached(file, bucket) {
  let last = -1;
  try {
    last = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
  } catch {
    last = -1;
  }
  if (!(bucket > last)) return false;
  try {
    fs.writeFileSync(file, String(bucket));
  } catch {
    // Best-effort: at worst the same advice repeats.
  }
  return true;
}

function contextAdvice(usage, settings, sessionId) {
  const window = contextWindowFor(usage.model, usage.tokens, settings.context_window);
  const threshold = contextThresholdFor(settings, window);
  if (!(threshold > 0) || usage.tokens < threshold) return "";
  const bucket = Math.floor((usage.tokens - threshold) / settings.context_interval);
  if (!bucketReached(path.join(os.tmpdir(), `ai-dev-context-bucket-${sessionId}`), bucket)) return "";
  const share = Math.round((usage.tokens / window) * 100);
  return `[ai-dev compact] Context ~${Math.round(usage.tokens / 1000)}k tokens (${share}% of ${Math.round(window / 1000)}k). Finish the current edit, checkpoint_task, save_session, then /compact at this phase boundary.`;
}

async function main() {
  const { raw } = await readStdin();
  if (hooksDisabled("pre:edit:compact-advisor")) process.exit(0);
  const input = normalizeInput(raw);
  const policy = loadPolicy(projectRootOf(input.cwd));
  if (!profileAllows(policy.profile, ["standard", "strict"])) process.exit(0);
  const settings = compactSettings(policy);
  const messages = [];
  const usage = latestAssistantUsage(input.transcriptPath);
  if (usage) {
    const advice = contextAdvice(usage, settings, input.sessionId);
    if (advice) messages.push(advice);
  }
  const count = counter(path.join(os.tmpdir(), `ai-dev-tool-count-${input.sessionId}`));
  if (count === settings.tool_threshold) messages.push(`[ai-dev compact] ${settings.tool_threshold} tool calls in this session; if you are between phases, save_session and /compact.`);
  else if (count > settings.tool_threshold && (count - settings.tool_threshold) % settings.tool_interval === 0) messages.push(`[ai-dev compact] ${count} tool calls; good checkpoint for /compact if the context is stale.`);
  if (messages.length) emitContext("PreToolUse", messages.join("\n"));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[ai-dev compact] error: ${error.message}\n`);
  process.exit(0);
});

import { listDecisions, summarizeDecisions } from "./decision-ledger.mjs";
import { InstinctStore } from "./instincts.mjs";
import { SessionStore, hookDraftCaveat, isHookDraft, sessionAgeDays } from "./session-memory.mjs";

/**
 * Extra context-pack sections contributed by optional subsystems (decision
 * ledger, learned instincts, session handoff, ...). Each provider receives the
 * same input and returns `null` or `{ id, title, markdown, items }`.
 *
 * Providers must be cheap, read-only, and must never throw: a broken provider
 * is reported as an `unknown` entry instead of failing `begin_task`.
 */
export const CONTEXT_EXTRA_PROVIDERS = [
  decisionsContextProvider,
  handoffContextProvider,
  instinctsContextProvider
];

/**
 * Recent architecture decisions from `<projectRoot>/.ai-dev/decisions`.
 *
 * @param {{ projectRoot: string }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function decisionsContextProvider({ projectRoot }) {
  const decisions = await listDecisions(projectRoot, { limit: 20 });
  const markdown = summarizeDecisions(decisions, 5);
  if (!markdown) return null;
  return {
    id: "decisions",
    title: "Recent Decisions",
    markdown,
    items: decisions.slice(0, 5).map((item) => ({ id: item.id, title: item.title, status: item.status, path: item.path }))
  };
}

/**
 * Latest substantive session handoff for the project: next step, blockers,
 * and approaches that already failed (so they are not retried).
 *
 * @param {{ stateRoot?: string, repositoryId?: string, projectId?: string }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function handoffContextProvider({ stateRoot, repositoryId, projectId }) {
  if (!stateRoot || !(repositoryId || projectId)) return null;
  const record = await new SessionStore({ stateRoot }).latest({ repositoryId, projectId });
  if (!record) return null;
  const age = sessionAgeDays(record);
  // The newest record may be a hook capture nobody confirmed. It still carries
  // more than nothing, but the pack must not present heuristics as fact.
  const draft = isHookDraft(record);
  const lines = [
    ...(draft ? [`- ${hookDraftCaveat(record)}`] : []),
    `- Saved ${record.saved_at}${age > 7 ? ` (WARNING: ${Math.floor(age)} days ago; verify against git before trusting it)` : ""}${record.task_id ? `, task ${record.task_id}` : ""}: ${record.topic}`,
    `- Next step: ${record.next_step || "not recorded"}`
  ];
  for (const item of (record.failed ?? []).slice(0, 3)) lines.push(`- Do not retry: ${item.approach} (${item.reason || "reason not recorded"})`);
  for (const item of (record.blockers ?? []).slice(0, 3)) lines.push(`- Blocker: ${item}`);
  lines.push("- Historical reference only: verify the working tree before acting on it.");
  return {
    id: "handoff",
    title: draft ? "Last Session Handoff (unconfirmed hook draft)" : "Last Session Handoff",
    markdown: lines.join("\n"),
    items: [{ id: record.id, saved_at: record.saved_at, task_id: record.task_id, unconfirmed: draft }]
  };
}

/**
 * High-confidence learned instincts relevant to this project, stack, and task.
 *
 * @param {{ stateRoot?: string, repositoryId?: string, projectId?: string, task?: string, stack?: string[] }} input
 * @returns {Promise<{ id: string, title: string, markdown: string, items: object[] } | null>}
 */
export async function instinctsContextProvider({ stateRoot, repositoryId, projectId, task, stack = [] }) {
  if (!stateRoot) return null;
  const ranked = await new InstinctStore({ stateRoot }).rankForContext({ repositoryId, projectId, stack, task });
  if (!ranked.instincts.length) return null;
  return {
    id: "instincts",
    title: "Learned Instincts",
    markdown: ranked.markdown,
    items: ranked.instincts.map((item) => ({ id: item.id, confidence: item.effective_confidence, scope: item.scope }))
  };
}

/**
 * Run every registered provider and collect the sections a context pack should
 * render after the routed skills. Errors are captured per provider.
 *
 * Memory-backed providers are keyed by `repositoryId` (shared by every worktree
 * of one clone) and fall back to `projectId` for records written before it.
 *
 * @param {{ projectRoot: string, stateRoot?: string, repositoryId?: string, projectId?: string, task?: string, stack?: string[], providers?: Function[] }} input
 * @returns {Promise<{ sections: object[], errors: string[] }>}
 */
export async function loadContextExtras({ projectRoot, stateRoot = "", repositoryId = "", projectId = "", task = "", stack = [], providers = CONTEXT_EXTRA_PROVIDERS }) {
  const sections = [];
  const errors = [];
  for (const provider of providers) {
    try {
      const section = await provider({ projectRoot, stateRoot, repositoryId, projectId, task, stack });
      if (section?.markdown) sections.push(section);
    } catch (error) {
      errors.push(`${provider.name || "provider"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sections, errors };
}

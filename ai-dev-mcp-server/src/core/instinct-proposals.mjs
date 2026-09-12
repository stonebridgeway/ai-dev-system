import { initialConfidence } from "./instincts.mjs";

/**
 * Instinct proposals: what a session's observation log says about how this
 * project is actually worked on.
 *
 * The `session-end` hook records raw events — what the user said, what tools
 * ran with what, which calls came back as errors — and this module turns them
 * into candidate instincts. It ports the deterministic half of ECC's
 * continuous-learning-v2 observer (`agents/observer.md`: user corrections,
 * error then resolution, repeated workflows, confidence from the observation
 * count) to run over a saved log instead of a background process.
 *
 * The half that is not ported is the half that needs a model. A correction is
 * detected here, but the rule behind it is the user's own sentence, not a
 * paraphrase this module invented: every proposal quotes what it saw, carries
 * `status: "proposed"`, and waits for `update_instinct` to confirm it.
 */

/** The event kinds the hook writes. */
export const OBSERVATION_EVENT_KINDS = Object.freeze(["user", "tool", "error"]);

/**
 * The file the `session-end` hook writes beside a draft record.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function observationsFileName(sessionId) {
  return `observe-${String(sessionId || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
}

/** How many times something has to happen before it is a pattern rather than an event. */
export const PROPOSAL_THRESHOLDS = Object.freeze({ correction: 1, rule: 1, error: 2, command: 3, chain: 2 });

/** A proposal is a guess: its confidence never reaches the level that would inject it into a context pack. */
const MAX_PROPOSAL_CONFIDENCE = 0.5;

const CORRECTION_CUES = Object.freeze([
  /^(?:no|nope|don'?t|do not|stop|wrong|incorrect|actually|instead)\b/i,
  /\b(?:i said|i asked|that'?s not|not what i|don'?t do that|revert that|undo that|please stop)\b/i,
  /^(?:нет|не надо|не так|стоп|неверно|неправильно)\b/i,
  /\b(?:я (?:же )?(?:просил|сказал|говорил)|вместо этого|не то|откати)\b/i
]);

const RULE_CUES = Object.freeze([
  /\b(?:always|never|from now on|going forward|prefer|don'?t ever)\b/i,
  /\buse\s+.{1,40}?\s+instead of\b/i,
  /\b(?:всегда|никогда|впредь|предпочитай|по умолчанию)\b/i,
  /\bвместо\s+.{1,40}?\s+использу/i
]);

/** The condition half of a stated rule, when the sentence carries one: the word that introduces it, then the clause. */
const CONDITION_CLAUSE = /\b(whenever|when|if|before|after|если|когда|при|перед)\b\s+(.{3,120}?)(?:\s*[,.;]|$)/i;
/** "before you push" stays "before you push"; the rest become "when …". */
const KEPT_CONDITION_WORDS = new Set(["before", "after", "перед"]);

/** What a command is for, which is what an instinct about it triggers on. */
const COMMAND_PURPOSES = Object.freeze([
  { pattern: /\b(?:test|spec|pytest|jest|vitest|rspec|minitest)\b|\b(?:go|cargo|dotnet|swift)\s+test\b/i, purpose: "the tests are run", domain: "testing" },
  { pattern: /\b(?:lint|eslint|ruff|clippy|rubocop|flake8|biome|ktlint|detekt|phpstan|psalm)\b/i, purpose: "the code is linted", domain: "code-style" },
  { pattern: /\b(?:fmt|format|prettier|gofmt|black)\b/i, purpose: "the code is formatted", domain: "code-style" },
  { pattern: /\b(?:build|compile|tsc|webpack|rollup|esbuild)\b/i, purpose: "the project is built", domain: "tooling" },
  { pattern: /^\s*git\b/i, purpose: "git state is read or changed", domain: "git" },
  { pattern: /\b(?:install|ci|add|remove|sync|update|upgrade)\b/i, purpose: "dependencies change", domain: "tooling" },
  { pattern: /\b(?:migrate|migration|alembic|prisma)\b/i, purpose: "the database schema changes", domain: "tooling" },
  { pattern: /\b(?:docker|compose|kubectl|helm|terraform)\b/i, purpose: "the deployment is touched", domain: "tooling" }
]);

/** Domain guessed from the words of a request, for proposals that come from prose. */
const PROSE_DOMAINS = Object.freeze([
  { pattern: /\b(?:test|spec|coverage)|тест|покрыти/i, domain: "testing" },
  { pattern: /\b(?:commit|branch|rebase|merge|push)|коммит|ветк/i, domain: "git" },
  { pattern: /\b(?:secret|token|auth|password|vulnerab)|секрет|парол|безопасн/i, domain: "security" },
  { pattern: /\b(?:style|naming|format|lint)|стиль|именован|формат/i, domain: "code-style" },
  { pattern: /\b(?:doc|readme|changelog)|документ/i, domain: "documentation" },
  { pattern: /\b(?:error|fail|bug|crash)|ошибк|падает|сбо/i, domain: "debugging" },
  { pattern: /\b(?:architect|module|layer|depend)|архитектур|модул|слой/i, domain: "architecture" }
]);

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

function domainOf(value) {
  return PROSE_DOMAINS.find((item) => item.pattern.test(value))?.domain ?? "general";
}

function purposeOf(command) {
  return COMMAND_PURPOSES.find((item) => item.pattern.test(command)) ?? { purpose: "this step is needed", domain: "tooling" };
}

/**
 * Split a sentence into the condition it names and the behaviour it asks for.
 * A sentence with no condition gets the repository as its trigger: the
 * instinct is still true, it is just true everywhere.
 *
 * @param {string} sentence
 * @param {string} [projectName]
 * @returns {{ trigger: string, action: string }}
 */
export function splitStatedRule(sentence, projectName = "") {
  const cleaned = text(sentence);
  const where = projectName ? `when working in ${projectName}` : "when working in this repository";
  const match = cleaned.match(CONDITION_CLAUSE);
  if (!match) return { trigger: where, action: cleaned };
  const word = text(match[1]).toLowerCase();
  const condition = text(match[2]);
  const rest = text(cleaned.replace(match[0], " "));
  if (!condition || rest.length < 4) return { trigger: where, action: cleaned };
  return { trigger: KEPT_CONDITION_WORDS.has(word) ? `${word} ${condition}` : `when ${condition}`, action: rest };
}

/** The stable part of an error message: its first line, with paths, numbers and quoted values generalised. */
export function errorSignature(message) {
  const first = text(String(message ?? "").split("\n")[0]);
  return first
    .replace(/(?:[A-Za-z]:)?[/\\][^\s'"`]+/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "<value>")
    .slice(0, 160);
}

function proposal({ kind, trigger, action, domain, observations, note }) {
  return {
    kind,
    trigger: text(trigger).slice(0, 200),
    action: text(action).slice(0, 300),
    domain,
    observations,
    confidence: Math.min(MAX_PROPOSAL_CONFIDENCE, initialConfidence(observations)),
    note: text(note).slice(0, 300)
  };
}

function correctionProposals(events, projectName) {
  const proposals = [];
  let acted = false;
  for (const event of events) {
    if (event.k === "tool") acted = true;
    if (event.k !== "user") continue;
    const said = text(event.t);
    // A correction only means something after the agent has done something to
    // correct: the first message of a session is a request, not a rebuke.
    if (!acted || !said || !matchesAny(CORRECTION_CUES, said)) continue;
    const { trigger, action } = splitStatedRule(said, projectName);
    proposals.push(proposal({
      kind: "correction",
      trigger,
      action,
      domain: domainOf(said),
      observations: PROPOSAL_THRESHOLDS.correction,
      note: `The user corrected the agent: "${said}"`
    }));
  }
  return proposals;
}

function ruleProposals(events, projectName) {
  const proposals = [];
  for (const event of events) {
    if (event.k !== "user") continue;
    const said = text(event.t);
    if (!said || !matchesAny(RULE_CUES, said)) continue;
    // Only the sentence that carries the rule, not the whole message.
    const sentence = said.split(/(?<=[.!?;])\s+/).find((part) => matchesAny(RULE_CUES, part)) ?? said;
    const { trigger, action } = splitStatedRule(sentence, projectName);
    proposals.push(proposal({
      kind: "stated_rule",
      trigger,
      action,
      domain: domainOf(sentence),
      observations: PROPOSAL_THRESHOLDS.rule,
      note: `The user stated a rule: "${text(sentence)}"`
    }));
  }
  return proposals;
}

function errorProposals(events) {
  const failures = new Map();
  const failedCommands = new Set();
  for (const [index, event] of events.entries()) {
    if (event.k !== "error") continue;
    const signature = errorSignature(event.t);
    if (!signature) continue;
    const entry = failures.get(signature) ?? { signature, tool: text(event.n), command: text(event.c), count: 0, lastIndex: 0 };
    entry.count += 1;
    entry.lastIndex = index;
    failures.set(signature, entry);
    if (event.c) failedCommands.add(`${text(event.n)}::${text(event.c)}`);
  }
  const proposals = [];
  for (const entry of failures.values()) {
    if (entry.count < PROPOSAL_THRESHOLDS.error) continue;
    // What cleared it: the next call of the same tool, after the last failure,
    // with a command that never failed itself.
    const resolution = events.slice(entry.lastIndex + 1).find((event) => (
      event.k === "tool"
      && text(event.n) === entry.tool
      && text(event.c)
      && text(event.c) !== entry.command
      && !failedCommands.has(`${text(event.n)}::${text(event.c)}`)
    ));
    if (!resolution) continue;
    proposals.push(proposal({
      kind: "resolved_error",
      trigger: `when ${entry.tool || "a command"} fails with "${entry.signature}"`,
      action: `run \`${text(resolution.c)}\``,
      domain: "debugging",
      observations: entry.count,
      note: `Failed ${entry.count} times${entry.command ? ` on \`${entry.command}\`` : ""}; the next call that did not fail was \`${text(resolution.c)}\`.`
    }));
  }
  return proposals;
}

/** Joins two commands into one Map key. A newline cannot appear in a clipped command, so the split is exact. */
const CHAIN_SEPARATOR = "\n";

function commandProposals(events) {
  const commands = events
    .filter((event) => event.k === "tool" && event.n === "Bash" && text(event.c))
    .map((event) => text(event.c));
  const proposals = [];

  const counts = new Map();
  for (const command of commands) counts.set(command, (counts.get(command) ?? 0) + 1);
  for (const [command, count] of counts) {
    if (count < PROPOSAL_THRESHOLDS.command) continue;
    const { purpose, domain } = purposeOf(command);
    proposals.push(proposal({
      kind: "repeated_command",
      trigger: `when ${purpose} in this project`,
      action: `run \`${command}\``,
      domain,
      observations: count,
      note: `Run ${count} times in one session.`
    }));
  }

  const chains = new Map();
  for (let index = 0; index + 1 < commands.length; index += 1) {
    if (commands[index] === commands[index + 1]) continue;
    const key = `${commands[index]}${CHAIN_SEPARATOR}${commands[index + 1]}`;
    chains.set(key, (chains.get(key) ?? 0) + 1);
  }
  for (const [key, count] of chains) {
    if (count < PROPOSAL_THRESHOLDS.chain) continue;
    const [first, second] = key.split(CHAIN_SEPARATOR);
    const { purpose, domain } = purposeOf(first);
    proposals.push(proposal({
      kind: "repeated_chain",
      trigger: `when ${purpose} in this project`,
      action: `run \`${first}\`, then \`${second}\``,
      domain,
      observations: count,
      note: `The pair ran ${count} times in a row in one session.`
    }));
  }
  return proposals;
}

/**
 * Candidate instincts from one session's observation log.
 *
 * Ordered by how many observations back them, then by kind, and deduplicated
 * on trigger and action so one repeated correction yields one candidate.
 *
 * @param {{ events?: Array<{ k: string, n?: string, c?: string, t?: string }>, projectName?: string, limit?: number }} [input]
 * @returns {{ proposals: object[], signals: { events: number, user_messages: number, tool_calls: number, errors: number } }}
 */
export function proposeInstincts({ events = [], projectName = "", limit = 10 } = {}) {
  const clean = (Array.isArray(events) ? events : []).filter((event) => OBSERVATION_EVENT_KINDS.includes(event?.k));
  const all = [
    ...correctionProposals(clean, projectName),
    ...ruleProposals(clean, projectName),
    ...errorProposals(clean),
    ...commandProposals(clean)
  ].filter((item) => item.trigger && item.action);

  const merged = new Map();
  for (const item of all) {
    const key = `${item.trigger} ${item.action}`.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    existing.observations += item.observations;
    existing.confidence = Math.min(MAX_PROPOSAL_CONFIDENCE, initialConfidence(existing.observations));
  }
  const order = ["correction", "stated_rule", "resolved_error", "repeated_chain", "repeated_command"];
  const proposals = [...merged.values()]
    .sort((left, right) => right.observations - left.observations
      || order.indexOf(left.kind) - order.indexOf(right.kind)
      || left.action.localeCompare(right.action))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));

  return {
    proposals,
    signals: {
      events: clean.length,
      user_messages: clean.filter((event) => event.k === "user").length,
      tool_calls: clean.filter((event) => event.k === "tool").length,
      errors: clean.filter((event) => event.k === "error").length
    }
  };
}

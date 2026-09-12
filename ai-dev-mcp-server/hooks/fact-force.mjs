// Fact forcing for the PreToolUse guard: the first edit of a file in a session,
// and the first destructive command, are refused once until the agent has put
// the grounding on the record.
//
// Ported from ECC's `gateguard-fact-force.js`, which denies the first Write or
// Edit of each file with a four-fact demand (importers, affected API, data
// schema, quoted instruction) and the first destructive Bash command with a
// demand for a rollback line. The mechanics we keep: per-session state with an
// expiry, a cap on entries, damping after a few refusals, exempt globs, and
// failing open when the state cannot be read or written.
//
// What we do not keep is an unverifiable demand. A refusal the agent answers by
// repeating the call teaches nothing, so the facts are checked where they can
// be seen: the transcript the harness is already writing. The refusal quotes
// the exact block to write, the agent writes it in the turn that retries the
// edit, and the retry passes. Where there is no transcript (Cursor sends a
// conversation id, not a path), the gate cannot see and does not judge.
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./lib.mjs";

/** The four facts an edit has to rest on, in the order the demand prints them. */
export const FACT_KEYS = Object.freeze(["importers", "api", "data", "instruction"]);

/** How much of the transcript tail is searched for the facts. */
export const FACT_TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Shortest answer that counts as an answer rather than a shrug. */
/** Whitespace that is not a line break: `\s` would let an empty key borrow the next line's text. */
const HORIZONTAL = "[^\\S\\r\\n]";

const MIN_FACT_LENGTH = 3;
const MIN_ROLLBACK_LENGTH = 10;

/**
 * Commands that change something outside the working tree and cannot be undone
 * with an editor. The hard guard already blocks the irreversible ones
 * (`rm -rf`, `git reset --hard`, `git push --force`); these are the ones that
 * are allowed to run, and are worth one sentence about how to get back.
 */
export const DESTRUCTIVE_COMMANDS = Object.freeze([
  { id: "file-removal", pattern: /(?:^|\s)(?:rm|rmdir|unlink|shred)\s/, what: "deletes files" },
  { id: "file-move", pattern: /(?:^|\s)(?:mv|rename)\s/, what: "moves files" },
  { id: "in-place-edit", pattern: /\bsed\s+(?:-[a-zA-Z]+\s+)*-i\b|\bperl\s+-[a-zA-Z]*i[a-zA-Z]*\s/, what: "rewrites files in place" },
  { id: "history-rewrite", pattern: /\bgit\s+(?:[^|;&]*\s)?(?:commit\s+[^|;&]*--amend|rebase|revert|reset|filter-branch)\b/, what: "rewrites git history" },
  { id: "publish", pattern: /\bgit\s+(?:[^|;&]*\s)?push\b/, what: "publishes commits" },
  { id: "dependency-change", pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|uninstall|update|upgrade)\b|\bpip3?\s+(?:install|uninstall)\b|\bpoetry\s+(?:add|remove|update)\b|\buv\s+(?:add|remove|sync)\b|\bcargo\s+(?:add|remove|update)\b|\bgo\s+get\b|\bbundle\s+(?:install|update)\b/, what: "changes dependencies" },
  { id: "migration", pattern: /\b(?:alembic|flyway|liquibase)\b|\bprisma\s+migrate\b|\bknex\s+migrate\b|\bsequelize\s+db:migrate\b|\b(?:rails|rake)\s+db:|\bmanage\.py\s+migrate\b/, what: "migrates a database" },
  { id: "database-write", pattern: /\b(?:psql|mysql|sqlite3|mongosh?)\b[^|;&]*\s(?:-c|-e|--eval|--command)\b|\bredis-cli\s+[^|;&]*\bflush/, what: "writes to a database" },
  { id: "infrastructure", pattern: /\bterraform\s+(?:apply|destroy)\b|\bkubectl\s+(?:apply|patch|scale|rollout|replace)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bdocker\s+(?:rm|rmi|stop|kill)\b|\bdocker(?:\s+compose|-compose)\s+(?:down|rm|stop)\b/, what: "changes deployed infrastructure" },
  { id: "permissions", pattern: /\bch(?:mod|own|grp)\s/, what: "changes file permissions" },
  { id: "service-control", pattern: /\b(?:systemctl|service|launchctl)\s+(?:start|stop|restart|reload|enable|disable)\b|\bpkill\b|\bkill\s+-9\b/, what: "stops or restarts a service" }
]);

/**
 * Defaults for the `fact_force` block of `.ai-dev/policy.json`. The gate is off
 * unless a project turns it on; `defaultPolicy("strict")` does.
 */
export const FACT_FORCE_DEFAULTS = Object.freeze({
  enabled: false,
  files: true,
  bash: true,
  expiry_minutes: 30,
  max_denials: 3,
  max_entries: 500,
  exempt_globs: ["**/*.md", "**/*.txt", "**/*.lock", "**/*.snap", ".ai-dev/**", ".claude/**", ".cursor/**"]
});

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Settings for this project: policy first, then `AI_DEV_FACT_FORCE` (`1`/`0`)
 * and `AI_DEV_FACT_FORCE_EXEMPT` (comma-separated globs, added to the policy's).
 *
 * @param {object} [policy] - From `loadPolicy`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {typeof FACT_FORCE_DEFAULTS}
 */
export function factForceSettings(policy = {}, env = process.env) {
  const configured = policy.fact_force && typeof policy.fact_force === "object" ? policy.fact_force : {};
  const override = String(env.AI_DEV_FACT_FORCE ?? "").toLowerCase();
  const enabled = ["1", "true", "on", "yes"].includes(override) ? true
    : ["0", "false", "off", "no"].includes(override) ? false
      : configured.enabled === true;
  const extra = String(env.AI_DEV_FACT_FORCE_EXEMPT ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const globs = Array.isArray(configured.exempt_globs) ? configured.exempt_globs.map(String) : [...FACT_FORCE_DEFAULTS.exempt_globs];
  return {
    enabled,
    files: configured.files !== false,
    bash: configured.bash !== false,
    expiry_minutes: positiveNumber(configured.expiry_minutes, FACT_FORCE_DEFAULTS.expiry_minutes),
    max_denials: positiveNumber(configured.max_denials, FACT_FORCE_DEFAULTS.max_denials),
    max_entries: positiveNumber(configured.max_entries, FACT_FORCE_DEFAULTS.max_entries),
    exempt_globs: [...globs, ...extra]
  };
}

/**
 * Match one `*`/`**`/`?` glob against a repository-relative path. `*` stops at a
 * separator, `**` does not.
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesGlob(pattern, value) {
  let source = "";
  const text = String(pattern ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "*") {
      if (text[index + 1] === "*") {
        // `**/` also matches nothing, so `**/*.md` covers a file at the root.
        if (text[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    source += char === "?" ? "[^/]" : char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`).test(String(value ?? ""));
  } catch {
    return false;
  }
}

/**
 * @param {string} relativePath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function isExempt(relativePath, globs = []) {
  return globs.some((glob) => matchesGlob(glob, relativePath));
}

/**
 * The assistant's own words from the tail of a transcript, newest last. The
 * turn that carries a tool call is already written when PreToolUse runs, so the
 * facts and the edit can travel together.
 *
 * @param {string} transcriptPath
 * @param {number} [tailBytes]
 * @returns {string}
 */
export function assistantTextTail(transcriptPath, tailBytes = FACT_TRANSCRIPT_TAIL_BYTES) {
  if (!transcriptPath) return "";
  let text = "";
  let partialFirstLine = false;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - Math.max(1024, tailBytes));
      partialFirstLine = start > 0;
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  const lines = text.split("\n");
  if (partialFirstLine) lines.shift();
  const said = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const isAssistant = entry?.type === "assistant" || entry?.message?.role === "assistant" || entry?.role === "assistant";
    if (!isAssistant) continue;
    const content = entry.message?.content ?? entry.content;
    if (typeof content === "string") said.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") said.push(part);
        else if (part?.type === "text" && typeof part.text === "string") said.push(part.text);
      }
    }
  }
  return said.join("\n");
}

/** The `FACTS <path>` block the demand asks for, as a regular expression over one file. */
function factBlocksFor(text, relativePath) {
  const base = path.posix.basename(relativePath);
  const blocks = [];
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^[-*>#\s]*(?:\*\*)?FACTS(?:\*\*)?\s+(\S+)\s*$/i);
    if (!header) continue;
    const named = header[1].replaceAll("\\", "/").replace(/^[`"']|[`"']$/g, "");
    if (named !== relativePath && path.posix.basename(named) !== base) continue;
    blocks.push(lines.slice(index + 1, index + 1 + FACT_KEYS.length * 3).join("\n"));
  }
  return blocks;
}

/**
 * Which of the four facts the agent has stated for a file, and which are still
 * missing. A block is read from the lines that follow its `FACTS <path>` header.
 *
 * @param {string} text - Assistant text, from {@link assistantTextTail}.
 * @param {string} relativePath
 * @returns {{ stated: string[], missing: string[] }}
 */
export function factsFor(text, relativePath) {
  const stated = new Set();
  for (const block of factBlocksFor(text, relativePath)) {
    for (const key of FACT_KEYS) {
      const match = block.match(new RegExp(`^${HORIZONTAL}*(?:[-*]${HORIZONTAL}*)?(?:\\*\\*)?${key}(?:\\*\\*)?${HORIZONTAL}*:${HORIZONTAL}*(.+)$`, "im"));
      const value = (match?.[1] ?? "").replace(/[`"'*\s]+$/g, "").trim();
      if (value.length >= MIN_FACT_LENGTH) stated.add(key);
    }
  }
  return { stated: FACT_KEYS.filter((key) => stated.has(key)), missing: FACT_KEYS.filter((key) => !stated.has(key)) };
}

/**
 * Whether the agent has stated how to undo what it is about to run.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function rollbackStated(text) {
  const match = String(text ?? "").match(new RegExp(`^(?:[-*>#]|${HORIZONTAL})*(?:\\*\\*)?ROLLBACK(?:\\*\\*)?${HORIZONTAL}*:${HORIZONTAL}*(.+)$`, "im"));
  return (match?.[1] ?? "").trim().length >= MIN_ROLLBACK_LENGTH;
}

/** Where one session's guard state lives. */
export function guardStatePath(sessionId) {
  const name = String(sessionId || "default").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
  return path.join(stateRoot(), "guard", `${name}.json`);
}

/**
 * Read the session's state, dropping entries older than the expiry and keeping
 * the newest `max_entries` files. Unreadable state reads as empty: the gate
 * fails open rather than refusing work it cannot account for.
 *
 * @param {string} sessionId
 * @param {typeof FACT_FORCE_DEFAULTS} settings
 * @param {number} [now]
 * @returns {{ files: Record<string, number>, bash: number, denials: number }}
 */
export function readGuardState(sessionId, settings, now = Date.now()) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(guardStatePath(sessionId), "utf8"));
  } catch {
    parsed = null;
  }
  const horizon = now - settings.expiry_minutes * 60_000;
  const entries = Object.entries(parsed?.files ?? {})
    .map(([key, at]) => [key, Number(at) || 0])
    .filter(([, at]) => at > horizon)
    .sort((left, right) => right[1] - left[1])
    .slice(0, settings.max_entries);
  const bash = Number(parsed?.bash) || 0;
  return {
    files: Object.fromEntries(entries),
    bash: bash > horizon ? bash : 0,
    denials: Number(parsed?.denials) || 0
  };
}

/**
 * Persist the session's state. Best effort: a state root that cannot be written
 * (a read-only home, a sandbox) leaves the gate open instead of blocking every
 * edit for the rest of the session.
 *
 * @param {string} sessionId
 * @param {{ files: Record<string, number>, bash: number, denials: number }} state
 * @returns {boolean} Whether it was written.
 */
export function writeGuardState(sessionId, state) {
  const target = guardStatePath(sessionId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

function factsDemand(relativePath, missing) {
  return [
    `BLOCKED (fact_force): this is the first edit of ${relativePath} in this session, and the facts behind it are not on the record.`,
    "Write this block in your next message, then repeat the edit:",
    "",
    `FACTS ${relativePath}`,
    "importers: which files import or call it (or \"none\")",
    "api: the exported behaviour this edit changes (or \"none\")",
    "data: the data shape it reads or writes (or \"none\")",
    "instruction: \"the words of the request this serves\"",
    "",
    `Missing: ${missing.join(", ")}.`,
    "Set fact_force.enabled to false in .ai-dev/policy.json to turn this gate off."
  ].join("\n");
}

function rollbackDemand(what) {
  return [
    `BLOCKED (fact_force): this is the first command of this session that ${what}, and there is no way back on the record.`,
    "Write this line in your next message, then repeat the command:",
    "",
    "ROLLBACK: the command or steps that put this back",
    "",
    "Set fact_force.enabled to false in .ai-dev/policy.json to turn this gate off."
  ].join("\n");
}

/** The first destructive thing a command does, or null. */
export function destructiveIntent(command) {
  const text = String(command ?? "");
  for (const rule of DESTRUCTIVE_COMMANDS) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

/**
 * Decide a single guard call. Pure: every read and write of the world is passed
 * in, so the whole decision table is testable without a transcript or a home
 * directory.
 *
 * @param {object} input
 * @param {"bash" | "file"} input.mode
 * @param {string[]} [input.targets] - Repository-relative paths, for `file`.
 * @param {string} [input.command] - For `bash`.
 * @param {string} input.said - Assistant text, from {@link assistantTextTail}.
 * @param {boolean} input.transcript - Whether `said` came from a readable transcript.
 * @param {typeof FACT_FORCE_DEFAULTS} input.settings
 * @param {{ files: Record<string, number>, bash: number, denials: number }} input.state
 * @param {number} [input.now]
 * @returns {{ deny: string, note: string, state: object, changed: boolean }}
 */
export function decideFactForce({ mode, targets = [], command = "", said = "", transcript = true, settings, state, now = Date.now() }) {
  const next = { files: { ...state.files }, bash: state.bash, denials: state.denials };
  const damped = state.denials >= settings.max_denials;
  const notes = [];
  let deny = "";

  if (mode === "file" && settings.files) {
    for (const relativePath of targets) {
      if (!relativePath || isExempt(relativePath, settings.exempt_globs)) continue;
      if (next.files[relativePath]) continue;
      const { missing } = transcript ? factsFor(said, relativePath) : { missing: [] };
      if (!missing.length || damped || !transcript) {
        next.files[relativePath] = now;
        if (missing.length && damped) notes.push(`fact_force: ${relativePath} was edited without ${missing.join(", ")}; the gate stopped refusing after ${settings.max_denials} refusals this session.`);
        continue;
      }
      deny = factsDemand(relativePath, missing);
      next.denials = state.denials + 1;
      break;
    }
  }

  if (!deny && mode === "bash" && settings.bash) {
    const intent = destructiveIntent(command);
    if (intent && !next.bash) {
      const stated = transcript ? rollbackStated(said) : true;
      if (stated || damped) {
        next.bash = now;
        if (!stated && damped) notes.push(`fact_force: a command that ${intent.what} ran without a rollback line; the gate stopped refusing after ${settings.max_denials} refusals this session.`);
      } else {
        deny = rollbackDemand(intent.what);
        next.denials = state.denials + 1;
      }
    }
  }

  const changed = next.denials !== state.denials
    || next.bash !== state.bash
    || Object.keys(next.files).length !== Object.keys(state.files).length;
  return { deny, note: notes.join("\n"), state: next, changed };
}

/**
 * Run the gate for one guard call: read the transcript and the session state,
 * decide, persist. Any failure below leaves the call alone.
 *
 * @param {object} input
 * @param {"bash" | "file"} input.mode
 * @param {object} input.hookInput - From `normalizeInput`.
 * @param {object} input.policy - From `loadPolicy`.
 * @param {string[]} input.targets - Repository-relative paths, for `file`.
 * @returns {{ deny: string, note: string }}
 */
export function evaluateFactForce({ mode, hookInput, policy, targets }) {
  const settings = factForceSettings(policy);
  if (!settings.enabled) return { deny: "", note: "" };
  try {
    const said = assistantTextTail(hookInput.transcriptPath);
    const state = readGuardState(hookInput.sessionId, settings);
    const decision = decideFactForce({
      mode,
      targets,
      command: hookInput.command,
      said,
      transcript: Boolean(hookInput.transcriptPath && said),
      settings,
      state
    });
    if (decision.changed) writeGuardState(hookInput.sessionId, decision.state);
    return { deny: decision.deny, note: decision.note };
  } catch {
    return { deny: "", note: "" };
  }
}

/**
 * The control API's contract: what each tool of the `control` profile
 * answers, as JSON Schema, and the version of that contract.
 *
 * The desktop app is written against it. The server hands each schema to the
 * client as the tool's `outputSchema` (under `result`, as every tool's answer
 * is), so an MCP SDK client checks every answer it gets against it, and
 * `docs/CONTROL-API.md` is rendered from this module, so the two cannot
 * disagree.
 *
 * The version follows semantic versioning. A new optional field, a new tool or
 * a new value of an open string is a minor change; a field removed, retyped or
 * newly required, or a value removed from an enum, is a major one. Objects
 * allow fields they do not list: a client written against 1.0 reads a 1.1
 * answer.
 */

/** The contract's version; `system_status` answers it as `api_version`. */
export const CONTROL_API_VERSION = "1.3.0";

const string = { type: "string" };
const count = { type: "integer", minimum: 0 };
const boolean = { type: "boolean" };
const strings = { type: "array", items: string };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const list = (items) => ({ type: "array", items });
const choice = (...values) => ({ type: "string", enum: values });

/**
 * An object with these properties, all of them required unless named in
 * `optional`; further properties are allowed.
 */
function object(properties, { optional = [], description } = {}) {
  return {
    type: "object",
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties).filter((name) => !optional.includes(name))
  };
}

/** A setup step, a model file, a client config: each says what happened to it. */
const STEP = object({
  id: string,
  title: string,
  status: choice("done", "skipped", "failed"),
  reason: { type: "string", description: "Why it ran or did not, or what it did." },
  error: string,
  duration_ms: count
}, { optional: ["reason", "error", "duration_ms"] });

const MODEL_STATE = object({
  installed: { type: "boolean", description: "Every file is there and matches the manifest." },
  dir: string,
  model: string,
  revision: string,
  dtype: string,
  present: strings,
  missing: strings,
  mismatched: strings,
  partial: list(object({ file: string, bytes: count, size: nullable(count) })),
  unreadable: { type: "string", description: "Why this user could not read the model at all, when it could not: no file is then counted present or mismatched, and `missing` holds only those not there at all (1.2)." },
  supported: { type: "boolean", description: "Whether the ONNX runtime runs on this machine." },
  support_reason: string
}, { optional: ["unreadable"], description: "Where the local model stands." });

const MODEL_CHANGE = object({
  ready: { type: "boolean", description: "The model is complete and verified after this call." },
  dir: string,
  present: strings,
  missing: strings,
  mismatched: strings,
  model: MODEL_STATE
}, { description: "What a model operation left behind, and the model's state after it." });

const CLIENT_RESULT = object({
  client: { type: "string", description: "claude-code, claude-desktop, cursor, vscode, codex or gemini." },
  label: string,
  file: string,
  status: {
    type: "string",
    description: "added, updated, unchanged, removed, restored, absent, skipped or failed; with dry_run, would-add, would-update, would-remove or would-restore."
  },
  backup: nullable(string),
  reason: string,
  error: string
}, { optional: ["backup", "reason", "error"] });

const SERVED_BY = object({
  kind: choice("daemon", "process"),
  pid: count,
  build: string,
  sessions: count,
  started_at: string,
  idle_timeout_ms: count,
  retired: { type: "boolean", description: "The code this daemon runs was replaced in place and a daemon of the new code serves now: this one only finishes the sessions it has, so a program that stays connected should reconnect (1.1)." },
  retired_reason: string
}, {
  optional: ["build", "sessions", "started_at", "idle_timeout_ms", "retired", "retired_reason"],
  description: "The process that answered: the daemon every client shares, or a client's own server."
});

const CHECK = object({
  name: string,
  status: { type: "string", description: "ok, warn, fail or skipped." },
  summary: string,
  critical: { type: "boolean", description: "Whether the install fails without it (1.1)." },
  details: { type: "object", description: "What the check found, as it reports it: paths, counts, versions (1.1)." }
}, { optional: ["critical", "details"] });

/** When a setting's change takes effect (`settings.mjs`). */
const APPLIES = {
  type: "string",
  enum: ["now", "new_session", "next_daemon", "app"],
  description: "now: at once, in a session already connected too; new_session: in sessions started afterwards (reconnect); next_daemon: when the daemon starts next; app: the desktop app's own."
};

const SETTING = object({
  name: string,
  type: choice("string", "number", "boolean"),
  default: {},
  env: nullable(string),
  applies: APPLIES,
  description: string
});

const TASK = object({ task_id: string, title: string, status: string, project: string, updated_at: string });

const CUSTOM_SKILL = object({
  name: string,
  description: string,
  folder: string,
  origin: { ...choice("seed", "yours"), description: "seed: it comes with AI Dev, and is not removed; yours: added here." }
});

/** The skill registry after a change of the person's skills: rebuilt, so search and routing see it at once. */
const REGISTRY = object({
  total: { ...count, description: "Skills in the rebuilt registry." },
  custom: { ...count, description: "Of them in the custom source: the seed's and the person's own." }
});

/**
 * Each control tool's answer.
 *
 * @type {Readonly<Record<string, object>>}
 */
export const CONTROL_RESULTS = Object.freeze({
  system_status: object({
    api_version: string,
    status: { ...choice("ok", "degraded", "failed"), description: "ok: nothing to do; degraded: works, something is missing; failed: does not work." },
    summary: string,
    version: string,
    install: object({ kind: string, root: string, vault_root: string, runtime_root: string }),
    served_by: SERVED_BY,
    model: MODEL_STATE,
    index: object({
      exists: boolean,
      documents: count,
      dense_documents: count,
      dense_pending: count,
      fresh: boolean,
      built_at: nullable(string)
    }),
    clients: object({ found: count, connected: count }),
    settings_problems: strings,
    checks: list(CHECK)
  }),
  setup_run: object({
    succeeded: { type: "boolean", description: "Nothing in the run failed: no step and no client. A run the client cancels gets no answer — MCP drops the answer to a cancelled request; what it built stays, and system_status shows it." },
    steps: list(STEP),
    clients: nullable(list(CLIENT_RESULT))
  }),
  model_install: MODEL_CHANGE,
  model_import: MODEL_CHANGE,
  model_verify: object({
    ready: boolean,
    dir: string,
    present: strings,
    missing: strings,
    mismatched: strings
  }),
  model_remove: object({
    dir: string,
    removed: strings,
    kept: strings,
    freed_bytes: count
  }),
  clients_list: object({
    clients: list(object({
      client: string,
      label: string,
      file: string,
      found: { type: "boolean", description: "The client is installed here." },
      connected: { type: "boolean", description: "Its config runs this install of ai-dev." },
      entry: { type: "string", description: "What its ai-dev entry runs: this install, another one, the 2.x name, Docker, or none." },
      error: string
    }, { optional: ["error"] }))
  }),
  clients_install: object({ results: list(CLIENT_RESULT), changed: count, failed: count }),
  clients_remove: object({ results: list(CLIENT_RESULT), changed: count, failed: count }),
  logs_tail: object({
    log: string,
    file: string,
    exists: boolean,
    size: count,
    lines: strings,
    truncated: { type: "boolean", description: "Earlier lines exist that are not in this answer." }
  }),
  settings_get: object({
    file: string,
    schema_version: { type: "integer", minimum: 1, description: "The file's own; one newer than this version knows is listed in problems." },
    settings: { type: "object", description: "Each value in force for this session: what it started with, where a change since applies to sessions started afterwards (new_session) or the next daemon (next_daemon)." },
    sources: { type: "object", description: "Per setting: default, file, or environment (NAME) when a variable overrides the file; \"file, as this session started\" or \"default, as this session started\" when the file says otherwise since." },
    pending: { type: "object", description: "Per setting the file has changed since this session started: the value sessions started afterwards — or the next daemon — use. Reconnect to use it." },
    problems: strings,
    definitions: list(SETTING)
  }),
  settings_set: object({
    changed: strings,
    settings: { type: "object", description: "Each value in force for this session, as settings_get has it." },
    pending: { type: "object", description: "As settings_get has it: what this session does not use yet." },
    applies: { type: "object", additionalProperties: APPLIES, description: "Per changed setting: when the change takes effect." },
    note: string
  }),
  custom_skills_list: object({
    root: { type: "string", description: "The custom source's folder: where a person's own skills are kept." },
    skills: list(CUSTOM_SKILL)
  }),
  custom_skills_add: object({
    name: string,
    description: string,
    folder: string,
    created: { type: "boolean", description: "true: a new skill from the template, to be written in its SKILL.md; false: copied from a folder." },
    replaced: { type: "boolean", description: "A skill of the person's of that name was replaced." },
    files: count,
    bytes: count,
    skipped: { ...strings, description: "What the copy left out: links, and folders such as .git or node_modules." },
    registry: REGISTRY
  }),
  custom_skills_remove: object({ name: string, folder: string, registry: REGISTRY }),
  workspace_overview: object({
    projects: list(object({ id: string, name: string, root: string, stack: strings, updated_at: string })),
    tasks: object({ active: list(TASK), recent: list(TASK) }),
    epics: list(object({ epic_id: string, title: string, status: string, children: count, done: count })),
    decisions: list(object({ id: string, title: string, status: string, date: string, project: string })),
    usage: object({
      events: count,
      tool_calls: count,
      cost_usd: { type: "number", minimum: 0 },
      today_cost_usd: { type: "number", minimum: 0 },
      last_7_days_cost_usd: { type: "number", minimum: 0 }
    })
  })
});

/** The tools of the contract, in the order the documentation lists them. */
export const CONTROL_TOOLS = Object.freeze(Object.keys(CONTROL_RESULTS));

/**
 * The `outputSchema` a tool advertises: its answer under `result`, as the
 * server wraps every answer.
 *
 * @param {object} result
 * @returns {object}
 */
export function wrappedOutputSchema(result) {
  return {
    type: "object",
    properties: { result },
    required: ["result"],
    additionalProperties: false
  };
}

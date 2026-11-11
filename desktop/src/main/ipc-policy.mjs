/**
 * What the page may ask the main process for. The preload exposes exactly
 * these channels; the main process answers only these, only from the app's
 * own page. The screens call only the tools named here, with only the
 * arguments their buttons send; any other tool goes through the tool console,
 * where one that changes something runs only after the person confirms it in
 * the main process (console-policy.mjs). A setting that decides where the
 * daemon reaches out to, what it reads and writes, or which tools AI clients
 * get is changed from the page only after such a confirmation too
 * (CONFIRMED_SETTINGS) — a page that something managed to run script in can
 * still do only what the screens' buttons do, and cannot send what the daemon
 * reads anywhere.
 */

/** Every channel the page invokes, and what it does. */
export const INVOKE_CHANNELS = Object.freeze({
  state: "ai-dev:state",
  connect: "ai-dev:connect",
  retry: "ai-dev:retry",
  call: "ai-dev:call",
  cancel: "ai-dev:cancel",
  chooseFolder: "ai-dev:choose-folder",
  setLanguage: "ai-dev:set-language",
  tools: "ai-dev:tools",
  consoleCall: "ai-dev:console-call",
  reconnect: "ai-dev:reconnect"
});

/** Every channel the main process sends the page. */
export const EVENT_CHANNELS = Object.freeze({
  state: "ai-dev:state-changed",
  progress: "ai-dev:progress"
});

/**
 * The tools the screens call, each with the arguments their buttons send:
 * `boolean`, `number`, `text` (a string of at most 4 KB), `path` (a path the
 * system's dialog or the daemon gave), `clients` (a list of client names), one
 * of a list of words, or an object of named settings; `?` lets a setting be
 * null — back to its default. The rest of the control API (`model_remove`,
 * `clients_remove`) and the agent's tools that change something are not here,
 * and neither is any argument the screens do not send — a forced rebuild,
 * Frontend QA, the language (which goes through setLanguage). The tool console
 * reaches the rest behind a confirmation.
 */
export const PAGE_TOOL_ARGUMENTS = Object.freeze({
  system_status: { checks: "boolean" },
  setup_run: { model: "boolean" },
  model_install: {},
  model_import: { source: "path" },
  clients_list: {},
  clients_install: { clients: "clients" },
  settings_get: {},
  settings_set: {
    settings: {
      projects_root: "path?",
      model_dir: "path?",
      model_mirror: "text?",
      profiles: "text?",
      daemon_idle_minutes: "number?",
      daemon_autostart: "boolean"
    }
  },
  rebuild_search_index: {},
  // The data screens: Projects, Costs, Skills, the log.
  list_projects: {},
  read_project: { name: "text" },
  list_tasks: { project_path: "path", limit: "number" },
  epic_status: { task_id: "text" },
  list_decisions: { project_path: "path", limit: "number" },
  list_sessions: { project_path: "path", limit: "number" },
  usage_report: { project_path: "path" },
  search_skills: { query: "text", limit: "number" },
  read_skill: { name: "text", source: "text" },
  list_skill_groups: {},
  browse_skill_group: { group: "text", limit: "number" },
  logs_tail: { log: ["daemon", "daemon.1"], lines: "number" },
  // The person's own skills, a repository of skills and the registry (the Skills screen).
  custom_skills_list: {},
  custom_skills_add: { source: "path", name: "text", description: "text", replace: "boolean" },
  import_skill_repo: { repository_url: "text", select_skills: "boolean" },
  rebuild_index: {},
  // A repository's rules and the MCP servers its configs start (the Rules screen).
  list_policy_rules: { project_path: "path" },
  upsert_policy_rule: {
    project_path: "path",
    rule: { id: "text", event: ["bash", "file", "all"], pattern: "text", action: ["block", "warn"], message: "text", example: "text", enabled: "boolean" }
  },
  agent_hooks_status: { project_path: "path" },
  install_agent_hooks: { project_path: "path", profile: ["minimal", "standard", "strict"] },
  list_rule_packs: { project_path: "path" },
  install_project_rules: { project_path: "path", dry_run: "boolean" },
  list_mcp_servers: { project_path: "path", include_user_scope: "boolean" }
});

/**
 * The screens' calls that change the person's files — the skill library, a
 * repository's rules and hooks — which run only after the person confirms
 * them in a dialog of the main process, as the tool console's do: a page that
 * something managed to run script in cannot put a skill an agent follows, or
 * a rule, where the person did not say so. A dry run
 * changes nothing and is not asked about. Removing a skill or a rule is not a
 * screens' call at all: its button goes through the tool console, which asks
 * too, as every call that takes back what it cannot undo does.
 */
export const PAGE_CONFIRMED_TOOLS = Object.freeze([
  "custom_skills_add",
  "import_skill_repo",
  "upsert_policy_rule",
  "install_agent_hooks",
  "install_project_rules"
]);

/** Whether a screens' call must be confirmed by the person first. Call it on a call refuseCall let through. */
export function callToConfirm(request) {
  return PAGE_CONFIRMED_TOOLS.includes(request?.tool) && request.args?.dry_run !== true;
}

/**
 * The arguments the interface always sends; a call without one is refused.
 * The daemon reads a `clients_install` that names no client as all of them.
 */
export const PAGE_REQUIRED_ARGUMENTS = Object.freeze({
  model_import: ["source"],
  clients_install: ["clients"],
  settings_set: ["settings"],
  read_project: ["name"],
  epic_status: ["task_id"],
  search_skills: ["query"],
  read_skill: ["name"],
  browse_skill_group: ["group"],
  import_skill_repo: ["repository_url"],
  list_policy_rules: ["project_path"],
  upsert_policy_rule: ["project_path", "rule"],
  agent_hooks_status: ["project_path"],
  install_agent_hooks: ["project_path"],
  list_rule_packs: ["project_path"],
  install_project_rules: ["project_path"],
  list_mcp_servers: ["project_path"]
});

/** The tools the interface calls. */
export const PAGE_TOOLS = Object.freeze(Object.keys(PAGE_TOOL_ARGUMENTS));

/**
 * The settings the page changes only after the person confirms them in a
 * dialog of the main process: the model's download mirror (where the daemon
 * reaches out to — with it, anything the daemon reads could leave in a request's
 * address), the model folder (what the daemon reads and writes as the model) and
 * the tool profiles AI clients get.
 */
export const CONFIRMED_SETTINGS = Object.freeze(["model_mirror", "model_dir", "profiles"]);

/** The settings a screens' call would change that need the person's confirmation first, or null. Call it on a call refuseCall let through. */
export function settingsToConfirm(request) {
  if (request?.tool !== "settings_set") return null;
  const settings = request.args?.settings ?? {};
  const asked = CONFIRMED_SETTINGS.filter((name) => Object.hasOwn(settings, name));
  return asked.length ? Object.fromEntries(asked.map((name) => [name, settings[name]])) : null;
}

/**
 * A call's id from the page: `call-` and up to 59 letters, digits, - or _.
 * The main process names its own calls otherwise (`tray-rebuild`,
 * `language`), so the page can neither cancel them nor stand in for them.
 */
const CALL_ID = /^call-[A-Za-z0-9_-]{1,59}$/;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_TEXT = 4096;
const CLIENT_NAME = /^[a-z][a-z0-9-]{1,31}$/;

/** An object as JSON makes it — not a Date, a Map or another class's. */
function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function refuseValue(kind, value, where) {
  if (Array.isArray(kind)) return kind.includes(value) ? null : `${where} is one of ${kind.join(", ")}.`;
  if (typeof kind === "string" && kind.endsWith("?")) return value === null ? null : refuseValue(kind.slice(0, -1), value, where);
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? null : `${where} is true or false.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${where} is a number.`;
    case "text":
      return typeof value === "string" && value.length <= MAX_TEXT ? null : `${where} is text of at most ${MAX_TEXT} characters.`;
    case "path":
      return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT ? null : `${where} is a path.`;
    case "clients":
      return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((name) => typeof name === "string" && CLIENT_NAME.test(name))
        ? null
        : `${where} is a list of client names.`;
    default: {
      if (!plainObject(value)) return `${where} is an object.`;
      const names = Object.keys(value);
      if (!names.length) return `${where} names something to change.`;
      for (const name of names) {
        if (!Object.hasOwn(kind, name)) return `The interface does not change ${JSON.stringify(name).slice(0, 80)}.`;
        const refused = refuseValue(kind[name], value[name], `${where}.${name}`);
        if (refused) return refused;
      }
      return null;
    }
  }
}

/** Why a call from a screen is refused, or null when it may go on. */
export function refuseCall(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  const { tool, args = {} } = request;
  if (typeof tool !== "string" || !Object.hasOwn(PAGE_TOOL_ARGUMENTS, tool)) return `The interface does not call ${JSON.stringify(String(tool)).slice(0, 80)}.`;
  const malformed = refuseRequest(request);
  if (malformed) return malformed;
  const allowed = PAGE_TOOL_ARGUMENTS[tool];
  for (const name of PAGE_REQUIRED_ARGUMENTS[tool] ?? []) {
    if (!Object.hasOwn(args, name)) return `${tool} needs ${name}.`;
  }
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(allowed, name)) return `The interface does not send ${JSON.stringify(name).slice(0, 80)} to ${tool}.`;
    const refused = refuseValue(allowed[name], value, name);
    if (refused) return refused;
  }
  return null;
}

/**
 * Why `clients_install` from the page is refused, given what `clients_list`
 * says now: the wizard offers only the clients found on this computer whose
 * config can be read, so the page connects no other — not `all`, not one the
 * person has not got.
 *
 * @param {string[]} names - The page's `clients`.
 * @param {Array<{ client: string, found: boolean, entry?: string }>} listed - `clients_list`'s `clients`.
 */
export function refuseClients(names, listed) {
  const offered = new Set(listed.filter((item) => item.found && item.entry !== "unreadable").map((item) => item.client));
  const other = names.filter((name) => !offered.has(name));
  return other.length ? `The interface connects only the clients it found on this computer, not ${other.join(", ").slice(0, 120)}.` : null;
}

/**
 * Why a call is malformed — its tool's name, its id, its arguments — or null.
 * Which tool it may name is the caller's rule: the screens' list, or the
 * console's (console-policy.mjs).
 */
export function refuseRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "A call is an object with tool, arguments and id.";
  const { tool, args = {}, id } = request;
  if (typeof tool !== "string" || !tool) return "A call names a tool.";
  if (!validCallId(id)) return "A call's id is call- and 1 to 59 letters, digits, - or _.";
  if (!plainObject(args)) return "A call's arguments are an object.";
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(args));
  } catch {
    return "A call's arguments must be plain JSON.";
  }
  if (size > MAX_ARGUMENT_BYTES) return `A call's arguments are at most ${MAX_ARGUMENT_BYTES} bytes.`;
  return null;
}

/** Whether a call id is one the page may use (call, cancel, progress). */
export function validCallId(id) {
  return typeof id === "string" && CALL_ID.test(id);
}

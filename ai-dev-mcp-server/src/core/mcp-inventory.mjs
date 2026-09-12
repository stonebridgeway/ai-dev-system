/**
 * What MCP servers a repository wires into its agents, read out of the config
 * files the clients actually load.
 *
 * Every client keeps its own list — `.mcp.json` for Claude Code, `.cursor/mcp.json`,
 * `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml` — and each
 * entry is a program that starts with the editor and answers tool calls with the
 * user's credentials. Nothing in the repository lists them together, so a server
 * added to one client and forgotten in another, or one carrying a token in
 * cleartext, is invisible until someone opens all five files.
 *
 * The report says, per server: which files declare it, over which transport, the
 * environment variables it expects and whether they are substituted or written
 * out, and whether Claude Code will start it without asking. A credential in
 * cleartext is a `block` finding — it is in the repository, so it is in the
 * clone, the fork and the backup.
 *
 * The findings stop at what a config file can prove. Grading the whole agent
 * harness (`CLAUDE.md` auto-run, `Bash(*)` permissions, hook interpolation) is
 * `scan_agent_config`, PLAN.md 3.22, which builds on this inventory.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSecretsInLine } from "./change-hygiene.mjs";
import { readJsonSubset } from "./json-subset.mjs";
import { parseTomlLite } from "./toml-lite.mjs";

/** Project-scope config files, in the order a report lists them. */
export const MCP_PROJECT_SOURCES = Object.freeze([
  { client: "claude-code", scope: "project", file: ".mcp.json", format: "json", key: "mcpServers", approvable: true },
  { client: "claude-code", scope: "project-settings", file: ".claude/settings.json", format: "json", key: "mcpServers", approvals: true },
  { client: "claude-code", scope: "local-settings", file: ".claude/settings.local.json", format: "json", key: "mcpServers", approvals: true },
  { client: "cursor", scope: "project", file: ".cursor/mcp.json", format: "json", key: "mcpServers" },
  { client: "vscode", scope: "project", file: ".vscode/mcp.json", format: "json", key: "servers" },
  { client: "gemini", scope: "project", file: ".gemini/settings.json", format: "json", key: "mcpServers" },
  { client: "codex", scope: "project", file: ".codex/config.toml", format: "toml", key: "mcp_servers" }
]);

/** User-scope config files: the same ones this server's own installers write. */
export const MCP_USER_SOURCES = Object.freeze([
  { client: "claude-code", scope: "user", file: ".claude.json", format: "json", key: "mcpServers", projects: true },
  { client: "cursor", scope: "user", file: ".cursor/mcp.json", format: "json", key: "mcpServers" },
  { client: "gemini", scope: "user", file: ".gemini/settings.json", format: "json", key: "mcpServers" },
  { client: "codex", scope: "user", file: ".codex/config.toml", format: "toml", key: "mcp_servers" }
]);

const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 };
const EDITOR_VARIABLES = new Set(["workspaceFolder", "workspaceFolderBasename", "fileWorkspaceFolder", "userHome", "pathSeparator", "cwd"]);
const REMOTE_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx", "dlx"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"]);
const SECRET_KEY = /(?:^|[_-])(?:token|tokens|secret|secrets|key|keys|password|passwd|pwd|credential|credentials|apikey|auth|authorization|pat|cookie)(?:$|[_-])/i;
const NON_SECRET_KEY = /(?:^|[_-])(?:path|file|dir|url|uri|name|id|env|var|type|format|enabled|header|expiry|ttl|store|manager)$/i;
const SUBSTITUTION = /\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const HAS_SUBSTITUTION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
const SECRET_FLAG = /^--?([A-Za-z][A-Za-z0-9-]*)=(.+)$/s;

function basename(command) {
  return path.basename(String(command ?? "").replaceAll("\\", "/")).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

/**
 * Strip `//` and `/* *\/` comments and trailing commas from a JSON document.
 * VS Code and Cursor both accept them; a config we cannot read is a blind spot
 * in the report, not a reason to skip the file.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      output += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

/** Bytes past which the report says what reading this file cost. */
const LARGE_CONFIG_BYTES = 2 * 1024 * 1024;

/**
 * Read only the keys that declare servers, streaming past the rest.
 *
 * `~/.claude.json` holds the user's own MCP servers *and* Claude Code's
 * conversation history for every project it has opened, which is tens of
 * megabytes on an active machine (docs/ecc-upgrades/DEBTS.md, Д-17). Two keys
 * are wanted; the rest is streamed through and dropped. The scanner does not
 * validate, so the first character is checked instead: a file that does not
 * start an object is reported unreadable the way a failed parse was.
 */
async function readServerKeys(absolute, source, projectRoot) {
  const patterns = [[source.key]];
  if (source.projects && projectRoot) patterns.push(["projects", projectRoot, source.key]);
  const scan = await readJsonSubset(absolute, patterns);
  if (!scan.exists) return { exists: false, document: null, error: "", warnings: [] };
  if (scan.root && scan.root !== "{") {
    return { exists: true, document: null, error: `not valid JSON: the document starts with "${scan.root}", not an object`, warnings: [] };
  }
  const document = {};
  for (const { path: keyPath, value } of scan.found) {
    let holder = document;
    for (const segment of keyPath.slice(0, -1)) {
      if (!holder[segment] || typeof holder[segment] !== "object") holder[segment] = {};
      holder = holder[segment];
    }
    holder[keyPath.at(-1)] = value;
  }
  const warnings = [];
  if (scan.bytes > LARGE_CONFIG_BYTES) {
    warnings.push(`${(scan.bytes / (1024 * 1024)).toFixed(1)} MB streamed to read ${patterns.length} key(s); the rest of the file was skipped, not parsed`);
  }
  for (const key of scan.truncated) warnings.push(`${key} is larger than the value limit and was skipped`);
  return { exists: true, document, error: scan.errors.length ? `not valid JSON: ${scan.errors[0]}` : "", warnings };
}

async function readConfigDocument(absolute, format) {
  let text;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, document: null, error: "", warnings: [] };
    return { exists: true, document: null, error: error.message, warnings: [] };
  }
  if (format === "toml") {
    const { data, warnings } = parseTomlLite(text);
    return { exists: true, document: data, error: "", warnings };
  }
  try {
    return { exists: true, document: JSON.parse(text), error: "", warnings: [] };
  } catch (parseError) {
    try {
      const document = JSON.parse(stripJsonComments(text));
      return { exists: true, document, error: "", warnings: ["read as JSON with comments; strict JSON.parse rejected it"] };
    } catch {
      return { exists: true, document: null, error: `not valid JSON: ${parseError.message}`, warnings: [] };
    }
  }
}

/**
 * Environment and editor substitutions inside one config value.
 *
 * @param {string} value
 * @returns {Array<{ raw: string, kind: string, variable: string }>}
 */
export function collectSubstitutions(value) {
  const found = [];
  for (const match of String(value ?? "").matchAll(SUBSTITUTION)) {
    const body = (match[1] ?? match[2] ?? "").trim();
    if (!body) continue;
    const colon = body.indexOf(":");
    const prefix = colon === -1 ? "" : body.slice(0, colon);
    if (prefix === "env" || prefix === "localEnv") {
      found.push({ raw: match[0], kind: "env", variable: body.slice(colon + 1).split(/:?[-+]/)[0].trim() });
      continue;
    }
    if (prefix === "input") {
      found.push({ raw: match[0], kind: "input", variable: body.slice(colon + 1).trim() });
      continue;
    }
    const name = body.split(/:?[-+]/)[0].trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      found.push({ raw: match[0], kind: "unknown", variable: body });
      continue;
    }
    found.push({ raw: match[0], kind: EDITOR_VARIABLES.has(name) ? "editor" : "env", variable: name });
  }
  return found;
}

function looksLikePlaceholder(value) {
  const text = String(value ?? "").trim();
  if (text.length < 8) return true;
  if (HAS_SUBSTITUTION.test(text)) return true;
  if (/^(?:true|false|null|none|undefined|\d+)$/i.test(text)) return true;
  if (/^(?:[~.]?[\\/]|[A-Za-z]:[\\/])/.test(text)) return true;
  if (/^<.*>$|^\{\{.*\}\}$/.test(text)) return true;
  if (/^(?:replace|change|your|example|sample|dummy|placeholder|fake|todo|tbd|redacted|test)[-_]?/i.test(text)) return true;
  return /^[x*.\-_]+$/i.test(text);
}

/** The transport a client would use for this entry. */
export function mcpTransport(definition) {
  const declared = String(definition?.type ?? definition?.transport ?? "").toLowerCase();
  if (declared === "streamable-http" || declared === "streamablehttp" || declared === "http") return "http";
  if (declared === "sse") return "sse";
  if (declared === "ws" || declared === "websocket") return "websocket";
  if (definition?.command) return "stdio";
  const url = String(definition?.url ?? "");
  if (url) return /\/sse(?:$|[/?#])/.test(url) ? "sse" : "http";
  return "unknown";
}

/** Every string a client would hand to the operating system or the network, by location. */
function stringValues(definition) {
  const values = [];
  if (typeof definition?.command === "string") values.push({ location: "command", key: "command", value: definition.command });
  if (typeof definition?.url === "string") {
    values.push({ location: "url", key: "url", value: definition.url });
    // A token in the query string is as exposed as one in a header.
    for (const parameter of definition.url.matchAll(/[?&]([^=&#]+)=([^&#]+)/g)) {
      values.push({ location: `url?${parameter[1]}`, key: parameter[1], value: parameter[2], group: "url" });
    }
  }
  (Array.isArray(definition?.args) ? definition.args : []).forEach((arg, position) => {
    if (typeof arg !== "string") return;
    // `--api-key=…` on the command line is as much a credential in the file as
    // one under `env`, so it is read as a key and a value, not as opaque text.
    const flag = SECRET_FLAG.exec(arg);
    values.push(flag
      ? { location: `args[${position}] (${flag[1]})`, key: flag[1], value: flag[2], group: "args" }
      : { location: `args[${position}]`, key: "", value: arg });
  });
  for (const [group, holder] of [["env", definition?.env], ["headers", definition?.headers]]) {
    if (!holder || typeof holder !== "object") continue;
    for (const [key, value] of Object.entries(holder)) {
      if (typeof value === "string") values.push({ location: `${group}.${key}`, key, value, group });
    }
  }
  return values;
}

function packageIsPinned(spec) {
  const name = String(spec ?? "");
  const at = name.lastIndexOf("@");
  return at > 0 && !name.slice(at + 1).includes("/");
}

function commandFindings(definition, add) {
  const args = (Array.isArray(definition?.args) ? definition.args : []).map((arg) => String(arg));
  const command = basename(definition?.command);
  if (SHELLS.has(command) && args.some((arg) => ["-c", "/c", "/C", "-Command", "-command"].includes(arg))) {
    add("shell_wrapped", "warn", "command", "The server starts through a shell one-liner, so what actually runs is decided at start-up and no config review can see it. Point the entry at the program itself.");
  }
  if (!REMOTE_RUNNERS.has(command)) return;
  // `pipx run <package>`: the subcommand is not the package.
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const spec = (command === "pipx" && positional[0] === "run" ? positional[1] : positional[0]) ?? "";
  const consented = args.some((arg) => ["-y", "--yes"].includes(arg));
  if (!packageIsPinned(spec)) {
    add(
      "unpinned_remote_package",
      "warn",
      "command",
      `${command} ${consented ? "-y " : ""}${spec || "<package>"} fetches and runs whatever the registry serves at start-up${consented ? ", with the install prompt answered in advance" : ""}. Pin the version (${spec || "package"}@1.2.3) or vendor the server.`
    );
  }
}

function describeOrigin({ definition, env }) {
  const findings = [];
  const substitutions = [];
  // Whatever the findings identify as a credential is masked out of the command
  // line and the url this report echoes back: a report that repeats the secret
  // it found spreads it into the next log, ticket or pull request.
  const redactions = new Map();
  const add = (id, severity, location, message, extra = {}) => {
    findings.push({ id, severity, location, message, ...extra });
  };
  const transport = mcpTransport(definition);
  for (const { location, key, value, group } of stringValues(definition)) {
    for (const substitution of collectSubstitutions(value)) {
      substitutions.push({
        location,
        kind: substitution.kind,
        variable: substitution.variable,
        set: substitution.kind === "env" ? Boolean(env?.[substitution.variable]) : null
      });
    }
    for (const hit of findSecretsInLine(value)) {
      add(`secret_${hit.id}`, hit.severity, location, `${location} carries what looks like a ${hit.id.replaceAll("_", " ")} in cleartext (${hit.masked}). Move it to an environment variable and reference it as \${VAR}.`);
      redactions.set(value, maskValue(value));
    }
    if (group && SECRET_KEY.test(key) && !NON_SECRET_KEY.test(key) && !looksLikePlaceholder(value)) {
      add("plaintext_secret", "block", location, `${location} is a credential written out in the config file, which is in the repository, the clone and every backup of it. Reference it as \${${key.toUpperCase().replaceAll("-", "_")}} and keep the value in the environment.`, { masked: maskValue(value) });
      redactions.set(value, maskValue(value));
    }
  }
  if (transport === "unknown") {
    add("unknown_transport", "warn", "", "The entry names neither a command nor a url, so no client can start it.");
  }
  const url = String(definition?.url ?? "");
  if (/^http:\/\//i.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:$|[/?#])/i.test(url)) {
    add("insecure_url", "warn", "url", `${url} is plain HTTP: the tool calls and whatever they carry cross the network unencrypted.`);
  }
  commandFindings(definition, add);
  return { transport, substitutions, findings, redactions };
}

/** Replace every value the findings flagged with its mask. */
function redact(text, redactions) {
  let output = String(text ?? "");
  for (const [value, mask] of redactions) output = output.split(value).join(mask);
  return output;
}

/**
 * A credential as a report may repeat it: enough to recognise, not enough to
 * use. Exported because `scan_agent_config` masks the same way — one function,
 * so a value that is safe to print in one report is safe in the other.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function maskConfigValue(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return "***";
  return `${text.slice(0, 3)}…${text.slice(-2)} (${text.length} chars)`;
}

function maskValue(value) {
  return maskConfigValue(value);
}

function definitionFingerprint(definition) {
  return JSON.stringify({
    command: definition?.command ?? null,
    args: definition?.args ?? null,
    url: definition?.url ?? null,
    env: definition?.env ?? null,
    headers: definition?.headers ? Object.keys(definition.headers).sort() : null,
    // The declared type is read through `mcpTransport`, so `{ url }` and
    // `{ type: "http", url }` are the same entry written two ways, not a conflict.
    transport: mcpTransport(definition)
  });
}

function serverEntries(document, source, projectRoot) {
  const entries = [];
  const collect = (holder, scope) => {
    if (!holder || typeof holder !== "object" || Array.isArray(holder)) return;
    for (const [name, definition] of Object.entries(holder)) {
      if (definition && typeof definition === "object" && !Array.isArray(definition)) entries.push({ name, definition, scope });
    }
  };
  collect(document?.[source.key], source.scope);
  if (source.projects) {
    const projects = document?.projects;
    const record = projects && typeof projects === "object" ? projects[projectRoot] : null;
    collect(record?.mcpServers, "user-project");
  }
  return entries;
}

function approvalState(settings, name) {
  if (settings.disabled.has(name)) return "disabled";
  if (settings.enableAll || settings.enabled.has(name)) return "enabled";
  return "prompt";
}

/**
 * Read every MCP server a project's agents can reach.
 *
 * @param {{ projectRoot: string, homeDir?: string, env?: Record<string, string>, includeUserScope?: boolean }} input
 * @returns {Promise<object>} sources read, servers found, and findings by severity.
 */
export async function listMcpServers({ projectRoot, homeDir = os.homedir(), env = process.env, includeUserScope = false }) {
  const root = path.resolve(projectRoot);
  const home = homeDir ? path.resolve(homeDir) : "";
  const planned = [
    ...MCP_PROJECT_SOURCES.map((source) => ({ ...source, absolute: path.join(root, ...source.file.split("/")), display: source.file })),
    ...(includeUserScope && home
      ? MCP_USER_SOURCES.map((source) => {
        const absolute = path.join(home, ...source.file.split("/"));
        return { ...source, absolute, display: absolute.replaceAll("\\", "/") };
      }).filter((source) => !source.absolute.startsWith(`${root}${path.sep}`) && source.absolute !== root)
      : [])
  ];

  const sources = [];
  const found = [];
  const findings = [];
  const settings = { enableAll: false, enabled: new Set(), disabled: new Set() };

  for (const source of planned) {
    // The user-scope Claude Code file is read key by key rather than parsed
    // whole: it is also where the conversation history lives.
    const { exists, document, error, warnings } = source.projects
      ? await readServerKeys(source.absolute, source, root)
      : await readConfigDocument(source.absolute, source.format);
    const entries = error ? [] : serverEntries(document, source, root);
    if (source.approvals && document && typeof document === "object") {
      if (document.enableAllProjectMcpServers === true) settings.enableAll = true;
      for (const name of Array.isArray(document.enabledMcpjsonServers) ? document.enabledMcpjsonServers : []) settings.enabled.add(String(name));
      for (const name of Array.isArray(document.disabledMcpjsonServers) ? document.disabledMcpjsonServers : []) settings.disabled.add(String(name));
    }
    sources.push({
      client: source.client,
      scope: source.scope,
      path: source.display,
      exists,
      readable: exists && !error,
      error,
      warnings: warnings ?? [],
      server_count: entries.length
    });
    if (exists && error) {
      findings.push({ id: "unreadable_config", severity: "warn", server: "", client: source.client, scope: source.scope, path: source.display, location: "", message: `${source.display} could not be read (${error}), so the servers it declares are missing from this report.` });
    }
    for (const warning of warnings ?? []) {
      findings.push({ id: "config_parse_warning", severity: "info", server: "", client: source.client, scope: source.scope, path: source.display, location: "", message: `${source.display}: ${warning}.` });
    }
    for (const entry of entries) found.push({ ...entry, source: { ...source, scope: entry.scope } });
  }

  if (settings.enableAll) {
    findings.push({ id: "project_servers_auto_approved", severity: "warn", server: "", client: "claude-code", scope: "settings", path: ".claude/settings.json", location: "enableAllProjectMcpServers", message: "enableAllProjectMcpServers starts every server in .mcp.json without asking, including one a future commit adds." });
  }

  const byName = new Map();
  for (const { name, definition, source } of found) {
    const described = describeOrigin({ definition, env });
    findings.push(...described.findings.map((finding) => ({
      ...finding, server: name, client: source.client, scope: source.scope, path: source.display
    })));
    const server = byName.get(name) ?? {
      name,
      transport: described.transport,
      command: typeof definition.command === "string" ? definition.command : "",
      args: (Array.isArray(definition.args) ? definition.args : []).map((arg) => redact(arg, described.redactions)),
      url: redact(typeof definition.url === "string" ? definition.url : "", described.redactions),
      env_var_names: Object.keys(definition.env && typeof definition.env === "object" ? definition.env : {}),
      header_names: Object.keys(definition.headers && typeof definition.headers === "object" ? definition.headers : {}),
      substitutions: [],
      origins: [],
      approval: null,
      findings: [],
      fingerprints: new Set()
    };
    for (const substitution of described.substitutions) {
      const key = `${substitution.location}|${substitution.kind}|${substitution.variable}`;
      if (!server.substitutions.some((item) => `${item.location}|${item.kind}|${item.variable}` === key)) server.substitutions.push(substitution);
    }
    server.origins.push({ client: source.client, scope: source.scope, path: source.display, transport: described.transport });
    for (const finding of described.findings) {
      // The same entry copied into two clients has the same problem twice; the
      // per-server view says it once, the findings list keeps both files.
      const key = `${finding.id}|${finding.location}|${finding.message}`;
      if (!server.findings.some((item) => `${item.id}|${item.location}|${item.message}` === key)) server.findings.push(finding);
    }
    server.fingerprints.add(definitionFingerprint(definition));
    if (source.approvable) server.approval = approvalState(settings, name);
    byName.set(name, server);
  }

  const servers = [...byName.values()].map((server) => {
    const { fingerprints, ...rest } = server;
    if (fingerprints.size > 1) {
      const conflict = {
        id: "conflicting_definitions",
        severity: "warn",
        server: server.name,
        client: server.origins.map((origin) => origin.client).join(", "),
        scope: "",
        path: server.origins.map((origin) => origin.path).join(", "),
        location: "",
        message: `"${server.name}" is declared differently in ${server.origins.length} files, so which program answers depends on which client the agent runs in.`
      };
      findings.push(conflict);
      rest.findings = [...rest.findings, { id: conflict.id, severity: conflict.severity, location: "", message: conflict.message }];
    }
    return rest;
  }).sort((left, right) => left.name.localeCompare(right.name));

  findings.sort((left, right) => (SEVERITY_ORDER[left.severity] ?? 3) - (SEVERITY_ORDER[right.severity] ?? 3) || left.server.localeCompare(right.server));
  const transports = {};
  for (const server of servers) transports[server.transport] = (transports[server.transport] ?? 0) + 1;
  return {
    project_path: root,
    user_scope: Boolean(includeUserScope && home),
    sources,
    servers,
    findings,
    summary: {
      sources_present: sources.filter((source) => source.exists).length,
      sources_read: sources.filter((source) => source.readable).length,
      servers: servers.length,
      transports,
      block: findings.filter((finding) => finding.severity === "block").length,
      warn: findings.filter((finding) => finding.severity === "warn").length,
      info: findings.filter((finding) => finding.severity === "info").length
    }
  };
}

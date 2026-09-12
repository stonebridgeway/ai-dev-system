/**
 * Grading a repository's agent harness (PLAN.md, stage 3.22).
 *
 * `list_mcp_servers` answers "what programs will an agent's editor start here".
 * This answers the wider question: what is this repository allowed to make an
 * agent do without anyone being asked. Five places decide that, and nothing in
 * a repository reads them together:
 *
 * - `CLAUDE.md` and `AGENTS.md`, which can run a command every time they load
 *   and can tell the agent in prose to stop asking.
 * - `.claude/settings.json` and its `.local` sibling, where one `Bash(*)` entry
 *   or `defaultMode: bypassPermissions` removes the permission prompt
 *   altogether.
 * - the MCP configs, where a server can arrive unpinned from a registry or with
 *   a credential in cleartext — that part is `list_mcp_servers`, folded in
 *   here rather than re-implemented.
 * - hook commands, which run in a shell with the tool's own input available,
 *   so one interpolated variable is a command-injection point.
 * - subagent definitions, which inherit every tool their parent has unless the
 *   definition narrows them.
 *
 * The output is findings in the same shape as change hygiene
 * (`{ rule, severity, file, line, message }`) plus a grade from A to F, because
 * a number is what fits in a project card and what a person can watch move.
 *
 * Secrets are masked with {@link maskConfigValue}, the same function the MCP
 * inventory uses: a report that repeats the credential it found has spread it
 * into the next ticket.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { findSecretsInLine } from "./change-hygiene.mjs";
import { listMcpServers, maskConfigValue, stripJsonComments } from "./mcp-inventory.mjs";

/** Files the scan reads, and what each one is authoritative for. */
export const AGENT_CONFIG_FILES = Object.freeze([
  { file: "CLAUDE.md", kind: "instructions" },
  { file: "AGENTS.md", kind: "instructions" },
  { file: ".claude/CLAUDE.md", kind: "instructions" },
  { file: ".claude/settings.json", kind: "settings" },
  { file: ".claude/settings.local.json", kind: "settings" },
  { file: ".cursor/hooks.json", kind: "hooks" }
]);

/** Where subagent definitions live. */
export const AGENT_DEFINITION_DIR = ".claude/agents";

/** What each severity costs the grade. */
export const SEVERITY_WEIGHTS = Object.freeze({ block: 25, warn: 8, info: 2 });

/** Grade bands, best first. A single `block` finding caps the grade at D. */
export const GRADE_BANDS = Object.freeze([
  { grade: "A", min: 90 },
  { grade: "B", min: 80 },
  { grade: "C", min: 70 },
  { grade: "D", min: 60 },
  { grade: "F", min: 0 }
]);

// `!`command`` in CLAUDE.md is Claude Code's inline bash syntax: the command
// runs every time the file is loaded, before the agent has read a word of it.
const COMMAND_INJECTION = /!`[^`]+`/;

// Prose that tells the agent to act without asking. Deliberately narrow: this
// has to survive being read out loud as the reason for a finding.
// `\b` is ASCII-only in JavaScript, so the Russian half carries no word
// boundary: "Не спрашивай" at the start of a line would not match one.
//
// "always run …" used to be here and is not any more: "Always run the tests
// before you claim the task is done" waives nothing, and a rule that calls an
// honest instruction a bypass is a rule people stop reading (Д-24). What is
// left names the confirmation it removes.
const AUTO_RUN_PROSE = new RegExp([
  "\\bwithout (?:asking|being asked|confirmation|permission|prompting|a prompt)\\b",
  "\\bno (?:need to ask|confirmation (?:needed|required))\\b",
  "\\b(?:do not|don't|never|no need to) (?:ask|confirm|prompt|stop to ask)\\b",
  "\\bskip (?:the )?(?:confirmation|prompt|permission)s?\\b",
  "\\bauto[- ]?(?:run|approve|accept|commit|merge|push|apply)\\b",
  // An imperative only: "Run the dev server automatically" is an instruction,
  // "the formatter runs automatically on save" is a description of the project.
  "^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:always\\s+)?(?:run|start|launch|execute|commit|push|merge|apply|deploy|install)\\b[^.\\n]{0,40}\\bautomatically\\b",
  "(?:не спрашивай|не переспрашивай|без подтверждени|без спроса|не жди подтверждени|сразу запускай|запускай сразу)",
  "(?:автоматически (?:запускай|выполняй|коммить|пуш)|(?:запускай|выполняй)[^.\\n]{0,40}автоматически)"
].join("|"), "i");

// The flags and settings that turn the permission prompt off outright. A
// literal is the easiest thing in this module to recognise and the most
// common way such a file starts, so it is its own rule rather than prose.
const PERMISSION_BYPASS_FLAG = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b|\bbypassPermissions\b/i;

// …unless the line is telling the reader not to use it. "Never run with
// --dangerously-skip-permissions" is the opposite of the finding.
const BYPASS_FORBIDDEN = /\b(?:never|not|without|avoid|don't|do not|forbidden|prohibited)\b[^.\n]{0,60}$|(?:никогда|не |без |запрещен)[^.\n]{0,60}$/i;

// A hook command that splices something in: `$VAR`, `${VAR}`, `$(cmd)` or a
// backtick. Hook input is the tool call's own arguments, so this is where a
// file name becomes a command.
const HOOK_INTERPOLATION = /\$\(|`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

// Hook variables the client substitutes itself and which carry no tool input.
const SAFE_HOOK_VARIABLES = /^\$(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|HOME|PATH|PWD|SHELL|USER|TMPDIR)$/;

/** Permission entries that allow anything of their kind. */
const WIDE_PERMISSION = /^(?<tool>[A-Za-z]+)\((?<pattern>[:*\s]*|\*\*?|\/?\*\*?)\)$/;

/** Permission modes that skip the prompt. */
const PERMISSIVE_MODES = Object.freeze({
  bypassPermissions: "block",
  acceptEdits: "warn",
  plan: "",
  default: ""
});

/**
 * Every string in a document, with the path of the key holding it.
 *
 * Top-level strings are not where a secret goes. `env` is: it is how Claude
 * Code puts variables into the session, so `env.AWS_ACCESS_KEY_ID` is the most
 * likely credential in the file and used to be the one place this scan did not
 * look (Д-23). Naming the path — `env.AWS_ACCESS_KEY_ID`, not `env` — is what
 * makes the finding actionable.
 *
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {number} [depth]
 * @returns {Generator<{ path: string, value: string }>}
 */
function* stringValues(value, prefix = "", depth = 0) {
  if (depth > 12) return;
  if (typeof value === "string") {
    yield { path: prefix || "(root)", value };
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringValues(item, `${prefix}[${index}]`, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) yield* stringValues(item, prefix ? `${prefix}.${key}` : key, depth + 1);
  }
}

function finding({ rule, severity, file, line = 0, message }) {
  return { rule, severity, file, line: Math.max(0, Number(line) || 0), message: String(message) };
}

async function readTextIfExists(absolute) {
  return fs.readFile(absolute, "utf8").then((text) => ({ exists: true, text })).catch((error) => (
    error?.code === "ENOENT" ? { exists: false, text: "" } : { exists: true, text: "", error: String(error?.message ?? error) }
  ));
}

function parseJsonDocument(text) {
  try {
    return { document: JSON.parse(stripJsonComments(text)), error: "" };
  } catch (error) {
    return { document: null, error: String(error?.message ?? error) };
  }
}

/**
 * Findings from one instruction file (`CLAUDE.md`, `AGENTS.md`).
 *
 * @param {string} file - Repository-relative path, for the finding.
 * @param {string} text
 * @returns {object[]}
 */
export function scanInstructionFile(file, text) {
  const findings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((content, index) => {
    const line = index + 1;
    if (COMMAND_INJECTION.test(content)) {
      findings.push(finding({
        rule: "instructions_run_commands",
        severity: "block",
        file,
        line,
        message: `${file}:${line} runs a shell command every time the file is loaded (\`!\`…\`\`), before the agent has read the instructions. Anyone who can commit to this repository can choose that command.`
      }));
    }
    const bypass = PERMISSION_BYPASS_FLAG.exec(content);
    if (bypass && !BYPASS_FORBIDDEN.test(content.slice(0, bypass.index))) {
      findings.push(finding({
        rule: "instructions_disable_permission_prompt",
        severity: "block",
        file,
        line,
        message: `${file}:${line} tells the agent to run with \`${bypass[0]}\` ("${content.trim().slice(0, 80)}"), which turns off the permission prompt entirely for everyone who opens this repository. Pre-approve the commands this project needs instead.`
      }));
    }
    if (AUTO_RUN_PROSE.test(content)) {
      findings.push(finding({
        rule: "instructions_disable_confirmation",
        severity: "warn",
        file,
        line,
        message: `${file}:${line} tells the agent to act without being asked ("${content.trim().slice(0, 80)}"). The permission prompt is the last check on a destructive command; an instruction file is not the place to remove it.`
      }));
    }
    for (const hit of findSecretsInLine(content)) {
      findings.push(finding({
        rule: "instructions_carry_secret",
        severity: "block",
        file,
        line,
        message: `${file}:${line} contains what looks like a ${hit.id.replaceAll("_", " ")} (${hit.masked}). It is in the repository, so it is in every clone; rotate it and read it from the environment.`
      }));
    }
  });
  return findings;
}

/**
 * Findings from one Claude Code settings document.
 *
 * @param {string} file
 * @param {object} document
 * @returns {object[]}
 */
export function scanSettingsDocument(file, document) {
  const findings = [];
  const permissions = document?.permissions ?? {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow.map(String) : [];
  const deny = Array.isArray(permissions.deny) ? permissions.deny.map(String) : [];
  for (const entry of allow) {
    const match = WIDE_PERMISSION.exec(entry.trim());
    if (!match) continue;
    const tool = match.groups.tool;
    findings.push(finding({
      rule: tool.toLowerCase() === "bash" ? "settings_allow_any_command" : "settings_allow_any_use",
      severity: tool.toLowerCase() === "bash" ? "block" : "warn",
      file,
      message: tool.toLowerCase() === "bash"
        ? `${file} pre-approves \`${entry}\`: every shell command runs without a prompt, including one an instruction file or a tool result asks for. Allow the commands this project actually needs instead.`
        : `${file} pre-approves \`${entry}\`: every ${tool} call runs without a prompt. Narrow it to the paths or hosts this project needs.`
    }));
  }
  const mode = String(document?.permissions?.defaultMode ?? document?.defaultMode ?? "");
  const modeSeverity = PERMISSIVE_MODES[mode];
  if (modeSeverity) {
    findings.push(finding({
      rule: "settings_permissive_default_mode",
      severity: modeSeverity,
      file,
      message: mode === "bypassPermissions"
        ? `${file} sets defaultMode "bypassPermissions": nothing is ever asked about, for anyone who opens this repository. It is a debugging setting, not a project one.`
        : `${file} sets defaultMode "acceptEdits": file writes land without review. Reasonable for a scratch repository, worth stating in the project card for a shared one.`
    }));
  }
  if (allow.length && !deny.length) {
    findings.push(finding({
      rule: "settings_no_deny_list",
      severity: "info",
      file,
      message: `${file} pre-approves ${allow.length} pattern(s) and denies nothing. A deny list is what keeps a broad allow from reaching production commands.`
    }));
  }
  for (const { path: keyPath, value } of stringValues(document ?? {})) {
    for (const hit of findSecretsInLine(value)) {
      findings.push(finding({
        rule: "settings_carry_secret",
        severity: "block",
        file,
        message: `${file} → ${keyPath} holds what looks like a ${hit.id.replaceAll("_", " ")} (${maskConfigValue(value)}). Settings files are committed; keep credentials in the environment.`
      }));
    }
  }
  return findings;
}

/** Every hook command a settings document declares, with where it came from. */
export function hookCommands(document) {
  const commands = [];
  const hooks = document?.hooks;
  if (!hooks || typeof hooks !== "object") return commands;
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of Array.isArray(matchers) ? matchers : [matchers]) {
      const inner = Array.isArray(matcher?.hooks) ? matcher.hooks : (matcher?.command ? [matcher] : []);
      for (const hook of inner) {
        if (typeof hook?.command !== "string") continue;
        commands.push({ event, matcher: String(matcher?.matcher ?? ""), command: hook.command });
      }
    }
  }
  return commands;
}

/**
 * Findings from the hook commands a settings document declares.
 *
 * @param {string} file
 * @param {object} document
 * @returns {object[]}
 */
export function scanHookCommands(file, document) {
  const findings = [];
  for (const { event, matcher, command } of hookCommands(document)) {
    const where = `${event}${matcher ? `(${matcher})` : ""}`;
    const tokens = command.match(/\$\(|`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g) ?? [];
    const risky = tokens.filter((token) => !SAFE_HOOK_VARIABLES.test(token.replace(/[{}]/g, "")));
    if (!HOOK_INTERPOLATION.test(command) || !risky.length) continue;
    findings.push(finding({
      rule: "hook_command_interpolates",
      severity: "block",
      file,
      message: `${file} → hooks.${where} runs \`${command.slice(0, 120)}\`, which splices ${risky.slice(0, 3).join(", ")} into a shell. A hook's input is the tool call's own arguments, so a file name or a command string decides what runs. Read the payload from stdin in a script instead.`
    }));
  }
  return findings;
}

/**
 * Findings from one subagent definition.
 *
 * @param {string} file
 * @param {string} text - The definition, frontmatter included.
 * @returns {object[]}
 */
export function scanAgentDefinition(file, text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!frontmatter) {
    return [finding({
      rule: "agent_without_frontmatter",
      severity: "warn",
      file,
      message: `${file} has no frontmatter, so it declares neither a name nor a tool list and inherits every tool the session has.`
    })];
  }
  const tools = /^tools\s*:\s*(.*)$/mi.exec(frontmatter[1]);
  const value = String(tools?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!tools) {
    return [finding({
      rule: "agent_without_tool_limit",
      severity: "warn",
      file,
      message: `${file} declares no \`tools:\`, so this subagent inherits every tool the session has, Bash included. List the tools it needs.`
    })];
  }
  if (value === "*" || value.toLowerCase() === "all") {
    return [finding({
      rule: "agent_without_tool_limit",
      severity: "warn",
      file,
      message: `${file} declares \`tools: ${value}\`, which is every tool the session has. List the tools it needs.`
    })];
  }
  return [];
}

/**
 * The grade, from the findings.
 *
 * The arithmetic is deliberately simple enough to explain in a card: each
 * finding costs its severity's weight, and a `block` — something that removes a
 * check rather than weakening it — also caps the grade, because a repository
 * with one bypass and nothing else wrong is not an A.
 *
 * @param {object[]} findings
 * @returns {{ grade: string, score: number, block: number, warn: number, info: number }}
 */
export function gradeAgentConfig(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const counts = {
    block: list.filter((item) => item.severity === "block").length,
    warn: list.filter((item) => item.severity === "warn").length,
    info: list.filter((item) => item.severity === "info").length
  };
  const penalty = counts.block * SEVERITY_WEIGHTS.block + counts.warn * SEVERITY_WEIGHTS.warn + counts.info * SEVERITY_WEIGHTS.info;
  const score = Math.max(0, 100 - penalty);
  const banded = GRADE_BANDS.find((band) => score >= band.min).grade;
  // A `block` removes a check rather than weakening one, so it caps the grade
  // as well as costing points: one is a D at best, two is an F.
  const cap = counts.block >= 2 ? "F" : counts.block === 1 ? "D" : "A";
  const grade = GRADE_BANDS.findIndex((band) => band.grade === banded) >= GRADE_BANDS.findIndex((band) => band.grade === cap)
    ? banded
    : cap;
  return { grade, score, ...counts };
}

/**
 * Scan a repository's agent configuration.
 *
 * @param {string} projectRoot
 * @param {{ includeUserScope?: boolean, mcpInventory?: object, env?: object, homeDir?: string }} [options]
 * @returns {Promise<object>}
 */
export async function scanAgentConfig(projectRoot, { includeUserScope = false, mcpInventory = null, env, homeDir } = {}) {
  const root = path.resolve(projectRoot);
  const findings = [];
  const files = [];

  for (const entry of AGENT_CONFIG_FILES) {
    const absolute = path.join(root, ...entry.file.split("/"));
    const { exists, text, error } = await readTextIfExists(absolute);
    const record = { file: entry.file, kind: entry.kind, exists, readable: exists && !error };
    if (exists && error) {
      findings.push(finding({ rule: "config_unreadable", severity: "warn", file: entry.file, message: `${entry.file} could not be read (${error}), so what it allows is unknown.` }));
    } else if (exists && entry.kind === "instructions") {
      findings.push(...scanInstructionFile(entry.file, text));
    } else if (exists && (entry.kind === "settings" || entry.kind === "hooks")) {
      const { document, error: parseError } = parseJsonDocument(text);
      if (parseError) {
        findings.push(finding({ rule: "config_unreadable", severity: "warn", file: entry.file, message: `${entry.file} is not valid JSON (${parseError}), so the client ignores it and what it was meant to restrict is not restricted.` }));
      } else {
        if (entry.kind === "settings") findings.push(...scanSettingsDocument(entry.file, document));
        findings.push(...scanHookCommands(entry.file, document));
      }
    }
    files.push(record);
  }

  const agentsDir = path.join(root, ...AGENT_DEFINITION_DIR.split("/"));
  const agentNames = await fs.readdir(agentsDir).then((names) => names.filter((name) => name.endsWith(".md"))).catch(() => []);
  for (const name of agentNames) {
    const relative = `${AGENT_DEFINITION_DIR}/${name}`;
    const { text } = await readTextIfExists(path.join(agentsDir, name));
    findings.push(...scanAgentDefinition(relative, text));
  }

  // The MCP side is `list_mcp_servers`, not a second implementation of it: its
  // findings arrive already masked and keep their own ids.
  const inventory = mcpInventory ?? await listMcpServers({ projectRoot: root, includeUserScope, env, homeDir });
  for (const item of inventory.findings ?? []) {
    findings.push(finding({
      rule: `mcp_${item.id}`,
      severity: item.severity,
      file: item.path || ".mcp.json",
      message: `${item.server ? `MCP server "${item.server}": ` : "MCP configuration: "}${item.message}`
    }));
  }

  const order = { block: 0, warn: 1, info: 2 };
  findings.sort((left, right) => (order[left.severity] ?? 3) - (order[right.severity] ?? 3) || left.file.localeCompare(right.file) || left.line - right.line);
  const grade = gradeAgentConfig(findings);
  return {
    project_path: root,
    files,
    agent_definitions: agentNames.map((name) => `${AGENT_DEFINITION_DIR}/${name}`),
    mcp: {
      servers: inventory.summary?.servers ?? 0,
      sources_present: inventory.summary?.sources_present ?? 0,
      user_scope: Boolean(inventory.user_scope)
    },
    findings,
    ...grade,
    status: grade.block ? "block" : grade.warn ? "warn" : "pass"
  };
}

/**
 * The grade as the one-screen section a project card carries.
 *
 * @param {object} scan - From {@link scanAgentConfig}.
 * @returns {string}
 */
export function renderAgentConfigMarkdown(scan) {
  const lines = [
    `- Grade: **${scan.grade}** (${scan.score}/100), ${scan.block} blocking, ${scan.warn} warning, ${scan.info} advisory finding(s).`,
    `- Files read: ${scan.files.filter((file) => file.exists).map((file) => `\`${file.file}\``).join(", ") || "none"}.`,
    `- MCP servers declared: ${scan.mcp.servers} across ${scan.mcp.sources_present} config file(s).`
  ];
  if (scan.agent_definitions.length) lines.push(`- Subagents: ${scan.agent_definitions.length}.`);
  if (scan.findings.length) {
    lines.push("", "Findings:");
    for (const item of scan.findings.slice(0, 20)) {
      lines.push(`- \`${item.severity}\` ${item.rule} — ${item.message}`);
    }
    if (scan.findings.length > 20) lines.push(`- …and ${scan.findings.length - 20} more.`);
  } else {
    lines.push("", "No findings: nothing here removes a check an agent would otherwise get.");
  }
  return `${lines.join("\n")}\n`;
}

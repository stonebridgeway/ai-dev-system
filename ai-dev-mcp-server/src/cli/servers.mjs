/**
 * `ai-dev servers` — the MCP servers the AI clients start for a repository:
 * what each runs, which client config names it, and what to look at before
 * trusting it (`list_mcp_servers`). Read-only.
 *
 * Exit codes: 0 done, 1 failed, 2 a usage mistake.
 */
import path from "node:path";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { tildify } from "./context.mjs";
import { cut, lineWidth, withTools } from "./tools.mjs";

export function usage() {
  return [
    "Usage: ai-dev servers [--project <path>] [--mine] [--json]",
    "",
    "The MCP servers AI clients start for a repository — Claude Code, Cursor, VS Code, Gemini, Codex —",
    "from the configs in it: what each runs, which config names it, and what to check before",
    "trusting it (an unpinned package, a credential in cleartext). Nothing is changed.",
    "",
    "  --project <path>   the repository; the current folder when left out",
    "  --mine             also your own configs in your home folder, which apply to every repository",
    "  --json             print the result as JSON"
  ].join("\n");
}

/** What a server runs, in one phrase. */
function runs(server) {
  if (server.url) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 */
/**
 * The servers and what to check in them, each line within `width`: a server's command is cut to
 * fit beside its clients, and a finding wraps at words under a four-space indent.
 *
 * @param {{ servers: Array<object>, findings?: Array<object> }} listed
 * @param {{ width: number, mine?: boolean }} options
 * @returns {string[]}
 */
export function serverLines(listed, { width, mine = false }) {
  const lines = [];
  if (!listed.servers.length) lines.push(`  None in ${mine ? "these configs" : "this repository's configs: --mine adds your own"}.`);
  const column = Math.min(24, Math.max(0, ...listed.servers.map((server) => server.name.length))) + 4;
  for (const server of listed.servers) {
    const where = [...new Set(server.origins.map((origin) => origin.client))].join(", ");
    // The line ends with "  (" + where + ")", and stays a column short of the edge.
    lines.push(`${`  ${server.name}`.padEnd(column)}${cut(runs(server), Math.max(20, width - column - where.length - 5))}  (${where})`);
  }
  for (const finding of listed.findings ?? []) lines.push(...wrapWords(`${finding.severity} · ${finding.server}: ${finding.message}`, width - 1, "  ", "    "));
  return lines;
}

/** `text` broken at spaces into lines no longer than `width`, the first after `first`, the rest after `rest`. */
function wrapWords(text, width, first, rest) {
  const lines = [];
  let line = first;
  for (const word of String(text).replace(/\s+/g, " ").trim().split(" ")) {
    const start = line === first || line === rest;
    if (!start && line.length + 1 + word.length > width) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (start ? "" : " ") + word;
    }
  }
  lines.push(line);
  return lines;
}

export async function run(argv, io) {
  const { values } = parseCommandLine(argv, {
    command: "servers",
    options: { json: { type: "boolean" }, project: { type: "string" }, mine: { type: "boolean" } }
  });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  const project = path.resolve(values.project ?? process.cwd());
  return withTools(async ({ call }) => {
    const listed = await call("list_mcp_servers", { project_path: project, include_user_scope: Boolean(values.mine) });
    if (values.json) {
      io.out(JSON.stringify(listed, null, 2));
      return EXIT.ok;
    }
    io.out(`MCP servers · ${tildify(project)}${values.mine ? " and your own configs" : ""}`);
    for (const line of serverLines(listed, { width: lineWidth(io), mine: Boolean(values.mine) })) io.out(line);
    const unreadable = listed.sources.filter((source) => source.exists && !source.readable);
    for (const source of unreadable) io.out(`  ${source.path} could not be read: ${source.error}`);
    // The tool speaks to an agent; at a terminal its tool is a command.
    if (listed.next_step) io.out(String(listed.next_step).replaceAll("install_local_mcp_clients", "`ai-dev clients install`"));
    return EXIT.ok;
  });
}

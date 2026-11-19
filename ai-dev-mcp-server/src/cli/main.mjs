/**
 * `ai-dev` — one command for everything a person does with this server.
 *
 * Commands load on demand: `ai-dev help`, `ai-dev version` and a mistyped
 * command answer without starting the runtime or touching any data. The old
 * `scripts/ai-dev.mjs` imported the whole runtime and migrated the runtime home
 * before it looked at the command, so a typo moved files and then printed the
 * help, and its `start` imported a server that only starts when run directly —
 * exit 0, nothing served.
 *
 * Exit codes: 0 done, 1 failed, 2 wrong usage, 130 stopped with Ctrl-C.
 */
import { CliUsageError, EXIT, closest } from "../core/cli-args.mjs";
import { applySettingsToEnvironment } from "../core/settings.mjs";
import { createIo, packageVersion } from "./context.mjs";

/** @typedef {{ summary: string, group: string, load: () => Promise<{ run: (argv: string[], io: import("./context.mjs").CliIo, name: string) => Promise<number | null | undefined>, usage?: (name: string) => string }> }} CommandEntry */

const runtime = () => import("./runtime.mjs");

/** @type {Map<string, CommandEntry>} */
export const COMMANDS = new Map([
  ["setup", { group: "Setup", summary: "Build the search index, connect your AI clients, optionally get the local model", load: () => import("./setup.mjs") }],
  ["clients", { group: "Setup", summary: "list | install | remove | doctor — the ai-dev entry in Claude, Cursor, VS Code, Codex, Gemini", load: () => import("./clients.mjs") }],
  ["settings", { group: "Configure", summary: "list | get | set | reset — the settings file: profiles, model folder and mirror, daemon idle time", load: () => import("./settings.mjs") }],
  ["skills", { group: "Configure", summary: "search | show | mine | add | new | remove | import | rebuild — the skill library, your own skills too", load: () => import("./skills.mjs") }],
  ["rules", { group: "Configure", summary: "list | add | on | off | remove | hooks | install — a repository's guard rules and engineering rules", load: () => import("./rules.mjs") }],
  ["servers", { group: "Configure", summary: "The MCP servers AI clients start for a repository, and what to check before trusting them", load: () => import("./servers.mjs") }],
  ["model", { group: "Setup", summary: "status | install | import | verify | remove | doctor — the local search model", load: () => import("./model.mjs") }],
  ["uninstall", { group: "Setup", summary: "Take the desktop app's runtime off this computer (what the Windows uninstaller runs)", load: () => import("./uninstall.mjs") }],
  ["mcp", { group: "Run", summary: "Serve MCP on stdin/stdout — what an AI client starts", load: runtime }],
  ["daemon", { group: "Run", summary: "start | stop | status | run — the one warm server every client is handed to", load: () => import("./daemon.mjs") }],
  ["menu", { group: "Run", summary: "A menu over all of this, by number — what `ai-dev` alone opens at a terminal", load: () => import("./menu.mjs") }],
  ["status", { group: "Run", summary: "The state of this install in a few lines: model, index, clients, health checks", load: () => import("./status.mjs") }],
  ["doctor", { group: "Run", summary: "Check the health of this install (the full report, as JSON)", load: runtime }],
  ["reindex", { group: "Maintenance", summary: "Rebuild text search, keeping the dense vectors", load: runtime }],
  ["refresh", { group: "Maintenance", summary: "Refresh overlays, outcomes, search, runtime and dashboard", load: runtime }],
  ["dashboard", { group: "Maintenance", summary: "Regenerate the Obsidian dashboard", load: runtime }],
  ["galaxy", { group: "Maintenance", summary: "Render the vault as a 3D galaxy (HTML)", load: runtime }],
  ["distribution", { group: "Maintenance", summary: "Check the runtime distribution boundaries", load: runtime }],
  ["acceptance", { group: "Maintenance", summary: "Run the acceptance suite (a source checkout only)", load: runtime }],
  ["backup", { group: "Maintenance", summary: "ZIP backup of the vault and AI Dev's state, with every file's sha256", load: () => import("./backup.mjs") }],
  ["restore", { group: "Maintenance", summary: "Put a backup back (--confirm)", load: () => import("./backup.mjs") }]
]);

/** Names that used to work, kept as synonyms. */
const SYNONYMS = new Map([["start", "mcp"], ["serve", "mcp"]]);

function overview() {
  const lines = [
    `ai-dev ${packageVersion()} — a local MCP server for AI coding agents.`,
    "",
    "Usage: ai-dev <command> [options]      (from a clone: npm run ai-dev -- <command>)",
    ""
  ];
  for (const group of ["Setup", "Configure", "Run", "Maintenance"]) {
    lines.push(`${group}:`);
    for (const [name, entry] of COMMANDS) {
      if (entry.group === group) lines.push(`  ${name.padEnd(14)}${entry.summary}`);
    }
    lines.push("");
  }
  lines.push(
    "  version       Print the version",
    "  help [cmd]    This text, or one command's",
    "",
    "Exit codes: 0 done, 1 failed, 2 wrong usage, 130 stopped with Ctrl-C."
  );
  return lines.join("\n");
}

function unknownCommand(name) {
  const near = closest(name, [...COMMANDS.keys(), "help", "version"]);
  return new CliUsageError(`There is no command "${name}".${near ? ` Did you mean \`ai-dev ${near}\`?` : ""} \`ai-dev help\` lists them.`);
}

/**
 * Run one command line.
 *
 * @param {string[]} argv - Everything after `ai-dev`.
 * @param {import("./context.mjs").CliIo} [io]
 * @returns {Promise<number | null>} The exit code, or null when the command keeps
 *   the process alive on its own (`mcp`).
 */
export async function main(argv, io = createIo()) {
  // `ai-dev` alone: the menu for a person at a terminal, the overview for anything else.
  const [first = io.interactive ? "menu" : "help", ...rest] = argv;
  try {
    if (first === "help" || first === "--help" || first === "-h") {
      const [topic] = rest;
      if (!topic) {
        io.out(overview());
        return EXIT.ok;
      }
      const name = SYNONYMS.get(topic) ?? topic;
      const entry = COMMANDS.get(name);
      if (!entry) throw unknownCommand(topic);
      return await (await entry.load()).run(["--help"], io, name) ?? EXIT.ok;
    }
    if (first === "version" || first === "--version" || first === "-v") {
      io.out(`ai-dev ${packageVersion()} (Node ${process.versions.node}, ${process.platform}-${process.arch})`);
      return EXIT.ok;
    }
    const name = SYNONYMS.get(first) ?? first;
    const entry = COMMANDS.get(name);
    if (!entry) throw unknownCommand(first);
    // What the settings file says fills the variables the environment leaves
    // unset, for this command and every process it starts: the daemon, the
    // bridge's own server. A variable set by hand keeps the last word.
    applySettingsToEnvironment(io.env);
    const module = await entry.load();
    return await module.run(rest, io, name);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(error.message);
      return EXIT.usage;
    }
    io.err(String(error?.message ?? error));
    return Number.isInteger(error?.exitCode) ? error.exitCode : EXIT.failed;
  }
}

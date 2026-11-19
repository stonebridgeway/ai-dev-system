/**
 * What a program needs to drive this install from outside it — the desktop
 * app, a script, a test: an MCP SDK client on the daemon every AI
 * client shares, the settings, the daemon's log, stopping it.
 *
 * The app imports this module by its path inside the install, so the SDK and
 * the daemon code it runs are the install's own; nothing here is the app's.
 */
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { listClients } from "./client-connections.mjs";
import { stopDaemons } from "./daemon-client.mjs";
import { DaemonClientTransport } from "./daemon-transport.mjs";
import { tailLines } from "./log-tail.mjs";
import { daemonLogPath } from "./runtime-paths.mjs";
import { SETTINGS_SCHEMA_VERSION, readSettings, writeSettings } from "./settings.mjs";

export { SETTINGS_SCHEMA_VERSION, readSettings, stopDaemons, writeSettings };

/**
 * Connect an MCP SDK client to the daemon of this install's build for `env`,
 * with the `control` profile unless told otherwise. The settings apply to the
 * session's environment as they do at the CLI's start (`connectDaemon`), so
 * the build is the one `ai-dev mcp` in the same environment reaches.
 *
 * @param {object} options
 * @param {string} options.serverRoot - `ai-dev-mcp-server/` of this install.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.execPath] - The Node the daemon runs on; the caller's own when it is Node.
 * @param {boolean} [options.start] - Start the daemon when none runs; false fails with code ENOTRUNNING.
 * @param {string} [options.profiles]
 * @param {string} [options.name] - The client name the daemon shows in `ai-dev daemon status`.
 * @param {string} [options.version]
 * @returns {Promise<{ client: Client, transport: DaemonClientTransport }>}
 */
export async function openControlClient({ serverRoot, env = process.env, execPath, start = true, profiles = "control", name = "ai-dev-control", version = "1.0.0", timeoutMs } = {}) {
  const transport = new DaemonClientTransport({ serverRoot, env, profiles, execPath, start, timeoutMs });
  const client = new Client({ name, version }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** The last lines of the daemon's log, for a screen that says why it did not start. */
export async function daemonLogTail(env = process.env, lines = 12) {
  const tail = await tailLines(daemonLogPath(env), { lines });
  return tail.lines;
}

/**
 * The Node executables AI clients' ai-dev entries run — what `ai-dev clients
 * install` wrote — so the app starts the daemon on the same Node and reaches
 * the same one they do. Entries that run this install come first.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, cliPath?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function clientNodePaths({ env = process.env, home = os.homedir(), cliPath } = {}) {
  const ours = [];
  const others = [];
  for (const client of await listClients({ env, home })) {
    const entry = client.row?.entries?.["ai-dev"];
    if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) continue;
    if (!/^node(\.exe)?$/i.test(path.basename(entry.command))) continue;
    const runsThis = cliPath && entry.args.some((arg) => typeof arg === "string" && path.resolve(arg) === path.resolve(cliPath));
    (runsThis ? ours : others).push(entry.command);
  }
  return [...new Set([...ours, ...others])];
}

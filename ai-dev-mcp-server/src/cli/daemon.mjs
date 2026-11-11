/**
 * `ai-dev daemon start | stop | status | run` — the one warm server every AI
 * client of this user is bridged to (`src/daemon.mjs`). Clients do not need
 * any of these: `ai-dev mcp` starts the daemon when it is not running. They are
 * for a person who wants to see it, stop it, or run it in a terminal.
 */
import { CliUsageError, EXIT, closest, parseCommandLine } from "../core/cli-args.mjs";
import { formatBytes } from "../core/disk-space.mjs";
import { readLine, writeLine } from "../core/daemon-channel.mjs";
import { connectDaemon, daemonStatus, stopDaemons } from "../core/daemon-client.mjs";
import { CLI_PATH, SERVER_ROOT, packageVersion, tildify } from "./context.mjs";

const SUBCOMMANDS = ["start", "stop", "status", "run"];

export function usage() {
  return [
    "Usage: ai-dev daemon <start | stop | status | run> [--json]",
    "",
    "One warm server for every AI client of this user. `ai-dev mcp` — what each client's",
    "config runs — hands the client to it, and starts it when it is not running.",
    "",
    "  start    start it in the background",
    "  stop     stop it, and every other daemon of this runtime home; a client that sends",
    "           another request starts a new one",
    "  status   whether it runs: pid, version, sessions, memory, address, log, and the other",
    "           daemons of this runtime home (exit 1: none runs for this install)",
    "  run      serve in this terminal, as `start` does in the background",
    "  --json   print the result as JSON",
    "",
    "Clients whose code or data differ — another copy of AI Dev, another AI_DEV_VAULT_ROOT —",
    "each get a daemon of their own. AI_DEV_DAEMON=0 in a client's environment makes",
    "`ai-dev mcp` serve that client in its own process, as 2.x did. The daemon leaves after",
    "30 minutes without a client (AI_DEV_IDLE_TIMEOUT_MS)."
  ].join("\n");
}

function duration(seconds) {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

/** A message for the middle of a sentence: without the full stop it ends with. */
const clause = (message) => String(message ?? "").trim().replace(/\.+$/, "");

/** One line about a daemon that is not this install's own. */
function otherLine(daemon) {
  const sessions = `${daemon.sessions} session(s)`;
  if (daemon.gone) return `Pid ${daemon.pid} is gone and left its descriptor behind; \`ai-dev daemon stop\` clears it.`;
  if (daemon.unreachable) return `Pid ${daemon.pid} does not answer: ${clause(daemon.unreachable)}.`;
  if (daemon.retired) return `Also running: pid ${daemon.pid}, retired (${clause(daemon.retired_reason)}), finishing ${sessions}.`;
  const why = daemon.differences.length ? ` — ${daemon.differences.join("; ")}` : "";
  return `Also running: pid ${daemon.pid}, ai-dev ${daemon.version}, ${sessions}${why}.`;
}

async function status(values, io) {
  const result = await daemonStatus({ serverRoot: SERVER_ROOT, version: packageVersion(), env: io.env });
  if (values.json) {
    io.out(JSON.stringify(result, null, 2));
    return result.running ? EXIT.ok : EXIT.failed;
  }
  if (!result.running) {
    if (result.stale) io.out(`Not running: ${clause(result.reason)}.`);
    else if (result.others.length) io.out("Not running for this install and environment: a client started from here gets a daemon of its own.");
    else io.out("Not running. `ai-dev mcp` starts it when a client connects; `ai-dev daemon start` starts it now.");
  } else {
    const clients = result.clients?.length ? `: ${result.clients.map((client) => `${client.name || "a client"} ${client.version ?? ""}`.trim()).join(", ")}` : "";
    io.out(`Running: pid ${result.pid}, ai-dev ${result.version}, up ${duration(result.uptime_s)}, ${result.sessions} session(s)${clients}.`);
    io.out(`Memory: ${formatBytes(result.rss_bytes)}. Address: ${result.address}. Log: ${result.log ? tildify(result.log) : "its terminal"}.`);
  }
  for (const daemon of result.others) io.out(otherLine(daemon));
  if (result.others.length) io.out("`ai-dev daemon stop` stops every one of them.");
  return result.running ? EXIT.ok : EXIT.failed;
}

async function start(values, io) {
  const channel = await connectDaemon({ serverRoot: SERVER_ROOT, cliPath: CLI_PATH, version: packageVersion(), env: io.env, mode: "control" });
  try {
    await writeLine(channel.socket, { control: "ping" });
    await readLine(channel.socket, { buffered: channel.rest });
  } finally {
    channel.socket.destroy();
  }
  const result = { status: channel.started ? "started" : "running", pid: channel.info.pid, address: channel.info.address, build: channel.build.id };
  if (values.json) io.out(JSON.stringify(result, null, 2));
  else if (!channel.started) io.out(`Already running: pid ${result.pid}.`);
  else io.out(`Started: pid ${result.pid}. Log: ${channel.info.log ? tildify(channel.info.log) : "none"}.`);
  return EXIT.ok;
}

async function stop(values, io) {
  const { daemons } = await stopDaemons({ env: io.env });
  const failed = daemons.filter((daemon) => !daemon.stopped);
  if (values.json) {
    io.out(JSON.stringify({ running: failed.length > 0, daemons }, null, 2));
    return failed.length ? EXIT.failed : EXIT.ok;
  }
  const stopped = daemons.filter((daemon) => daemon.stopped && !daemon.gone);
  if (!stopped.length && !failed.length) io.out("Not running.");
  for (const daemon of stopped) io.out(`Stopped: pid ${daemon.pid}${daemon.retired ? " (retired)" : ""}, ${daemon.sessions} session(s) ended with it.`);
  for (const daemon of failed) io.out(`Pid ${daemon.pid} did not stop: ${clause(daemon.reason) || "it is still running"}.`);
  return failed.length ? EXIT.failed : EXIT.ok;
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 * @returns {Promise<number | null>}
 */
export async function run(argv, io) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    io.out(usage());
    return subcommand ? EXIT.ok : EXIT.usage;
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    const near = closest(subcommand, SUBCOMMANDS);
    throw new CliUsageError(`\`ai-dev daemon\` has no "${subcommand}".${near ? ` Did you mean \`ai-dev daemon ${near}\`?` : ""} It takes ${SUBCOMMANDS.join(", ")}.`);
  }
  const { values } = parseCommandLine(rest, { command: `daemon ${subcommand}`, options: subcommand === "run" ? {} : { json: { type: "boolean" } } });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  if (subcommand === "status") return status(values, io);
  if (subcommand === "start") return start(values, io);
  if (subcommand === "stop") return stop(values, io);
  const { runDaemon } = await import("../daemon.mjs");
  if (await runDaemon({ env: io.env })) return null;
  io.err("A daemon of this build already serves this runtime home, or is starting: `ai-dev daemon status` shows it.");
  return EXIT.ok;
}

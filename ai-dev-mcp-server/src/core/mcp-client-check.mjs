/**
 * Start the command an MCP client would start, ask it `initialize`, and say
 * what came back.
 *
 * A config can name a Node that has since been uninstalled, a checkout that
 * moved, or a server that prints a banner on stdout and breaks the protocol;
 * the client then shows a red dot and nothing else. This runs the same
 * command line the same way a client does (no shell, the entry's `env` on top
 * of the environment) and reads the answer as a client would: one JSON-RPC
 * message per line on stdout.
 */
import { spawn } from "node:child_process";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-dev clients doctor", version: "1" } }
};

/** What Node prints around an uncaught error that says nothing about it. */
const NOISE = [
  /^Node\.js v\d/, // the version, printed last
  /^\s+at\s/, // the stack
  /^\s*\^+\s*$/, // the caret under the line that threw
  /^\s*[{}]\s*$/, // the error's own properties…
  /^\s+[\w$]+: /, // …one per line
  /^(?:node:|file:\/\/)\S+:\d+$/, // where it was thrown
  // What the Docker CLI prints after a usage error, its own words, before 29 and since
  /^(?:Usage:\s+docker\s.*|See '[^']+ --help'\.|Run '[^']+ --help' for more information)$/,
  // A warning the Docker CLI prints before it goes on — a config file it cannot read, an image of another platform,
  // ports with the host's network: no reason it stopped, and the first of them says "Error"
  /^WARNING: /
];

/**
 * The line of a command's stderr that says why it stopped: the last one that
 * names an error — one not indented first, as Node prints the error itself
 * and indents its causes — else the last that is not noise. The last line
 * itself was Node's version, and a moved clone was reported as "Node.js
 * v22.22.0". A line past 300 characters keeps its
 * start and its end: Docker says why it refused a `--mount` after the whole
 * value, which a long path made the part cut off. Each cut falls
 * between two characters, not inside a surrogate pair: half of one is no
 * character, and `--json` wrote it as `\ud83d`.
 */
function errorLine(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !NOISE.some((pattern) => pattern.test(line)));
  const named = (line) => /\b(?:error|exception)\b/i.test(line);
  const line = (lines.findLast((each) => named(each) && !/^\s/.test(each)) ?? lines.findLast(named) ?? lines.at(-1) ?? "").trim();
  if (line.length <= 300) return line;
  const head = /[\ud800-\udbff]/.test(line[149]) ? 149 : 150;
  const tail = /[\udc00-\udfff]/.test(line[line.length - 149]) ? line.length - 150 : line.length - 149;
  return `${line.slice(0, head)}\u2026${line.slice(tail)}`;
}

/** How long a command told to stop has to exit before it is killed — the command, not a container it started. */
const STOP_GRACE_MS = 5000;

/**
 * @typedef {object} CommandCheck
 * @property {boolean} ok - It answered `initialize` with instructions.
 * @property {number} ms
 * @property {{ name?: string, version?: string }} [server]
 * @property {string} [protocolVersion]
 * @property {number} [instructions] - Length of the instructions it sent.
 * @property {string} [error] - What went wrong, in a sentence.
 * @property {number | null} [code] - The exit code of a command that ended before it answered (null for a signal).
 * @property {string} [stderr] - The end of what such a command wrote to stderr, as it wrote it.
 */

/**
 * @param {{ command: string, args?: unknown[], env?: Record<string, string> }} entry
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, killAfterMs?: number }} [options]
 * @returns {Promise<CommandCheck>}
 */
export function checkServerCommand(entry, { timeoutMs = 30_000, env = process.env, spawnProcess = spawn, killAfterMs = STOP_GRACE_MS } = {}) {
  const started = Date.now();
  const command = String(entry?.command ?? "");
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    // Told to stop as an MCP client tells a server — its stdin closed, and SIGTERM — and killed if it is still there
    // a few seconds on: a child that runs keeps this process from exiting, and `docker run -i` passes SIGTERM to a
    // container whose first process may not stop for it, as `sleep` does not; nor does a Docker CLI that waits on an
    // engine that hangs. What is killed is the command — for `docker run`, the Docker CLI: such a container
    // runs on until that process ends, and `--rm` then removes it. Node signals no child that has exited, so
    // one that stopped is not killed.
    const stop = () => {
      if (!child) return;
      child.stdin.end();
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), killAfterMs).unref();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve({ ...result, ms: Date.now() - started });
    };
    if (!command) {
      finish({ ok: false, error: "the entry names no command" });
      return;
    }
    try {
      child = spawnProcess(command, args, {
        env: { ...env, ...(entry.env && typeof entry.env === "object" ? entry.env : {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      finish({ ok: false, error: `${command} could not be started: ${error.message}` });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, error: `no answer to initialize within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (let newline = stdout.indexOf("\n"); newline >= 0 && !settled; newline = stdout.indexOf("\n")) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, error: `it printed something other than MCP on stdout, which clients cannot read: ${line.slice(0, 120)}` });
          return;
        }
        if (message?.id !== 1) continue;
        if (message.error) {
          finish({ ok: false, error: `it refused initialize: ${message.error.message ?? JSON.stringify(message.error)}` });
          return;
        }
        const result = message.result ?? {};
        const instructions = typeof result.instructions === "string" ? result.instructions.length : 0;
        finish({
          ok: instructions > 0,
          server: result.serverInfo,
          protocolVersion: result.protocolVersion,
          instructions,
          ...(instructions > 0 ? {} : { error: "it answered initialize without instructions" })
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.stdin.on("error", () => undefined); // a command that died early closed it; `close` says why
    child.on("error", (error) => {
      finish({ ok: false, error: error?.code === "ENOENT" ? `${command} does not exist` : `${command} could not be started: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      const why = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      const said = errorLine(stderr);
      finish({ ok: false, error: `it ${why} before answering${said ? `: ${said}` : ""}`, code, stderr });
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  });
}

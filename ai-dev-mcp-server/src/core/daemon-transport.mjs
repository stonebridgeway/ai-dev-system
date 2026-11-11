/**
 * An MCP SDK transport to the daemon — what a program uses where a client
 * config uses `ai-dev mcp`: the desktop app, a test, a script.
 *
 *   const client = new Client({ name: "my-app", version: "1.0.0" });
 *   await client.connect(new DaemonClientTransport({ serverRoot }));
 *
 * It finds the daemon of this install's build, or starts one, proves itself
 * with the secret in the daemon's descriptor (`run/daemon-<build>.json`) and
 * checks the daemon's proof (`daemon-channel.mjs`); the session then runs in
 * the environment given here, as a client's does in its bridge's. After that
 * the connection is plain MCP, one message per line.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { connectDaemon } from "./daemon-client.mjs";

export class DaemonClientTransport {
  #options;
  #socket = null;
  #buffer = new ReadBuffer();
  #closed = false;

  onclose;
  onerror;
  onmessage;

  /** What the descriptor said about the daemon this transport reached, once started. */
  info = null;

  /** The daemon's answer to the handshake: version, build, the session's tool counts. */
  welcome = null;

  /**
   * @param {object} options
   * @param {string} options.serverRoot - `ai-dev-mcp-server/` of the install whose daemon to reach.
   * @param {NodeJS.ProcessEnv} [options.env] - The session's environment: the build is computed from it,
   *   a daemon this transport starts gets it, and the session's tools run in it.
   * @param {string | null} [options.profiles] - The session's capability profiles; empty for the default
   *   surface, `control` (with or without others) for the desktop app's tools. Not given: what `env`
   *   names, with the settings applied, as for a client's `ai-dev mcp`.
   * @param {number} [options.timeoutMs] - How long to wait for a daemon this transport starts.
   * @param {string} [options.execPath] - The Node the daemon runs on; needed where this process is not
   *   that Node (Electron): the daemon's build includes it, and a client's `ai-dev mcp` runs on it.
   * @param {boolean} [options.start] - false: reach a running daemon only; `start()` then fails with
   *   code `ENOTRUNNING` when there is none.
   */
  constructor({ serverRoot, env = process.env, profiles = null, timeoutMs, execPath, start = true } = {}) {
    if (!serverRoot) throw new Error("DaemonClientTransport needs the serverRoot of the install whose daemon it reaches.");
    const version = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8")).version;
    this.#options = { serverRoot, cliPath: path.join(serverRoot, "bin", "ai-dev.mjs"), version, env, profiles, timeoutMs, start, ...(execPath ? { execPath } : {}) };
  }

  /** Connect: called by the SDK's `Client.connect`. */
  async start() {
    if (this.#socket) throw new Error("DaemonClientTransport is already started.");
    const channel = await connectDaemon({ ...this.#options, mode: "mcp" });
    this.info = channel.info;
    this.welcome = channel.welcome;
    this.#socket = channel.socket;
    this.#socket.on("data", (chunk) => this.#read(chunk));
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#notifyClosed());
    if (channel.rest?.length) this.#read(channel.rest);
    this.#socket.resume();
  }

  #read(chunk) {
    try {
      this.#buffer.append(chunk);
    } catch (error) {
      this.onerror?.(error);
      this.#socket?.destroy();
      return;
    }
    for (;;) {
      let message;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        this.onerror?.(error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  /** @param {unknown} message */
  async send(message) {
    if (!this.#socket || this.#closed) throw new Error("The daemon connection is closed.");
    await new Promise((resolve, reject) => {
      this.#socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close() {
    this.#socket?.end();
    this.#notifyClosed();
  }

  #notifyClosed() {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}

import { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * The largest message a session takes: the SDK's own limit for stdio, so a
 * client meets the same bound whether it is served by the daemon or in its own
 * process. The bridge refuses a longer one itself (`daemon-bridge.mjs`).
 */
export const MAX_MESSAGE_BYTES = STDIO_DEFAULT_MAX_BUFFER_SIZE;

/**
 * Room above one message in the read buffer: the rest of the socket read that
 * ends it, so a message of the largest size is never refused for the bytes
 * that came with it.
 */
const READ_SLACK_BYTES = 1024 * 1024;

/**
 * MCP's line-delimited JSON transport, carried over a local socket.
 *
 * The stdio transport the server normally uses frames messages the same way,
 * so this reuses the SDK's own buffer and serialiser and only swaps the pipe:
 * a Unix socket, or a named pipe on Windows. That is what lets one daemon
 * serve many clients while each still speaks plain MCP.
 */
export class SocketServerTransport {
  #socket;
  #buffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE_BYTES + READ_SLACK_BYTES });
  #buffered;
  #scope;
  #started = false;
  #closed = false;

  onclose;
  onerror;
  onmessage;

  /**
   * @param {import("node:net").Socket} socket - An already-connected socket.
   * @param {{ buffered?: Buffer, scope?: (deliver: () => void) => void }} [options] -
   *   `buffered`: bytes read past the daemon's handshake, the start of the MCP
   *   stream, which must not be lost. `scope`: runs the delivery of each message,
   *   so that everything it sets off runs in the session's environment
   *   (`src/core/session-env.mjs`).
   */
  constructor(socket, { buffered, scope = (deliver) => deliver() } = {}) {
    this.#socket = socket;
    this.#buffered = buffered;
    this.#scope = scope;
  }

  /**
   * Begin reading messages. Called by the SDK during `server.connect`.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#started) {
      throw new Error("SocketServerTransport is already started.");
    }
    this.#started = true;
    this.#socket.on("data", (chunk) => {
      try {
        this.#buffer.append(chunk);
      } catch (error) {
        // Ten megabytes without a line break is not a client to keep reading.
        this.onerror?.(error);
        this.#socket.destroy();
        return;
      }
      this.#drain();
    });
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#notifyClosed());
    if (this.#buffered?.length) {
      this.#buffer.append(this.#buffered);
      this.#buffered = null;
      this.#drain();
    }
    // The handshake leaves the socket paused, so nothing arrives before the
    // listeners above are there to take it.
    this.#socket.resume();
  }

  /** Hand every complete message in the buffer to the server. */
  #drain() {
    for (;;) {
      let message;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        // The bad line is already out of the buffer: report it and go on with
        // the next one, as the SDK's stdio transport does.
        this.onerror?.(error);
        continue;
      }
      if (message === null) return;
      this.#scope(() => this.onmessage?.(message));
    }
  }

  /**
   * @param {unknown} message - A JSON-RPC message to frame and write.
   * @returns {Promise<void>}
   */
  async send(message) {
    if (this.#closed) return;
    await new Promise((resolve, reject) => {
      this.#socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    this.#buffer.clear();
    this.#socket.end();
    this.#notifyClosed();
  }

  /** Fire `onclose` exactly once, however the socket went away. */
  #notifyClosed() {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }
}

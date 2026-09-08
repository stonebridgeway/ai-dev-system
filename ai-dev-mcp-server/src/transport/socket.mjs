import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/** MCP's line-delimited JSON transport over a local Unix socket or named pipe. */
export class SocketServerTransport {
  #socket; #buffer = new ReadBuffer(); #started = false; #closed = false;
  onclose; onerror; onmessage;
  constructor(socket) { this.#socket = socket; }
  async start() {
    if (this.#started) throw new Error("SocketServerTransport is already started.");
    this.#started = true;
    this.#socket.on("data", (chunk) => {
      this.#buffer.append(chunk);
      for (;;) {
        let message;
        try { message = this.#buffer.readMessage(); } catch (error) { this.onerror?.(error); return; }
        if (message === null) return;
        this.onmessage?.(message);
      }
    });
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.#notifyClosed());
  }
  async send(message) {
    await new Promise((resolve, reject) => this.#socket.write(serializeMessage(message), (error) => error ? reject(error) : resolve()));
  }
  async close() { this.#buffer.clear(); this.#socket.end(); this.#notifyClosed(); }
  #notifyClosed() { if (!this.#closed) { this.#closed = true; this.onclose?.(); } }
}

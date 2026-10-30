/**
 * `ai-dev mcp` as a bridge: the AI client's stdin and stdout on one side, the
 * daemon on the other.
 *
 * MCP passes through untouched, one JSON-RPC message per line — the
 * handshake too, so the client gets the daemon's own `initialize` answer with
 * its instructions. The bridge keeps only what it needs when the daemon goes
 * away mid-session (a crash, `kill -9`, `ai-dev daemon stop`):
 *
 * - the client's `initialize`, to replay to the next daemon, so the session
 *   goes on without the client noticing more than one failed call;
 * - the requests the daemon has not answered: each gets an error saying what
 *   happened, instead of hanging until the client's timeout.
 *
 * The next message from the client reconnects — to a daemon started for it,
 * or, when none can be, to a server in this process. When the client closes
 * its end, the bridge stops reading and waits for the answers to what it
 * already sent before it leaves.
 */
import { MAX_MESSAGE_BYTES } from "../transport/socket.mjs";

/** Ids the bridge gives its own requests, so their answers are not passed to the client. */
const BRIDGE_ID = "ai-dev-bridge-";

/** How long a replayed `initialize` may take before the session goes on without it. */
const REPLAY_TIMEOUT_MS = 60_000;

/**
 * How long the bridge waits, once the client closed its end, for the answers
 * to requests it had sent: a rebuild of a large index takes minutes, a server
 * that never answers must not keep the process forever.
 */
export const DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A line longer than this is not even read whole: past the largest message a
 * server takes it can only be refused, and holding more of it costs memory
 * for nothing.
 */
const LONGEST_LINE_READ = 64 * 1024 * 1024;

const isRequest = (message) => typeof message?.method === "string" && message.id !== undefined && message.id !== null;
const isResponse = (message) => message?.method === undefined && message?.id !== undefined;

/**
 * Split a byte stream into JSON-RPC messages, one per line.
 *
 * Bytes are kept as they come and a line is decoded only once it is whole: a
 * pipe hands over 64 KB at a time, and a character cut by a chunk's edge,
 * decoded on its own, became two U+FFFD that `JSON.parse` took without a word —
 * a Russian note of a few hundred kilobytes came out changed, on disk too.
 * Each byte is looked at once and each line joined
 * once, so a line of many megabytes costs what its size does. A line past
 * `longest` bytes is skipped unread, and `onTooLong` hears of it.
 *
 * @param {(message: object, bytes: number) => void} onMessage
 * @param {(line: string, error: Error) => void} onInvalid
 * @param {{ longest?: number, onTooLong?: (bytes: number) => void }} [options]
 * @returns {(chunk: Buffer | string) => void}
 */
export function lineReader(onMessage, onInvalid, { longest = Infinity, onTooLong = () => undefined } = {}) {
  const parts = [];
  let length = 0;
  let skipped = 0;
  return (chunk) => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a)) {
      if (skipped) {
        onTooLong(skipped + end);
        skipped = 0;
        bytes = bytes.subarray(end + 1);
        continue;
      }
      parts.push(bytes.subarray(0, end));
      const size = length + end;
      const line = Buffer.concat(parts, size).toString("utf8").replace(/\r$/, "");
      parts.length = 0;
      length = 0;
      bytes = bytes.subarray(end + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        onInvalid(line, error);
        continue;
      }
      onMessage(message, size);
    }
    if (!bytes.length) return;
    if (skipped) {
      skipped += bytes.length;
    } else if (length + bytes.length > longest) {
      skipped = length + bytes.length;
      parts.length = 0;
      length = 0;
    } else {
      parts.push(bytes);
      length += bytes.length;
    }
  };
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** A message's size and the limit, in megabytes — or in bytes, where megabytes would read the same. */
function sizes(bytes, limit = MAX_MESSAGE_BYTES) {
  return megabytes(bytes) === megabytes(limit) ? [`${bytes} bytes`, `${limit} bytes`] : [megabytes(bytes), megabytes(limit)];
}

/**
 * An upstream over a socket the daemon handshake left paused.
 *
 * @param {{ socket: import("node:net").Socket, rest?: Buffer, describe?: string, pid?: number }} channel
 */
export function socketUpstream({ socket, rest, describe = "the daemon", pid = 0 }) {
  let closed = false;
  return {
    describe,
    /** Whether the daemon's process is still there; one this process may not signal is. */
    alive() {
      if (!pid) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    },
    start(onMessage, onClose) {
      const read = lineReader(onMessage, () => undefined);
      socket.on("data", read);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        closed = true;
        onClose(`${describe} closed the connection`);
      });
      if (rest?.length) read(rest);
      socket.resume();
    },
    send(message) {
      if (closed) return Promise.reject(new Error("closed"));
      return new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
      });
    },
    close() {
      closed = true;
      socket.end();
    }
  };
}

/**
 * Relay one client's MCP session to an upstream that may change under it.
 */
export class StdioBridge {
  #input;
  #output;
  #note;
  #connect;
  #upstream = null;
  #generation = 0;
  #connecting = null;
  #queue = [];
  #initialize = null;
  #initializeForwarded = false;
  #initialized = false;
  #inFlight = new Map();
  #own = new Map();
  #nextOwn = 0;
  #inputEnded = false;
  #drainTimer = null;
  #drainTimeoutMs;
  #unanswered = 0;
  #ended = false;
  #done;

  /**
   * @param {object} options
   * @param {NodeJS.ReadableStream} options.input - The client's messages (stdin).
   * @param {NodeJS.WritableStream} options.output - Where the client reads (stdout).
   * @param {(line: string) => void} options.note - A line for the client's log (stderr).
   * @param {(context: { reconnect: boolean }) => Promise<object>} options.connect - A started-or-found upstream; never rejects.
   * @param {number} [options.drainTimeoutMs] - How long answers are waited for once the client closed its end.
   */
  constructor({ input, output, note, connect, drainTimeoutMs = DRAIN_TIMEOUT_MS }) {
    this.#input = input;
    this.#output = output;
    this.#note = note;
    this.#connect = connect;
    this.#drainTimeoutMs = drainTimeoutMs;
  }

  /**
   * Serve until the client closes its end and the requests it sent are answered.
   *
   * @param {object} upstream - The first upstream, connected before anything is read.
   * @returns {Promise<{ unanswered: number }>} how many requests ended without a server's answer
   */
  run(upstream) {
    this.#attach(upstream);
    return new Promise((resolve) => {
      this.#done = () => resolve({ unanswered: this.#unanswered });
      const read = lineReader(
        (message, bytes) => this.#fromClient(message, bytes),
        (line) => this.#note(`ai-dev: ignored a line from the client that is not JSON: ${line.slice(0, 80)}`),
        {
          longest: LONGEST_LINE_READ,
          onTooLong: (bytes) => this.#note(`ai-dev: skipped a message of ${megabytes(bytes)} from the client: a server takes messages up to ${megabytes(MAX_MESSAGE_BYTES)}, and one this long cannot even be answered.`)
        }
      );
      this.#input.on("data", read);
      this.#input.on("end", () => this.#endOfInput());
      this.#input.on("close", () => this.#endOfInput());
      // The client is gone when it no longer reads what it is sent.
      this.#output.on?.("error", () => this.#finish());
      this.#input.resume?.();
    });
  }

  /** The upstream messages are going to now. */
  #attach(upstream) {
    const generation = ++this.#generation;
    this.#upstream = upstream;
    upstream.start(
      (message) => this.#fromUpstream(generation, message),
      (reason) => this.#lost(generation, reason)
    );
    return generation;
  }

  #fromClient(message, bytes = 0) {
    if (this.#ended || this.#inputEnded) return;
    // A server refuses a message past its limit by dropping the connection; the
    // client hears why instead, and the session goes on.
    if (bytes > MAX_MESSAGE_BYTES) {
      const [size, limit] = sizes(bytes);
      if (isRequest(message)) {
        this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: `This ${message.method} message is ${size}; ai-dev takes messages up to ${limit}.` } });
      }
      this.#note(`ai-dev: refused a message of ${size} from the client: the limit is ${limit}.`);
      return;
    }
    if (isRequest(message) && message.method === "initialize") this.#initialize = message;
    if (message?.method === "notifications/initialized") this.#initialized = true;
    // A cancelled request gets no answer: it no longer waits for one, so a
    // daemon that goes away later does not answer it with an error either.
    if (message?.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      this.#inFlight.delete(id);
      const queued = this.#queue.findIndex((waiting) => isRequest(waiting) && waiting.id === id);
      if (queued >= 0) {
        // Never sent: neither it nor its cancellation needs to go anywhere.
        this.#queue.splice(queued, 1);
        return;
      }
    }
    if (this.#upstream && !this.#connecting) {
      this.#forward(message);
      return;
    }
    this.#queue.push(message);
    this.#reconnect();
  }

  #forward(message) {
    if (!this.#upstream) {
      this.#queue.push(message);
      this.#reconnect();
      return;
    }
    // A daemon that died while idle may not have been heard of yet: Windows
    // closes a killed process's pipe after the process is already gone, and a
    // write into it in between is taken.
    if (isRequest(message) && this.#upstream.alive?.() === false) {
      const gone = this.#upstream;
      this.#lost(this.#generation, `${gone.describe ?? "the daemon"} is gone`);
      gone.close?.();
      this.#queue.push(message);
      this.#reconnect();
      return;
    }
    if (isRequest(message)) {
      const entry = { method: message.method, message, delivered: false };
      this.#inFlight.set(message.id, entry);
      if (message.method === "initialize") this.#initializeForwarded = true;
      this.#upstream.send(message).then(() => {
        entry.delivered = true;
      }, () => undefined);
      return;
    }
    this.#upstream.send(message).catch(() => undefined);
  }

  #fromUpstream(generation, message) {
    if (generation !== this.#generation) return;
    if (isResponse(message)) {
      const own = this.#own.get(message.id);
      if (own) {
        this.#own.delete(message.id);
        own(message);
        return;
      }
      this.#inFlight.delete(message.id);
    }
    this.#write(message);
    this.#drained();
  }

  /**
   * The upstream is gone: every request it took gets an answer now, one it never
   * took goes to the next, and the next message reconnects.
   */
  #lost(generation, reason) {
    if (generation !== this.#generation || this.#ended) return;
    this.#generation += 1;
    this.#upstream = null;
    const untaken = [];
    for (const [id, { method, message, delivered }] of this.#inFlight) {
      // Its write failed or never ended: the daemon was gone before it, as on a
      // Windows pipe, whose end is heard of after a write into it fails.
      if (!delivered) {
        untaken.push(message);
        if (method === "initialize") this.#initializeForwarded = false;
        continue;
      }
      this.#unanswered += 1;
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `The ai-dev daemon went away while ${method} ran (${reason}). The next request starts a new one; repeat this call.` }
      });
    }
    this.#inFlight.clear();
    this.#queue.unshift(...untaken);
    for (const settle of this.#own.values()) settle(null);
    this.#own.clear();
    this.#note(`ai-dev: lost the daemon (${reason}); the next request reconnects.`);
    if (this.#queue.length) this.#reconnect();
    else this.#drained();
  }

  #reconnect() {
    if (this.#connecting || this.#ended) return;
    this.#connecting = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const upstream = await this.#connect({ reconnect: true });
        if (this.#ended) {
          upstream.close();
          return;
        }
        this.#attach(upstream);
        // The new server has not met this client: it is introduced the way the
        // first one was, and only then hears what the client sent meanwhile.
        if (this.#initialize && this.#initializeForwarded) await this.#replayInitialize();
        if (this.#upstream === upstream) {
          this.#connecting = null;
          for (const message of this.#queue.splice(0)) this.#forward(message);
          this.#drained();
          return;
        }
      }
      this.#refuseQueued("no server could be started for it");
    })().catch((error) => {
      this.#refuseQueued(error.message);
    }).finally(() => {
      this.#connecting = null;
      // A reconnect that ended in refusals answered the last requests while it
      // still counted as pending: the client may be waiting on nothing now.
      this.#drained();
    });
  }

  /** Answer every request still waiting for a server, when none can be had. */
  #refuseQueued(reason) {
    for (const message of this.#queue.splice(0)) {
      if (!isRequest(message)) continue;
      this.#unanswered += 1;
      this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `ai-dev could not serve ${message.method}: ${reason}.` } });
    }
    this.#note(`ai-dev: could not reconnect: ${reason}.`);
    this.#drained();
  }

  async #replayInitialize() {
    const id = `${BRIDGE_ID}${++this.#nextOwn}`;
    const answered = new Promise((resolve) => {
      this.#own.set(id, resolve);
      setTimeout(() => resolve(null), REPLAY_TIMEOUT_MS).unref?.();
    });
    await this.#upstream.send({ ...this.#initialize, id }).catch(() => undefined);
    const answer = await answered;
    this.#own.delete(id);
    if (!answer || answer.error) {
      this.#note(`ai-dev: the new server did not take the session over (${answer?.error?.message ?? "no answer"}).`);
      return;
    }
    if (this.#initialized) await this.#upstream?.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  #write(message) {
    if (this.#ended) return;
    try {
      this.#output.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.#finish();
    }
  }

  /** Requests sent or waiting to be sent, which a server has yet to answer. */
  #pending() {
    return this.#inFlight.size + this.#queue.filter(isRequest).length + (this.#connecting ? 1 : 0);
  }

  /**
   * The client closed its end: nothing more is read, and the bridge leaves once
   * the requests it sent have their answers — or, past the drain timeout, says
   * which have none.
   */
  #endOfInput() {
    if (this.#inputEnded || this.#ended) return;
    this.#inputEnded = true;
    if (!this.#pending()) {
      this.#finish();
      return;
    }
    this.#drainTimer = setTimeout(() => {
      const waiting = this.#inFlight.size + this.#queue.filter(isRequest).length;
      this.#unanswered += waiting;
      this.#note(`ai-dev: the client closed its input; ${waiting} request(s) still had no answer after ${Math.round(this.#drainTimeoutMs / 1000)} s.`);
      this.#finish();
    }, this.#drainTimeoutMs);
    // Kept referenced: it is what the process waits on when the server it
    // waits for holds nothing open of its own.
  }

  /** After an answer: once the client has closed its end and nothing is left to answer, leave. */
  #drained() {
    if (this.#inputEnded && !this.#ended && !this.#pending()) this.#finish();
  }

  #finish() {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#drainTimer);
    this.#upstream?.close();
    this.#upstream = null;
    this.#done?.();
  }
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MAX_MESSAGE_BYTES } from "../transport/socket.mjs";
import { StdioBridge, lineReader, socketUpstream } from "./daemon-bridge.mjs";

/** An upstream that answers every request with `{ echo: method }`, and can be made to die. */
function fakeUpstream(name, { answer = true } = {}) {
  const upstream = {
    name,
    describe: name,
    sent: [],
    closed: false,
    onMessage: null,
    onClose: null,
    start(onMessage, onClose) {
      upstream.onMessage = onMessage;
      upstream.onClose = onClose;
    },
    send(message) {
      upstream.sent.push(message);
      if (answer && message.id !== undefined && message.method) {
        setImmediate(() => upstream.onMessage?.({ jsonrpc: "2.0", id: message.id, result: { echo: message.method, by: name } }));
      }
      return Promise.resolve();
    },
    close() {
      upstream.closed = true;
    },
    // Its process, which `vanish` ends without a word on the connection.
    gone: false,
    alive() {
      return !upstream.gone;
    },
    vanish() {
      upstream.gone = true;
    },
    die(reason = "killed") {
      upstream.onClose?.(reason);
    }
  };
  return upstream;
}

/** A bridge over in-memory streams; `lines()` is what the client has read so far. */
function bridgeOver(first, connect, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const notes = [];
  let read = "";
  output.on("data", (chunk) => {
    read += chunk;
  });
  const bridge = new StdioBridge({ input, output, note: (line) => notes.push(line), connect, ...options });
  const done = bridge.run(first);
  return {
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    lines: () => read.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    notes,
    done,
    end: () => input.end()
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The client's answer to `id`, once it has come: a reconnect takes what a loaded machine makes it take. */
async function answerTo(client, id) {
  for (let tries = 0; tries < 250; tries += 1) {
    const found = client.lines().find((message) => message.id === id);
    if (found) return found;
    await settle();
  }
  return undefined;
}
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("lines are read whole however they are cut, CRLF and blank lines included", () => {
  const messages = [];
  const invalid = [];
  const read = lineReader((message) => messages.push(message), (line) => invalid.push(line));
  read('{"a":');
  read("1}\r\n\n{\"b\":2}\nnot json\n{\"c\"");
  read(":3}\n");
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(invalid, ["not json"]);
});

test("a character cut between two chunks arrives whole, in both directions", async () => {
  const messages = [];
  const read = lineReader((message) => messages.push(message), () => assert.fail("no invalid line"));
  const bytes = Buffer.from(`${JSON.stringify({ text: "я — ёжик 🦔" })}\n`, "utf8");
  // Every possible cut, including those inside the two-byte я and the four-byte hedgehog.
  for (let cut = 1; cut < bytes.length; cut += 1) {
    read(bytes.subarray(0, cut));
    read(bytes.subarray(cut));
  }
  assert.equal(messages.length, bytes.length - 1);
  assert.ok(messages.every((message) => message.text === "я — ёжик 🦔"));

  // Through the bridge: the client's line in one-byte chunks, the daemon's answer in three-byte chunks.
  const answer = "Проверка кириллицы — ".repeat(2000);
  const upstream = fakeUpstream("daemon", { answer: false });
  const input = new PassThrough();
  const output = new PassThrough();
  let read2 = Buffer.alloc(0);
  output.on("data", (chunk) => {
    read2 = Buffer.concat([read2, chunk]);
  });
  const bridge = new StdioBridge({ input, output, note: () => undefined, connect: async () => assert.fail("no reconnect") });
  const done = bridge.run(upstream);
  const request = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { arguments: { content: answer } } })}\n`);
  for (let at = 0; at < request.length; at += 1) input.write(request.subarray(at, at + 1));
  await settle();
  assert.equal(upstream.sent[0].params.arguments.content, answer);
  const reply = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { text: answer } })}\n`);
  // The socket side reads with the same function: the daemon's reply, cut every three bytes.
  const fromDaemon = lineReader((message) => upstream.onMessage(message), () => assert.fail("no invalid line"));
  for (let at = 0; at < reply.length; at += 3) fromDaemon(reply.subarray(at, at + 3));
  await settle();
  assert.equal(JSON.parse(read2.toString("utf8")).result.text, answer);
  input.end();
  await done;
});

test("a line of many megabytes costs what its size does", () => {
  const messages = [];
  const read = lineReader((message) => messages.push(message), () => assert.fail("no invalid line"));
  const line = Buffer.from(`${JSON.stringify({ text: "ж".repeat(16 * 1024 * 1024) })}\n`);
  const started = performance.now();
  for (let at = 0; at < line.length; at += 64 * 1024) read(line.subarray(at, at + 64 * 1024));
  const elapsed = performance.now() - started;
  assert.equal(messages[0].text.length, 16 * 1024 * 1024);
  assert.ok(elapsed < 2_000, `32 MB in 64 KB chunks took ${Math.round(elapsed)} ms`);
});

test("MCP passes through both ways, the handshake included", async () => {
  const upstream = fakeUpstream("daemon-1");
  const client = bridgeOver(upstream, async () => assert.fail("no reconnect expected"));
  client.send(INITIALIZE);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await settle();
  upstream.onMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });
  await settle();
  assert.deepEqual(upstream.sent.map((message) => message.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(client.lines().map((message) => message.result?.echo ?? message.method), ["initialize", "tools/list", "notifications/message"]);
  client.end();
  await client.done;
  assert.equal(upstream.closed, true, "the client's end closes the daemon connection");
});

test("a daemon that dies answers its open requests with an error, and the next request goes to a new one, introduced first", async () => {
  const first = fakeUpstream("daemon-1", { answer: false });
  const second = fakeUpstream("daemon-2");
  const connects = [];
  const client = bridgeOver(first, async (context) => {
    connects.push(context);
    return second;
  });
  client.send(INITIALIZE);
  await settle();
  first.onMessage({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ai-dev-system" } } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rebuild_search_index" } });
  await settle();
  first.die("the daemon (pid 1) closed the connection");
  await settle();
  const failed = client.lines().find((message) => message.id === 2);
  assert.equal(failed.error.code, -32603);
  assert.match(failed.error.message, /went away while tools\/call ran \(the daemon \(pid 1\) closed the connection\)\. The next request starts a new one/);
  assert.equal(connects.length, 0, "nothing reconnects until the client asks for something");

  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_all" } });
  await settle();
  await settle();
  assert.deepEqual(connects, [{ reconnect: true }]);
  // Introduced as the first daemon was, under the bridge's own id; then the request.
  assert.equal(second.sent[0].method, "initialize");
  assert.match(String(second.sent[0].id), /^ai-dev-bridge-/);
  assert.deepEqual(second.sent[0].params, INITIALIZE.params);
  assert.equal(second.sent[1].method, "notifications/initialized");
  assert.equal(second.sent[2].id, 3);
  const lines = client.lines();
  assert.ok(!lines.some((message) => String(message.id).startsWith("ai-dev-bridge-")), "the replayed answer is the bridge's, not the client's");
  assert.deepEqual(lines.find((message) => message.id === 3).result, { echo: "tools/call", by: "daemon-2" });
  assert.ok(client.notes.some((note) => /lost the daemon/.test(note)));
  client.end();
  await client.done;
});

test("a request the dead daemon never took goes to the next one, unanswered by an error", async () => {
  const first = fakeUpstream("daemon-1", { answer: false });
  const second = fakeUpstream("daemon-2");
  const client = bridgeOver(first, async () => second);
  client.send(INITIALIZE);
  await settle();
  first.onMessage({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ai-dev-system" } } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await settle();
  // A Windows pipe whose daemon was killed: the write into it fails, and the
  // close is heard before the failed write's promise settles, as Node orders them.
  first.send = (message) => {
    first.sent.push(message);
    process.nextTick(() => first.die("the daemon (pid 1) closed the connection"));
    return Promise.reject(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  };
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_all" } });
  const answer = await answerTo(client, 2);
  assert.deepEqual(answer.result, { echo: "tools/call", by: "daemon-2" }, JSON.stringify(answer));
  assert.equal(second.sent.filter((message) => message.id === 2).length, 1);
  client.end();
  assert.deepEqual(await client.done, { unanswered: 0 });
});

test("a request to a daemon whose process is gone, not yet heard of on its connection, goes to a new one", async () => {
  const first = fakeUpstream("daemon-1");
  const second = fakeUpstream("daemon-2");
  const client = bridgeOver(first, async () => second);
  client.send(INITIALIZE);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await settle();
  // Windows: the killed daemon is gone, its pipe not closed yet, and a write into it would be taken.
  first.vanish();
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_all" } });
  const answer = await answerTo(client, 2);
  assert.equal(first.sent.filter((message) => message.id === 2).length, 0, "nothing more is written to it");
  assert.equal(first.closed, true);
  assert.deepEqual(answer?.result, { echo: "tools/call", by: "daemon-2" }, JSON.stringify(answer));
  assert.ok(client.notes.some((note) => /lost the daemon \(daemon-1 is gone\); the next request reconnects/.test(note)), client.notes.join("\n"));
  client.end();
  assert.deepEqual(await client.done, { unanswered: 0 });
});

test("a server lost again while it is being introduced is replaced again", async () => {
  const first = fakeUpstream("daemon-1");
  const dying = fakeUpstream("daemon-2", { answer: false });
  const third = fakeUpstream("daemon-3");
  const queue = [dying, third];
  const client = bridgeOver(first, async () => queue.shift());
  client.send(INITIALIZE);
  await settle();
  first.die();
  client.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await settle();
  dying.die("died during the introduction");
  await settle();
  await settle();
  assert.deepEqual(client.lines().find((message) => message.id === 2).result, { echo: "ping", by: "daemon-3" });
  assert.equal(third.sent[0].method, "initialize");
  client.end();
  await client.done;
});

test("a request that came before the first initialize was forwarded is not answered twice", async () => {
  const first = fakeUpstream("daemon-1");
  const second = fakeUpstream("daemon-2");
  const client = bridgeOver(first, async () => second);
  first.die("gone before the client said anything");
  client.send(INITIALIZE);
  await settle();
  await settle();
  assert.deepEqual(second.sent.map((message) => message.id), [1], "the client's own initialize, not a replay of it as well");
  assert.equal(client.lines().filter((message) => message.id === 1).length, 1);
  client.end();
  await client.done;
});

test("a socket upstream reads what came with the handshake first, then the socket, and says when it closes", async (t) => {
  // Under /tmp, not the temp folder: with a long TMPDIR libuv cuts a socket path short, and parallel runs share one
  // name.
  const directory = process.platform === "win32" ? null : await fs.mkdtemp(path.join("/tmp", "db-"));
  if (directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\ai-dev-bridge-test-${process.pid}` : path.join(directory, "s.sock");
  let far;
  const server = net.createServer((socket) => {
    far = socket;
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const socket = net.connect(address);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.pause();
  const upstream = socketUpstream({ socket, rest: Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'), describe: "the daemon (pid 9)" });
  const messages = [];
  const closed = new Promise((resolve) => upstream.start((message) => messages.push(message), resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const received = new Promise((resolve) => far.once("data", resolve));
  await upstream.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(String(await received), '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  far.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(messages.map((message) => message.id), [0, 1]);
  far.destroy();
  assert.equal(await closed, "the daemon (pid 9) closed the connection");
  await assert.rejects(upstream.send({ jsonrpc: "2.0", method: "x" }), /closed/);
});

test("a client that writes its requests and closes its input still gets every answer", async () => {
  const upstream = fakeUpstream("daemon-1", { answer: false });
  const client = bridgeOver(upstream, async () => assert.fail("no reconnect expected"));
  client.send(INITIALIZE);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  client.end();
  await settle();
  let finished = false;
  client.done.then(() => {
    finished = true;
  });
  await settle();
  assert.equal(finished, false, "two answers are still to come");
  assert.equal(upstream.closed, false);
  upstream.onMessage({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "ai-dev" } } });
  await settle();
  assert.equal(finished, false);
  upstream.onMessage({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  assert.deepEqual(await client.done, { unanswered: 0 });
  assert.deepEqual(client.lines().map((message) => message.id), [1, 2]);
  assert.equal(upstream.closed, true);
});

test("after the client closed its input, a lost daemon or a server that never answers ends the run as failed", async () => {
  const lost = fakeUpstream("daemon-1", { answer: false });
  const first = bridgeOver(lost, async () => assert.fail("nothing is queued, nothing reconnects"));
  first.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rebuild_search_index" } });
  first.end();
  await settle();
  lost.die("killed");
  assert.deepEqual(await first.done, { unanswered: 1 });
  assert.match(first.lines()[0].error.message, /went away while tools\/call ran/);

  const silent = fakeUpstream("daemon-2", { answer: false });
  const second = bridgeOver(silent, async () => assert.fail("no reconnect expected"), { drainTimeoutMs: 50 });
  second.send({ jsonrpc: "2.0", id: 8, method: "tools/call" });
  second.send({ jsonrpc: "2.0", method: "notifications/progress" });
  second.end();
  assert.deepEqual(await second.done, { unanswered: 1 });
  assert.ok(second.notes.some((note) => /closed its input; 1 request\(s\) still had no answer after 0 s/.test(note)), second.notes.join(" | "));

  const quiet = fakeUpstream("daemon-3");
  const third = bridgeOver(quiet, async () => assert.fail("no reconnect expected"));
  third.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  third.end();
  assert.deepEqual(await third.done, { unanswered: 0 }, "with nothing to wait for, it leaves at once");
});

test("a cancelled request is no longer waited for, and a daemon lost later does not answer it", async () => {
  const first = fakeUpstream("daemon-1", { answer: false });
  const client = bridgeOver(first, async () => assert.fail("no reconnect expected"));
  client.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rebuild_search_index" } });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "user" } });
  await settle();
  assert.deepEqual(first.sent.map((message) => message.method), ["tools/call", "notifications/cancelled"], "the cancellation reaches the server");
  first.die("killed");
  await settle();
  assert.deepEqual(client.lines(), [], "no error for a request the client gave up on");
  client.end();
  assert.deepEqual(await client.done, { unanswered: 0 });
});

test("a request cancelled while it waited for a server is never sent, nor is its cancellation", async () => {
  const first = fakeUpstream("daemon-1");
  let release;
  const second = fakeUpstream("daemon-2");
  const client = bridgeOver(first, () => new Promise((resolve) => {
    release = () => resolve(second);
  }));
  first.die("killed");
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/call" });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  client.send({ jsonrpc: "2.0", id: 10, method: "ping" });
  await settle();
  release();
  await settle();
  assert.deepEqual(second.sent.map((message) => message.id ?? message.method), [10]);
  client.end();
  assert.deepEqual(await client.done, { unanswered: 0 });
});

test("a message past the server's limit is answered with why, and the session goes on", async () => {
  const upstream = fakeUpstream("daemon-1");
  const client = bridgeOver(upstream, async () => assert.fail("no reconnect expected"));
  const big = { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "write_note", arguments: { body: "я".repeat(MAX_MESSAGE_BYTES / 2 + 10) } } };
  client.send(big);
  client.send({ jsonrpc: "2.0", id: 12, method: "ping" });
  await settle();
  await settle();
  const [refused, answered] = client.lines();
  assert.equal(refused.id, 11);
  assert.equal(refused.error.code, -32600);
  // Megabytes would read "10.0 MB … up to 10.0 MB": the sizes are said in bytes then.
  assert.match(refused.error.message, /^This tools\/call message is \d+ bytes; ai-dev takes messages up to 10485760 bytes\.$/);
  assert.deepEqual(answered.result, { echo: "ping", by: "daemon-1" });
  assert.deepEqual(upstream.sent.map((message) => message.id), [12], "the server never saw it");
  client.end();
  await client.done;
});

test("a line past what is worth reading is skipped unread, and the next one is read", () => {
  const messages = [];
  const skipped = [];
  const read = lineReader((message, bytes) => messages.push([message, bytes]), () => assert.fail("not invalid"), { longest: 10, onTooLong: (bytes) => skipped.push(bytes) });
  read('{"a":1}\n{"b":"');
  read("0123456789");
  read('abc"}\n{"c":3}\n');
  assert.deepEqual(messages, [[{ a: 1 }, 7], [{ c: 3 }, 7]]);
  assert.deepEqual(skipped, [21], "{\"b\":\" + ten digits + abc\"}");
});

test("a message well past the limit is said in megabytes", async () => {
  const upstream = fakeUpstream("daemon-1");
  const client = bridgeOver(upstream, async () => assert.fail("no reconnect expected"));
  client.send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { body: "x".repeat(12 * 1024 * 1024) } });
  await settle();
  await settle();
  assert.match(client.lines()[0].error.message, /^This tools\/call message is 12\.0 MB; ai-dev takes messages up to 10\.0 MB\.$/);
  client.end();
  await client.done;
});

test("when no server can be had after the client closed its input, the bridge leaves as soon as it has refused", async () => {
  const first = fakeUpstream("daemon-1", { answer: false });
  const dead = () => {
    const upstream = fakeUpstream("never", { answer: false });
    setImmediate(() => upstream.die("refused"));
    return upstream;
  };
  const client = bridgeOver(first, async () => dead(), { drainTimeoutMs: 60_000 });
  client.send(INITIALIZE);
  await settle();
  first.onMessage({ jsonrpc: "2.0", id: 1, result: {} });
  first.die("killed");
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  client.end();
  const started = Date.now();
  const result = await client.done;
  assert.ok(Date.now() - started < 5_000, `left after ${Date.now() - started} ms`);
  assert.equal(result.unanswered, 1);
  assert.match(client.lines().find((message) => message.id === 2).error.message, /could not serve tools\/list/);
});

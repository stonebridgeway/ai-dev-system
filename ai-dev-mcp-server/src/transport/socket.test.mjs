import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { SocketServerTransport } from "./socket.mjs";

test("socket transport accepts split newline-delimited JSON-RPC messages", async (t) => {
  const listener = net.createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  const received = new Promise((resolve, reject) => listener.once("connection", async (socket) => {
    const transport = new SocketServerTransport(socket); transport.onmessage = resolve; transport.onerror = reject; await transport.start();
  }));
  const client = net.connect(listener.address().port, "127.0.0.1");
  await new Promise((resolve) => client.once("connect", resolve)); client.write('{"jsonrpc":"2.0",'); client.write('"method":"ping"}\n');
  assert.deepEqual(await received, { jsonrpc: "2.0", method: "ping" }); client.end();
});

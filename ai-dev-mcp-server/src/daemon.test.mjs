import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function connect(address) {
  return new Promise((resolve, reject) => { const socket = net.connect(address); socket.once("connect", () => resolve(socket)); socket.once("error", reject); });
}
test("daemon accepts an MCP session through the local socket", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-daemon-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/ai-dev.mjs", import.meta.url)), "daemon"], { env: { ...process.env, AI_DEV_HOME: state, AI_DEV_IDLE_TIMEOUT_MS: "0" }, stdio: "ignore", windowsHide: true });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await fs.rm(state, { recursive: true, force: true }); });
  const infoPath = path.join(state, ".ai-dev", "run", "daemon.json");
  let info;
  for (let attempts = 0; attempts < 100; attempts += 1) { info = await fs.readFile(infoPath, "utf8").then(JSON.parse).catch(() => null); if (info) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(info, "daemon wrote its state file");
  const socket = await connect(info.address); let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  socket.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n');
  socket.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  socket.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  for (let attempts = 0; attempts < 100 && !response.includes("trust_project"); attempts += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  socket.end(); assert.match(response, /trust_project/);
});

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { daemonInfoPath, logsDir, runtimeDir, socketAddress } from "./core/runtime-paths.mjs";

function connectOnce() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketAddress());
    socket.once("connect", () => resolve(socket)); socket.once("error", reject);
  });
}
async function spawnDaemon() {
  await Promise.all([fs.mkdir(logsDir(), { recursive: true }), fs.mkdir(runtimeDir(), { recursive: true, mode: 0o700 })]);
  const log = openSync(path.join(logsDir(), "daemon.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.mjs", import.meta.url))], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
}
export async function ensureDaemon({ deadlineMs = 20_000 } = {}) {
  let socket;
  try { socket = await connectOnce(); } catch (error) { if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code)) throw error; }
  if (!socket) {
    await spawnDaemon(); const deadline = Date.now() + deadlineMs;
    while (!socket && Date.now() < deadline) { try { socket = await connectOnce(); } catch { await sleep(150); } }
    if (!socket) throw new Error(`daemon did not start within ${deadlineMs} ms; see ${path.join(logsDir(), "daemon.log")}`);
  }
  return socket;
}
export async function attach(options = {}) {
  const socket = await ensureDaemon(options);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  process.stdin.once("end", () => socket.end());
  socket.once("error", (error) => { process.stderr.write(`ai-dev: ${error.message}\n`); process.exitCode = 70; });
  socket.once("close", () => { if (!process.exitCode) process.exitCode = 0; });
}

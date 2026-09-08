import fs from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createAiDevServer } from "./server.mjs";
import { daemonInfoPath, daemonLockPath, runtimeDir, socketAddress } from "./core/runtime-paths.mjs";
import { SocketServerTransport } from "./transport/socket.mjs";

const VERSION = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const idleTimeout = Number(process.env.AI_DEV_IDLE_TIMEOUT_MS || 30 * 60 * 1000);

async function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } }
async function acquireLock() {
  await fs.mkdir(runtimeDir(), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(daemonLockPath(), String(process.pid), { flag: "wx", mode: 0o600 }); return true; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = Number(await fs.readFile(daemonLockPath(), "utf8").catch(() => "0"));
    if (owner && await pidAlive(owner)) return false;
    await fs.rm(daemonLockPath(), { force: true });
    return acquireLock();
  }
}

export async function runDaemon() {
  if (!(await acquireLock())) return false;
  const address = socketAddress();
  if (process.platform !== "win32") await fs.rm(address, { force: true });
  let sessions = 0;
  let shuttingDown = false;
  let idleTimer;
  const listener = net.createServer(async (socket) => {
    if (shuttingDown) return socket.destroy();
    sessions += 1; clearTimeout(idleTimer);
    const server = createAiDevServer();
    socket.once("close", () => {
      sessions = Math.max(0, sessions - 1);
      server.close().catch(() => undefined);
      armIdle();
    });
    try { await server.connect(new SocketServerTransport(socket)); } catch { socket.destroy(); }
  });
  const cleanup = async () => {
    clearTimeout(idleTimer); listener.close();
    await Promise.all([fs.rm(daemonInfoPath(), { force: true }), fs.rm(daemonLockPath(), { force: true })]);
    if (process.platform !== "win32") await fs.rm(address, { force: true });
  };
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await cleanup(); process.exit(0); };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!shuttingDown && sessions === 0 && idleTimeout > 0) { idleTimer = setTimeout(shutdown, idleTimeout); idleTimer.unref?.(); }
  };
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(address, resolve); });
  if (process.platform !== "win32") await fs.chmod(address, 0o600);
  await fs.writeFile(daemonInfoPath(), `${JSON.stringify({ pid: process.pid, version: VERSION, address, started_at: new Date().toISOString(), sessions }, null, 2)}\n`, { mode: 0o600 });
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  armIdle();
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runDaemon();

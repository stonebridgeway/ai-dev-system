import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { daemonInfoPath } from "../core/runtime-paths.mjs";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
export async function run() {
  const info = await fs.readFile(daemonInfoPath(), "utf8").then(JSON.parse).catch(() => null);
  if (info?.pid) { try { process.kill(info.pid, "SIGTERM"); } catch { /* already stopped */ } }
  await runCommand("npm", ["install", "--global", "ai-dev-mcp@latest"]);
  process.stdout.write("AI Dev updated. Run ai-dev doctor to confirm the new installation.\n");
}

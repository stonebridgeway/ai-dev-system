import fs from "node:fs/promises";
import { aiDevHome, daemonInfoPath } from "../core/runtime-paths.mjs";
export async function run(args = []) {
  const info = await fs.readFile(daemonInfoPath(), "utf8").then(JSON.parse).catch(() => null);
  if (info?.pid) { try { process.kill(info.pid, "SIGTERM"); } catch { /* already stopped */ } }
  if (args.includes("--purge")) await fs.rm(aiDevHome(), { recursive: true, force: true });
  process.stdout.write(args.includes("--purge") ? "AI Dev runtime data removed. Repository files were not changed.\n" : "Daemon stopped. Runtime data and repository files were preserved. Use --purge to remove runtime data.\n");
}

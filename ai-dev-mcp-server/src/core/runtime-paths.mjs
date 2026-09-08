import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveRuntimeStateRoot } from "./runtime-home.mjs";

/** The private, per-user state directory used by the standalone program. */
export function aiDevHome() {
  return path.resolve(resolveRuntimeStateRoot());
}

export const runtimeDir = () => path.join(aiDevHome(), "run");
export const logsDir = () => path.join(aiDevHome(), "logs");
export const daemonInfoPath = () => path.join(runtimeDir(), "daemon.json");
export const daemonLockPath = () => path.join(runtimeDir(), "daemon.lock");
export const clientConfigPath = () => path.join(aiDevHome(), "config.json");
export const tasksStateRoot = () => path.join(aiDevHome(), "state");

export function socketAddress() {
  if (process.platform === "win32") {
    const user = String(os.userInfo().username || "user").replace(/[^A-Za-z0-9_-]/g, "_");
    return `\\\\.\\pipe\\ai-dev-${user}`;
  }
  return path.join(runtimeDir(), "ai-dev.sock");
}

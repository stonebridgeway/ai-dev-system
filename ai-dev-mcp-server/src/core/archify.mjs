import path from "node:path";
import process from "node:process";
import { runProcess } from "./process-runner.mjs";

export const ARCHIFY_TYPES = Object.freeze([
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle"
]);

export function archifyCliPath(vaultRoot) {
  return path.join(
    vaultRoot,
    "03-skills-catalog",
    "sources",
    "external",
    "archify",
    "bin",
    "archify.mjs"
  );
}

/**
 * Run the vendored Archify CLI through a static, shell-free Node invocation.
 * Callers remain responsible for validating user-provided paths and arguments.
 */
export async function runArchify({
  vaultRoot,
  args,
  cwd,
  timeoutMs = 120_000,
  env = {}
}) {
  // Archify's findChrome() treats a *present* ARCHIFY_CHROME key as an explicit
  // override — even when empty — which disables auto-discovery. Only set it when
  // a real path is available; otherwise let the CLI find the system browser.
  const { chrome, ...extraEnv } = env;
  const chromePath = chrome ?? process.env.ARCHIFY_CHROME;
  if (chromePath) extraEnv.ARCHIFY_CHROME = chromePath;
  const result = await runProcess({
    executable: process.execPath,
    args: [archifyCliPath(vaultRoot), ...args],
    cwd,
    timeoutMs,
    env: extraEnv
  });
  let json = null;
  if (args.includes("--json") && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // Keep unparseable CLI output available verbatim to callers.
    }
  }
  return { ...result, json };
}

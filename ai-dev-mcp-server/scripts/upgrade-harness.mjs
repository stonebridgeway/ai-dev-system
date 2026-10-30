/**
 * What `npm run upgrade:test` (`upgrade-check.mjs`) and its way back
 * (`upgrade-way-back.mjs`) share: commands without a shell, the checks as they
 * pass or fail, an MCP client on a server's standard streams.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSpawnInvocation } from "../src/core/process-runner.mjs";

export function run(command, args, { cwd, env = process.env, allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true, shell: false, input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}:\n${(result.stderr || result.stdout || "").slice(-4000)}`);
  }
  return result;
}

/**
 * `run` for a child that talks to a server in this process — the model mirror:
 * a synchronous spawn would stop the event loop the server answers on.
 */
export function runAsync(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** npm without a shell: on Windows `npm` is a `.cmd`, which the spawn adapter rewrites to `node npm-cli.js`. */
const npmPlan = await resolveSpawnInvocation("npm", []);
export function npm(args, options) {
  return run(npmPlan.executable, [...npmPlan.args, ...args], options);
}

export const checks = [];
export function check(label, condition, detail = "") {
  checks.push({ label, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`);
}

export async function withServer({ command, args, env, cwd }, operation) {
  const transport = new StdioClientTransport({ command, args, env, cwd, stderr: "pipe" });
  const client = new Client({ name: "ai-dev-upgrade-test", version: "1.0.0" }, { capabilities: {} });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await client.connect(transport);
    return await operation(client);
  } catch (error) {
    error.message = `${error.message}\n--- server stderr ---\n${stderr.join("").slice(-3000)}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = (result.content || []).map((item) => item.text || "").join("\n");
  if (result.isError) throw new Error(`${name} failed: ${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function makeRepository(root) {
  run("git", ["init", "-q", root]);
  return fs.writeFile(path.join(root, "README.md"), "# upgrade fixture\n", "utf8").then(() => {
    run("git", ["-C", root, "add", "."]);
    run("git", ["-C", root, "-c", "user.name=AI Dev Upgrade Test", "-c", "user.email=upgrade-test@example.invalid", "commit", "-qm", "fixture"]);
  });
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

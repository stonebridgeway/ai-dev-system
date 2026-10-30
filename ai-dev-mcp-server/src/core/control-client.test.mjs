import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clientNodePaths, daemonLogTail, openControlClient, stopDaemons } from "./control-client.mjs";
import { listDaemons } from "./daemon-client.mjs";
import { controlRequest } from "./daemon-channel.mjs";

// What the desktop app imports from an install (docs/DESKTOP.md): an MCP SDK
// client on the install's daemon, the daemon's log, and the Node the AI
// clients run. Real processes: the daemon this test starts, and stops.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(serverRoot, "bin", "ai-dev.mjs");

async function stage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-control-client-"));
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]");
  await fs.mkdir(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude-config"),
    CODEX_HOME: path.join(home, ".codex"),
    AI_DEV_HOME: path.join(home, ".ai-dev"),
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_IDLE_TIMEOUT_MS: "60000"
  };
  t.after(async () => {
    await stopDaemons({ timeoutMs: 5000, env });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, home, env };
}

const answer = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent.result;

test("a program reaches the install's daemon: none is started when it says not to, one is when it may", async (t) => {
  const { env } = await stage(t);
  await assert.rejects(openControlClient({ serverRoot, env, start: false, name: "probe" }), (error) => error.code === "ENOTRUNNING");
  assert.deepEqual((await stopDaemons({ env, timeoutMs: 1000 })).daemons, [], "nothing was started");

  const { client } = await openControlClient({ serverRoot, env, execPath: process.execPath, name: "probe" });
  t.after(() => client.close().catch(() => undefined));
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(listed.includes("system_status") && listed.includes("settings_set"), "the control profile by default");
  const first = await answer(client, "system_status", { checks: false });
  assert.equal(first.served_by.kind, "daemon");

  // A second program that only wants a running daemon reaches the same one.
  const { client: second } = await openControlClient({ serverRoot, env, execPath: process.execPath, start: false, profiles: "all,control", name: "probe-2" });
  t.after(() => second.close().catch(() => undefined));
  assert.equal((await answer(second, "system_status", { checks: false })).served_by.pid, first.served_by.pid);
  assert.ok((await second.listTools()).tools.length > 140, "the profiles it names");

  assert.ok((await daemonLogTail(env, 20)).some((line) => /listening at/.test(line)), "the log the offline screen shows");
});

test("the Node of an AI client's ai-dev entry: this install's first, then others; Docker and other programs are not Node", async (t) => {
  const { home, env } = await stage(t);
  const ours = path.join(home, "node-for-this", "bin", "node");
  const theirs = path.join(home, "node-for-another", "bin", "node");
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: { "ai-dev": { command: theirs, args: [path.join(home, "another-install", "bin", "ai-dev.mjs"), "mcp"] } }
  }));
  await fs.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({
    mcpServers: { "ai-dev": { command: ours, args: [cliPath, "mcp"] } }
  }));
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), JSON.stringify({
    mcpServers: { "ai-dev": { command: "docker", args: ["run", "-i", "--rm", "ai-dev"] } }
  }));
  assert.deepEqual(await clientNodePaths({ env, home, cliPath }), [ours, theirs]);
  assert.deepEqual(new Set(await clientNodePaths({ env, home })), new Set([ours, theirs]), "without the install's own entry point, each client's");
});

test("a daemon told to retire says so to the sessions it keeps: served_by.retired", async (t) => {
  const { env } = await stage(t);
  const { client } = await openControlClient({ serverRoot, env, name: "probe" });
  t.after(() => client.close().catch(() => undefined));
  const before = await answer(client, "system_status", { checks: false });
  assert.equal(before.served_by.retired, undefined, "a serving daemon says nothing of retiring");
  const entry = (await listDaemons({ env })).find((item) => item.info.pid === before.served_by.pid);
  assert.equal((await controlRequest(entry.info, "retire")).retiring, true);
  const after = await answer(client, "system_status", { checks: false });
  assert.equal(after.served_by.pid, before.served_by.pid, "the same daemon still serves this session");
  assert.equal(after.served_by.retired, true);
  assert.equal(typeof after.served_by.retired_reason, "string");
});

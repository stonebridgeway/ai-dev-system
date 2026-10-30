import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_SERVER_NAMES,
  MCP_CLIENTS,
  SERVER_NAME,
  clientEntry,
  clientLocations,
  describeEntry,
  discoverClients,
  installServer,
  parseClientSelection,
  planInstall,
  planRemove,
  readServerEntries,
  removeServer
} from "./mcp-clients.mjs";
import { readJsonc } from "./jsonc-edit.mjs";
import { parseTomlLite } from "./toml-lite.mjs";

const LAUNCH = { command: "/usr/local/bin/node", args: ["/opt/ai-dev/bin/ai-dev.mjs", "mcp"] };

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-clients-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

/** A home where all six clients live, each with a server of its own. */
async function sixClients(home) {
  const files = {
    ".claude.json": "{\n  \"numStartups\": 3,\n  \"mcpServers\": {\n    \"github\": {\n      \"type\": \"stdio\",\n      \"command\": \"gh-mcp\"\n    }\n  }\n}\n",
    ".config/Claude/claude_desktop_config.json": "{\n  \"mcpServers\": {\n    \"filesystem\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/home/u\"]\n    }\n  }\n}\n",
    ".cursor/mcp.json": "{\n  \"mcpServers\": {\n    \"linear\": { \"url\": \"https://mcp.linear.app/sse\" }\n  }\n}\n",
    ".config/Code/User/mcp.json": "{\n\t// my servers\n\t\"servers\": {\n\t\t\"playwright\": { \"type\": \"stdio\", \"command\": \"npx\", \"args\": [\"@playwright/mcp\"] },\n\t},\n}\n",
    ".codex/config.toml": "model = \"gpt-5\"\n\n# servers\n[mcp_servers.sentry]\ncommand = \"npx\"\nargs = [\"-y\", \"@sentry/mcp\"]\n",
    ".gemini/settings.json": "{\n  \"theme\": \"Default\",\n  \"mcpServers\": {\n    \"context7\": { \"httpUrl\": \"https://mcp.context7.com/mcp\" }\n  }\n}\n"
  };
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await fs.writeFile(path.join(home, relative), text);
  }
  return files;
}

async function snapshot(home, files) {
  const result = {};
  for (const relative of Object.keys(files)) result[relative] = await fs.readFile(path.join(home, relative), "utf8").catch(() => null);
  return result;
}

const env = (home) => ({ HOME: home });

test("the client list covers six clients, and a selection names them by id, alias or all", () => {
  assert.deepEqual(MCP_CLIENTS.map((client) => client.id), ["claude-code", "claude-desktop", "cursor", "vscode", "codex", "gemini"]);
  assert.equal(SERVER_NAME, "ai-dev");
  assert.deepEqual(LEGACY_SERVER_NAMES, ["ai-dev-system"]);
  assert.deepEqual(parseClientSelection("all"), { all: true, ids: MCP_CLIENTS.map((client) => client.id) });
  assert.deepEqual(parseClientSelection(" Cursor, claude ,code,cursor"), { all: false, ids: ["cursor", "claude-code", "claude-desktop", "vscode"] });
  assert.throws(() => parseClientSelection("cursor,zed,emacs"), /Not a client: zed, emacs\. The clients are claude-code, claude-desktop, cursor, vscode, codex, gemini \(or all\)\./);
  assert.throws(() => parseClientSelection(" , "), /No client named/);
});

test("each platform's config paths, with APPDATA, XDG_CONFIG_HOME and CODEX_HOME honoured", () => {
  const linux = clientLocations({ home: "/home/u", env: {}, platform: "linux" });
  assert.equal(linux["claude-desktop"].file, "/home/u/.config/Claude/claude_desktop_config.json");
  assert.equal(linux.vscode.file, "/home/u/.config/Code/User/mcp.json");
  assert.equal(linux.codex.file, "/home/u/.codex/config.toml");
  const xdg = clientLocations({ home: "/home/u", env: { XDG_CONFIG_HOME: "/cfg", CODEX_HOME: "/srv/codex" }, platform: "linux" });
  assert.equal(xdg.vscode.file, "/cfg/Code/User/mcp.json");
  assert.equal(xdg.codex.file, "/srv/codex/config.toml");
  assert.equal(linux["claude-code"].file, "/home/u/.claude.json");
  // Claude Code reads its user servers from CLAUDE_CONFIG_DIR when it is set, and ~/.claude.json no more.
  const profile = clientLocations({ home: "/home/u", env: { CLAUDE_CONFIG_DIR: "/home/u/profiles/work" }, platform: "linux" });
  assert.deepEqual(profile["claude-code"], { file: "/home/u/profiles/work/.claude.json", markers: ["/home/u/profiles/work"] });
  assert.equal(clientLocations({ home: "C:\\Users\\u", env: { CLAUDE_CONFIG_DIR: "D:\\claude" }, platform: "win32" })["claude-code"].file, "D:\\claude\\.claude.json");
  assert.equal(clientLocations({ home: "/home/u", env: { CLAUDE_CONFIG_DIR: "" }, platform: "linux" })["claude-code"].file, "/home/u/.claude.json", "empty is unset");
  const mac = clientLocations({ home: "/Users/u", env: {}, platform: "darwin" });
  assert.equal(mac["claude-desktop"].file, "/Users/u/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(mac.vscode.file, "/Users/u/Library/Application Support/Code/User/mcp.json");
  const windows = clientLocations({ home: "C:\\Users\\u", env: { APPDATA: "D:\\Roaming" }, platform: "win32" });
  assert.equal(windows["claude-desktop"].file, "D:\\Roaming\\Claude\\claude_desktop_config.json");
  assert.equal(windows["claude-code"].file, "C:\\Users\\u\\.claude.json");
  assert.equal(windows.cursor.file, "C:\\Users\\u\\.cursor\\mcp.json");
});

test("discovery marks what is installed and adds the Store build's own config on Windows", async () => {
  const present = new Set([
    "C:\\Users\\u\\.cursor",
    "C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json"
  ]);
  const targets = await discoverClients({
    home: "C:\\Users\\u",
    env: {},
    platform: "win32",
    exists: async (target) => present.has(target),
    listDirectory: async (target) => {
      assert.equal(target, "C:\\Users\\u\\AppData\\Local\\Packages");
      return ["Claude_pzs8sxrjxfjjc", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Claude_unlaunched"];
    }
  });
  assert.deepEqual(targets.filter((target) => target.detected).map((target) => [target.client, target.variant ?? "", target.file]), [
    ["claude-desktop", "store", "C:\\Users\\u\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json"],
    ["cursor", "", "C:\\Users\\u\\.cursor\\mcp.json"]
  ]);
  assert.equal(targets.length, 7);
  assert.equal(targets.find((target) => target.client === "vscode").marker, "C:\\Users\\u\\AppData\\Roaming\\Code");
});

test("entries: type stdio where the client wants it, env only when set, Codex with its timeouts", () => {
  const [claudeCode, , cursor, vscode, codex] = MCP_CLIENTS;
  assert.deepEqual(clientEntry(claudeCode, LAUNCH), { type: "stdio", ...LAUNCH });
  assert.deepEqual(clientEntry(vscode, LAUNCH), { type: "stdio", ...LAUNCH });
  assert.deepEqual(clientEntry(cursor, { ...LAUNCH, env: {} }), LAUNCH);
  assert.deepEqual(clientEntry(cursor, { ...LAUNCH, env: { AI_DEV_VAULT_ROOT: "/v" } }), { ...LAUNCH, env: { AI_DEV_VAULT_ROOT: "/v" } });
  assert.deepEqual(clientEntry(codex, LAUNCH), { ...LAUNCH, startup_timeout_sec: 120, tool_timeout_sec: 3600 });
});

test("an entry says what it runs", () => {
  assert.equal(describeEntry(LAUNCH, LAUNCH).kind, "current");
  assert.deepEqual(describeEntry({ command: "node", args: ["/clone/ai-dev-mcp-server/src/server.mjs"] }), { kind: "local", command: "node", script: "/clone/ai-dev-mcp-server/src/server.mjs" });
  assert.equal(describeEntry({ command: "/bin/sh", args: ["/clone/docker/run-mcp.sh"], env: { AI_DEV_IMAGE: "x" } }).kind, "docker");
  assert.equal(describeEntry({ command: "C:\\ProgramData\\AI-Dev-System\\ClaudeMcpProxy.exe", args: [] }).kind, "docker");
  assert.equal(describeEntry({ command: "npx", args: ["x"] }).kind, "other");
  assert.equal(describeEntry("node").kind, "invalid");
});

test("six clients with servers of their own: added once, unchanged the second time, and remove gives each file back byte for byte", async (t) => {
  const home = await tempHome(t);
  const files = await sixClients(home);
  const before = await snapshot(home, files);
  const statePath = path.join(home, ".ai-dev", "state", "mcp-clients.json");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  assert.equal(targets.length, 6);
  const entryFor = (target) => clientEntry(target, LAUNCH);

  const first = await installServer({ targets, entryFor, statePath });
  assert.deepEqual(first.map((result) => [result.client, result.status]), MCP_CLIENTS.map((client) => [client.id, "added"]));
  for (const result of first) {
    assert.equal(await fs.readFile(result.backup, "utf8"), before[path.relative(home, result.file).replaceAll(path.sep, "/")], `${result.client} backup holds the original`);
    // Windows keeps no owner-only bit for Node to set.
    if (process.platform !== "win32") assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  }
  const after = await snapshot(home, files);
  assert.deepEqual(readJsonc(after[".claude.json"]).mcpServers, { github: { type: "stdio", command: "gh-mcp" }, "ai-dev": { type: "stdio", ...LAUNCH } });
  assert.equal(readJsonc(after[".claude.json"]).numStartups, 3);
  assert.ok(after[".config/Code/User/mcp.json"].includes("\t// my servers\n"), "VS Code's comment stays");
  assert.deepEqual(readJsonc(after[".config/Code/User/mcp.json"]).servers["ai-dev"], { type: "stdio", ...LAUNCH });
  assert.deepEqual(parseTomlLite(after[".codex/config.toml"]).data.mcp_servers, {
    sentry: { command: "npx", args: ["-y", "@sentry/mcp"] },
    "ai-dev": { ...LAUNCH, startup_timeout_sec: 120, tool_timeout_sec: 3600 }
  });
  for (const relative of Object.keys(files)) assert.ok(after[relative].startsWith(before[relative].slice(0, 20)), relative);

  const second = await installServer({ targets, entryFor, statePath });
  assert.deepEqual(second.map((result) => result.status), Array(6).fill("unchanged"));
  assert.deepEqual(await snapshot(home, files), after);

  const removed = await removeServer({ targets, statePath });
  assert.deepEqual(removed.map((result) => result.status), Array(6).fill("restored"));
  assert.deepEqual(await snapshot(home, files), before);
  assert.deepEqual((await removeServer({ targets, statePath })).map((result) => result.status), Array(6).fill("absent"));
});

test("2.x entries under either name are migrated with a backup; a Docker ai-dev entry is replaced and named", async (t) => {
  const home = await tempHome(t);
  const legacy = { command: "/usr/bin/node", args: ["/clone/ai-dev-mcp-server/src/server.mjs"], env: { AI_DEV_PYTHON: "python3" } };
  const docker = { command: "/bin/sh", args: ["/clone/docker/run-mcp.sh"], env: { AI_DEV_IMAGE: "ghcr.io/x:latest", AI_DEV_PROJECT_PATH: "/p" } };
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { "ai-dev-system": legacy, "ai-dev": docker, other: {} } }, null, 2)}\n`);
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "[mcp_servers.ai-dev-system]\ncommand = \"/usr/bin/node\"\nargs = [\"/clone/ai-dev-mcp-server/src/server.mjs\"]\n\n[mcp_servers.other]\ncommand = \"o\"\n");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  const results = await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH), statePath: path.join(home, "state.json") });
  assert.deepEqual(results.map((result) => [result.client, result.status, result.previous ?? "", result.migrated ?? []]), [
    ["cursor", "updated", "docker", ["ai-dev-system"]],
    ["codex", "added", "", ["ai-dev-system"]]
  ]);
  assert.deepEqual(Object.keys(readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers), ["ai-dev", "other"]);
  assert.deepEqual(Object.keys(parseTomlLite(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8")).data.mcp_servers), ["other", "ai-dev"]);
  // Removing afterwards gives back the original without either name, not the 2.x entry.
  await removeServer({ targets, statePath: path.join(home, "state.json") });
  assert.deepEqual(Object.keys(readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers), ["other"]);
  assert.deepEqual(Object.keys(parseTomlLite(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8")).data.mcp_servers), ["other"]);
});

test("one unreadable file is that client's failure; an empty file is an empty config; the others are written", async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), "");
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), "{\n  \"mcpServers\": {\n");
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "[mcp_servers]\nai-dev = { command = \"x\" }\n");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  const results = await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) });
  assert.deepEqual(results.map((result) => [result.client, result.status]), [["cursor", "added"], ["codex", "failed"], ["gemini", "failed"]]);
  assert.match(results[1].error, /line 2: mcp_servers\.ai-dev is written as a key/);
  assert.match(results[2].error, /line 3, column 1: expected a "quoted" member name/);
  assert.deepEqual(readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")), { mcpServers: { "ai-dev": LAUNCH } });
  assert.equal(await fs.readFile(path.join(home, ".gemini", "settings.json"), "utf8"), "{\n  \"mcpServers\": {\n", "the broken file is left as it was");
});

test("a dry run writes nothing; a client named on purpose is written even where it is not installed", async (t) => {
  const home = await tempHome(t);
  const targets = await discoverClients({ home, env: env(home), platform: "linux" });
  const vscode = targets.filter((target) => target.client === "vscode");
  assert.equal(vscode[0].detected, false);
  assert.deepEqual((await installServer({ targets: vscode, entryFor: (target) => clientEntry(target, LAUNCH), apply: false })).map((result) => result.status), ["would-add"]);
  await assert.rejects(fs.access(vscode[0].file));
  const statePath = path.join(home, "state.json");
  assert.deepEqual((await installServer({ targets: vscode, entryFor: (target) => clientEntry(target, LAUNCH), statePath })).map((result) => result.status), ["added"]);
  assert.deepEqual(readJsonc(await fs.readFile(vscode[0].file, "utf8")), { servers: { "ai-dev": { type: "stdio", ...LAUNCH } } });
  assert.deepEqual((await removeServer({ targets: vscode, apply: false, statePath })).map((result) => result.status), ["would-restore"]);
  assert.deepEqual((await removeServer({ targets: vscode, statePath })).map((result) => result.status), ["restored"]);
  await assert.rejects(fs.access(vscode[0].file), "a file that did not exist before is gone again");
});

test("a file changed since the install loses only the entry on remove; the change stays", async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const file = path.join(home, ".cursor", "mcp.json");
  await fs.writeFile(file, "{\n  \"mcpServers\": {}\n}\n");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  const statePath = path.join(home, "state.json");
  await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH), statePath });
  const edited = (await fs.readFile(file, "utf8")).replace("\"mcpServers\": {", "\"mcpServers\": {\n    \"mine\": {},");
  await fs.writeFile(file, edited);
  const [result] = await removeServer({ targets, statePath });
  assert.equal(result.status, "removed");
  assert.deepEqual(result.removed, ["ai-dev"]);
  assert.deepEqual(readJsonc(await fs.readFile(file, "utf8")), { mcpServers: { mine: {} } });
});

test("the client saving the file mid-write keeps its change: the edit is planned again on what it wrote", async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const file = path.join(home, ".cursor", "mcp.json");
  await fs.writeFile(file, "{\n  \"mcpServers\": {}\n}\n");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  let calls = 0;
  const results = await installServer({
    targets,
    entryFor: (target) => clientEntry(target, LAUNCH),
    // `now` stamps the backup, after the plan is made and before the rename:
    // the first time, the client saves the file right then.
    now: () => {
      calls += 1;
      if (calls === 1) writeFileSync(file, "{\n  \"mcpServers\": {\n    \"added-by-the-client\": {}\n  }\n}\n");
      return new Date(calls * 1000);
    }
  });
  assert.equal(results[0].status, "added");
  assert.deepEqual(Object.keys(readJsonc(await fs.readFile(file, "utf8")).mcpServers), ["added-by-the-client", "ai-dev"]);
  assert.equal(await fs.readFile(results[0].backup, "utf8"), "{\n  \"mcpServers\": {\n    \"added-by-the-client\": {}\n  }\n}\n",
    "the backup is of what was replaced");
  assert.deepEqual((await fs.readdir(path.join(home, ".cursor"))).filter((name) => name.includes("backup")).length, 1, "the first attempt's backup is gone");

  // A file that changes on every attempt is left alone, and said so.
  const stubborn = await installServer({
    targets,
    entryFor: () => ({ command: "other" }),
    now: () => {
      calls += 1;
      writeFileSync(file, `{"mcpServers": {"n${calls}": {}}}`);
      return new Date(calls * 1000);
    }
  });
  assert.equal(stubborn[0].status, "failed");
  assert.match(stubborn[0].error, /changed again each time it was about to be written \(is Cursor saving it right now\?\)\. Nothing was changed/);
});

test("a symlinked config is written through the link, and the file's mode is kept", { skip: process.platform === "win32" && "a symlink and a 0600 mode both need POSIX" }, async (t) => {
  const home = await tempHome(t);
  const dotfiles = path.join(home, "dotfiles");
  await fs.mkdir(dotfiles, { recursive: true });
  await fs.writeFile(path.join(dotfiles, "claude.json"), "{\"mcpServers\": {}}\n", { mode: 0o600 });
  await fs.chmod(path.join(dotfiles, "claude.json"), 0o600);
  await fs.symlink(path.join(dotfiles, "claude.json"), path.join(home, ".claude.json"));
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.client === "claude-code");
  const [result] = await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) });
  assert.equal(result.status, "added");
  assert.ok((await fs.lstat(path.join(home, ".claude.json"))).isSymbolicLink(), "still a link");
  assert.deepEqual(readJsonc(await fs.readFile(path.join(dotfiles, "claude.json"), "utf8")).mcpServers["ai-dev"], { type: "stdio", ...LAUNCH });
  assert.equal((await fs.stat(path.join(dotfiles, "claude.json"))).mode & 0o777, 0o600);
  assert.equal(path.dirname(result.backup), home, "the backup sits next to the link, not in the dotfiles repository");
});

test("written by root in someone else's home, every file and folder stays theirs", { skip: process.getuid?.() !== 0 && "only root gives files away" }, async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, ".cursor"));
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), "{\"mcpServers\": {}}\n", { mode: 0o600 });
  for (const item of [home, path.join(home, ".cursor"), path.join(home, ".cursor", "mcp.json")]) await fs.chown(item, 1000, 1000);
  const statePath = path.join(home, ".ai-dev", "state", "mcp-clients.json");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => ["cursor", "codex"].includes(target.client));
  const installed = await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH), statePath });
  assert.deepEqual(installed.map((result) => result.status), ["added", "added"]);
  const removed = await removeServer({ targets, statePath });
  assert.deepEqual(removed.map((result) => result.status), ["restored", "restored"]);
  const owners = [];
  for (const relative of [".ai-dev", ".ai-dev/state", ".ai-dev/state/mcp-clients.json", ".codex", ".cursor/mcp.json", ...installed.concat(removed).flatMap((result) => result.backup ? [path.relative(home, result.backup)] : [])]) {
    const stat = await fs.stat(path.join(home, relative));
    owners.push(`${relative} ${stat.uid}:${stat.gid}`);
  }
  assert.ok(owners.length >= 7, owners.join("\n"));
  assert.deepEqual(owners.filter((line) => !line.endsWith(" 1000:1000")), [], owners.join("\n"));
  assert.equal((await fs.stat(path.join(home, ".cursor", "mcp.json"))).mode & 0o777, 0o600, "the mode is kept as well");
});

test("a client folder linked from elsewhere, with no config yet: remove gives back no file at all", { skip: process.platform === "win32" && "a symlink needs Developer Mode on Windows" }, async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, "dotfiles", "cursor"), { recursive: true });
  await fs.symlink(path.join(home, "dotfiles", "cursor"), path.join(home, ".cursor"));
  const statePath = path.join(home, ".ai-dev", "state", "mcp-clients.json");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.client === "cursor");
  assert.deepEqual((await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH), statePath })).map((result) => result.status), ["added"]);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(statePath, "utf8")).files), [path.join(await fs.realpath(path.join(home, "dotfiles")), "cursor", "mcp.json")]);
  assert.deepEqual((await removeServer({ targets, statePath })).map((result) => result.status), ["restored"]);
  assert.deepEqual((await fs.readdir(path.join(home, "dotfiles", "cursor"))).filter((name) => !name.includes(".backup-")), [], "no {\"mcpServers\": {}} left behind");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).files, {});
});

test("a config that is not UTF-8 is refused and left byte for byte, on install and on remove", async (t) => {
  const home = await tempHome(t);
  // "серверы" in cp1251, in a comment, as an editor set to Windows-1251 saves it.
  const cp1251 = Buffer.concat([Buffer.from("{\n  // "), Buffer.from([0xf1, 0xe5, 0xf0, 0xe2, 0xe5, 0xf0, 0xfb]), Buffer.from("\n  \"mcpServers\": {}\n}\n")]);
  await fs.mkdir(path.join(home, ".cursor"));
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), cp1251);
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.client === "cursor");
  for (const results of [
    await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) }),
    await removeServer({ targets }),
    await readServerEntries(targets)
  ]) {
    assert.match(results[0].error, /^not UTF-8 text, so it is left as it is\. Save it as UTF-8/);
  }
  assert.deepEqual(await fs.readFile(path.join(home, ".cursor", "mcp.json")), cp1251);
  assert.deepEqual((await fs.readdir(path.join(home, ".cursor"))), ["mcp.json"], "no backup either: nothing was written");
  // A byte order mark is UTF-8 and stays.
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), "\uFEFF{\"mcpServers\": {}}\n");
  assert.equal((await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) }))[0].status, "added");
  assert.ok((await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).startsWith("\uFEFF{"));
});

test("plans are pure: what install and remove would do to a text", () => {
  const cursor = MCP_CLIENTS.find((client) => client.id === "cursor");
  const plan = planInstall(cursor, "", LAUNCH);
  assert.equal(plan.changed, true);
  assert.equal(plan.previous, undefined);
  assert.deepEqual(planInstall(cursor, plan.next, LAUNCH), { next: plan.next, changed: false, previous: LAUNCH, migrated: [] });
  assert.deepEqual(planRemove(cursor, plan.next).removed, ["ai-dev"]);
  assert.deepEqual(planRemove(cursor, "{}"), { next: "{}", changed: false, removed: [] });
});

test("entries read back for the list, a broken file as an error of its own", async (t) => {
  const home = await tempHome(t);
  await sixClients(home);
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), "{ nope");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  await installServer({ targets: targets.filter((target) => target.client === "codex"), entryFor: (target) => clientEntry(target, LAUNCH) });
  const rows = await readServerEntries(targets);
  assert.deepEqual(rows.find((row) => row.client === "codex").entries, { "ai-dev": { ...LAUNCH, startup_timeout_sec: 120, tool_timeout_sec: 3600 }, "ai-dev-system": undefined });
  assert.deepEqual(rows.find((row) => row.client === "cursor").entries, { "ai-dev": undefined, "ai-dev-system": undefined });
  assert.match(rows.find((row) => row.client === "gemini").error, /line 1, column 3/);
});

test("a temp file a killed run left next to the config is removed; a live writer's is not", async (t) => {
  const home = await tempHome(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), "{}\n");
  const dead = path.join(home, ".cursor", ".mcp.json.2147483646.0f0e.tmp");
  const live = path.join(home, ".cursor", `.mcp.json.${process.ppid}.0f0e.tmp`);
  const foreign = path.join(home, ".cursor", ".other.json.2147483646.0f0e.tmp");
  for (const file of [dead, live, foreign]) await fs.writeFile(file, "partial");
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.detected);
  await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH), apply: false });
  await fs.access(dead);
  await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) });
  await assert.rejects(fs.access(dead), "the dead writer's temp file is gone");
  await fs.access(live);
  await fs.access(foreign);
});

test("a config keeps a mode the umask would not give its copy, through install and remove", { skip: process.platform === "win32" && "a 0664 mode needs POSIX" }, async (t) => {
  const home = await tempHome(t);
  const file = path.join(home, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, "{\"mcpServers\": {}}\n");
  await fs.chmod(file, 0o664);
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const targets = (await discoverClients({ home, env: env(home), platform: "linux" })).filter((target) => target.client === "cursor");
  assert.deepEqual((await installServer({ targets, entryFor: (target) => clientEntry(target, LAUNCH) })).map((result) => result.status), ["added"]);
  const installed = (await fs.stat(file)).mode & 0o777;
  assert.deepEqual((await removeServer({ targets })).map((result) => result.status), ["removed"]);
  const removed = (await fs.stat(file)).mode & 0o777;
  // The modes say so only where a new file takes its mode from the umask, which is checked after the writes: a default
  // ACL or a filesystem that ignores modes gives another.
  await fs.writeFile(path.join(home, "umask-probe"), "", { mode: 0o666 });
  assert.equal(((await fs.stat(path.join(home, "umask-probe"))).mode & 0o777).toString(8), "644",
    "a file made here with 666 gets 644, as umask 0022 gives: a default ACL or a filesystem that ignores modes gives another");
  assert.equal(installed, 0o664, "the copy that took its place was given its mode back");
  assert.equal(removed, 0o664);
});

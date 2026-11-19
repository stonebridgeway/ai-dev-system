import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The 2.x local installer is `ai-dev clients install` now; the script stays as
// a wrapper with its flags (dry run unless --apply) and its JSON on stdout.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(serverRoot, "scripts", "install-local-mcp-clients.mjs");

function run(args, home) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: serverRoot,
    // Every place a client keeps its config, Windows's APPDATA and LOCALAPPDATA
    // included, inside the test's home.
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      CODEX_HOME: "",
      CLAUDE_CONFIG_DIR: "",
      AI_DEV_HOME: ""
    },
    encoding: "utf8",
    windowsHide: true
  });
}

test("the 2.x installer is a dry run without --apply, and says what replaced it", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "local-installer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".cursor"));
  const result = run([], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /install-local-mcp-clients\.mjs is `ai-dev clients install` now/);
  assert.deepEqual(JSON.parse(result.stdout).clients.map((item) => [item.client, item.status]),
    [["claude-code", "would-add"], ["cursor", "would-add"], ["vscode", "would-add"], ["gemini", "would-add"]], "the four 2.x wrote, installed or not");
  assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
});

test("`--clients claude` is Claude Code alone, as in 2.x", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "local-installer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const args of [["--clients", "claude"], ["--clients=claude,cursor"]]) {
    const result = run(args, home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).clients.map((item) => item.client), args.join(" ").includes("cursor") ? ["claude-code", "cursor"] : ["claude-code"]);
  }
});

test("--apply writes ai-dev and takes out the ai-dev-system entry 2.x wrote", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "local-installer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".cursor"));
  const legacy = { command: process.execPath, args: [path.join(serverRoot, "src", "server.mjs")], env: { AI_DEV_PYTHON: "python3" } };
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { "ai-dev-system": legacy, other: {} } }, null, 2)}\n`);
  const result = run(["--apply", "--clients", "cursor"], home);
  assert.equal(result.status, 0, result.stderr);
  const [cursor] = JSON.parse(result.stdout).clients;
  assert.equal(cursor.status, "added");
  assert.deepEqual(cursor.migrated, ["ai-dev-system"]);
  const servers = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers;
  assert.deepEqual(Object.keys(servers), ["other", "ai-dev"]);
  assert.deepEqual(servers["ai-dev"], { command: process.execPath, args: [path.join(serverRoot, "bin", "ai-dev.mjs"), "mcp"] });
  assert.equal("AI_DEV_PYTHON" in (servers["ai-dev"].env ?? {}), false, "no AI_DEV_PYTHON any more");
});

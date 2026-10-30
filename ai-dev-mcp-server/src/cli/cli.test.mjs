import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonc } from "../core/jsonc-edit.mjs";
import { clientStatePath, commandWord, missingMountError } from "./clients.mjs";
import { createIo } from "./context.mjs";
import { parseSetupArgs } from "./setup.mjs";
import { PassThrough } from "node:stream";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(serverRoot, "bin", "ai-dev.mjs");
const INITIALIZE = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`;

/**
 * Every place a client keeps its config, inside `home`: on Windows VS Code's
 * and Claude Desktop's live under APPDATA and LOCALAPPDATA, not under HOME,
 * and a test that left them alone wrote to the developer's own files.
 */
function homeEnv(home, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: "",
    CLAUDE_CONFIG_DIR: "",
    AI_DEV_HOME: "",
    ...extra
  };
}

async function tempDir(t, prefix = "ai-dev-cli-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Run a script with node — `as` another user's `uid` and `gid`, where given; resolve with its exit code and output. */
function runNode(args, { env = {}, input = "", untilLine = null, timeoutMs = 60_000, as = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...as
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (untilLine && untilLine.test(stdout)) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

test("help, version and wrong usage answer with exit codes 0 and 2", async () => {
  const help = await runNode([cli, "help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^ai-dev \S+ — a local MCP server/);
  for (const name of ["setup", "clients", "settings", "skills", "rules", "servers", "model", "menu", "status", "mcp", "doctor"]) assert.match(help.stdout, new RegExp(`\\n  ${name} `));
  const version = await runNode([cli, "--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^ai-dev \d+\.\d+\.\d+ \(Node \d+/);
  // What `clients remove` keeps back is any entry the install replaced, 2.x's ai-dev-system too.
  const clientsHelp = await runNode([cli, "clients", "--help"]);
  assert.equal(clientsHelp.code, 0);
  assert.match(clientsHelp.stdout, /\n {2}remove {5}take ai-dev out again; an untouched file goes back as it was, less any ai-dev or ai-dev-system\n {13}entry the install replaced \(its backup keeps it\)\n/);

  const cases = [
    [["frobnicate"], /There is no command "frobnicate"\. `ai-dev help` lists them\./],
    [["dcotor"], /Did you mean `ai-dev doctor`\?/], [["statsu"], /Did you mean `ai-dev status`\?/],
    [["setup", "--forse"], /`ai-dev setup` has no option --forse\. Did you mean --force\?/],
    [["setup", "--clients=zed"], /`ai-dev setup`: Not a client: zed\./],
    [["setup", "--yes=1"], /--yes is a switch and takes no value/],
    [["clients", "isntall"], /Did you mean `ai-dev clients install`\?/],
    [["clients", "install", "--clients"], /--clients needs a value/],
    [["model", "import"], /needs a folder or a \.zip/],
    [["doctor", "extra"], /takes no argument, and was given "extra" as well/],
    [["help", "nope"], /There is no command "nope"/]
  ];
  for (const [args, said] of cases) {
    const result = await runNode([cli, ...args]);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, said, args.join(" "));
    assert.equal(result.stdout, "", `${args.join(" ")}: nothing on stdout`);
  }
});

test("a mistyped command touches no data: the 2.x runtime folder stays where it is", async (t) => {
  const home = await tempDir(t);
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(runtime, ".ai-dev", "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, ".ai-dev", "state", "instincts.json"), "{}\n");
  for (const args of [[cli, "statsu"], [cli, "setup", "--forse"], [path.join(serverRoot, "scripts", "ai-dev.mjs"), "statsu"]]) {
    const result = await runNode(args, { env: homeEnv(home, { AI_DEV_HOME: runtime }) });
    assert.equal(result.code, 2);
  }
  assert.deepEqual(await fs.readdir(runtime), [".ai-dev"]);
  assert.deepEqual(await fs.readdir(path.join(runtime, ".ai-dev", "state")), ["instincts.json"]);
});

test("`ai-dev mcp`, its synonym `start` and the 2.x `scripts/ai-dev.mjs start` serve MCP with instructions", async (t) => {
  const home = await tempDir(t);
  for (const args of [[cli, "mcp"], [cli, "start"], [path.join(serverRoot, "scripts", "ai-dev.mjs"), "start"], [path.join(serverRoot, "src", "server.mjs")]]) {
    const result = await runNode(args, { env: homeEnv(home), input: INITIALIZE, untilLine: /\n/ });
    const [line] = result.stdout.split("\n");
    const message = JSON.parse(line);
    assert.equal(message.id, 1, args.join(" "));
    assert.ok(message.result.instructions.length > 500, args.join(" "));
    assert.equal(message.result.serverInfo.name, "ai-dev-system");
    if (args[0].endsWith(path.join("scripts", "ai-dev.mjs"))) assert.match(result.stderr, /scripts\/ai-dev\.mjs is `ai-dev` now/);
  }
});

test("clients install, list, doctor and remove through the CLI, in a home with a client of each kind", async (t) => {
  const home = await tempDir(t);
  const original = "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"o\" }\n  }\n}\n";
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), original);
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n");
  const env = homeEnv(home);

  const install = await runNode([cli, "clients", "install", "--json"], { env });
  assert.equal(install.code, 0, install.stderr);
  const installed = JSON.parse(install.stdout).clients;
  assert.deepEqual(installed.filter((result) => result.status !== "skipped").map((result) => [result.client, result.status]), [["cursor", "added"], ["codex", "added"]]);
  assert.ok(installed.filter((result) => result.status === "skipped").every((result) => /^not installed \(no /.test(result.reason)));
  const entry = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.deepEqual(entry, { command: process.execPath, args: [cli, "mcp"] });

  const again = await runNode([cli, "clients", "install"], { env });
  assert.match(again.stdout, /No changes: every client already runs this install\./);

  const list = JSON.parse((await runNode([cli, "clients", "list", "--json"], { env })).stdout).clients;
  assert.deepEqual(list.filter((row) => row.current).map((row) => row.client), ["cursor", "codex"]);

  const doctor = await runNode([cli, "clients", "doctor", "--json"], { env });
  assert.equal(doctor.code, 0, doctor.stdout);
  const checked = JSON.parse(doctor.stdout).clients;
  assert.deepEqual(checked.map((item) => [item.client, item.ok]), [["cursor", true], ["codex", true]]);
  assert.ok(checked.every((item) => item.instructions > 500));

  const remove = await runNode([cli, "clients", "remove"], { env });
  assert.equal(remove.code, 0);
  assert.match(remove.stdout, /Cursor\s+restored/);
  assert.equal(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"), original);
  assert.equal(await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8"), "model = \"gpt-5\"\n");
});

test("clients install --docker writes `docker run -i --rm …`, and list, entry and remove know it for what it is", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "docker.exe" : "docker"), "", { mode: 0o755 });
  // The test runner's AI_DEV_STATE_ROOT would be the hooks' state folder, and so the entry's: unset, the default.
  const env = homeEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AI_DEV_STATE_ROOT: "" });
  const flags = ["--docker", "--image=example/ai-dev:3", `--projects=${path.join(home, "Projects")}`];

  const install = await runNode([cli, "clients", "install", ...flags, "--json"], { env });
  assert.equal(install.code, 0, install.stderr);
  const written = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.equal(written.command, path.join(bin, process.platform === "win32" ? "docker.exe" : "docker"), "the CLI by its full path");
  assert.deepEqual([written.args[0], written.args.at(-1)], ["run", "example/ai-dev:3"]);
  const mounts = written.args.flatMap((argument, index) => (written.args[index - 1] === "--mount" ? [argument] : []));
  const state = path.join(home, ".ai-dev", "state");
  // Shared where Docker Desktop maps the image's user to this one; on Linux only
  // when tried and found writable as this user — the stub docker here writes
  // nothing, so not here. A dry run says it did not try.
  const shared = process.platform !== "linux";
  assert.equal(mounts.includes(`type=bind,source=${state},target=/ai-dev-state`), shared, mounts.join(" "));
  assert.ok(!written.args.includes("--user"));
  // Tried whatever the uid: the stub ran, and wrote nothing.
  if (!shared) assert.match(JSON.parse(install.stdout).note, /what the image's user wrote into your state folder did not reach it\. The server keeps its state in the volume/);
  await fs.access(path.join(home, "Projects"));
  await fs.access(path.join(state, "mcp-clients.json"));
  if (process.platform === "linux") {
    const dry = await runNode([cli, "clients", "install", ...flags, "--dry-run", "--json"], { env });
    assert.match(JSON.parse(dry.stdout).note, /a dry run does not try it/);
  }

  const list = await runNode([cli, "clients", "list"], { env });
  assert.match(list.stdout, /Cursor\s+ai-dev → Docker: example\/ai-dev:3$/m, "a client run in Docker is not pointed back at a local install");

  const entry = await runNode([cli, "clients", "entry", "claude-code", ...flags], { env });
  assert.equal(entry.code, 0, entry.stderr);
  assert.deepEqual(JSON.parse(entry.stdout), { type: "stdio", ...written });
  const many = await runNode([cli, "clients", "entry", "claude", "--docker"], { env });
  assert.equal(many.code, 2);
  assert.match(many.stderr, /"claude" names 2 clients; name one: claude-code, claude-desktop/);
  const stray = await runNode([cli, "clients", "install", "--image=x"], { env });
  assert.equal(stray.code, 2);
  assert.match(stray.stderr, /--image is an option of --docker/);

  const remove = await runNode([cli, "clients", "remove", "--clients=cursor"], { env });
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Cursor\s+(restored|removed)/);
});

test("clients entry --docker tries the state folder's sharing as install does, the folder made for it", async (t) => {
  if (process.platform !== "linux") return t.skip("only a Linux host tries it");
  const home = await tempDir(t);
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  // A docker that refuses to bind a folder that is not there, as Docker does, and otherwise writes nothing.
  await fs.writeFile(path.join(bin, "docker"), [
    "#!/bin/sh",
    'for a in "$@"; do case "$a" in type=bind,source=*) s="${a#type=bind,source=}"; s="${s%%,target=*}"; [ -d "$s" ] || { echo "docker: Error response from daemon: bind source path does not exist: $s" >&2; exit 125; } ;; esac; done',
    "exit 0",
    ""
  ].join("\n"), { mode: 0o755 });
  const env = homeEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AI_DEV_STATE_ROOT: "" });
  const entry = await runNode([cli, "clients", "entry", "cursor", "--docker", "--image=example/ai-dev:3", `--projects=${path.join(home, "p")}`], { env });
  assert.equal(entry.code, 0, entry.stderr);
  await fs.access(path.join(home, ".ai-dev", "state"));
  assert.match(entry.stderr, /what the image's user wrote into your state folder did not reach it/);
  assert.doesNotMatch(entry.stderr, /Docker did not run/);
});

test("the record of written configs is in the hooks' state folder; one an earlier install kept in the runtime home stays used", async (t) => {
  const home = await tempDir(t);
  const runtime = path.join(home, ".ai-dev", "state", "mcp-clients.json");
  const stateRoot = path.join(home, "elsewhere");
  assert.equal(clientStatePath({ HOME: home, USERPROFILE: home, AI_DEV_HOME: "", AI_DEV_STATE_ROOT: "" }), runtime);
  const env = { HOME: home, USERPROFILE: home, AI_DEV_HOME: "", AI_DEV_STATE_ROOT: stateRoot };
  assert.equal(clientStatePath(env), path.join(stateRoot, "mcp-clients.json"));
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  await fs.writeFile(runtime, "{\"version\":1,\"files\":{}}");
  assert.equal(clientStatePath(env), runtime, "the record an earlier install wrote is still read");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "mcp-clients.json"), "{\"version\":1,\"files\":{}}");
  assert.equal(clientStatePath(env), path.join(stateRoot, "mcp-clients.json"));
});

test("with AI_DEV_STATE_ROOT set, clients remove reads the record a Docker install wrote there, and puts the file back", async (t) => {
  const home = await tempDir(t);
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "docker.exe" : "docker"), "", { mode: 0o755 });
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const original = "{\"mcpServers\":{\"other\":{\"command\":\"other\"}}}\n";
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), original);
  const stateRoot = path.join(home, "elsewhere", "state");
  const env = homeEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AI_DEV_STATE_ROOT: stateRoot });
  const install = await runNode([cli, "clients", "install", "--docker", "--image=example/ai-dev:3", "--clients=cursor", "--shared-state=no"], { env });
  assert.equal(install.code, 0, install.stderr);
  await fs.access(path.join(stateRoot, "mcp-clients.json"));
  const remove = await runNode([cli, "clients", "remove", "--clients=cursor"], { env });
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Cursor\s+restored/);
  assert.equal(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8"), original);
});

test("clients entry --docker --model mounts a linked bge-m3-onnx itself; on the host one that leads nowhere is refused, in the image it is taken as bootstrap checked it", { skip: process.platform === "win32" && "a POSIX link" }, async (t) => {
  const home = await fs.realpath(await tempDir(t));
  const models = path.join(home, "models");
  await fs.mkdir(path.join(home, "disk2", "bge-m3-onnx-real"), { recursive: true });
  await fs.mkdir(models);
  await fs.symlink(path.join(home, "disk2", "bge-m3-onnx-real"), path.join(models, "bge-m3-onnx"));
  const flags = ["clients", "entry", "cursor", "--docker", "--image=example/ai-dev:3", `--projects=${path.join(home, "p")}`, `--model=${models}`, "--shared-state=no", "--platform=linux"];
  const linked = await runNode([cli, ...flags], { env: homeEnv(home) });
  assert.equal(linked.code, 0, linked.stderr);
  const args = JSON.parse(linked.stdout).args;
  assert.ok(args.includes(`type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`), args.join(" "));
  assert.ok(!args.some((argument) => argument.endsWith("target=/models,readonly")));

  await fs.rm(path.join(home, "disk2"), { recursive: true });
  const refused = await runNode([cli, ...flags], { env: homeEnv(home) });
  assert.equal(refused.code, 2, refused.stdout);
  assert.match(refused.stderr, /bge-m3-onnx is a link to .*bge-m3-onnx-real that leads nowhere here \(ENOENT\): connect the disk it leads to, or name another model folder/);
  const inImage = await runNode([cli, ...flags], { env: homeEnv(home, { AI_DEV_RUNTIME: "docker" }) });
  assert.equal(inImage.code, 0, inImage.stderr);
  assert.ok(JSON.parse(inImage.stdout).args.includes(`type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`));
});

test("in the image on the host's behalf, clients install --docker makes no folder of the host's and shares the state as the host decided", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const state = path.join(home, ".ai-dev", "state");
  await fs.mkdir(state, { recursive: true }); // bootstrap.sh made it on the host and mounted it
  const projects = path.join(home, "not-mounted", "projects");
  const flags = ["--docker", "--image=example/ai-dev:3", `--projects=${projects}`, `--state=${state}`, `--home=${home}`, "--platform=linux", "--docker-command=/usr/bin/docker"];
  // The image's own environment: AI_DEV_RUNTIME=docker, and an AI_DEV_STATE_ROOT that is not the host's.
  const env = homeEnv(home, { AI_DEV_RUNTIME: "docker", AI_DEV_STATE_ROOT: "/data/runtime-home/.ai-dev/state" });
  const shared = await runNode([cli, "clients", "install", ...flags, "--shared-state=yes", "--json"], { env });
  assert.equal(shared.code, 0, shared.stderr);
  await assert.rejects(fs.access(projects), /ENOENT/, "the projects folder is the host's to make: the image's root is read-only");
  const args = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"].args;
  assert.ok(args.includes(`type=bind,source=${state},target=/ai-dev-state`), args.join(" "));
  assert.ok(args.includes(`type=bind,source=${projects},target=${projects}`));
  await fs.access(path.join(state, "mcp-clients.json"));

  const apart = await runNode([cli, "clients", "install", ...flags, "--shared-state=no", "--json"], { env });
  assert.equal(apart.code, 0, apart.stderr);
  const after = readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"].args;
  assert.ok(!after.some((argument) => argument.includes("/ai-dev-state")), after.join(" "));
  // Decided by bootstrap.sh, it is bootstrap.sh that says why — once, not once per run.
  assert.equal(JSON.parse(apart.stdout).note ?? "", "");
  const untried = await runNode([cli, "clients", "install", ...flags, "--shared-state=untried"], { env });
  assert.equal(untried.code, 0, untried.stderr);
  assert.doesNotMatch(`${untried.stdout}${untried.stderr}`, /ai-dev clients install --docker` again/, "bootstrap's user has no host CLI to run");
  const wrong = await runNode([cli, "clients", "install", ...flags, "--shared-state=maybe"], { env });
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /--shared-state takes yes, no or untried/);
});

test("on the host, the state folder of a Docker entry is the hooks' one: AI_DEV_STATE_ROOT first", async (t) => {
  const home = await tempDir(t);
  const elsewhere = path.join(home, "elsewhere", "state");
  const entry = await runNode([cli, "clients", "entry", "cursor", "--docker", "--image=x", "--platform=darwin", `--projects=${path.join(home, "p")}`], { env: homeEnv(home, { AI_DEV_STATE_ROOT: elsewhere }) });
  assert.equal(entry.code, 0, entry.stderr);
  assert.ok(JSON.parse(entry.stdout).args.includes(`type=bind,source=${elsewhere},target=/ai-dev-state`), entry.stdout);
});

test("clients doctor names a config whose Node is gone, and exits 1", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: path.join(home, "gone", "node"), args: [cli, "mcp"] } } }));
  const doctor = await runNode([cli, "clients", "doctor"], { env: homeEnv(home) });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /Cursor\s+FAILED — .*gone[\\/]node does not exist/);
  for (const value of ["abc", "0", "-5"]) {
    const wrong = await runNode([cli, "clients", "doctor", `--timeout=${value}`], { env: homeEnv(home) });
    assert.equal(wrong.code, 2, value);
    assert.match(wrong.stderr, /--timeout takes the seconds each command has to answer, a number above 0/);
  }
});

test("clients doctor names a Docker entry whose mounted folder is gone, without starting it", async (t) => {
  const home = await tempDir(t);
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  // The model a link led to sat on a disk that is not connected now; `docker` here would only fail.
  const away = path.join(home, "models", "bge-m3-onnx");
  const args = ["run", "-i", "--rm", "--mount", "type=volume,source=ai-dev-system-data,target=/data",
    "--mount", `type=bind,source=${away},target=/models/bge-m3-onnx,readonly`, "ai-dev-system:3"];
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: path.join(home, "no-such", "docker"), args } } }));
  const doctor = await runNode([cli, "clients", "doctor"], { env: homeEnv(home) });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, new RegExp(`Cursor\\s+FAILED — the folder this entry mounts at /models/bge-m3-onnx is not here: ${escapeRegExp(away)}\\. Docker starts no session without it: connect the disk it is on, or write the entries again with another model folder \\(--model=<folder>\\) or with none, the model then the volume's: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor\`\\.`));
  assert.doesNotMatch(doctor.stdout, /no-such/, "the entry was not started");
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("clients doctor names where a gone model link leads, and its advice writes the entries again with the entry's own options", { skip: process.platform === "win32" && "a POSIX link" }, async (t) => {
  const home = await fs.realpath(await tempDir(t));
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const projects = path.join(home, "My Projects");
  const models = path.join(home, "models");
  await fs.mkdir(projects, { recursive: true });
  await fs.mkdir(models);
  // The link is there; the disk it leads to is not.
  const target = path.join(home, "disk2", "bge-m3-onnx-real");
  await fs.symlink(target, path.join(models, "bge-m3-onnx"));
  const args = ["run", "-i", "--rm", "--mount", "type=volume,source=ai-dev-system-data,target=/data",
    "--mount", `type=bind,source=${projects},target=${projects}`,
    "--mount", `type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`, "ai-dev-system:p14r2"];
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: path.join(home, "no-such", "docker"), args } } }));
  const linked = await runNode([cli, "clients", "doctor"], { env: homeEnv(home) });
  assert.equal(linked.code, 1);
  // The image the entry runs, not the default one; the projects folder quoted, for its space.
  assert.ok(linked.stdout.includes(`FAILED — the folder this entry mounts at /models/bge-m3-onnx: ${models}/bge-m3-onnx leads to ${target}, which is not here. Docker starts no session without it: connect the disk it leads to, or write the entries again with another model folder (--model=<folder>) or with none, the model then the volume's: \`ai-dev clients install --docker --image=ai-dev-system:p14r2 --clients=cursor '--projects=${projects}'\`.`), linked.stdout);

  // A projects folder that went: install makes it again, so it is not one to write the entries without.
  await fs.mkdir(target, { recursive: true });
  await fs.rm(projects, { recursive: true });
  const moved = await runNode([cli, "clients", "doctor"], { env: homeEnv(home) });
  assert.equal(moved.code, 1);
  assert.ok(moved.stdout.includes(`FAILED — the folder this entry mounts at ${projects} is not here: ${projects}. Docker starts no session without it: connect the disk it is on, or write the entries again, which makes the folder: \`ai-dev clients install --docker --image=ai-dev-system:p14r2 --clients=cursor '--projects=${projects}' --model=${models}\`.`), moved.stdout);
  assert.doesNotMatch(moved.stdout, /without it \(/);
  assert.doesNotMatch(`${linked.stdout}${moved.stdout}`, /no-such/, "the entry was not started");
});

// The command a doctor's advice gives, as the words a POSIX shell reads in it: each one bare, or quoted whole.
function adviceWords(stdout) {
  const command = /`(ai-dev clients install [^`]*)`/.exec(stdout)?.[1];
  assert.ok(command, stdout);
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((match) => (match[1] === undefined ? match[2] : match[1].replaceAll("'\\''", "'")));
}

// A home with Cursor configured to run a Docker entry, and a docker on PATH that writes nothing (the state's probe).
async function dockerEntryHome(t) {
  const home = await fs.realpath(await tempDir(t));
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), "", { mode: 0o755 });
  const writeEntry = (...mounts) => fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": {
    command: path.join(home, "no-such", "docker"),
    args: ["run", "-i", "--rm", ...mounts.flatMap((mount) => ["--mount", mount]), "ai-dev-system:3"]
  } } }));
  const readEntry = async () => readJsonc(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"].args;
  return { home, writeEntry, readEntry, env: homeEnv(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, AI_DEV_STATE_ROOT: "" }) };
}

test("clients doctor's advice drops --model whichever gone folder is the model's, and keeps the volume and the state", { skip: process.platform === "win32" && "a POSIX link" }, async (t) => {
  const { home, writeEntry, readEntry, env } = await dockerEntryHome(t);
  const projects = path.join(home, "Projects");
  const state = path.join(home, "state");
  const models = path.join(home, "models");
  await fs.mkdir(state);
  await fs.mkdir(models);
  await fs.symlink(path.join(home, "disk2", "bge-m3-onnx-real"), path.join(models, "bge-m3-onnx"));
  const volume = "type=volume,source=r3f-other-data,target=/data";
  // The projects folder and the model both gone: the model's mount is the last one, and still the one --model is about.
  await writeEntry(volume, `type=bind,source=${state},target=/ai-dev-state`, `type=bind,source=${projects},target=${projects}`, `type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`);
  const both = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(both.code, 1);
  assert.ok(both.stdout.includes(`FAILED — the folder this entry mounts at ${projects} is not here: ${projects} (nor is the one it mounts at /models/bge-m3-onnx). Docker starts no session without them: connect the disks they are on, or write the entries again, which makes the projects folder, and with another model folder (--model=<folder>) or with none, the model then the volume's: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor --volume=r3f-other-data --projects=${projects} --state=${state}\`.`), both.stdout);
  // Run as it is written, it writes the entry again: the projects folder made, no model, the volume and image kept.
  const again = await runNode([cli, ...adviceWords(both.stdout).slice(1)], { env });
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  await fs.access(projects);
  const args = await readEntry();
  assert.deepEqual([args.at(-1), args.includes(volume), args.some((argument) => argument.includes("/models"))], ["ai-dev-system:3", true, false], args.join(" "));

  // A model folder mounted at /models itself, not through its bge-m3-onnx link: gone, it is the model's as well.
  await writeEntry(volume, `type=bind,source=${projects},target=${projects}`, `type=bind,source=${path.join(home, "gone-models")},target=/models,readonly`);
  const folder = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(folder.code, 1);
  assert.ok(folder.stdout.includes(`FAILED — the folder this entry mounts at /models is not here: ${path.join(home, "gone-models")}. Docker starts no session without it: connect the disk it is on, or write the entries again with another model folder (--model=<folder>) or with none, the model then the volume's: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor --volume=r3f-other-data --projects=${projects}\`.`), folder.stdout);
});

test("clients doctor's advice writes the entry it is about, not every client's: a client of a local install stays one", async (t) => {
  const { home, writeEntry, env } = await dockerEntryHome(t);
  await fs.mkdir(path.join(home, ".gemini"));
  const local = `${JSON.stringify({ mcpServers: { "ai-dev": { command: process.execPath, args: [cli, "mcp"] } } }, null, 2)}\n`;
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), local);
  const projects = path.join(home, "Projects");
  await writeEntry(`type=bind,source=${projects},target=${projects}`);
  const doctor = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(doctor.code, 1, doctor.stdout);
  assert.match(doctor.stdout, /Gemini CLI\s+ok — /);
  const words = adviceWords(doctor.stdout);
  assert.deepEqual(words, ["ai-dev", "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${projects}`]);
  const again = await runNode([cli, ...words.slice(1)], { env });
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  assert.match(again.stdout, /Cursor\s+updated/);
  assert.doesNotMatch(again.stdout, /Gemini/);
  assert.equal(await fs.readFile(path.join(home, ".gemini", "settings.json"), "utf8"), local, "Gemini CLI still runs the local install");
});

test("clients doctor's advice for a projects or state folder that is a link leading nowhere takes another folder: install cannot make one through it", { skip: process.platform === "win32" && "a POSIX link" }, async (t) => {
  const { home, writeEntry, readEntry, env } = await dockerEntryHome(t);
  const projects = path.join(home, "Projects");
  const unplugged = path.join(home, "unplugged", "Projects");
  await fs.symlink(unplugged, projects);
  await writeEntry(`type=bind,source=${projects},target=${projects}`);
  const doctor = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(doctor.code, 1);
  assert.ok(doctor.stdout.includes(`FAILED — the folder this entry mounts at ${projects}: ${projects} leads to ${unplugged}, which is not here. Docker starts no session without it: connect the disk it leads to, or write the entries again with another projects folder in place of <projects-folder>, as install cannot make one through a link that leads nowhere: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor '--projects=<projects-folder>'\`.`), doctor.stdout);
  // The folder the link names is not one install can make: what the advice said before fails.
  const through = await runNode([cli, "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${projects}`], { env });
  assert.equal(through.code, 2);
  assert.match(through.stderr, /ENOENT/);
  // Another folder named in place of <projects-folder>: the entry is written with it.
  const elsewhere = path.join(home, "Elsewhere");
  const again = await runNode([cli, ...adviceWords(doctor.stdout).slice(1).map((word) => word.replace("<projects-folder>", elsewhere))], { env });
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  assert.ok((await readEntry()).includes(`type=bind,source=${elsewhere},target=${elsewhere}`));

  // The state folder the same way.
  const state = path.join(home, "state");
  await fs.symlink(path.join(home, "unplugged", "state"), state);
  await writeEntry(`type=bind,source=${state},target=/ai-dev-state`, `type=bind,source=${elsewhere},target=${elsewhere}`);
  const stateDoctor = await runNode([cli, "clients", "doctor"], { env });
  assert.deepEqual(adviceWords(stateDoctor.stdout).slice(3), ["--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${elsewhere}`, "--state=<state-folder>"]);
  assert.match(stateDoctor.stdout, /or write the entries again with another state folder in place of <state-folder>, as install cannot make one through a link that leads nowhere: `/);

  // Both of them links that lead nowhere: each its own placeholder, and the reason said once.
  await writeEntry(`type=bind,source=${state},target=/ai-dev-state`, `type=bind,source=${projects},target=${projects}`);
  const both = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(both.code, 1);
  assert.ok(both.stdout.includes(`, or write the entries again with another projects folder and another state folder in place of <projects-folder> and <state-folder>, as install cannot make either through a link that leads nowhere: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor '--projects=<projects-folder>' '--state=<state-folder>'\`.`), both.stdout);
  assert.equal(both.stdout.split("leads nowhere").length, 2, "the reason once");
  const otherState = path.join(home, "Other-state");
  const written = await runNode([cli, ...adviceWords(both.stdout).slice(1).map((word) => word.replace("<projects-folder>", elsewhere).replace("<state-folder>", otherState))], { env });
  assert.equal(written.code, 0, `${written.stdout}${written.stderr}`);
  assert.ok((await readEntry()).includes(`type=bind,source=${elsewhere},target=${elsewhere}`));
});

test("clients doctor's advice takes another folder where install could not make one: under a link that leads nowhere, or where this user may not write", { skip: process.platform === "win32" && "POSIX links and modes" }, async (t) => {
  const { home, writeEntry, readEntry, env } = await dockerEntryHome(t);
  // The projects folder on a disk reached through a link, which is not connected: the link leads nowhere.
  const disk = path.join(home, "Projects-disk");
  await fs.symlink(path.join(home, "unplugged", "Projects-disk"), disk);
  const projects = path.join(disk, "Projects");
  await writeEntry(`type=bind,source=${projects},target=${projects}`);
  const under = await runNode([cli, "clients", "doctor"], { env });
  assert.equal(under.code, 1);
  assert.ok(under.stdout.includes(`FAILED — the folder this entry mounts at ${projects} is not here: ${projects}. Docker starts no session without it: connect the disk it is on, or write the entries again with another projects folder in place of <projects-folder>, as install cannot make one through ${disk}, a link that leads nowhere: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor '--projects=<projects-folder>'\`.`), under.stdout);
  // The folder itself, as the advice gave it before, is not one install can make.
  const through = await runNode([cli, "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${projects}`], { env });
  assert.equal(through.code, 2);
  assert.match(through.stderr, /ENOTDIR|ENOENT/);
  const elsewhere = path.join(home, "Elsewhere");
  const again = await runNode([cli, ...adviceWords(under.stdout).slice(1).map((word) => word.replace("<projects-folder>", elsewhere))], { env });
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  assert.ok((await readEntry()).includes(`type=bind,source=${elsewhere},target=${elsewhere}`));

  // The state folder under such a link the same way.
  const stateDisk = path.join(home, "state-disk");
  await fs.symlink(path.join(home, "unplugged", "state-disk"), stateDisk);
  await writeEntry(`type=bind,source=${path.join(stateDisk, "state")},target=/ai-dev-state`, `type=bind,source=${elsewhere},target=${elsewhere}`);
  const stateUnder = await runNode([cli, "clients", "doctor"], { env });
  assert.deepEqual(adviceWords(stateUnder.stdout).slice(3), ["--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${elsewhere}`, "--state=<state-folder>"]);
  assert.match(stateUnder.stdout, new RegExp(`or write the entries again with another state folder in place of <state-folder>, as install cannot make one through ${escapeRegExp(stateDisk)}, a link that leads nowhere: \``));

  // A disk not connected under a mount point this user may not write to (root's, as /mnt/External is): mkdir there
  // fails. Root writes anywhere, so as root the doctor and the install run as another user.
  const mountPoint = path.join(home, "mnt", "External");
  await fs.mkdir(mountPoint, { recursive: true });
  await fs.chmod(mountPoint, 0o555);
  const unplugged = path.join(mountPoint, "Projects");
  await writeEntry(`type=bind,source=${unplugged},target=${unplugged}`);
  const as = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  if (as.uid !== undefined) {
    if ((await runNode([cli, "--version"], { as })).code !== 0) return t.diagnostic("the case of a folder this user may not write to is not run: uid 65534 cannot run this checkout");
    for (const folder of [home, path.join(home, ".cursor"), path.join(home, "bin"), path.join(home, "mnt")]) await fs.chmod(folder, 0o755);
    await fs.chmod(path.join(home, ".cursor", "mcp.json"), 0o644);
  }
  const locked = await runNode([cli, "clients", "doctor"], { env, as });
  assert.equal(locked.code, 1, `${locked.stdout}${locked.stderr}`);
  assert.ok(locked.stdout.includes(`FAILED — the folder this entry mounts at ${unplugged} is not here: ${unplugged}. Docker starts no session without it: connect the disk it is on, or write the entries again with another projects folder in place of <projects-folder>, as install cannot make one in ${mountPoint}, which you may not write to: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor '--projects=<projects-folder>'\`.`), locked.stdout);
  const denied = await runNode([cli, "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${unplugged}`], { env, as });
  assert.equal(denied.code, 2, `${denied.stdout}${denied.stderr}`);
  assert.match(denied.stderr, /EACCES/);
});

// A docker that runs what the CLIs before Docker 29 run, and refuses a --mount none of them reads, in the words of
// Docker 29 — or of 27 with DOCKER_SAYS=27 — and with exit 125. Past its options, it fails as the engine does with
// DOCKER_FAILS: that line, and exit 125. What it runs answers initialize as the server does.
const OLD_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
for a in "$@"; do
  case "$a" in
    *bogus=1*)
      if [ "\${DOCKER_SAYS:-}" = 27 ]; then printf '%s\\n' "invalid argument \\"$a\\" for \\"--mount\\" flag: unexpected key 'bogus' in 'bogus=1'" "See 'docker run --help'." >&2
      else printf '%s\\n' "invalid argument \\"$a\\" for \\"--mount\\" flag: unknown option 'bogus' in 'bogus=1'" "" "Usage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]" "" "Run 'docker run --help' for more information" >&2; fi
      exit 125 ;;
  esac
done
if [ -n "\${DOCKER_FAILS:-}" ]; then printf '%s\\n' "$DOCKER_FAILS" "See 'docker run --help'." >&2; exit 125; fi
read -r line
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ai-dev-system","version":"3"},"instructions":"Begin with begin_task."}}'
`;

// A home whose Cursor runs an entry of the given --mount values through the docker above, and `doctorOf`: the doctor
// run on it, with how many times it started the entry.
async function oldDockerHome(t) {
  const { home, env, readEntry } = await dockerEntryHome(t);
  const docker = path.join(home, "old-cli", "docker");
  await fs.mkdir(path.dirname(docker));
  await fs.writeFile(docker, OLD_DOCKER, { mode: 0o755 });
  const log = path.join(home, "docker.log");
  const doctorOf = async (mounts, says = "", fails = "", options = []) => {
    await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: docker, args: ["run", "-i", "--rm", ...mounts.flatMap((mount) => ["--mount", mount]), "ai-dev-system:3"] } } }));
    await fs.rm(log, { force: true });
    const doctor = await runNode([cli, "clients", "doctor", ...options], { env: { ...env, STUB_LOG: log, DOCKER_SAYS: says, DOCKER_FAILS: fails } });
    return { ...doctor, started: await fs.readFile(log, "utf8").then((text) => text.split("\n").filter(Boolean).length, () => 0) };
  };
  return { home, env, readEntry, doctorOf };
}

test("clients doctor starts an entry whose --mount it cannot read, and names that --mount only when Docker refuses to start it, after Docker's own words", { skip: process.platform === "win32" && "a shell script for docker" }, async (t) => {
  const { home, doctorOf } = await oldDockerHome(t);
  const projects = path.join(home, "Projects");
  const models = path.join(home, "models");
  await fs.mkdir(projects);
  await fs.mkdir(models);
  // Docker 29 trims a value: a space before it is no fault. And readonly=TRUE is what the CLIs before 29 take.
  for (const mounts of [
    [" type=volume,source=r4f-data,target=/data", `type=bind,source=${projects},target=${projects}`],
    ["type=volume,source=r4f-data,target=/data", `type=bind,source=${models},target=/models,readonly=TRUE`]
  ]) {
    const doctor = await doctorOf(mounts);
    assert.equal(doctor.code, 0, `${mounts.join(" ")}\n${doctor.stdout}${doctor.stderr}`);
    assert.match(doctor.stdout, /Cursor\s+ok — ai-dev-system 3 answered in \d+ ms/);
    assert.equal(doctor.started, 1, "the entry was started");
  }
  // One that Docker refuses: the entry is started all the same, and the --mount is named after Docker's own words;
  // a folder gone beside it, which Docker 29 never looked at, is said after them — it is gone for every Docker.
  const value = `type=bind,source=${path.join(home, "gone")},target=/x,bogus=1`;
  const goneToo = path.join(home, "gone-too");
  for (const [says, reason] of [["", "unknown option 'bogus' in 'bogus=1'"], ["27", "unexpected key 'bogus' in 'bogus=1'"]]) {
    const refused = await doctorOf([value, `type=bind,source=${goneToo},target=/y`], says);
    assert.equal(refused.code, 1);
    assert.equal(refused.started, 1);
    assert.ok(refused.stdout.includes(`Cursor                  FAILED — it exited with code 125 before answering: invalid argument ${JSON.stringify(value)} for "--mount" flag: ${reason}. Its --mount ${JSON.stringify(value)} is the likely cause, one Docker 29 cannot read: correct it in ~${path.sep}${path.join(".cursor", "mcp.json")}. The folder this entry mounts at /y is not here: ${goneToo}. Docker starts no session without it: connect the disk it is on, or write the entries again, which makes the folder, and without its --mount ${JSON.stringify(value)}, which Docker 29 cannot read: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor --projects=${goneToo}\`.\n`), refused.stdout);
    assert.doesNotMatch(refused.stdout, /Usage:|--help/);
  }
  // Docker gives its reason after the whole value: a line too long to keep whole loses its middle, not the reason.
  const long = `type=bind,source=${path.join(home, "x".repeat(240))},target=/x,bogus=1`;
  const cut = await doctorOf([long]);
  assert.match(cut.stdout, /FAILED — it exited with code 125 before answering: invalid argument "type=bind,source=[^…]+…[^…]+ for "--mount" flag: unknown option 'bogus' in 'bogus=1'\. Its --mount "type=bind,source=/);
});

test("clients doctor names a --mount Docker 29 cannot read only when Docker refused it: a start that failed otherwise is said in Docker's words, and a folder gone beside it as one", { skip: process.platform === "win32" && "a shell script for docker" }, async (t) => {
  const { home, env, readEntry, doctorOf } = await oldDockerHome(t);
  const models = path.join(home, "models");
  await fs.mkdir(models);
  // readonly=TRUE: Docker 29 refuses it, the CLIs before it read it. This one reads it, and the start fails for another
  // reason — the image is not here — which is all that is said; nor do --json's items carry what the doctor read.
  const odd = `type=bind,source=${models},target=/models,readonly=TRUE`;
  const volume = "type=volume,source=r5f-data,target=/data";
  const noImage = "docker: Error response from daemon: No such image: ai-dev-system:3";
  const image = await doctorOf([volume, odd], "", noImage);
  assert.deepEqual([image.code, image.started], [1, 1]);
  assert.ok(image.stdout.includes(`Cursor                  FAILED — it exited with code 125 before answering: ${noImage}\n`), image.stdout);
  assert.doesNotMatch(image.stdout, /likely cause|Docker 29|readonly=TRUE/);
  const [item] = JSON.parse((await doctorOf([volume, odd], "", noImage, ["--json"])).stdout).clients;
  assert.deepEqual([item.ok, "code" in item, "stderr" in item], [false, false, false]);
  // The projects folder gone: beside a model mount every Docker reads, said without a start, --model kept; beside
  // readonly=TRUE the entry is started (Docker 29 refuses that first), and the folder said unless the start answered.
  const gone = path.join(home, "Projects-disk", "Projects");
  const plain = await doctorOf([volume, `type=bind,source=${gone},target=${gone}`, `type=bind,source=${models},target=/models,readonly`]);
  assert.equal(plain.started, 0);
  assert.ok(plain.stdout.includes(`which makes the folder: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor --volume=r5f-data --projects=${gone} --model=${models}\`.\n`), plain.stdout);
  const away = await doctorOf([volume, `type=bind,source=${gone},target=${gone}`, odd], "", `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${gone}`);
  assert.deepEqual([away.code, away.started], [1, 1]);
  assert.ok(away.stdout.includes(`Cursor                  FAILED — the folder this entry mounts at ${gone} is not here: ${gone}. Docker starts no session without it: connect the disk it is on, or write the entries again, which makes the folder, and without its --mount ${JSON.stringify(odd)}, which Docker 29 cannot read: \`ai-dev clients install --docker --image=ai-dev-system:3 --clients=cursor --volume=r5f-data --projects=${gone}\`.\n`), away.stdout);
  assert.doesNotMatch(away.stdout, /likely cause|bind source path/);
  const [answered] = JSON.parse((await doctorOf([volume, `type=bind,source=${gone},target=${gone}`, odd], "", "", ["--json"])).stdout).clients;
  assert.deepEqual([answered.ok, answered.error], [true, undefined]);
  // The command as given writes the entry again: the folder made, that --mount gone, the volume kept.
  const again = await runNode([cli, ...adviceWords(away.stdout).slice(1)], { env });
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  await fs.access(gone);
  const args = await readEntry();
  assert.deepEqual([args.includes(volume), args.includes(`type=bind,source=${gone},target=${gone}`), args.some((argument) => /readonly=TRUE/.test(argument))], [true, true, false], args.join(" "));
});

test("clients doctor's advice for a folder on a drive that is not there takes another folder: install cannot make one on it", () => {
  const entry = { args: ["run", "-i", "--rm", "--mount", "type=volume,source=ai-dev-system-data,target=/data", "--mount", "type=bind,source=E:\\Projects,target=/workspace", "ghcr.io/stonebridgeway/ai-dev-system:latest"] };
  // What the walk up says on Windows of E:\Projects when E:\ is not there (docker-launch.test.mjs).
  assert.equal(missingMountError("cursor", entry, [{ source: "E:\\Projects", target: "/workspace", unmakeable: { at: "E:\\", why: "gone" } }]), `the folder this entry mounts at /workspace is not here: E:\\Projects. Docker starts no session without it: connect the disk it is on, or write the entries again with another projects folder in place of <projects-folder>, as install cannot make one on E:\\, which is not there: \`ai-dev clients install --docker --image=ghcr.io/stonebridgeway/ai-dev-system:latest --clients=cursor ${commandWord("--projects=<projects-folder>")}\`.`);
});

test("a command the doctor gives is quoted for the shell it is pasted into: a POSIX one, or on Windows PowerShell and cmd.exe alike", (t) => {
  assert.equal(commandWord("--projects=/home/me/My $Projects", "linux"), "'--projects=/home/me/My $Projects'");
  assert.equal(commandWord("--state=/home/O'Brien/state", "darwin"), "'--state=/home/O'\\''Brien/state'");
  assert.equal(commandWord("--image=ghcr.io/x/ai-dev@sha256:ab12", "linux"), "--image=ghcr.io/x/ai-dev@sha256:ab12");
  assert.equal(commandWord("--projects=C:\\Users\\me\\AI-Dev-Projects", "win32"), "--projects=C:\\Users\\me\\AI-Dev-Projects");
  // Double quotes, which PowerShell and cmd.exe both read; where PowerShell would expand in them ($, a backtick) or a
  // quote would end them, single quotes, a quote in them doubled, the typographic ones too.
  const windows = ["--projects=C:\\Users\\John Smith\\AI-Dev-Projects", "--state=C:\\Users\\O'Brien\\state", "--model=C:\\Users\\O\u2019Brien\\models",
    "--projects=<projects-folder>", "--volume=a,b", "@data", "--projects=C:\\Users\\me\\My $Projects", "--projects=C:\\Users\\me\\a`b",
    "--image=say \"hi\"", "--image=say \u201chi\u201d", "--state=C:\\Users\\O'Brien\\$state"];
  assert.deepEqual(windows.map((word) => commandWord(word, "win32")), ["\"--projects=C:\\Users\\John Smith\\AI-Dev-Projects\"",
    "\"--state=C:\\Users\\O'Brien\\state\"", "\"--model=C:\\Users\\O\u2019Brien\\models\"", "\"--projects=<projects-folder>\"", "\"--volume=a,b\"", "\"@data\"",
    "'--projects=C:\\Users\\me\\My $Projects'", "'--projects=C:\\Users\\me\\a`b'", "'--image=say \"hi\"'", "'--image=say \u201chi\u201d'",
    "'--state=C:\\Users\\O''Brien\\$state'"]);
  // PowerShell itself, where there is one, reads each back as the word it was (cmd.exe is not here to ask).
  const run = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${process.execPath.replaceAll("'", "''")}' -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${windows.map((word) => commandWord(word, "win32")).join(" ")}`], { encoding: "utf8" });
  if (run.error?.code === "ENOENT") return t.skip("pwsh is unavailable on this host");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), windows);
});
test("the note that the model is on another disk reaches the person: on stderr from clients entry --docker, in install --docker --json", { skip: process.platform === "win32" && "a POSIX link" }, async (t) => {
  const home = await fs.realpath(await tempDir(t));
  // The link has to lead to another filesystem than the one it is on, which a temporary folder alone does not give.
  const device = (await fs.stat(home)).dev;
  const candidates = ["/dev/shm", "/run/shm"];
  let disk = "";
  for (const candidate of candidates) {
    const found = await fs.stat(candidate).catch(() => null);
    if (found?.isDirectory() && found.dev !== device && await fs.access(candidate, fsConstants.W_OK).then(() => true, () => false)) {
      disk = candidate;
      break;
    }
  }
  if (!disk) return t.skip(`no writable folder on another filesystem than ${home}'s to link the model to (tried ${candidates.join(", ")})`);
  const elsewhere = await fs.mkdtemp(path.join(disk, "ai-dev-model-"));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const models = path.join(home, "models");
  await fs.mkdir(models);
  await fs.symlink(elsewhere, path.join(models, "bge-m3-onnx"));
  const note = `${path.join(models, "bge-m3-onnx")} leads to ${elsewhere}, on another disk: every session mounts it from there, so while that disk is away Docker starts no session at all — \`ai-dev clients doctor\` names the entry then.`;
  // Sharing decided, so no Docker is asked; the record and the state stay in this home.
  const env = homeEnv(home, { AI_DEV_STATE_ROOT: "" });
  const flags = ["--docker", "--image=example/ai-dev:3", `--projects=${path.join(home, "p")}`, `--model=${models}`, "--shared-state=no"];

  const entry = await runNode([cli, "clients", "entry", "cursor", ...flags], { env });
  assert.equal(entry.code, 0, entry.stderr);
  assert.ok(JSON.parse(entry.stdout).args.includes(`type=bind,source=${models}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly`));
  assert.equal(entry.stderr.trim(), note);

  const install = await runNode([cli, "clients", "install", ...flags, "--clients=cursor", "--json"], { env });
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).note, note);
});

test("setup's flags: --model, its 2.x names --dense and --dense-python, --all, --no-clients and --no-health", () => {
  assert.equal(parseSetupArgs([]).model, undefined, "unset: asked at a terminal, no elsewhere");
  for (const flags of [["--model"], ["--dense"], ["--dense-python"], ["--all"]]) assert.equal(parseSetupArgs(flags).model, true, flags.join(" "));
  assert.equal(parseSetupArgs(["--no-model"]).model, false);
  assert.equal(parseSetupArgs(["--all"]).frontendQa, true);
  assert.equal(parseSetupArgs(["--dense-python"]).densePython, true);
  assert.equal(parseSetupArgs(["--no-clients"]).clients, false);
  assert.equal(parseSetupArgs(["--clients", "cursor,claude"]).clients, "cursor,claude");
  assert.equal(parseSetupArgs(["--no-health"]).health, false);
  assert.equal(parseSetupArgs(["-y"]).yes, true);
});

test("Ctrl-C at a question stops with 130, as Ctrl-C anywhere else does", async () => {
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true, columns: 80, setRawMode() { return this; } });
  const ask = (typed, fallback) => {
    const stdin = terminal();
    const io = createIo({ stdin, stdout: terminal(), stderr: new PassThrough(), interactive: true });
    setTimeout(() => stdin.write(typed), 20);
    return io.ask("Connect ai-dev to Cursor?", fallback);
  };
  await assert.rejects(ask("\u0003", true), (error) => error.exitCode === 130 && error.message === "Stopped with Ctrl-C at a question, before anything was changed.");
  assert.equal(await ask("да\r", false), true);
  assert.equal(await ask("n\r", true), false);
  assert.equal(await ask("\r", true), true, "Enter takes the default");
});

test("`ai-dev backup` and `ai-dev restore` run on every system, and a restore asks for --confirm", async (t) => {
  const home = await tempDir(t);
  const vault = path.join(home, "vault");
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(vault, "01-system"), { recursive: true });
  await fs.writeFile(path.join(vault, "01-system", "Agent Rules.md"), "mine\n");
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "instincts.json"), "{}\n");
  // The state the server keeps under this runtime: the test setup's own AI_DEV_STATE_ROOT is not it.
  const env = homeEnv(home, { AI_DEV_HOME: runtime, AI_DEV_VAULT_ROOT: vault, AI_DEV_STATE_ROOT: "" });

  const made = await runNode([cli, "backup", "before", "--to", path.join(home, "b"), "--json"], { env });
  assert.equal(made.code, 0, made.stderr);
  const backup = JSON.parse(made.stdout);
  assert.equal(backup.status, "created");
  assert.equal(backup.files, 2);
  assert.match(path.basename(backup.archive), /^ai-dev-system_.+_before\.zip$/);

  const unconfirmed = await runNode([cli, "restore", backup.archive, "--to", path.join(home, "r")], { env });
  assert.equal(unconfirmed.code, 2);
  assert.match(unconfirmed.stderr, /add --confirm to go ahead/);
  await assert.rejects(fs.access(path.join(home, "r")));

  const inPlace = await runNode([cli, "restore", backup.archive, "--confirm"], { env });
  assert.equal(inPlace.code, 1, "the files are there: nothing is written over without --overwrite");
  assert.match(inPlace.stderr, /2 file\(s\) would be written over/);

  const restored = await runNode([cli, "restore", backup.archive, "--confirm", "--to", path.join(home, "r"), "--json"], { env });
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).restored, 2);
  assert.equal(await fs.readFile(path.join(home, "r", "vault", "01-system", "Agent Rules.md"), "utf8"), "mine\n");
});

test("`ai-dev uninstall` says what it would do, changes nothing without --yes, and refuses a typo", async (t) => {
  const home = await tempDir(t);
  const runtime = path.join(home, "rt");
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "instincts.json"), "{}\n");
  const env = homeEnv(home, { AI_DEV_HOME: runtime, AI_DEV_STATE_ROOT: "" });
  const help = await runNode([cli, "help", "uninstall"], { env });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: ai-dev uninstall \[--clients\] \[--data\] \[--yes\] \[--json\]/);
  const dry = await runNode([cli, "uninstall", "--clients", "--data", "--json"], { env });
  assert.equal(dry.code, 0, dry.stderr);
  const said = JSON.parse(dry.stdout);
  assert.equal(said.apply, false);
  assert.equal(said.runtime_home, runtime);
  assert.deepEqual(said.data, { asked: true, removed: false });
  await fs.access(path.join(runtime, "state", "instincts.json"));
  // A runtime home that holds something AI Dev did not make is kept, and the exit status says so.
  await fs.writeFile(path.join(runtime, "notes.txt"), "mine\n");
  const kept = await runNode([cli, "uninstall", "--data", "--yes"], { env });
  assert.equal(kept.code, 4, kept.stderr);
  assert.match(kept.stdout, /Kept .*rt: .*also holds what AI Dev did not make \(notes\.txt\); delete AI Dev's own folders in it yourself\./);
  await fs.access(path.join(runtime, "notes.txt"));
  await fs.access(path.join(runtime, "state", "instincts.json"));
  const typo = await runNode([cli, "uninstall", "--date"], { env });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /`ai-dev uninstall` has no option --date\. Did you mean --data\?/);
});

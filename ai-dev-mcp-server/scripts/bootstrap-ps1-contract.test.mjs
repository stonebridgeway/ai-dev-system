import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stubDocker } from "./bootstrap-contract-stubs.mjs";

// bootstrap.ps1, the Docker path on Windows, against the same `docker` as bootstrap.sh's contract
// (bootstrap-contract.test.mjs): pwsh runs the script itself; on a host without pwsh the tests that run it skip.
// Its own file since the two contracts together outgrew the 800 lines a module keeps.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const bootstrapPowerShell = path.join(repositoryRoot, "bootstrap.ps1");

function powerShellMessage(rendered) {
  return rendered
    .replace(/\u001B\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:Line|\d+)?\s*\|\s?/, "").trim())
    .filter((line) => line && !/^~+$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
}

function runPowerShellBootstrap(args, home, env = {}) {
  return spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-File", bootstrapPowerShell, "-ProjectPath", path.join(home, "projects"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", ...env }
  });
}

test("the PowerShell plan renders, and carries model_path only when -ModelPath is given", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-"));
  try {
    const bare = runPowerShellBootstrap(["-Plan"], home);
    if (bare.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return;
    }
    assert.equal(bare.status, 0, `stdout: ${bare.stdout}\nstderr: ${bare.stderr}`);
    const output = JSON.parse(bare.stdout);
    assert.equal(output.image, "ghcr.io/stonebridgeway/ai-dev-system:latest");
    assert.equal(output.build_local, false);
    assert.equal(output.clients, "all");
    assert.equal(output.installs_prerequisites_when_missing, false);
    assert.equal("model_path" in output, false);

    const withModels = runPowerShellBootstrap(["-Plan", "-ModelPath", path.join(home, "models")], home);
    assert.equal(withModels.status, 0, withModels.stderr);
    assert.equal(JSON.parse(withModels.stdout).model_path, path.join(home, "models"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the PowerShell installer refuses the 2.0.0 model path before it looks for Docker", async (context) => {
  // A validation that let this through would go on to Assert-Docker, which on
  // Windows may start Docker Desktop; the refusal is asserted where it cannot.
  if (process.platform === "win32") {
    context.skip("Assert-Docker has side effects on Windows");
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-"));
  const oldStyle = path.join(home, "bge-m3");
  await fs.mkdir(oldStyle);
  await fs.writeFile(path.join(oldStyle, "pytorch_model.bin"), "");
  try {
    const result = runPowerShellBootstrap(["-SkipSmoke", "-SkipClientInstall", "-ModelPath", oldStyle], home);
    if (result.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const message = powerShellMessage(result.stderr);
    assert.match(message, /holds model files itself \(pytorch_model\.bin\)/);
    assert.match(message, /bge-m3-onnx/, "the message does not say what the folder should contain");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the PowerShell installer pulls, checks the server's own handshake and has the checkout's CLI write the configs", async (context) => {
  if (process.platform === "win32") {
    context.skip("the stub docker is a shell script");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-run-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const log = path.join(root, "docker.log");
  const result = runPowerShellBootstrap(["-Clients", "cursor"], home, {
    STUB_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_DEV_HOME: path.join(home, ".ai-dev")
  });
  if (result.error?.code === "ENOENT") {
    context.skip("pwsh is unavailable on this host");
    return;
  }
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const calls = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\t"))
    // On Linux the CLI tries the state folder's sharing with the image; Windows does not.
    .filter((call) => !(process.platform === "linux" && call[0] === "run" && call.includes("touch") && call.includes("--rm")));
  assert.deepEqual(calls.map((call) => call[0]), ["version", "pull", "run"], "no proxy built, no container kept");
  // The checkout's CLI wrote a direct docker entry into the client's config.
  const config = JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  assert.equal(config.args[0], "run");
  assert.equal(config.args.at(-1), "ghcr.io/stonebridgeway/ai-dev-system:latest");
  // A config written: the restart is asked for, in bootstrap.sh's words.
  assert.match(result.stdout, /Writing the AI clients' configs\.\.\.\n[^]*\nAI Dev is ready\. Restart the AI clients to load ai-dev\.\n$/);
  assert.doesNotMatch(result.stdout, /No AI client found here/);
});

test("bootstrap.ps1 with no client here names its own -Clients and writes nothing; each of its endings is bootstrap.sh's", async (context) => {
  if (process.platform === "win32") {
    context.skip("the stub docker is a shell script");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-none-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(path.join(home, ".unrelated"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const log = path.join(root, "docker.log");
  const env = {
    STUB_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_DEV_HOME: path.join(home, ".ai-dev"), AI_DEV_STATE_ROOT: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: ""
  };
  const none = runPowerShellBootstrap(["-SkipSmoke"], home, env);
  if (none.error?.code === "ENOENT") {
    context.skip("pwsh is unavailable on this host");
    return;
  }
  assert.equal(none.status, 0, `stdout: ${none.stdout}\nstderr: ${none.stderr}`);
  // The script's own parameter, not the CLI's --clients=…, which PowerShell would take for the projects folder.
  assert.match(none.stdout, /\nNo AI client found here \(Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI\)\. Name one to write its config anyway, -Clients "cursor,vscode,…", or install one and run bootstrap\.ps1 again\.\nAI Dev is ready; no AI client is connected to it yet\.\n$/);
  assert.doesNotMatch(none.stdout, /--clients|Writing the AI clients' configs|Restart the AI clients/);
  // Typed at a PowerShell prompt as it is printed, the list is one string; bare, PowerShell passes an array, which
  // -Clients refuses.
  const hint = /-Clients ("[^"]*")/.exec(none.stdout)[1].replace(",…", "");
  const typed = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-Command", `& '${bootstrapPowerShell.replaceAll("'", "''")}' -Plan -Clients ${hint}`], { encoding: "utf8", env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "" } });
  assert.equal(typed.status, 0, typed.stderr);
  assert.equal(JSON.parse(typed.stdout).clients, "cursor,vscode");
  const bare = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-Command", `& '${bootstrapPowerShell.replaceAll("'", "''")}' -Plan -Clients ${JSON.parse(hint)}`], { encoding: "utf8", env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "" } });
  assert.notEqual(bare.status, 0, "the quotes are what the hint needs");
  // Nothing written, and so nothing tried for it: Docker was asked for its version and the image, no more.
  const calls = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
  assert.deepEqual(calls, ["version", "pull"]);
  for (const folder of [".ai-dev", ".cursor", path.join(".config", "Claude")]) await assert.rejects(fs.access(path.join(home, folder)), /ENOENT/, folder);

  const skipped = runPowerShellBootstrap(["-SkipSmoke", "-SkipClientInstall"], home, env);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /\nAI Dev is ready; the AI clients' configs were left as they were\.\n$/);
  assert.doesNotMatch(skipped.stdout, /Restart the AI clients|No AI client found here/);
});

/** A home of its own for bootstrap.ps1, `folders` and `files` made in it, and the stub `docker` first on PATH. */
async function powerShellHome(context, { folders = [], files = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-home-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(bin);
  for (const folder of folders) await fs.mkdir(path.join(home, folder), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), content);
  }
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const env = {
    STUB_LOG: path.join(root, "docker.log"), PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: path.join(home, ".config"),
    AI_DEV_HOME: path.join(home, ".ai-dev"), AI_DEV_STATE_ROOT: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: ""
  };
  return { home, env };
}

// What pwsh printed, as lines, its colours taken off: it colours a warning even with no terminal.
const powerShellLines = (output) => output.replace(/\u001B\[[0-9;]*m/g, "").split(/\r?\n/).filter((line) => line.trim() !== "");

test("bootstrap.ps1 from a stale image says so before its last line, as bootstrap.sh does", async (context) => {
  if (process.platform === "win32") return context.skip("the stub docker is a shell script");
  const { home, env } = await powerShellHome(context, { folders: [".cursor"] });
  // The documented command before the image is published: the pull fails, the copy built here is installed.
  const result = runPowerShellBootstrap(["-Image", "ai-dev-system:local", "-AllowStaleImage", "-SkipSmoke"], home, { ...env, PULL: "fail" });
  if (result.error?.code === "ENOENT") return context.skip("pwsh is unavailable on this host");
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const lines = powerShellLines(result.stdout);
  assert.equal(lines.at(-1), "AI Dev is ready. Restart the AI clients to load ai-dev.");
  assert.match(lines.at(-2), /^WARNING: Installed from a stale image\. Registry pull failed\. The cached copy of ai-dev-system:local was created 2019-01-02T03:04:05/);
});

test("bootstrap.ps1 writes the clients it can when one client's config is broken, names that one and fails; run again, a client already current is not one missing", async (context) => {
  if (process.platform === "win32") return context.skip("the stub docker is a shell script");
  // Cursor is fine; Gemini CLI's settings.json is not JSON, so the installer's dry run exits 1 over it. (Both live in
  // the home on Linux and macOS alike, which VS Code's config does not.)
  const { home, env } = await powerShellHome(context, { folders: [".cursor"], files: { [path.join(".gemini", "settings.json")]: "{ \"mcpServers\": { broken" } });
  const broken = runPowerShellBootstrap(["-SkipSmoke"], home, env);
  if (broken.error?.code === "ENOENT") return context.skip("pwsh is unavailable on this host");
  assert.equal(broken.status, 1, `stdout: ${broken.stdout}\nstderr: ${broken.stderr}`);
  assert.match(broken.stdout, /Writing the AI clients' configs\.\.\.\n {2}Cursor {18}added {9}~\/\.cursor\/mcp\.json\n {2}Gemini CLI {14}FAILED {8}~\/\.gemini\/settings\.json: line 1, column 19: /);
  assert.match(powerShellMessage(broken.stderr), /Writing the client configs failed \(exit code 1\)\./);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"].args.at(-1), "ghcr.io/stonebridgeway/ai-dev-system:latest");
  assert.doesNotMatch(broken.stdout, /No AI client found here|AI Dev is ready/);

  // Gemini CLI's file put right, the same command again writes it; and once more, every client is current already —
  // still clients connected, not none found.
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), "{}\n");
  const fixed = runPowerShellBootstrap(["-SkipSmoke"], home, env);
  assert.equal(fixed.status, 0, `stdout: ${fixed.stdout}\nstderr: ${fixed.stderr}`);
  assert.match(fixed.stdout, / {2}Cursor {18}unchanged {5}~\/\.cursor\/mcp\.json\n {2}Gemini CLI {14}added {9}~\/\.gemini\/settings\.json/);
  const again = runPowerShellBootstrap(["-SkipSmoke"], home, env);
  assert.equal(again.status, 0, `stdout: ${again.stdout}\nstderr: ${again.stderr}`);
  assert.match(again.stdout, /\nNo changes: every client already runs this install\.\n/);
  assert.match(again.stdout, /\nAI Dev is ready\. Restart the AI clients to load ai-dev\.\n$/);
  assert.doesNotMatch(again.stdout, /No AI client found here/);
});

// Windows PowerShell 5.1 reads a script that has no BOM in the ANSI code page: a character past ASCII in a string
// would print as something else there, so the script spells such a character by its code.
test("bootstrap.ps1 keeps its code to ASCII; only its comments go past it", async () => {
  const lines = (await fs.readFile(bootstrapPowerShell, "utf8")).split(/\r?\n/);
  const past = lines.flatMap((line, index) => (/[^\x00-\x7F]/.test(line.replace(/(^|\s)#.*$/, "")) ? [`${index + 1}: ${line.trim()}`] : []));
  assert.deepEqual(past, []);
});

// Windows PowerShell 5.1 turns a native command's redirected stderr into error
// records, which `$ErrorActionPreference = "Stop"` makes fatal; the image writes
// to stderr at every start. No 5.1 runs here, so the
// rule is held on the text: a redirect of stderr only inside Invoke-Native.
test("bootstrap.ps1 throws a native command's stderr away only inside Invoke-Native", async () => {
  const lines = (await fs.readFile(bootstrapPowerShell, "utf8")).split(/\r?\n/);
  assert.ok(lines.some((line) => /^function Invoke-Native \{/.test(line)));
  let inside = false;
  const outside = [];
  for (const [index, line] of lines.entries()) {
    const code = line.replace(/(^|\s)#.*$/, "");
    const opens = /Invoke-Native \{/.test(code);
    if (/(?:\*|2)>\s*\$null|2>&1/.test(code) && !(inside || opens)) outside.push(`${index + 1}: ${line.trim()}`);
    inside = (inside || opens) && /`\s*$/.test(line);
  }
  assert.deepEqual(outside, []);
  assert.ok(lines.filter((line) => /Invoke-Native \{/.test(line)).length >= 5, "the handshake, the engine checks and the cached image's age");
});

/**
 * A `node` first on PATH for bootstrap.ps1: the installer's dry run (`--dry-run`) prints the bytes of `answer` and exits
 * 0, as a dry run that passed does; every other run is the real node's.
 */
async function nodeWhoseDryRunSays(home, answer) {
  const bin = path.join(path.dirname(home), "node-bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "dry-run.out"), answer);
  const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(path.join(bin, "node"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --dry-run ] && { cat ${quoted(path.join(bin, "dry-run.out"))}; exit 0; }; done\nexec ${quoted(process.execPath)} "$@"\n`, { mode: 0o755 });
  return bin;
}

test("bootstrap.ps1 whose dry run answers with no JSON it can read leaves it to the install, whose result stands; and it prints no Docker version", async (context) => {
  if (process.platform === "win32") return context.skip("the stub docker is a shell script");
  const { home, env } = await powerShellHome(context, { folders: [".cursor"] });
  const bin = await nodeWhoseDryRunSays(home, "(not JSON)\n");
  const written = runPowerShellBootstrap(["-SkipSmoke"], home, { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` });
  if (written.error?.code === "ENOENT") return context.skip("pwsh is unavailable on this host");
  assert.equal(written.status, 0, `stdout: ${written.stdout}\nstderr: ${written.stderr}`);
  const lines = powerShellLines(written.stdout);
  // The engine's version (27.0.0 from the stub) is not the first thing said.
  assert.equal(lines[0], "Pulling ghcr.io/stonebridgeway/ai-dev-system:latest...");
  assert.match(written.stdout, /Writing the AI clients' configs\.\.\.\n {2}Cursor {18}added {9}~\/\.cursor\/mcp\.json\n/);
  assert.equal(lines.at(-1), "AI Dev is ready. Restart the AI clients to load ai-dev.");
  assert.equal(JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"].args[0], "run");
  // A client's config the install cannot read: it names that one and fails, and so does the script.
  await fs.mkdir(path.join(home, ".gemini"));
  await fs.writeFile(path.join(home, ".gemini", "settings.json"), "{ \"mcpServers\": { broken");
  const failed = runPowerShellBootstrap(["-SkipSmoke"], home, { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` });
  assert.equal(failed.status, 1, `stdout: ${failed.stdout}\nstderr: ${failed.stderr}`);
  assert.match(failed.stdout, / {2}Gemini CLI {14}FAILED {8}~\/\.gemini\/settings\.json: /);
  assert.match(powerShellMessage(failed.stderr), /Writing the client configs failed \(exit code 1\)\./);
});

test("bootstrap.ps1 reads the dry run as the UTF-8 Node writes, under a console code page that is not, and gives that code page back", async (context) => {
  if (process.platform === "win32") return context.skip("the stub docker is a shell script");
  const { home, env } = await powerShellHome(context);
  // What the dry run answers on Windows for a user whose folder is named past ASCII, no client found: the JSON as
  // Node writes it. Read in a double-byte code page (936 here; 932, 949 and 950 alike), a byte of such a name takes
  // the backslash after it with it, and the JSON does not parse.
  const names = ["\u30db\u30fc\u30e0", "\u7528\u6237", "\uc0ac\uc6a9\uc790", "Jos\u00e9"];
  const answer = `${JSON.stringify({ clients: names.map((name) => ({ client: "cursor", file: `C:\\Users\\${name}\\.cursor\\mcp.json`, status: "skipped", reason: "not installed (no ~\\.cursor)" })) }, null, 2)}\n`;
  const bin = await nodeWhoseDryRunSays(home, answer);
  const script = `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); & '${bootstrapPowerShell.replaceAll("'", "''")}' -ProjectPath '${path.join(home, "projects").replaceAll("'", "''")}' -SkipSmoke; "code page " + [Console]::OutputEncoding.CodePage`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", ...env, PATH: `${bin}${path.delimiter}${env.PATH}` } });
  if (result.error?.code === "ENOENT") return context.skip("pwsh is unavailable on this host");
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const lines = powerShellLines(result.stdout);
  assert.match(result.stdout, /\nNo AI client found here \(Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI\)\. Name one to write its config anyway, -Clients "cursor,vscode,/);
  assert.doesNotMatch(result.stdout, /Writing the AI clients' configs/);
  assert.deepEqual(lines.slice(-2), ["AI Dev is ready; no AI client is connected to it yet.", "code page 936"]);
});

test("bootstrap.ps1 gives the console's code page back when its dry run throws: the node it found is gone by then", async (context) => {
  if (process.platform === "win32") return context.skip("the stub docker is a shell script");
  const { home, env } = await powerShellHome(context, { folders: [".cursor"] });
  // A node that answers the --version Assert-Node asks for and is gone after it, so `& $node` throws inside the try
  // around the dry run, while the code page is UTF-8.
  const bin = path.join(path.dirname(home), "node-bin");
  await fs.mkdir(bin);
  const shim = path.join(bin, "node");
  const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(shim, `#!/bin/sh\nfor a in "$@"; do [ "$a" = --version ] && { rm -f ${quoted(shim)}; echo v22.22.0; exit 0; }; done\nexec ${quoted(process.execPath)} "$@"\n`, { mode: 0o755 });
  const script = `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); try { & '${bootstrapPowerShell.replaceAll("'", "''")}' -ProjectPath '${path.join(home, "projects").replaceAll("'", "''")}' -SkipSmoke } finally { [Console]::Out.WriteLine("code page " + [Console]::OutputEncoding.CodePage) }`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", ...env, PATH: `${bin}${path.delimiter}${env.PATH}` } });
  if (result.error?.code === "ENOENT") return context.skip("pwsh is unavailable on this host");
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  await assert.rejects(fs.access(shim), /ENOENT/, "the node was there for its version, and not for the dry run");
  assert.match(powerShellMessage(result.stderr), /node' is not recognized as a name of a cmdlet, function, script file, or executable program/);
  assert.doesNotMatch(result.stdout, /Writing the AI clients' configs|AI Dev is ready/);
  assert.equal(powerShellLines(result.stdout).at(-1), "code page 936");
});

// The engine's version is asked for to see that it answers, at the start and while Docker Desktop starts: neither is
// printed. The second runs only on Windows with Docker Desktop installed, so this holds it on the text.
test("bootstrap.ps1 throws away each Docker version it asks for", async () => {
  const lines = (await fs.readFile(bootstrapPowerShell, "utf8")).split(/\r?\n/).filter((line) => /&\s*docker\s+version\b/.test(line.replace(/(^|\s)#.*$/, "")));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^\s*\$null = Invoke-Native \{ & docker version /, line);
});

test("bootstrap.ps1 with no -ProjectPath or -ModelPath keeps the folders the 2.x entry it replaces mounts, as bootstrap.sh does", async (context) => {
  if (process.platform === "win32") {
    context.skip("the stub docker is a shell script");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-ps-folders-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const dev = path.join(root, "Dev");
  const models = path.join(root, "models");
  await fs.mkdir(path.join(models, "bge-m3-onnx"), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  // The entry 2.x's install wrote: its launcher, the folders in its environment.
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev-system": {
    command: "/bin/sh", args: ["/clone/docker/run-mcp.sh"], env: { AI_DEV_IMAGE: "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH: dev, AI_DEV_MODEL_PATH: models }
  } } }));
  const result = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-File", bootstrapPowerShell, "-Clients", "cursor"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_DEV_MODEL_PATH: "", STUB_LOG: path.join(root, "docker.log"), PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      XDG_CONFIG_HOME: path.join(home, ".config"), AI_DEV_HOME: path.join(home, ".ai-dev") }
  });
  if (result.error?.code === "ENOENT") {
    context.skip("pwsh is unavailable on this host");
    return;
  }
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Projects folder: ${dev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, the one Cursor mounted`));
  assert.match(result.stdout, /Model folder: .*models, the one Cursor mounted/);
  const entry = JSON.parse(await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["ai-dev"];
  const binds = entry.args.filter((argument) => argument.startsWith("type=bind,"));
  assert.ok(binds.some((mount) => mount.startsWith(`type=bind,source=${dev},`)), JSON.stringify(binds));
  assert.ok(binds.some((mount) => mount.startsWith(`type=bind,source=${models},target=/models`)), JSON.stringify(binds));
  assert.ok(await fs.stat(dev).then((stat) => stat.isDirectory()), "the projects folder is made");
  await assert.rejects(fs.stat(path.join(home, "AI-Dev-Projects")), "and not the default");
});

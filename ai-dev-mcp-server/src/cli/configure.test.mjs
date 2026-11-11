import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createIo } from "./context.mjs";
import { main } from "./main.mjs";
import { runMenu } from "./menu.mjs";
import { parseValue, shown } from "./settings.mjs";

// The commands a server is configured with from a terminal — settings,
// skills, rules, servers, status — and the menu over them (`ai-dev` alone).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(serverRoot, "bin", "ai-dev.mjs");

async function tempDir(t, prefix = "ai-dev-configure-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** An io whose output is collected; `lines` is what a person types. */
function captured({ env, lines, interactive = false }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk; });
  stderr.on("data", (chunk) => { err += chunk; });
  const stdin = lines ? Readable.from([lines.map((line) => `${line}\n`).join("")]) : Readable.from([]);
  const io = createIo({ stdout, stderr, stdin, env, interactive });
  return { io, out: () => out, err: () => err };
}

test("settings: a value typed at a terminal means what the setting takes", () => {
  const where = { cwd: path.resolve("/srv/agents"), home: path.resolve("/home/agent") };
  assert.equal(parseValue("daemon_idle_minutes", "45", where), 45);
  assert.equal(parseValue("daemon_idle_minutes", "soon", where), "soon", "left for the setting's own check to refuse");
  assert.equal(parseValue("daemon_autostart", "OFF", where), false);
  assert.equal(parseValue("daemon_autostart", "yes", where), true);
  assert.equal(parseValue("daemon_autostart", "maybe", where), "maybe");
  assert.equal(parseValue("model_dir", "models", where), path.resolve("/srv/agents/models"));
  assert.equal(parseValue("model_dir", "~/models", where), path.join(path.resolve("/home/agent"), "models"));
  assert.equal(parseValue("model_dir", "", where), "");
  assert.equal(parseValue("profiles", " core,coding ", where), "core,coding");
  assert.equal(shown("daemon_autostart", false), "off");
  assert.equal(shown("profiles", ""), "(every profile)");
});

test("settings: list, set, get and reset write the file the desktop app reads, and refuse what is wrong", async (t) => {
  const home = await tempDir(t);
  const env = { AI_DEV_HOME: home };
  const run = async (...argv) => {
    const { io, out, err } = captured({ env: { ...env } });
    const code = await main(["settings", ...argv], io);
    return { code, out: out(), err: err() };
  };
  const listed = await run();
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /Settings · .*config\.json/);
  assert.match(listed.out, /daemon_idle_minutes\s+30/);

  const set = await run("set", "profiles", "core,coding");
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /profiles = core,coding\nSaved:\n {2}profiles: used by AI sessions started from now on/);
  assert.equal((await run("get", "profiles")).out, "core,coding\n");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")), { schema_version: 1, profiles: "core,coding" });

  const wrong = await run("set", "daemon_idle_minutes", "0.5");
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /daemon_idle_minutes must be a number of minutes from 1 to 10080/);
  const control = await run("set", "profiles", "control");
  assert.equal(control.code, 1);
  assert.match(control.err, /profiles cannot name control/);
  assert.equal(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")).profiles, "core,coding", "a refused value writes nothing");

  const typo = await run("set", "profles", "core");
  assert.equal(typo.code, 2);
  assert.match(typo.err, /There is no setting "profles"\. Did you mean profiles\?/);
  assert.match((await run("profles")).err, /Did you mean `ai-dev settings get profiles`\?/);
  assert.equal((await run("set", "profiles")).code, 2, "a value is needed");
  assert.equal((await run("list", "--all")).code, 2, "--all goes with reset only");

  const reset = await run("reset", "--all");
  assert.equal(reset.code, 0, reset.err);
  assert.match(reset.out, /profiles is back to its default: \(every profile\)/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8")), { schema_version: 1 });
  assert.match((await run("reset", "--all")).out, /Nothing changed/);

  // A variable set by hand wins over the file, and the change says so.
  const { io, out } = captured({ env: { ...env, AI_DEV_PROFILES: "core" } });
  assert.equal(await main(["settings", "set", "profiles", "coding"], io), 0);
  assert.match(out(), /AI_DEV_PROFILES is set in this environment and wins over the file/);
  const json = captured({ env: { ...env } });
  assert.equal(await main(["settings", "--json"], json.io), 0);
  assert.equal(JSON.parse(json.out()).definitions.length, 7);
});

test("the menu runs the commands with the answers typed, and leaves with q", async (t) => {
  const home = await tempDir(t);
  const ran = [];
  const fakeMain = async (argv) => {
    ran.push(argv);
    return argv[0] === "skills" && argv[1] === "add" && !argv.includes("--replace") ? 1 : 0;
  };
  const project = await tempDir(t, "ai-dev-menu-project-");
  const typed = [
    "2", "5", "45", "6", "off", "2", "1 coding", "7", "en", "b", // settings
    "4", "3", "release-notes", "Write release notes from merged pull requests.", // skills: new
    "4", "~/skills/mine", "y", "b", // skills: add, refused, then replaced
    "5", "p", project, "2", "no-force", "git push .*--force", "git push --force", "Never force-push.", "1", "block", "b", // rules: add
    "zz", "q"
  ];
  const { io, out } = captured({ env: { AI_DEV_HOME: home }, lines: typed, interactive: true });
  assert.equal(await runMenu(io, { main: fakeMain }), 0);
  assert.deepEqual(ran, [
    ["settings", "set", "--", "daemon_idle_minutes", "45"],
    ["settings", "set", "--", "daemon_autostart", "off"],
    ["settings", "set", "--", "profiles", "core,coding"],
    ["settings", "set", "--", "language", "en"],
    ["skills", "new", "--", "release-notes", "Write release notes from merged pull requests."],
    ["skills", "add", path.join(os.homedir(), "skills", "mine")],
    ["skills", "add", path.join(os.homedir(), "skills", "mine"), "--replace"],
    // Answers as option values or after `--`: a pattern such as --no-verify stays the pattern.
    ["rules", "add", "--pattern=git push .*--force", "--example=git push --force", "--message=Never force-push.", "--event", "bash", "--action", "block", "--project", project, "--", "no-force"]
  ]);
  assert.match(out(), /\$ ai-dev settings set -- daemon_idle_minutes 45/, "the command it ran is shown");
  assert.match(out(), /\$ ai-dev skills new -- release-notes 'Write release notes from merged pull requests\.'/);
  assert.match(out(), /There is no "zz" here: a number from the list or q\./);
});

test("the main menu is left with q or the end of the input only: Enter and b ask again", async (t) => {
  const home = await tempDir(t);
  const ran = [];
  const { io, out } = captured({ env: { AI_DEV_HOME: home }, lines: ["", "b", "h", "q"], interactive: true });
  assert.equal(await runMenu(io, { main: async (argv) => { ran.push(argv); return 0; } }), 0);
  assert.deepEqual(ran, [["help"]], "Enter and b chose nothing and did not leave");
  assert.match(out(), /There is no "b" here: a number from the list or q\./);
  assert.doesNotMatch(out(), /^ {3}b {2}/m, "no b line in the main menu");
});

test("the menu ends when the input does, and refuses to start where nobody can answer", async (t) => {
  const home = await tempDir(t);
  const ran = [];
  const ended = captured({ env: { AI_DEV_HOME: home }, lines: ["2"], interactive: true });
  assert.equal(await runMenu(ended.io, { main: async (argv) => ran.push(argv) }), 0);
  assert.deepEqual(ran, []);
  // Ended at a question whose Enter means yes: nobody said yes, and nothing is written.
  const atQuestion = captured({ env: { AI_DEV_HOME: home }, lines: ["5", "8"], interactive: true });
  assert.equal(await runMenu(atQuestion.io, { main: async (argv) => { ran.push(argv); return 0; } }), 0);
  assert.deepEqual(ran, [["rules", "install", "--dry-run", "--project", process.cwd()]]);
  assert.match(atQuestion.out(), /Write them\? \[Y\/n\]/);
  const piped = captured({ env: { AI_DEV_HOME: home } });
  assert.equal(await main(["menu"], piped.io), 2);
  assert.match(piped.err(), /nobody can answer here: run it at a terminal/);
  // `ai-dev` alone: the overview where nobody can be asked.
  const alone = captured({ env: { AI_DEV_HOME: home } });
  assert.equal(await main([], alone.io), 0);
  assert.match(alone.out(), /Configure:\n {2}settings/);
});

/** The CLI in a child process, in its own AI Dev home with a vault of its own. */
function runCli(args, { env, cwd = serverRoot, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("skills, rules, servers and status run the server's tools from a terminal", { timeout: 600_000 }, async (t) => {
  const root = await tempDir(t);
  const home = path.join(root, "home");
  const env = { AI_DEV_HOME: path.join(home, ".ai-dev"), AI_DEV_VAULT: "home", AI_DEV_DAEMON: "0", HOME: home, USERPROFILE: home };
  const custom = path.join(home, ".ai-dev", "vault", "03-skills-catalog", "sources", "custom");

  // Your own skills: a new one, one from a folder, and away again.
  const created = await runCli(["skills", "new", "deploy-check", "Check a deploy before calling it done."], { env });
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Started deploy-check\. Write what it does in .*deploy-check.SKILL\.md/);
  assert.match(created.stdout, /The skill registry is rebuilt: \d+ skills/);
  const folder = path.join(root, "skills", "probe");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "SKILL.md"), "---\nname: probe\ndescription: Probe a thing when asked to.\n---\n# Probe\n");
  const added = await runCli(["skills", "add", folder, "--json"], { env });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).name, "probe");
  // A name given is the one the registry knows it by.
  const renamed = await runCli(["skills", "add", folder, "--name", "renamed-one"], { env });
  assert.equal(renamed.code, 0, renamed.stderr);
  const shownRenamed = await runCli(["skills", "show", "renamed-one"], { env });
  assert.equal(shownRenamed.code, 0, shownRenamed.stderr);
  assert.match(shownRenamed.stdout, /name: renamed-one/);
  const mine = await runCli(["skills", "mine"], { env });
  assert.match(mine.stdout, /deploy-check\s+Check a deploy/);
  assert.match(mine.stdout, /probe\s+Probe a thing/);
  assert.match(mine.stdout, /\d+ more came with AI Dev/);
  const found = await runCli(["skills", "search", "deploy", "before", "done", "--limit", "3"], { env });
  assert.match(found.stdout, /deploy-check/);
  // The lines print the short rows an agent gets; --json hands over every field.
  const foundJson = await runCli(["skills", "search", "deploy", "before", "done", "--limit", "3", "--json"], { env });
  const row = JSON.parse(foundJson.stdout).find((item) => item.name === "deploy-check");
  assert.ok(row?.type, foundJson.stdout.slice(0, 400));
  const unasked = await runCli(["skills", "remove", "probe"], { env });
  assert.equal(unasked.code, 1, "nobody to ask: nothing removed");
  assert.match(unasked.stdout, /Add --yes to remove it/);
  assert.equal((await runCli(["skills", "remove", "probe", "--yes"], { env })).code, 0);
  await assert.rejects(fs.access(path.join(custom, "probe")));
  const seeded = await runCli(["skills", "remove", "ai-dev-orchestrator", "--yes"], { env });
  assert.equal(seeded.code, 1);
  assert.match(seeded.stderr, /comes with AI Dev/);
  assert.equal((await runCli(["skills", "serch", "x"], { env })).code, 2);

  // A repository's guard rules.
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { pg: { command: "npx", args: ["-y", "@example/pg"] } } }));
  const rule = await runCli(["rules", "add", "no-force-push", "--pattern", "git push .*--force", "--example", "git push origin main --force", "--message", "Never force-push."], { env, cwd: project });
  assert.equal(rule.code, 0, rule.stderr);
  assert.match(rule.stdout, /Added: block bash no-force-push/);
  const wrong = await runCli(["rules", "add", "too-broad", "--pattern", "rm -rf", "--example", "ls", "--message", "x", "--project", project], { env });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /does not match its own example/);
  assert.equal((await runCli(["rules", "off", "no-force-push", "--project", project], { env })).code, 0);
  const listed = await runCli(["rules", "list", "--project", project, "--json"], { env });
  assert.equal(JSON.parse(listed.stdout).rules.find((item) => item.id === "no-force-push").enabled, false);
  assert.equal((await runCli(["rules", "add", "x", "--event", "disk"], { env, cwd: project })).code, 2);
  // The menu's form: a pattern that starts with "-" is the pattern.
  const dashed = await runCli(["rules", "add", "--pattern=--no-verify", "--example=git commit --no-verify", "--message=Let the hooks run.", "--project", project, "--", "no-skip-hooks"], { env });
  assert.equal(dashed.code, 0, dashed.stderr);
  assert.match(dashed.stdout, /Added: block bash no-skip-hooks/);

  // The MCP servers its configs start, with what to check.
  const servers = await runCli(["servers", "--project", project], { env });
  assert.equal(servers.code, 0, servers.stderr);
  assert.match(servers.stdout, /pg\s+npx -y @example\/pg\s+\(claude-code\)/);
  assert.match(servers.stdout, /warn · pg: npx -y @example\/pg fetches and runs/);
  // None at all: the advice is a command at a terminal, not an agent's tool.
  await fs.mkdir(path.join(root, "bare"), { recursive: true });
  const bare = await runCli(["servers", "--project", path.join(root, "bare")], { env });
  assert.match(bare.stdout, /`ai-dev clients install` \(or the client's own settings\) registers one/);
  assert.doesNotMatch(bare.stdout, /install_local_mcp_clients/);

  // The state in a few lines: nothing is built in this home, and it says so.
  const status = await runCli(["status", "--quick"], { env });
  assert.equal(status.code, 1, "no index yet: failed");
  assert.match(status.stdout, /AI Dev \d+\.\d+\.\d+ · failed/);
  assert.match(status.stdout, /index {5}not built: `ai-dev setup` builds it/);
});

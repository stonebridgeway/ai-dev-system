import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonc } from "../core/jsonc-edit.mjs";
import { commandWord, missingMountError } from "./clients.mjs";

// `ai-dev clients doctor` on Docker entries whose `--mount` Docker 29 cannot read, the entry run by a `docker` that
// says what Docker's CLI said, as measured. Its own file since cli.test.mjs reached the 800 lines a module keeps.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(serverRoot, "bin", "ai-dev.mjs");
const skip = { skip: process.platform === "win32" && "a shell script for docker" };

// A docker that logs each start and, given DOCKER_SAYS, writes that file to stderr and exits 125 — Docker's words for
// a start it refused; otherwise what it runs answers initialize as the server does.
const SAYING_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ -n "\${DOCKER_SAYS:-}" ]; then cat "$DOCKER_SAYS" >&2; exit 125; fi
read -r line
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ai-dev-system","version":"3"},"instructions":"Begin with begin_task."}}'
`;

/** Run the CLI with `env` on top of this one's; resolve with its exit code and output. */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: serverRoot, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

// A home with Cursor, every client's config inside it, and a docker on PATH that writes nothing (install's probe of the
// state folder); `doctorOf` writes Cursor an entry of the given --mount values, run by the docker above, and runs the
// doctor on it — Docker saying `says`, if given — with how many times the entry was started.
async function sayingDockerHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-doctor-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".cursor"));
  await fs.mkdir(path.join(home, "bin"));
  await fs.writeFile(path.join(home, "bin", "docker"), "", { mode: 0o755 });
  const docker = path.join(home, "cli", "docker");
  await fs.mkdir(path.dirname(docker));
  await fs.writeFile(docker, SAYING_DOCKER, { mode: 0o755 });
  const env = {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", AI_DEV_HOME: "", AI_DEV_STATE_ROOT: "",
    PATH: `${path.join(home, "bin")}${path.delimiter}${process.env.PATH}`
  };
  const config = path.join(home, ".cursor", "mcp.json");
  const log = path.join(home, "docker.log");
  const doctorOf = async (mounts, says = "") => {
    await fs.writeFile(config, JSON.stringify({ mcpServers: { "ai-dev": { command: docker, args: ["run", "-i", "--rm", ...mounts.flatMap((mount) => ["--mount", mount]), "ai-dev-system:3"] } } }));
    await fs.rm(log, { force: true });
    const saying = path.join(home, "docker-says.txt");
    await fs.writeFile(saying, says);
    const doctor = await runCli(["clients", "doctor", "--clients=cursor"], { ...env, STUB_LOG: log, DOCKER_SAYS: says ? saying : "" });
    return { ...doctor, started: await fs.readFile(log, "utf8").then((text) => text.split("\n").filter(Boolean).length, () => 0) };
  };
  const readEntry = async () => readJsonc(await fs.readFile(config, "utf8")).mcpServers["ai-dev"].args;
  return { home, env, doctorOf, readEntry };
}

// How Docker quotes a value of plain characters, as the paths here are: as JSON does.
const quotedByDocker = (value) => JSON.stringify(value);

test("clients doctor names the --mount Docker refused when the entry has two it cannot read, the second the one refused", skip, async (t) => {
  const { home, doctorOf } = await sayingDockerHome(t);
  const models = path.join(home, "models");
  const projects = path.join(home, "Projects");
  await fs.mkdir(models);
  await fs.mkdir(projects);
  // The review's case D: readonly=TRUE, which the CLIs before 29 read, then a key none of them knows. CLI 27.5.1
  // refuses the second, Docker 29.8.2 the first — each in its own words.
  const readonlyTrue = `type=bind,source=${models},target=/models,readonly=TRUE`;
  const bogus = `type=bind,source=${projects},target=/extra,bogus=1`;
  const mounts = ["type=volume,source=r6f-data,target=/data", readonlyTrue, bogus];
  const usage29 = "\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n";
  for (const [refused, says] of [
    [bogus, `invalid argument ${quotedByDocker(bogus)} for "--mount" flag: unexpected key 'bogus' in 'bogus=1'\nSee 'docker run --help'.\n`],
    [readonlyTrue, `invalid argument ${quotedByDocker(readonlyTrue)} for "--mount" flag: invalid value for 'readonly': invalid boolean value ("TRUE"): must be one of "true", "1", "false", or "0" (default "true")\n${usage29}`]
  ]) {
    const doctor = await doctorOf(mounts, says);
    assert.deepEqual([doctor.code, doctor.started], [1, 1], `${doctor.stdout}${doctor.stderr}`);
    const [error] = /FAILED — (.*)\n/.exec(doctor.stdout).slice(1);
    assert.match(error, /^it exited with code 125 before answering: invalid argument "/);
    assert.ok(error.endsWith(`. Its --mount ${JSON.stringify(refused)} is the likely cause, one Docker 29 cannot read: correct it in ~${path.sep}${path.join(".cursor", "mcp.json")}.`), error);
  }
});

test("clients doctor says the reason Docker gave after a warning it printed first, and names the --mount it refused", skip, async (t) => {
  const { home, doctorOf } = await sayingDockerHome(t);
  const models = path.join(home, "models");
  await fs.mkdir(models);
  // Docker 29.8.2 with its config.json broken, as measured (the review's case C): the warning, then the refusal.
  const readonlyTrue = `type=bind,source=${models},target=/models,readonly=TRUE`;
  const reason = "invalid value for 'readonly': invalid boolean value (\"TRUE\"): must be one of \"true\", \"1\", \"false\", or \"0\" (default \"true\")";
  const says = `WARNING: Error parsing config file (${home}/.docker/config.json): invalid character 'b' looking for beginning of object key string\ninvalid argument ${quotedByDocker(readonlyTrue)} for "--mount" flag: ${reason}\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nRun 'docker run --help' for more information\n`;
  const doctor = await doctorOf(["type=volume,source=r6f-data,target=/data", readonlyTrue], says);
  assert.deepEqual([doctor.code, doctor.started], [1, 1], `${doctor.stdout}${doctor.stderr}`);
  const [error] = /FAILED — (.*)\n/.exec(doctor.stdout).slice(1);
  // Docker's line may be cut in its middle, if the home's path is long; its start and its reason are kept.
  assert.match(error, /^it exited with code 125 before answering: invalid argument "type=bind,source=/);
  assert.ok(error.endsWith(` for "--mount" flag: ${reason}. Its --mount ${JSON.stringify(readonlyTrue)} is the likely cause, one Docker 29 cannot read: correct it in ~${path.sep}${path.join(".cursor", "mcp.json")}.`), error);
  assert.doesNotMatch(doctor.stdout, /WARNING|config file/);
});

test("clients doctor's advice keeps the data volume of a --mount Docker 29 cannot read, and its command writes the entry with that volume", skip, async (t) => {
  const { home, env, doctorOf, readEntry } = await sayingDockerHome(t);
  // The review's entry: the volume with volume-nocopy=TRUE, which CLI 27.5.1 reads; the projects folder gone, which its
  // engine then refuses.
  const volume = "type=volume,source=r6f-team-data,target=/data,volume-nocopy=TRUE";
  const gone = path.join(home, "Projects-disk", "Projects");
  const says = `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${gone}\nSee 'docker run --help'.\n`;
  const doctor = await doctorOf([volume, `type=bind,source=${gone},target=${gone}`], says);
  assert.deepEqual([doctor.code, doctor.started], [1, 1], `${doctor.stdout}${doctor.stderr}`);
  const command = ["ai-dev", "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", "--volume=r6f-team-data", `--projects=${gone}`];
  assert.ok(doctor.stdout.includes(`Cursor                  FAILED — the folder this entry mounts at ${gone} is not here: ${gone}. Docker starts no session without it: connect the disk it is on, or write the entries again, which makes the folder, and without its --mount ${JSON.stringify(volume)}, which Docker 29 cannot read: \`${command.map((word) => commandWord(word)).join(" ")}\`.\n`), doctor.stdout);
  // The command as given: the entry written again on the same volume, the folder made.
  const again = await runCli(command.slice(1), env);
  assert.equal(again.code, 0, `${again.stdout}${again.stderr}`);
  await fs.access(gone);
  const args = await readEntry();
  assert.ok(args.includes("type=volume,source=r6f-team-data,target=/data"), args.join(" "));
  assert.ok(args.includes(`type=bind,source=${gone},target=${gone}`), args.join(" "));
  assert.doesNotMatch(args.join(" "), /volume-nocopy|ai-dev-system-data/);
});

test("clients doctor's advice takes no folder bound at /data for the projects folder, and says its data is not carried over", skip, async (t) => {
  const { home, doctorOf } = await sayingDockerHome(t);
  const gone = path.join(home, "disk", "Projects");
  const data = path.join(home, "team-data");
  await fs.mkdir(data);
  const command = ["ai-dev", "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${gone}`].map((word) => commandWord(word)).join(" ");
  const instead = `on the volume ai-dev-system-data in place of the folder it binds at /data, ${data}, whose data is not carried over`;
  // Read by Docker 29: not started, the folder gone said as it is.
  const readable = await doctorOf([`type=bind,source=${gone},target=/workspace`, `type=bind,source=${data},target=/data`]);
  assert.deepEqual([readable.code, readable.started], [1, 0], `${readable.stdout}${readable.stderr}`);
  assert.ok(readable.stdout.includes(`FAILED — the folder this entry mounts at /workspace is not here: ${gone}. Docker starts no session without it: connect the disk it is on, or write the entries again, which makes the folder, and ${instead}: \`${command}\`.\n`), readable.stdout);
  // Not read by Docker 29 — the CLIs before it bind it so — and started: the same, beside that --mount.
  const unread = `type=bind,source=${data},target=/data,bind-nonrecursive`;
  const says = `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${gone}\nSee 'docker run --help'.\n`;
  const started = await doctorOf([`type=bind,source=${gone},target=/workspace`, unread], says);
  assert.deepEqual([started.code, started.started], [1, 1], `${started.stdout}${started.stderr}`);
  assert.ok(started.stdout.includes(`which makes the folder, and ${instead}, and without its --mount ${JSON.stringify(unread)}, which Docker 29 cannot read: \`${command}\`.\n`), started.stdout);
});

test("clients doctor's advice for a folder bound at /data that is itself gone: no projects folder, none install makes, and the projects folder kept", () => {
  const data = path.join(path.sep, "home", "me", "disk", "ai-data");
  const projects = path.join(path.sep, "home", "me", "Projects");
  const entry = { args: ["run", "-i", "--rm", "--mount", `type=bind,source=${data},target=/data`, "--mount", `type=bind,source=${projects},target=${projects}`, "ai-dev-system:3"] };
  const command = ["ai-dev", "clients", "install", "--docker", "--image=ai-dev-system:3", "--clients=cursor", `--projects=${projects}`].map((word) => commandWord(word)).join(" ");
  const instead = `on the volume ai-dev-system-data in place of the folder it binds at /data, ${data}, whose data is not carried over`;
  // The disk it is on not connected: nothing for install to make — the volume takes the folder's place.
  assert.equal(missingMountError("cursor", entry, [{ source: data, target: "/data" }]),
    `the folder this entry mounts at /data is not here: ${data}. Docker starts no session without it: connect the disk it is on, or write the entries again ${instead}: \`${command}\`.`);
  // Its mount point not this user's to write in: still no reason to put a placeholder for the projects folder.
  const blocked = { at: path.dirname(data), why: "write" };
  assert.equal(missingMountError("cursor", entry, [{ source: data, target: "/data", unmakeable: blocked }]),
    `the folder this entry mounts at /data is not here: ${data}. Docker starts no session without it: connect the disk it is on, or write the entries again ${instead}: \`${command}\`.`);
});

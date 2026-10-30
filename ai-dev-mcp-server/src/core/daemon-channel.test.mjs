import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DAEMON_PROTOCOL,
  SESSION_LINE_BYTES,
  acceptHandshake,
  addressListening,
  buildDifferences,
  clientProof,
  controlRequest,
  describeBuild,
  isSupersededBy,
  newNonce,
  newSecret,
  nothingListens,
  openChannel,
  readDaemonInfo,
  readDaemonInfoState,
  readLine,
  removeDaemonInfo,
  sameProof,
  serverProof,
  writeDaemonInfo,
  writeLine
} from "./daemon-channel.mjs";
import { randomDaemonName } from "./runtime-paths.mjs";

/**
 * A fresh local address: a short socket path, or a pipe on Windows. Under
 * /tmp, not the temp folder: with a long TMPDIR libuv cuts a socket path short,
 * and two sockets of one folder become one.
 */
async function localAddress(t) {
  if (process.platform === "win32") return `\\\\.\\pipe\\${randomDaemonName()}`;
  const directory = await fs.mkdtemp(path.join("/tmp", "dc-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "s.sock");
}

/** A listener that runs `handle` for each connection, closed — with its connections — when the test ends. */
async function listen(t, address, handle) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    Promise.resolve(handle(socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return server;
}

const daemonInfo = (address, secret, pid = process.pid) => ({ protocol: DAEMON_PROTOCOL, pid, address, secret });

test("each side's proof is bound to both nonces, and a proof of one side is not the other's", () => {
  const secret = newSecret();
  const [server, client] = [newNonce(), newNonce()];
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.match(server, /^[0-9a-f]{32}$/);
  const proof = clientProof(secret, server, client);
  assert.equal(proof, clientProof(secret, server, client));
  assert.notEqual(proof, clientProof(secret, newNonce(), client), "another daemon nonce, another proof: nothing to replay");
  assert.notEqual(proof, clientProof(newSecret(), server, client));
  assert.notEqual(serverProof(secret, server, client, 7), proof);
  assert.notEqual(serverProof(secret, server, client, 7), serverProof(secret, server, client, 8), "the daemon's pid is in its proof");
  assert.equal(sameProof(proof, proof), true);
  assert.equal(sameProof(proof, proof.slice(1)), false);
  assert.equal(sameProof("", ""), false);
  assert.equal(sameProof(undefined, proof), false);
});

test("a client with the secret is let in, both ways proven, and the MCP bytes after the handshake are not lost", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  let accepted;
  await listen(t, address, async (socket) => {
    accepted = await acceptHandshake(socket, { secret, pid: process.pid, version: "9.9.9", build: "b1", welcome: ({ mode, profiles }) => ({ tools_listed: 3, echo: `${mode}:${profiles}` }) });
    const { message } = await readLine(socket, { buffered: accepted.rest });
    await writeLine(socket, { got: message });
  });
  const channel = await openChannel(daemonInfo(address, secret), { mode: "mcp", profiles: "core", environment: { PATH: "/client/bin", RETRIES: 3, UNSET: undefined } });
  t.after(() => channel.socket.destroy());
  assert.equal(channel.welcome.ok, true);
  assert.equal(channel.welcome.version, "9.9.9");
  assert.equal(channel.welcome.build, "b1");
  assert.equal(channel.welcome.tools_listed, 3);
  assert.equal(channel.welcome.echo, "mcp:core");
  await writeLine(channel.socket, { jsonrpc: "2.0", id: 1, method: "ping" });
  const { message } = await readLine(channel.socket, { buffered: channel.rest });
  assert.deepEqual(message.got, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(accepted.mode, "mcp");
  assert.equal(accepted.profiles, "core");
  assert.deepEqual(accepted.environment, { PATH: "/client/bin", RETRIES: "3" }, "the session's environment: what the client has set, as strings");
});

test("the client's environment goes only to a daemon that proved itself, and has a size limit", async (t) => {
  // Something at the address that speaks the protocol but lacks the secret:
  // it records every byte the client sends.
  const address = await localAddress(t);
  const secret = newSecret();
  const received = [];
  await listen(t, address, async (socket) => {
    socket.on("data", (chunk) => received.push(chunk));
    const nonce = newNonce();
    await writeLine(socket, { ai_dev_daemon: DAEMON_PROTOCOL, nonce });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeLine(socket, { ok: true, proof: "0".repeat(64), pid: process.pid, version: "1", build: "b" });
  });
  await assert.rejects(openChannel(daemonInfo(address, secret), { environment: { SECRET_TOKEN: "marker-7d3f" } }), /cannot prove it is this user's daemon/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(Buffer.concat(received).includes("marker-7d3f"), false, "the impostor never saw the environment");

  const huge = { BIG: "x".repeat(SESSION_LINE_BYTES) };
  await assert.rejects(openChannel(daemonInfo(address, secret), { environment: huge }), (error) => error.code === "E2BIG" && /more than the daemon takes/.test(error.message));
  // A control connection carries no environment at all.
  const real = await localAddress(t);
  let seen;
  await listen(t, real, async (socket) => {
    seen = await acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b" });
    socket.end();
  });
  const control = await openChannel(daemonInfo(real, secret), { mode: "control", environment: { SECRET_TOKEN: "marker" } });
  control.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.environment, null);
});

test("a session line that is not an environment, or is too long, is refused", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  const refused = [];
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b", timeoutMs: 1_000 }).catch((error) => {
    refused.push(error.message);
    socket.destroy();
  }));
  const session = async (line) => {
    const socket = net.connect(address);
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.once("connect", resolve));
    const hello = await readLine(socket);
    const nonce = newNonce();
    await writeLine(socket, { protocol: DAEMON_PROTOCOL, nonce, proof: clientProof(secret, hello.message.nonce, nonce), mode: "mcp" });
    await readLine(socket);
    socket.write(line);
    // readLine leaves the socket paused, and a paused socket never reads the end.
    socket.resume();
    await new Promise((resolve) => socket.once("close", resolve));
  };
  await session(`${JSON.stringify({ environment: { PATH: 1 } })}\n`);
  await session(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await session(`${JSON.stringify({ environment: { A: "x".repeat(SESSION_LINE_BYTES) } })}\n`);
  assert.deepEqual(refused.slice(0, 2), ["The client sent no environment for its session.", "The client sent no environment for its session."]);
  assert.equal(refused[2], "The other side sent a session environment of more than 1048576 bytes.");
});

test("a daemon that will not take a client says why", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  await listen(t, address, (socket) => acceptHandshake(socket, {
    secret,
    pid: process.pid,
    version: "1",
    build: "b",
    welcome: ({ mode }) => {
      if (mode === "mcp") throw Object.assign(new Error("This daemon has retired and takes no new session."), { code: "ERETIRED" });
      return {};
    }
  }).catch(() => undefined));
  await assert.rejects(openChannel(daemonInfo(address, secret)), (error) => error.code === "EAUTH" && /refused the connection: This daemon has retired and takes no new session\.$/.test(error.message));
});

test("a client without the secret is refused before it is served, and learns nothing it can reuse", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  const refused = [];
  let served;
  await listen(t, address, (socket) => (served = acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b" }).catch((error) => {
    refused.push(error.message);
  })));
  await assert.rejects(openChannel(daemonInfo(address, newSecret())), /refused the connection: Authentication failed/);
  // On a Windows pipe the daemon's write completes after the client has read it: its side ends later.
  await served;
  assert.deepEqual(refused, ["Authentication failed: the proof does not match this daemon's secret."]);
});

test("a handshake of another protocol, or none at all, is refused", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  const refused = [];
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b", timeoutMs: 500 }).catch((error) => {
    refused.push(error.message);
  }));
  const raw = async (line) => {
    const socket = net.connect(address);
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.once("connect", resolve));
    const hello = await readLine(socket);
    assert.equal(hello.message.ai_dev_daemon, DAEMON_PROTOCOL);
    if (line !== null) socket.write(line);
    const answer = await readLine(socket, { timeoutMs: 2_000 }).catch((error) => ({ message: { closed: error.message } }));
    socket.destroy();
    return answer.message;
  };
  assert.match((await raw(`${JSON.stringify({ protocol: 99, nonce: newNonce(), proof: "x" })}\n`)).error, /protocol 1, not 99/);
  assert.match((await raw(`${JSON.stringify({ protocol: 1 })}\n`)).error, /no nonce/);
  // An MCP client talking straight to the socket, as a 2.x probe would.
  assert.ok((await raw(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)).error);
  assert.match(String((await raw("not json\n")).closed ?? ""), /closed|handshake/);
  await raw(null);
  assert.equal(refused.length, 5);
  assert.ok(refused.some((reason) => /No handshake within 500 ms/.test(reason)), refused.join(" | "));
});

test("something else at the daemon's address cannot pass for it (a stale address taken over)", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  // It speaks the protocol, but does not hold the secret.
  await listen(t, address, (socket) => acceptHandshake(socket, { secret: newSecret(), pid: process.pid, version: "1", build: "b" }).catch(() => undefined));
  await assert.rejects(openChannel(daemonInfo(address, secret)), /refused the connection|cannot prove/);

  const quiet = await localAddress(t);
  await listen(t, quiet, () => undefined);
  await assert.rejects(openChannel(daemonInfo(quiet, secret), { timeoutMs: 300 }), /No handshake within 300 ms/);

  const chatty = await localAddress(t);
  await listen(t, chatty, (socket) => socket.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n`));
  await assert.rejects(openChannel(daemonInfo(chatty, secret)), /not a daemon of this version/);
});

test("the daemon must be the pid its descriptor names", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  await listen(t, address, (socket) => acceptHandshake(socket, { secret, pid: process.pid + 1, version: "1", build: "b" }));
  await assert.rejects(openChannel(daemonInfo(address, secret)), /is pid \d+, not the pid \d+ its descriptor names/);
});

test("a listener that hangs with its queue full still takes the address; refused or missing does not", { skip: process.platform !== "linux" && "only Linux answers a full queue with EAGAIN; macOS refuses it" }, async (t) => {
  const address = await localAddress(t);
  const listener = spawn(process.execPath, ["-e", `require("node:net").createServer(() => {}).listen({ path: ${JSON.stringify(address)}, backlog: 1 }, () => process.stdout.write("ready\\n"))`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => listener.kill("SIGKILL"));
  await once(listener.stdout, "data");
  process.kill(listener.pid, "SIGSTOP");
  const held = [];
  t.after(() => held.forEach((socket) => socket.destroy()));
  let refusal = "";
  while (!refusal && held.length < 100) {
    refusal = await new Promise((resolve) => {
      const socket = net.connect(address);
      socket.once("connect", () => resolve(held.push(socket) && ""));
      socket.once("error", (error) => resolve(error.code));
    });
  }
  assert.equal(refusal, "EAGAIN");
  assert.equal(await addressListening(address), true, "a hung daemon is not a gone one");
  listener.kill("SIGKILL");
  await once(listener, "exit");
  assert.equal(await addressListening(address), false, "the socket it left refuses");
  await fs.rm(address, { force: true });
  assert.equal(await addressListening(address), false, "no socket at all");
  assert.deepEqual(["EAGAIN", "EBUSY", "EACCES", "ETIMEDOUT", "ECONNREFUSED", "ENOENT", "ENOTDIR", "ENOTSOCK"].map((code) => nothingListens({ code })),
    [false, false, false, false, true, true, true, true]);
});

test("a control request gets one answer", async (t) => {
  const address = await localAddress(t);
  const secret = newSecret();
  await listen(t, address, async (socket) => {
    const accepted = await acceptHandshake(socket, { secret, pid: process.pid, version: "1", build: "b" });
    const { message } = await readLine(socket, { buffered: accepted.rest });
    await writeLine(socket, { ok: true, mode: accepted.mode, asked: message.control });
    socket.end();
  });
  assert.deepEqual(await controlRequest(daemonInfo(address, secret), "status"), { ok: true, mode: "control", asked: "status" });
  await assert.rejects(controlRequest({ ...daemonInfo(address, secret), address: `${address}.gone` }, "status"), /Cannot reach the daemon/);
});

test("a descriptor is written whole with mode 0600, read only in this version's form, removed only by its own daemon", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dc-info-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "daemon.json");
  assert.equal(await readDaemonInfo(file), null);
  assert.deepEqual(await readDaemonInfoState(file), { state: "missing", info: null });
  const info = { ...daemonInfo("/tmp/x.sock", newSecret(), 4242), sessions: 2 };
  await writeDaemonInfo(file, info);
  assert.deepEqual(await readDaemonInfo(file), info);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["daemon.json"], "no temp file left beside it");

  assert.equal((await readDaemonInfoState(file)).state, "ok");
  // What a 2.x daemon wrote: no protocol, no secret.
  await fs.writeFile(file, JSON.stringify({ pid: 1, version: "2.0.0", address: "/x/ai-dev.sock", sessions: 0 }));
  assert.equal(await readDaemonInfo(file), null);
  assert.equal((await readDaemonInfoState(file)).state, "invalid");
  // Torn, or refused for a moment: neither says the descriptor is gone.
  await fs.writeFile(file, "{ torn");
  assert.equal(await readDaemonInfo(file), null);
  assert.equal((await readDaemonInfoState(file)).state, "unreadable");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await fs.chmod(file, 0o000);
    assert.equal((await readDaemonInfoState(file)).state, "unreadable");
    await fs.chmod(file, 0o600);
  }

  await writeDaemonInfo(file, info);
  assert.equal(await removeDaemonInfo(file, 1), false, "another daemon's descriptor stays");
  assert.ok(await readDaemonInfo(file));
  assert.equal(await removeDaemonInfo(file, 4242), true);
  assert.equal(await readDaemonInfo(file), null);
});

test("a build is the code, its version and where its data is; what one client sets for itself is not", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dc-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(path.join(root, "src", "a.mjs"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "a.test.mjs"), "// a test\n");
  const env = { HOME: "/home/ivan", PATH: "/usr/bin", AI_DEV_VAULT_ROOT: "/v" };
  // This host's platform: the runtime home is found with its path rules (`resolveInstallLayout`), and compared so.
  const describe = (version, environment, more = {}) => describeBuild({ serverRoot: root, version, env: environment, platform: process.platform, execPath: "/usr/bin/node", ...more });
  const build = await describe("3.0.0", env);
  assert.match(build.id, /^[0-9a-f]{16}$/);
  assert.equal(build.version, "3.0.0");
  assert.equal(build.root, await fs.realpath(root));
  assert.ok(Object.keys(build.environment).includes("AI_DEV_VAULT_ROOT"));
  assert.match(build.environment.AI_DEV_VAULT_ROOT, /^[0-9a-f]{12}$/, "a digest, never the value");
  assert.ok(!JSON.stringify(build).includes("/home/ivan"));
  const id = async (version, environment, more) => (await describe(version, environment, more)).id;
  assert.equal(await id("3.0.0", env), build.id);
  // What each session brings along: its programs, its network, its profiles,
  // its hooks' switches, the daemon's lifetime.
  assert.equal(await id("3.0.0", {
    ...env,
    PATH: "/elsewhere",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
    APPDATA: "C:/x",
    XDG_CONFIG_HOME: "/c",
    CODEX_HOME: "/codex",
    AI_DEV_PROFILES: "core",
    AI_DEV_OFFLINE: "1",
    AI_DEV_MODEL_MIRROR: "https://hf-mirror.com",
    AI_DEV_HOOK_PROFILE: "strict",
    AI_DEV_DISABLED_HOOKS: "x",
    AI_DEV_IDLE_TIMEOUT_MS: "5",
    AI_DEV_IMAGE: "ghcr.io/x"
  }), build.id);
  // One place, spelled two ways, is one build.
  assert.equal(await id("3.0.0", { ...env, AI_DEV_STATE_ROOT: "  " }), build.id, "a blank variable is an unset one, as the server reads it");
  assert.equal(await id("3.0.0", { ...env, AI_DEV_VAULT_ROOT: "/v/" }), build.id, "a trailing slash");
  assert.equal(await id("3.0.0", { ...env, AI_DEV_HOME: "/home/ivan/.ai-dev" }), build.id, "AI_DEV_HOME set to where it is anyway");
  assert.equal(await id("3.0.0", { ...env, AI_DEV_STATE_ROOT: "/home/ivan/.ai-dev/state" }), build.id);
  const windows = { USERPROFILE: "C:\\Users\\ivan", AI_DEV_VAULT_ROOT: "C:\\Vault" };
  const onWindows = (environment) => id("3.0.0", environment, { platform: "win32", execPath: "C:\\node\\node.exe" });
  assert.equal(await onWindows({ ...windows, HOME: "C:\\Users\\ivan\\msys" }), await onWindows(windows), "Git Bash's HOME beside the profile: one home on Windows");
  assert.equal(await onWindows({ ...windows, AI_DEV_VAULT_ROOT: "c:\\vault" }), await onWindows(windows), "Windows paths ignore case");
  // Another place, another build.
  assert.notEqual(await id("3.0.1", env), build.id);
  assert.notEqual(await id("3.0.0", { ...env, AI_DEV_VAULT_ROOT: "/w" }), build.id);
  assert.notEqual(await id("3.0.0", { ...env, BGE_M3_ONNX_DIR: "/models" }), build.id);
  assert.notEqual(await id("3.0.0", { ...env, HOME: "/home/maria" }), build.id);
  assert.notEqual(await id("3.0.0", env, { execPath: "/opt/node24/bin/node" }), build.id, "another Node: its children find another node and npm");
  assert.notEqual(await id("3.0.0", { ...env, AI_DEV_SOMETHING_NEW: "1" }), build.id, "an AI Dev variable nobody classified yet splits rather than leaks");
  await fs.writeFile(path.join(root, "src", "a.test.mjs"), "// a longer test file\n");
  assert.equal(await id("3.0.0", env), build.id, "a test file is not the code a daemon runs");
  await fs.writeFile(path.join(root, "src", "a.mjs"), "export const a = 2; // edited\n");
  const pulled = await describe("3.0.0", env);
  assert.notEqual(pulled.id, build.id, "a git pull that changes the code");
  assert.notEqual(pulled.source, build.source);
});

test("why another daemon is not this one, said by name, and which one the new code replaces", () => {
  const mine = { version: "3.0.0", root: "/app", source: "s1", environment: { AI_DEV_VAULT_ROOT: "a", HOME: "h", BGE_M3_DEVICE: "d" } };
  assert.deepEqual(buildDifferences(mine, mine), []);
  assert.deepEqual(buildDifferences(mine, { ...mine, version: "2.9.0" }), ["ai-dev 2.9.0 (here: 3.0.0)"]);
  assert.deepEqual(buildDifferences(mine, { ...mine, root: "/other" }), ["the code at /other (here: /app)"]);
  assert.deepEqual(buildDifferences(mine, { ...mine, source: "s0" }), ["the code as it was before it changed on disk"]);
  assert.deepEqual(buildDifferences(mine, { ...mine, environment: { ...mine.environment, AI_DEV_VAULT_ROOT: "b" } }),
    ["another environment: AI_DEV_VAULT_ROOT differs"]);
  assert.deepEqual(buildDifferences(mine, { ...mine, environment: { AI_DEV_VAULT_ROOT: "b", HOME: "x", AI_DEV_STATE_ROOT: "s" } }),
    ["another environment: AI_DEV_VAULT_ROOT, HOME differ; AI_DEV_STATE_ROOT set only for it; BGE_M3_DEVICE set only here"]);
  assert.deepEqual(buildDifferences(mine, undefined), ["a build it does not describe"]);

  assert.equal(isSupersededBy(mine, { ...mine, source: "s0" }), true, "a git pull where it lies");
  assert.equal(isSupersededBy(mine, { ...mine, version: "2.9.0" }), true, "an update of the package where it lies");
  assert.equal(isSupersededBy(mine, mine), false);
  assert.equal(isSupersededBy(mine, { ...mine, root: "/other", source: "s0" }), false, "another copy serves clients of its own");
  assert.equal(isSupersededBy(mine, { ...mine, source: "s0", environment: { ...mine.environment, AI_DEV_VAULT_ROOT: "b" } }), false, "another vault serves clients of its own");
  assert.equal(isSupersededBy(mine, null), false);
  // New code that counts one more part of a build still retires the old code's
  // daemon: the parts both have decide.
  const { BGE_M3_DEVICE, ...fewerParts } = mine.environment;
  assert.ok(BGE_M3_DEVICE);
  assert.equal(isSupersededBy(mine, { ...mine, source: "s0", environment: fewerParts }), true);
  assert.equal(isSupersededBy(mine, { ...mine, source: "s0", environment: { ...fewerParts, AI_DEV_VAULT_ROOT: "b" } }), false);
  assert.equal(isSupersededBy(mine, { ...mine, source: "s0", environment: {} }), false, "nothing in common: nothing to go by");
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DAEMON_PROTOCOL, acceptHandshake, describeBuild, newSecret, readLine, writeDaemonInfo, writeLine } from "./daemon-channel.mjs";
import { processState, tryAcquireFileLock } from "./file-lock.mjs";
import { DEFAULT_START_TIMEOUT_MS, connectDaemon, daemonDisabled, daemonStatus, listDaemons, logTail, spawnDaemon, startTimeoutMs, stopDaemons } from "./daemon-client.mjs";
import { daemonInfoPath, daemonLogPath, retiredDaemonPath, runtimeDir } from "./runtime-paths.mjs";

// The runtime home here is the one test/setup.mjs gives every test process,
// and the environment these calls are given names it too: a daemon started
// for an environment lives in that environment's home.
const HOME_ENV = Object.freeze({ AI_DEV_HOME: process.env.AI_DEV_HOME });

/** A spawn that starts nothing: the child "exits" as told, and the call is recorded. */
function fakeSpawn(exit) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => undefined;
    setTimeout(() => child.emit("exit", exit, null), 20);
    return child;
  };
  return { spawnImpl, calls };
}

test("AI_DEV_DAEMON turns the daemon off with 0, off, false or no, in any case", () => {
  for (const value of ["0", "off", "OFF", "false", "no", " No "]) assert.equal(daemonDisabled({ AI_DEV_DAEMON: value }), true, value);
  for (const value of [undefined, "", "1", "on", "yes"]) assert.equal(daemonDisabled({ AI_DEV_DAEMON: value }), false, String(value));
});

test("the start timeout is milliseconds from the environment, 20 s otherwise", () => {
  assert.equal(startTimeoutMs({}), DEFAULT_START_TIMEOUT_MS);
  assert.equal(startTimeoutMs({ AI_DEV_DAEMON_START_TIMEOUT_MS: "1500" }), 1500);
  for (const value of ["", "abc", "0", "-3"]) assert.equal(startTimeoutMs({ AI_DEV_DAEMON_START_TIMEOUT_MS: value }), DEFAULT_START_TIMEOUT_MS, value);
});

test("a daemon is started detached, without a window, writing to its log, and its failure is told with the log's last lines", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  await fs.mkdir(path.dirname(daemonLogPath()), { recursive: true });
  await fs.writeFile(daemonLogPath(), "2026-10-12T00:00:00Z daemon 1: cannot listen at /x: EACCES\n");
  t.after(() => fs.rm(daemonLogPath(), { force: true }));
  const { spawnImpl, calls } = fakeSpawn(1);
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: HOME_ENV, spawnImpl, timeoutMs: 5_000 }),
    (error) => error.code === "ESTART" && /The daemon did not start: it exited with 1\. Its log \(.*daemon\.log\) ends with: .*cannot listen at \/x: EACCES/.test(error.message)
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ["/cli/ai-dev.mjs", "daemon", "run"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio[0], "ignore");
  assert.equal(typeof calls[0].options.stdio[1], "number", "stdout and stderr go to the log file");
});

test("a daemon for another environment than the caller's is started, logged and looked for in that environment's home", async (t) => {
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-other-home-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const log = path.join(other, "logs", "daemon.log");
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, "2026-10-12T00:00:00Z daemon 2: cannot listen at /other: EACCES\n");
  const { spawnImpl, calls } = fakeSpawn(1);
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: { AI_DEV_HOME: other }, spawnImpl, timeoutMs: 5_000 }),
    (error) => error.message.includes(`Its log (${log}) ends with:`) && /cannot listen at \/other: EACCES/.test(error.message)
  );
  assert.equal(calls[0].options.env.AI_DEV_HOME, other);
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: { AI_DEV_HOME: other } });
  assert.equal(path.dirname(status.info), path.join(other, "run"));
});

test("a daemon that never shows up is given up on at the timeout", async () => {
  const { spawnImpl } = fakeSpawn(0);
  const started = Date.now();
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: HOME_ENV, spawnImpl, timeoutMs: 400 }),
    (error) => error.code === "ETIMEDOUT" && /did not start within 0 s/.test(error.message)
  );
  assert.ok(Date.now() - started < 3_000);
});

test("a daemon that steps aside for one that never shows up is started again, a few times at most", async () => {
  const { spawnImpl, calls } = fakeSpawn(0);
  await assert.rejects(
    connectDaemon({ serverRoot: process.cwd(), cliPath: "/cli/ai-dev.mjs", version: "3.0.0", env: HOME_ENV, spawnImpl, timeoutMs: 1_000, restartAfterMs: 100 }),
    (error) => error.code === "ETIMEDOUT"
  );
  assert.equal(calls.length, 3);
});

test("a big log is set aside before a daemon writes to it", async (t) => {
  await fs.mkdir(path.dirname(daemonLogPath()), { recursive: true });
  await fs.writeFile(daemonLogPath(), "x".repeat(1024 * 1024 + 1));
  t.after(() => Promise.all([fs.rm(daemonLogPath(), { force: true }), fs.rm(`${daemonLogPath()}.1`, { force: true })]));
  const { spawnImpl } = fakeSpawn(0);
  spawnDaemon({ cliPath: "/cli/ai-dev.mjs", serverRoot: process.cwd(), env: HOME_ENV, spawnImpl });
  assert.equal((await fs.stat(`${daemonLogPath()}.1`)).size, 1024 * 1024 + 1);
  assert.equal((await fs.stat(daemonLogPath())).size, 0);
  assert.match(await logTail(), /^$|Its log/);
});

/** This install's build, as status computes it for the tests below. */
const ownBuild = () => describeBuild({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV });

/**
 * A stand-in daemon: a process that lives until it is stopped, and a control
 * channel in this test process that answers for it — `status` with what it is
 * told, `stop` by ending the process.
 */
async function standIn(t, { build, buildParts, retired = false, sessions = 1, clientName = "cursor", answersStatus = true, endsOnStop = true }) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  // Under /tmp: a long TMPDIR would cut the socket path short.
  const directory = process.platform === "win32" ? "" : await fs.mkdtemp(path.join("/tmp", "dcl-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\ai-dev-test-${process.pid}-${child.pid}` : path.join(directory, "s.sock");
  const secret = newSecret();
  const sockets = new Set();
  const server = net.createServer(async (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    try {
      const accepted = await acceptHandshake(socket, { secret, pid: child.pid, version: "3.0.0", build });
      const { message } = await readLine(socket, { buffered: accepted.rest });
      if (message.control === "status" && !answersStatus) {
        socket.destroy();
        return;
      }
      if (message.control === "status") await writeLine(socket, { ok: true, pid: child.pid, version: "3.0.0", build, sessions, clients: [{ name: clientName, version: "1" }], retired, ...(retired ? { retired_reason: "its code was replaced" } : {}) });
      if (message.control === "stop") {
        await writeLine(socket, { ok: true, stopping: true, sessions });
        if (endsOnStop) child.kill();
      }
      socket.end();
    } catch {
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(address, resolve));
  t.after(async () => {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  const info = { protocol: DAEMON_PROTOCOL, pid: child.pid, version: "3.0.0", build, build_parts: buildParts, address, secret, sessions };
  const file = retired ? retiredDaemonPath(child.pid) : daemonInfoPath(build);
  await fs.mkdir(runtimeDir(), { recursive: true });
  // As a real daemon does: its lock beside its descriptor, or its retired record, for as long as it lives.
  const lock = await tryAcquireFileLock(file, { heartbeatMs: 1_000 });
  child.once("exit", () => lock.release?.().catch(() => undefined));
  await writeDaemonInfo(file, info);
  t.after(async () => {
    await lock.release?.().catch(() => undefined);
    await fs.rm(file, { force: true });
  });
  return { child, info, file };
}

// A stand-in this test killed may wait to be collected by this very process: exited is gone.
const gone = (pid) => ["gone", "exited"].includes(processState(pid, { ask: true }));

test("status and stop with no daemon, and with descriptors whose daemons are long gone", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  const build = await ownBuild();
  assert.deepEqual(await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV }), { running: false, build: build.id, info: daemonInfoPath(build.id), others: [] });
  assert.deepEqual(await stopDaemons(), { daemons: [] });
  await fs.mkdir(runtimeDir(), { recursive: true });
  // A pid no process has: the highest a 32-bit system hands out, plus one.
  await writeDaemonInfo(daemonInfoPath(build.id), { protocol: DAEMON_PROTOCOL, pid: 4194305, build: build.id, address: "/nowhere.sock", secret: newSecret() });
  await writeDaemonInfo(retiredDaemonPath(4194305), { protocol: DAEMON_PROTOCOL, pid: 4194305, build: "0123456789abcdef", address: "/nowhere.sock", secret: newSecret(), retired: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV });
  assert.equal(status.running, false);
  assert.equal(status.stale, true);
  assert.equal(status.reason, "pid 4194305 is not running");
  assert.equal(existsSync(daemonInfoPath(build.id)), true, "status only looks");
  // stop clears what is left of daemons that are gone, and says there was nothing to stop.
  const stopped = await stopDaemons();
  assert.deepEqual(stopped.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.gone]), [[4194305, true, true], [4194305, true, true]]);
  assert.equal(existsSync(daemonInfoPath(build.id)), false);
  assert.equal(existsSync(retiredDaemonPath(4194305)), false);
});

test("a descriptor whose daemon answers nobody stays while its lock is held, and goes once nobody holds it", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  await fs.mkdir(runtimeDir(), { recursive: true });
  // Alive — this very process — and unreachable, with a live lock beside it.
  const descriptor = daemonInfoPath(build.id);
  await writeDaemonInfo(descriptor, { protocol: DAEMON_PROTOCOL, pid: process.pid, build: build.id, address: path.join(runtimeDir(), "gone.sock"), secret: newSecret() });
  await fs.writeFile(`${descriptor}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", acquired_at: Date.now() }));
  const listed = await listDaemons({ clean: true });
  assert.equal(listed.length, 1);
  assert.match(listed[0].unreachable, /^Cannot reach the daemon at .*gone\.sock/);
  assert.equal(listed[0].removed, false, "a live lock says a daemon may still serve it");
  const stopped = await stopDaemons();
  assert.equal(stopped.daemons[0].stopped, false);
  assert.match(stopped.daemons[0].reason, /^Cannot reach the daemon/);
  assert.doesNotMatch(stopped.daemons[0].reason, /\.$/, "a clause, for the CLI to end with one full stop");
  // Its lock abandoned: the descriptor is a leftover, and goes.
  await fs.writeFile(`${descriptor}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "t", acquired_at: Date.now() - 120_000 }));
  assert.equal((await listDaemons({ clean: true }))[0].removed, true);
  assert.equal(existsSync(descriptor), false);
});

test("status shows the daemons of other builds and the retired ones with why; stop stops every one", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  const mine = await standIn(t, { build: build.id, buildParts: build, sessions: 2 });
  const otherVault = await standIn(t, { build: "1111111111111111", buildParts: { ...build, environment: { ...build.environment, AI_DEV_VAULT_ROOT: "abc" } } });
  const old = await standIn(t, { build: "2222222222222222", buildParts: { ...build, source: "0000" }, retired: true, sessions: 3 });

  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV });
  assert.equal(status.running, true);
  assert.equal(status.current, true);
  assert.equal(status.pid, mine.child.pid);
  assert.equal(status.sessions, 2);
  assert.equal(status.secret, undefined, "status never carries the secret");
  const others = Object.fromEntries(status.others.map((daemon) => [daemon.pid, daemon]));
  assert.deepEqual(others[otherVault.child.pid].differences, ["another environment: AI_DEV_VAULT_ROOT differs"]);
  assert.equal(others[otherVault.child.pid].retired, false);
  assert.equal(others[old.child.pid].retired, true);
  assert.equal(others[old.child.pid].retired_reason, "its code was replaced");
  assert.equal(others[old.child.pid].sessions, 3);

  const stopped = await stopDaemons({ timeoutMs: 5_000 });
  assert.equal(stopped.daemons.length, 3);
  assert.ok(stopped.daemons.every((daemon) => daemon.stopped), JSON.stringify(stopped));
  assert.deepEqual(stopped.daemons.map((daemon) => daemon.sessions).sort(), [1, 2, 3]);
  for (const { child } of [mine, otherVault, old]) assert.equal(gone(child.pid), true);
});

test("stop counts a daemon that has exited and waits to be collected as stopped; where only ps could tell, it asks ps", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  // Its process stays: what the platform says of it is the stand-in's below.
  const zombie = await standIn(t, { build: build.id, buildParts: build, endsOnStop: false });
  const asks = [];
  const macos = (pid, { ask = false } = {}) => {
    asks.push(ask);
    return ask ? "exited" : "unknown";
  };
  const started = Date.now();
  const stopped = await stopDaemons({ timeoutMs: 5_000, state: macos });
  assert.deepEqual(stopped.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.reason]), [[zombie.child.pid, true, undefined]]);
  assert.ok(Date.now() - started < 2_000, `ps is asked within a second, not at the deadline: ${Date.now() - started} ms`);
  assert.ok(asks.filter(Boolean).length === 1 && asks.length <= 11, `ps once, after ten cheap looks: ${JSON.stringify(asks)}`);
});

test("stop that cannot tell whether a daemon's process still runs says so, rather than that it runs", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  const there = await standIn(t, { build: build.id, buildParts: build, endsOnStop: false });
  const unknown = await stopDaemons({ timeoutMs: 200, state: () => "unknown" });
  assert.equal(unknown.daemons[0].pid, there.child.pid);
  assert.equal(unknown.daemons[0].stopped, false);
  assert.match(unknown.daemons[0].reason, /^its process is still there: it runs, or it has exited and the program that started it has not collected it yet$/);
  const running = await stopDaemons({ timeoutMs: 200, state: () => "running" });
  assert.equal(running.daemons[0].reason, "it is still running");
});

test("a status answer of any reasonable length is read, and a daemon that does not answer status still takes stop", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  const long = await standIn(t, { build: build.id, buildParts: build, clientName: "x".repeat(20_000) });
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV });
  assert.equal(status.running, true);
  assert.equal(status.clients[0].name.length, 20_000);
  const mute = await standIn(t, { build: "3333333333333333", buildParts: { ...build, source: "other" }, answersStatus: false });
  const stopped = await stopDaemons({ timeoutMs: 5_000 });
  assert.deepEqual(stopped.daemons.map((daemon) => [daemon.pid, daemon.stopped]).sort(), [[long.child.pid, true], [mute.child.pid, true]].sort());
  assert.equal(gone(long.child.pid), true);
  assert.equal(gone(mute.child.pid), true);
});

test("a retired daemon nobody can reach is still shown; its record goes once nobody holds its lock, whoever has its pid", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  // A process that is not a daemon now has the pid the record names.
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill());
  await fs.mkdir(runtimeDir(), { recursive: true });
  const record = retiredDaemonPath(unrelated.pid);
  await writeDaemonInfo(record, { protocol: DAEMON_PROTOCOL, pid: unrelated.pid, build: build.id, address: path.join(runtimeDir(), "gone.sock"), secret: newSecret(), retired: true });
  // While its lock is held — by a retired daemon still finishing a session — it stays.
  const held = await tryAcquireFileLock(record, { heartbeatMs: 100 });
  const status = await daemonStatus({ serverRoot: process.cwd(), version: "3.0.0", env: HOME_ENV });
  assert.equal(status.running, false);
  assert.deepEqual(status.others.map((daemon) => [daemon.pid, daemon.retired, Boolean(daemon.unreachable)]), [[unrelated.pid, true, true]], "shown, not hidden");
  const first = await stopDaemons({ timeoutMs: 200 });
  assert.equal(first.daemons[0].stopped, false);
  assert.equal(existsSync(record), true);
  // Its daemon gone: the lock is not held any more, and stop clears the record.
  await held.release();
  const second = await stopDaemons({ timeoutMs: 200 });
  assert.deepEqual(second.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.gone]), [[unrelated.pid, true, true]]);
  assert.equal(existsSync(record), false);
  assert.equal(gone(unrelated.pid), false, "the process that has the pid now is left alone");
});

test("a retired daemon hung past its lock's life keeps its record while its address takes connections, and stop says it did not stop", async (t) => {
  await fs.rm(runtimeDir(), { recursive: true, force: true });
  t.after(() => fs.rm(runtimeDir(), { recursive: true, force: true }));
  const build = await ownBuild();
  // Hung: its kernel still takes connections, nothing answers the handshake.
  const directory = process.platform === "win32" ? "" : await fs.mkdtemp(path.join("/tmp", "dcl-"));
  const address = process.platform === "win32" ? `\\\\.\\pipe\\ai-dev-test-hung-${process.pid}` : path.join(directory, "s.sock");
  const sockets = new Set();
  const hung = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  await new Promise((resolve) => hung.listen(address, resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    hung.close(() => (directory ? fs.rm(directory, { recursive: true, force: true }).then(resolve, resolve) : resolve()));
  }));
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => holder.kill());
  await fs.mkdir(runtimeDir(), { recursive: true });
  const record = retiredDaemonPath(holder.pid);
  await writeDaemonInfo(record, { protocol: DAEMON_PROTOCOL, pid: holder.pid, build: build.id, address, secret: newSecret(), retired: true });
  // Its lock stopped beating two minutes ago.
  const lockFile = `${record}.lock`;
  await fs.writeFile(lockFile, JSON.stringify({ pid: holder.pid, host: os.hostname(), token: "hung", acquired_at: Date.now() - 120_000 }));
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockFile, old, old);
  const result = await stopDaemons({ timeoutMs: 200 });
  assert.deepEqual(result.daemons.map((daemon) => [daemon.pid, daemon.retired, daemon.stopped]), [[holder.pid, true, false]]);
  assert.match(result.daemons[0].reason, /./, "and says why");
  assert.equal(existsSync(record), true, "its record stays for when it wakes");
  // Gone for good — nothing takes connections at its address — and the record goes.
  await new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    hung.close(resolve);
  });
  const after = await stopDaemons({ timeoutMs: 200 });
  assert.deepEqual(after.daemons.map((daemon) => [daemon.pid, daemon.stopped, daemon.gone]), [[holder.pid, true, true]]);
  assert.equal(existsSync(record), false);
});

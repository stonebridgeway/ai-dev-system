import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BREAK_LOCK_STALE_MS,
  EMPTY_LOCK_GRACE_MS,
  LOCK_STALE_MS,
  LOCK_SUFFIX,
  LOCK_TIMEOUT_MS,
  acquireFileLock,
  breakStaleLock,
  lockIsLive,
  lockPathFor,
  processAlive,
  processState,
  procStateLetter,
  psStateLetter,
  readLock,
  sameLock,
  tryAcquireFileLock,
  withFileLock
} from "./file-lock.mjs";
import * as hookLib from "../../hooks/lib.mjs";

const tempDirectories = [];
test.after(() => Promise.all(tempDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function tempFile(name = "ledger.jsonl") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-lock-"));
  tempDirectories.push(directory);
  return path.join(directory, name);
}

/** A pid that is certainly not running: past the kernel's limit on every OS we run on. */
const DEAD_PID = 2 ** 30 + 7;

test("the lock sits beside the file it guards", () => {
  assert.equal(lockPathFor("/data/state/usage/events.jsonl"), path.resolve("/data/state/usage/events.jsonl") + LOCK_SUFFIX);
});

test("a holder is live while its process runs and the lock is young", () => {
  const now = 1_000_000;
  const holder = { pid: process.pid, host: os.hostname(), token: "t", acquired_at: now - 10 };
  assert.equal(lockIsLive({ holder, mtimeMs: now }, { now }), true);
  assert.equal(lockIsLive({ holder: { ...holder, pid: DEAD_PID }, mtimeMs: now }, { now }), false, "a dead pid is stale at once");
  assert.equal(lockIsLive({ holder: { ...holder, acquired_at: now - LOCK_STALE_MS }, mtimeMs: now }, { now }), false, "an old lock is stale whoever holds it");
  assert.equal(lockIsLive({ holder: { ...holder, host: "another-machine", pid: DEAD_PID }, mtimeMs: now }, { now }), true, "a pid on another host cannot be checked, so only age decides");
  assert.equal(lockIsLive({ holder: null, mtimeMs: now - 10 }, { now }), true, "a lock still being written is live for a moment");
  assert.equal(lockIsLive({ holder: null, mtimeMs: now - EMPTY_LOCK_GRACE_MS }, { now }), false, "an empty lock left by a killed writer is stale after the grace");
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(DEAD_PID), false);
  assert.equal(processAlive(0), false);
});

test("a process is gone, exited and waiting to be collected, running, or unknown — by /proc, else by ps when asked", () => {
  const asked = [];
  const ps = (letter) => (pid) => {
    asked.push(pid);
    return letter;
  };
  // A live pid, so that kill(pid, 0) answers and the letters decide, as on a POSIX host: on Windows kill alone does.
  const live = process.pid;
  assert.equal(processState(live, { platform: "linux", proc: () => "Z" }), "exited");
  assert.equal(processState(live, { platform: "linux", proc: () => "X" }), "exited");
  assert.equal(processState(live, { platform: "linux", proc: () => "S" }), "running");
  // kill has just found it, so a /proc that does not show it hides it — hidepid, someone else's process — or it
  // exited in between, which the next look's kill catches.
  assert.equal(processState(live, { platform: "linux", proc: () => "" }), "unknown", "hidden from /proc, not gone");
  assert.equal(processState(live, { platform: "linux", proc: () => null, ps: ps("Z") }), "unknown", "no /proc, and ps not asked");
  assert.deepEqual(asked, [], "ps is asked only when the caller says so");
  assert.equal(processState(live, { platform: "linux", proc: () => null, ask: true, ps: ps("Z") }), "exited");
  assert.equal(processState(live, { platform: "linux", proc: () => null, ask: true, ps: ps("S") }), "running");
  assert.equal(processState(live, { platform: "linux", proc: () => null, ask: true, ps: ps("") }), "unknown", "ps does not show what kill found");
  assert.equal(processState(live, { platform: "linux", proc: () => null, ask: true, ps: ps(null) }), "unknown", "ps could not be asked");
  assert.equal(processState(live, { platform: "linux", proc: () => "S", ask: true, ps: ps("Z") }), "running", "/proc, where there is one, decides");
  assert.equal(processState(live, { platform: "win32", proc: () => "Z" }), "running", "on Windows kill(pid, 0) decides");
  assert.equal(processState(DEAD_PID), "gone");
  assert.equal(processState(0), "gone");
  assert.equal(processState(-1), "gone");
  // The hooks judge a lock's holder the same way.
  for (const [letter, alive] of [["Z", false], ["X", false], ["", true], ["S", true], ["R", true], [null, true]]) {
    assert.equal(hookLib.processAlive(live, { platform: "linux", proc: () => letter }), alive, `hooks, letter ${JSON.stringify(letter)}`);
  }
  assert.equal(hookLib.processAlive(live, { platform: "win32", proc: () => "Z" }), true);
  assert.equal(hookLib.processAlive(DEAD_PID), false);
  assert.equal(hookLib.processAlive(0), false);
});

test("the real letters: this process runs; a pid nobody has is not there", { skip: process.platform === "win32" && "no /proc and no ps" }, () => {
  if (process.platform === "linux") {
    assert.match(procStateLetter(process.pid), /^[RS]$/);
    assert.equal(procStateLetter(DEAD_PID), "");
  } else {
    assert.equal(procStateLetter(process.pid), null, "no /proc here");
  }
  assert.match(psStateLetter(process.pid), /^[RS]$/);
  assert.equal(psStateLetter(DEAD_PID), "");
});

test("a child that has exited while this process's loop is held up is a zombie: exited, not alive", { skip: process.platform === "win32" && "Windows has no zombies" }, async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // Nothing collects the child until this loop runs again, so it stays a zombie for as long as this waits.
  const deadline = Date.now() + 10_000;
  let state = processState(child.pid, { ask: true });
  while (state !== "exited" && Date.now() < deadline) state = processState(child.pid, { ask: true });
  assert.equal(state, "exited");
  if (process.platform === "linux") {
    assert.equal(processAlive(child.pid), false, "where /proc tells, a zombie is not alive");
    assert.equal(hookLib.processAlive(child.pid), false);
  }
  await exited;
  assert.equal(processState(child.pid, { ask: true }), "gone", "collected now");
});

test("the hooks' copy of the protocol agrees with the server's on every case", () => {
  assert.equal(hookLib.LOCK_SUFFIX, LOCK_SUFFIX);
  assert.equal(hookLib.LOCK_STALE_MS, LOCK_STALE_MS);
  assert.equal(hookLib.EMPTY_LOCK_GRACE_MS, EMPTY_LOCK_GRACE_MS);
  assert.equal(hookLib.BREAK_LOCK_STALE_MS, BREAK_LOCK_STALE_MS);
  assert.equal(hookLib.lockPathFor("relative/ledger.jsonl"), lockPathFor("relative/ledger.jsonl"));
  const now = 5_000_000;
  const base = { pid: process.pid, host: os.hostname(), token: "t", acquired_at: now - 5 };
  const cases = [
    { holder: base, mtimeMs: now },
    { holder: { ...base, pid: DEAD_PID }, mtimeMs: now },
    { holder: { ...base, acquired_at: now - LOCK_STALE_MS - 1 }, mtimeMs: now },
    { holder: { ...base, host: "elsewhere" }, mtimeMs: now },
    { holder: { ...base, host: "elsewhere", acquired_at: 0 }, mtimeMs: now },
    { holder: null, mtimeMs: now - 1 },
    { holder: null, mtimeMs: now - EMPTY_LOCK_GRACE_MS - 1 },
    { holder: "garbage", mtimeMs: now - 1 },
    { holder: null, mtimeMs: 0, unreadable: true }
  ];
  for (const observed of cases) {
    assert.equal(hookLib.lockIsLive(observed, { now }), lockIsLive(observed, { now }), JSON.stringify(observed));
  }
  const pairs = [
    [{ id: "1:2", holder: { token: "t" }, mtimeMs: 5 }, { id: "1:2", holder: { token: "t" }, mtimeMs: 9 }],
    [{ id: "1:2", holder: { token: "t" }, mtimeMs: 5 }, { id: "1:3", holder: { token: "t" }, mtimeMs: 5 }],
    [{ id: "1:2", holder: null, mtimeMs: 5 }, { id: "1:2", holder: null, mtimeMs: 5 }],
    [{ id: "1:2", holder: null, mtimeMs: 5 }, { id: "1:2", holder: null, mtimeMs: 6 }],
    [{ id: "", holder: null, mtimeMs: 5, unreadable: true }, { id: "", holder: null, mtimeMs: 5 }]
  ];
  for (const [left, right] of pairs) {
    assert.equal(hookLib.sameLock(left, right), sameLock(left, right), JSON.stringify([left, right]));
  }
  assert.deepEqual(pairs.map(([left, right]) => sameLock(left, right)), [true, false, true, false, false]);
});

test("a writer waits out an abandoned lock rather than failing before it goes stale", () => {
  assert.ok(LOCK_TIMEOUT_MS > LOCK_STALE_MS, `${LOCK_TIMEOUT_MS} ms of waiting against ${LOCK_STALE_MS} ms to go stale`);
});

test("an unreadable lock — Windows refusing a file in use — counts as held", () => {
  assert.equal(lockIsLive({ holder: null, mtimeMs: 0, unreadable: true }), true);
});

const DEAD_HOLDER = () => JSON.stringify({ pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() });

for (const [label, read, breakLock] of [
  ["server", (lockPath) => readLock(lockPath), (lockPath, observed) => breakStaleLock(lockPath, observed)],
  ["hooks", (lockPath) => hookLib.readLockSync(lockPath), (lockPath, observed) => hookLib.breakStaleLockSync(lockPath, observed)]
]) {
  test(`${label}: a lock taken afresh after it was judged stale is not broken`, async () => {
    const target = await tempFile();
    const lockPath = lockPathFor(target);
    await fs.writeFile(lockPath, DEAD_HOLDER());
    const observed = await read(lockPath);
    assert.equal(lockIsLive(observed), false, "judged stale");
    // Meanwhile the abandoned lock was cleared and a live writer took a new one.
    await fs.rm(lockPath);
    const fresh = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "fresh", acquired_at: Date.now() });
    await fs.writeFile(lockPath, fresh);
    assert.equal(await breakLock(lockPath, observed), false);
    assert.equal(await fs.readFile(lockPath, "utf8"), fresh, "the fresh lock stands");
    await assert.rejects(fs.stat(`${lockPath}.break`), { code: "ENOENT" }, "the breaker cleans up after itself");
  });

  test(`${label}: a breaker killed mid-break holds the others up only until its own lock goes stale`, async () => {
    const target = await tempFile();
    const lockPath = lockPathFor(target);
    await fs.writeFile(lockPath, DEAD_HOLDER());
    const observed = await read(lockPath);
    await fs.writeFile(`${lockPath}.break`, "");
    assert.equal(await breakLock(lockPath, observed), false, "a young breaker lock means somebody is breaking it");
    const old = new Date(Date.now() - BREAK_LOCK_STALE_MS - 1_000);
    await fs.utimes(`${lockPath}.break`, old, old);
    assert.equal(await breakLock(lockPath, observed), false, "the abandoned breaker is cleared first");
    assert.equal(await breakLock(lockPath, observed), true, "then the stale lock goes");
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  });
}

test("a lock is taken, holds its holder, and is gone after release", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  const holder = JSON.parse(await fs.readFile(lockPathFor(target), "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.host, os.hostname());
  assert.match(holder.token, /^[0-9a-f-]{36}$/);
  await release();
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a second writer waits for the first and then runs", async () => {
  const target = await tempFile();
  const order = [];
  const release = await acquireFileLock(target);
  const waiting = withFileLock(target, async () => order.push("second"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  order.push("first done");
  await release();
  await waiting;
  assert.deepEqual(order, ["first done", "second"]);
});

test("a lock left by a dead process is broken at once", async () => {
  const target = await tempFile();
  await fs.writeFile(lockPathFor(target), JSON.stringify({ pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() }));
  const started = Date.now();
  await withFileLock(target, async () => undefined, { timeoutMs: 2_000 });
  assert.ok(Date.now() - started < 1_000, "nobody should wait for a dead holder");
});

test("an empty lock is broken once its grace has passed, and not before", async () => {
  const target = await tempFile();
  await fs.writeFile(lockPathFor(target), "");
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 100 }), /Timed out/);
  const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 1_000);
  await fs.utimes(lockPathFor(target), old, old);
  await withFileLock(target, async () => undefined, { timeoutMs: 1_000 });
});

test("waiting for a live holder ends in an error that names it", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 120 }), new RegExp(`held by pid ${process.pid}`));
  await release();
});

test("releasing never removes a lock someone else holds now", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  const theirs = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "someone-else", acquired_at: Date.now() });
  await fs.writeFile(lockPathFor(target), theirs);
  await release();
  assert.equal(await fs.readFile(lockPathFor(target), "utf8"), theirs);
});

test("the operation's result and error both come through", async () => {
  const target = await tempFile();
  assert.equal(await withFileLock(target, async () => 42), 42);
  await assert.rejects(withFileLock(target, async () => {
    throw new Error("inside");
  }), /inside/);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" }, "a failed operation still releases");
});

test("the hooks' synchronous lock excludes the server's and is released the same way", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target);
  assert.throws(() => hookLib.withFileLockSync(target, () => "never", { timeoutMs: 100 }), /Timed out/);
  await release();
  assert.equal(hookLib.withFileLockSync(target, () => "ran", { timeoutMs: 1_000 }), "ran");
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a heartbeat keeps a long-held lock live past its staleness bound, from any host's point of view", async () => {
  const target = await tempFile();
  // Beats 16 times per bound: only a stall of most of a second could age it.
  const release = await acquireFileLock(target, { staleMs: 800, heartbeatMs: 50 });
  const first = JSON.parse(await fs.readFile(lockPathFor(target), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const later = await readLock(lockPathFor(target));
  assert.ok(later.holder, "a reader never finds the holder half-rewritten");
  assert.equal(later.holder.token, first.token, "the same holder, rewritten in place");
  assert.ok(later.holder.acquired_at > first.acquired_at, "with a fresh acquired_at");
  // Another host cannot check the pid; the refreshed time is what keeps it held.
  assert.equal(lockIsLive(later, { staleMs: 800, host: "another-host" }), true);
  await assert.rejects(withFileLock(target, async () => undefined, { timeoutMs: 150, staleMs: 800 }), /Timed out/);
  await release();
  await withFileLock(target, async () => undefined, { timeoutMs: 500, staleMs: 800 });
});

test("a heartbeat whose file cannot be closed does not take the process down", async () => {
  const target = await tempFile();
  const realOpen = fs.open;
  let failedCloses = 0;
  // What a network file system can do: report a deferred write error at close.
  fs.open = async (file, flags, ...rest) => {
    const handle = await realOpen(file, flags, ...rest);
    if (flags !== "r+") return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      failedCloses += 1;
      throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
    };
    return handle;
  };
  try {
    const release = await acquireFileLock(target, { heartbeatMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await release();
  } finally {
    fs.open = realOpen;
  }
  assert.ok(failedCloses >= 3, `the beats ran into the failing close: ${failedCloses}`);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("a lock from another host that stopped beating is broken once its bound has passed", async () => {
  const target = await tempFile();
  // A container killed mid-rebuild: its host is not this one and its pid means nothing here.
  await fs.writeFile(lockPathFor(target), JSON.stringify({ pid: process.pid, host: "dead-container", token: "gone", acquired_at: Date.now() - 400 }));
  const started = Date.now();
  await withFileLock(target, async () => undefined, { timeoutMs: 2_000, staleMs: 300 });
  assert.ok(Date.now() - started < 1_000);
});

test("a process that exits while holding a lock removes it on the way out", async () => {
  const target = await tempFile();
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("./file-lock.mjs", import.meta.url).href;
  // What a SIGTERM handler that calls process.exit does: no finally runs.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireFileLock, lockPathFor } = await import(${JSON.stringify(moduleUrl)});
    const fs = await import("node:fs");
    await acquireFileLock(${JSON.stringify(target)}, { heartbeatMs: 1000 });
    if (!fs.existsSync(lockPathFor(${JSON.stringify(target)}))) process.exit(2);
    process.exit(0);
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(fs.stat(lockPathFor(target)), { code: "ENOENT" });
});

test("an exit in the middle of a release still removes the lock, and never one someone else took", async () => {
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("./file-lock.mjs", import.meta.url).href;
  const run = (target, body) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireFileLock, lockPathFor } = await import(${JSON.stringify(moduleUrl)});
    const fs = await import("node:fs");
    const fsp = (await import("node:fs/promises")).default;
    const target = ${JSON.stringify(target)};
    ${body}
  `], { encoding: "utf8" });

  // A SIGTERM handler exits while the release is reading the lock back.
  const releasing = await tempFile();
  const first = run(releasing, `
    const release = await acquireFileLock(target);
    const realOpen = fsp.open;
    fsp.open = async (file, flags, ...rest) => { if (flags === "r") process.exit(0); return realOpen(file, flags, ...rest); };
    await release();
    process.exit(3);
  `);
  assert.equal(first.status, 0, first.stderr);
  await assert.rejects(fs.stat(lockPathFor(releasing)), { code: "ENOENT" });

  // The lock was broken and taken by another process before this one exits.
  const retaken = await tempFile();
  const second = run(retaken, `
    await acquireFileLock(target);
    fs.writeFileSync(lockPathFor(target), JSON.stringify({ pid: 1, host: "elsewhere", token: "theirs", acquired_at: Date.now() }));
    process.exit(0);
  `);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(await fs.readFile(lockPathFor(retaken), "utf8")).token, "theirs");
});

test("a reader racing the heartbeat always finds a whole holder", async () => {
  const target = await tempFile();
  const release = await acquireFileLock(target, { staleMs: 60_000, heartbeatMs: 1 });
  try {
    for (let round = 0; round < 400; round += 1) {
      const seen = await readLock(lockPathFor(target));
      assert.ok(seen?.holder?.token, `round ${round}: ${JSON.stringify(seen)}`);
    }
  } finally {
    await release();
  }
});


test("a lock held for a process's life is taken now or its holder named, never waited for", async () => {
  const target = await tempFile("daemon.json");
  const first = await tryAcquireFileLock(target, { record: { started_at: 123 } });
  assert.equal(typeof first.release, "function");
  const holder = (await readLock(lockPathFor(target))).holder;
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.started_at, 123, "the caller's own fields ride along");
  assert.equal(await first.holds(), true);
  const started = Date.now();
  const second = await tryAcquireFileLock(target);
  assert.ok(Date.now() - started < 500, "a live holder is reported at once");
  assert.equal(second.release, undefined);
  assert.equal(second.observed.holder.token, first.token);
  await first.release();
  assert.equal(await first.holds(), false);
  const third = await tryAcquireFileLock(target);
  assert.equal(await third.holds(), true);
  await third.release();
});

test("a folder the lock has to make gets the mode its owner asks for, and the usual one otherwise", { skip: process.platform === "win32" && "Windows folders have no mode bits" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lock-mode-"));
  // Under a umask of 077 the folder comes out 0700 with the option or without
  // it, and the test would prove nothing: it sets the usual one.
  const umask = process.umask(0o022);
  t.after(() => {
    process.umask(umask);
    return fs.rm(root, { recursive: true, force: true });
  });
  const owned = await tryAcquireFileLock(path.join(root, "run", "daemon-0123456789abcdef.json"), { directoryMode: 0o700 });
  assert.ok(owned.release);
  assert.equal((await fs.stat(path.join(root, "run"))).mode & 0o777, 0o700);
  await owned.release();
  const plain = await tryAcquireFileLock(path.join(root, "state", "tasks.json"));
  assert.equal((await fs.stat(path.join(root, "state"))).mode & 0o777, 0o755);
  await plain.release();
});

test("a daemon's lock: a dead holder's is broken, an empty one in the making is left to its maker", async () => {
  const target = await tempFile("daemon.json");
  await fs.writeFile(lockPathFor(target), JSON.stringify({ pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() }));
  const taken = await tryAcquireFileLock(target);
  assert.equal(typeof taken.release, "function", "a dead holder's lock is taken over");
  await taken.release();

  // Created, not yet written: another daemon between open and write.
  await fs.writeFile(lockPathFor(target), "");
  const young = await tryAcquireFileLock(target);
  assert.equal(young.release, undefined, "a lock this young may be one being made");
  assert.equal(young.observed.holder, null);
  const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 1_000);
  await fs.utimes(lockPathFor(target), old, old);
  const after = await tryAcquireFileLock(target);
  assert.equal(typeof after.release, "function", "one empty for longer than a write takes was abandoned");
  await after.release();
});

test("a stuck holder's lock can be forced, but only while it is the lock observed", async () => {
  const target = await tempFile("daemon.json");
  const stuck = await tryAcquireFileLock(target, { heartbeatMs: 20 });
  const observed = (await tryAcquireFileLock(target)).observed;
  assert.equal(await breakStaleLock(lockPathFor(target), observed), false, "it is live: an ordinary break leaves it");
  assert.equal(await breakStaleLock(lockPathFor(target), observed, { force: true }), true);
  assert.equal(await stuck.holds(), false);
  const next = await tryAcquireFileLock(target);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await next.holds(), true, "the old holder's heartbeat does not write over the new lock");
  assert.equal(await breakStaleLock(lockPathFor(target), observed, { force: true }), false, "a lock taken since is another lock");
  await stuck.release();
  assert.equal(await next.holds(), true, "the old holder's release leaves the new lock alone");
  await next.release();
});

test("a lock that makes its folder names the highest one it made, and none when its folder is there", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lock-made-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "home", "run", "retired-4194305.json");
  const first = await tryAcquireFileLock(target, { directoryMode: 0o700 });
  assert.equal(path.toNamespacedPath(first.madeFolder), path.toNamespacedPath(path.join(root, "home")), "as fs.mkdir names it");
  await first.release();
  const again = await tryAcquireFileLock(target);
  assert.equal(again.madeFolder, undefined, "its folder was there: it made none");
  await again.release();
});

test("the folder a lock made is named also when another process writes the lock first, held or abandoned", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lock-made-lost-"));
  const target = path.join(root, "home", "run", "retired-4194305.json");
  const home = path.toNamespacedPath(path.join(root, "home"));
  // The other process writes its lock between this one's mkdir and its open.
  let theirs;
  const mkdir = fs.mkdir;
  fs.mkdir = async (...args) => {
    const made = await mkdir.apply(fs, args);
    await fs.writeFile(lockPathFor(target), JSON.stringify(theirs));
    return made;
  };
  t.after(() => {
    fs.mkdir = mkdir;
    return fs.rm(root, { recursive: true, force: true });
  });
  theirs = { pid: process.pid, host: os.hostname(), token: "theirs", acquired_at: Date.now() };
  const held = await tryAcquireFileLock(target, { directoryMode: 0o700 });
  assert.equal(held.release, undefined, "the other process holds it");
  assert.equal(path.toNamespacedPath(held.madeFolder), home);
  await fs.rm(path.join(root, "home"), { recursive: true });
  theirs = { pid: DEAD_PID, host: os.hostname(), token: "dead", acquired_at: Date.now() };
  const later = await tryAcquireFileLock(target, { directoryMode: 0o700 });
  assert.equal(typeof later.release, "function", "a dead holder's lock is broken and taken on the next try");
  assert.equal(path.toNamespacedPath(later.madeFolder), home, "the folder the first try made");
  await later.release();
});

test("a lock told to make no folder takes none when its folder is gone, and makes nothing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lock-no-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = path.join(root, "home", "run", "daemon-0123456789abcdef.json");
  assert.deepEqual(await tryAcquireFileLock(missing, { makeDirectory: false }), { observed: null });
  assert.deepEqual(await fs.readdir(root), [], "no folder was made");
  const made = await tryAcquireFileLock(missing);
  assert.ok(made.release, "the usual lock still makes its folder");
  await made.release();
});

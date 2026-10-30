import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appendJsonLines, atomicAppendFile, atomicWriteFile, atomicWriteJson, flushFile, keepMode, truncateTornTail, withExclusiveFile } from "./atomic-files.mjs";

/** A temp directory removed when the test ends. */
async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("atomic writes replace complete files", async (t) => {
  const root = await tempRoot(t, "ai-dev-atomic-");
  const file = path.join(root, "state.json");
  await atomicWriteJson(file, { version: 1 });
  await atomicWriteJson(file, { version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 2 });
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("queued appends do not lose concurrent updates", async (t) => {
  const root = await tempRoot(t, "ai-dev-append-");
  const file = path.join(root, "events.log");
  await atomicWriteFile(file, "");
  await Promise.all(Array.from({ length: 20 }, (_, index) => atomicAppendFile(file, `${index}\n`)));
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  assert.deepEqual(new Set(lines), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

// --- Several processes at once ---------------------
//
// Every MCP client runs its own server process and the agent hooks run as
// processes too, so these tests write from separate processes, the way a user's
// machine does. Before the cross-process lock three writers kept 208-223 lines
// of 600 and the JSON stores 202-222 updates of 600.

const atomicFilesUrl = new URL("./atomic-files.mjs", import.meta.url).href;
const hookLibUrl = new URL("../../hooks/lib.mjs", import.meta.url).href;

/** Run `source` (an ES module body) in a fresh Node process; resolves with its exit code. */
function runWriter(source, args, { env = {} } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, done };
}

const serverWriter = `
const [target, writer, count] = process.argv.slice(1);
const { appendJsonLines } = await import(${JSON.stringify(atomicFilesUrl)});
for (let i = 0; i < Number(count); i += 1) await appendJsonLines(target, JSON.stringify({ writer, i }) + "\\n");
`;

const hookWriter = `
const [writer, count] = process.argv.slice(1);
const { appendUsageEvents, usageLedgerPath } = await import(${JSON.stringify(hookLibUrl)});
for (let i = 0; i < Number(count); i += 1) appendUsageEvents([{ writer, i }]);
`;

async function readRecords(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const byWriter = {};
  let broken = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      (byWriter[record.writer] ??= []).push(record.i);
    } catch {
      broken += 1;
    }
  }
  return { byWriter, broken };
}

const inOrder = (values) => values.every((value, index) => value === index);

test("three processes appending 200 lines each keep all 600", async (t) => {
  const root = await tempRoot(t, "ai-dev-multi-append-");
  const file = path.join(root, "usage", "events.jsonl");
  const writers = ["a", "b", "c"].map((name) => runWriter(serverWriter, [file, name, "200"]));
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0);
  for (const name of ["a", "b", "c"]) {
    assert.equal(byWriter[name]?.length, 200, `writer ${name}`);
    assert.ok(inOrder(byWriter[name]), `writer ${name} kept its own order`);
  }
  await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" }, "no lock is left behind");
});

test("a hook and two servers appending to one ledger keep every line", async (t) => {
  const stateRoot = await tempRoot(t, "ai-dev-hook-append-");
  const file = path.join(stateRoot, "usage", "events.jsonl");
  const writers = [
    runWriter(serverWriter, [file, "server-1", "150"]),
    runWriter(serverWriter, [file, "server-2", "150"]),
    runWriter(hookWriter, ["hook", "150"], { env: { AI_DEV_STATE_ROOT: stateRoot } })
  ];
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(byWriter).map(([name, values]) => [name, values.length])), { hook: 150, "server-1": 150, "server-2": 150 });
});

// What this shows is the dead-pid rule under load: a writer killed at any point,
// lock held or not, never holds the others up. A torn line cannot come from it —
// each record is one write(2), which a signal does not split — so the torn-tail
// repair a crash between writes needs is tested on its own below.
test("a writer killed while the others append does not hold them up, and what it wrote is whole", async (t) => {
  if (process.platform === "win32") {
    t.skip("SIGKILL timing is POSIX-specific; the lock's dead-pid rule is covered by file-lock.test.mjs");
    return;
  }
  const root = await tempRoot(t, "ai-dev-kill-append-");
  const file = path.join(root, "events.jsonl");
  const survivors = [runWriter(serverWriter, [file, "a", "300"]), runWriter(serverWriter, [file, "b", "300"])];
  const victim = runWriter(serverWriter, [file, "victim", "100000"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  victim.child.kill("SIGKILL");
  const killed = await victim.done;
  assert.equal(killed.signal, "SIGKILL");
  const results = await Promise.all(survivors.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
  const { byWriter, broken } = await readRecords(file);
  assert.equal(broken, 0, "no line is torn");
  assert.equal(byWriter.a.length, 300);
  assert.equal(byWriter.b.length, 300);
  assert.ok(inOrder(byWriter.victim ?? []), "what the killed writer finished is intact and in order");
});

test("read-modify-write from three processes loses no update", async (t) => {
  const root = await tempRoot(t, "ai-dev-multi-rmw-");
  const file = path.join(root, "store.json");
  const updater = `
const [target, writer, count] = process.argv.slice(1);
const fs = await import("node:fs/promises");
const { atomicWriteJson, withExclusiveFile } = await import(${JSON.stringify(atomicFilesUrl)});
for (let i = 0; i < Number(count); i += 1) {
  await withExclusiveFile(target, async () => {
    let store = { events: [] };
    try { store = JSON.parse(await fs.readFile(target, "utf8")); } catch {}
    store.events.push(writer + ":" + i);
    await atomicWriteJson(target, store);
  });
}
`;
  const writers = ["a", "b", "c"].map((name) => runWriter(updater, [file, name, "100"]));
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0], results.map((result) => result.stderr).join("\n"));
  const store = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(store.events.length, 300);
  assert.equal(new Set(store.events).size, 300);
});

test("a rewrite under the lock and an append queued meanwhile do not wait on each other", async (t) => {
  // Queue first, lock second deadlocked: the append held the queue waiting for
  // the lock, the rewrite held the lock waiting for the queue, until the append
  // judged the lock stale (30 s) and the rewrite then dropped its line.
  const root = await tempRoot(t, "ai-dev-rotate-");
  const ledger = path.join(root, "events.jsonl");
  await fs.writeFile(ledger, Array.from({ length: 30 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n", "utf8");
  const started = Date.now();
  let holding;
  const held = new Promise((resolve) => { holding = resolve; });
  const rotation = withExclusiveFile(ledger, async () => {
    holding();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kept = (await fs.readFile(ledger, "utf8")).split("\n").filter(Boolean).slice(-10);
    await atomicWriteFile(ledger, `${kept.join("\n")}\n`);
  });
  // Queued while the rewrite holds the lock, whatever the load: 2 ms after it began was sometimes before.
  await held;
  const append = appendJsonLines(ledger, `${JSON.stringify({ late: true })}\n`);
  await Promise.all([rotation, append]);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  const lines = (await fs.readFile(ledger, "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 11, "ten kept, and the late line after them");
  assert.deepEqual(JSON.parse(lines.at(-1)), { late: true });
});

test("a torn last record is cut off before the next append, and only in JSONL", async (t) => {
  const root = await tempRoot(t, "ai-dev-torn-");
  const ledger = path.join(root, "events.jsonl");
  await fs.writeFile(ledger, '{"ok":1}\n{"half":', "utf8");
  await appendJsonLines(ledger, '{"ok":2}\n');
  assert.equal(await fs.readFile(ledger, "utf8"), '{"ok":1}\n{"ok":2}\n');

  const note = path.join(root, "note.md");
  await fs.writeFile(note, "# Note\nlast line without a newline", "utf8");
  await atomicAppendFile(note, "\nappended\n");
  assert.equal(await fs.readFile(note, "utf8"), "# Note\nlast line without a newline\nappended\n", "a human-edited note is never cut");

  const noNewlineAtAll = path.join(root, "only-torn.jsonl");
  await fs.writeFile(noNewlineAtAll, '{"half":', "utf8");
  assert.equal(await truncateTornTail(noNewlineAtAll), 8);
  assert.equal(await fs.readFile(noNewlineAtAll, "utf8"), "");
  assert.equal(await truncateTornTail(path.join(root, "missing.jsonl")), 0);
  await assert.rejects(appendJsonLines(ledger, '{"no":"newline"}'), /complete records/);
});

test("the hooks cut a torn record the same way", async (t) => {
  const root = await tempRoot(t, "ai-dev-hook-torn-");
  const ledger = path.join(root, "events.jsonl");
  await fs.writeFile(ledger, `{"ok":1}\n${"x".repeat(70 * 1024)}`, "utf8");
  const { truncateTornTailSync } = await import(hookLibUrl);
  assert.equal(truncateTornTailSync(ledger), 70 * 1024, "a torn tail longer than one read chunk");
  assert.equal(await fs.readFile(ledger, "utf8"), '{"ok":1}\n');
  assert.equal(await truncateTornTail(ledger), 0);
});

test("a file is flushed where Node allows it: the permission model's refusal of fsync fails no write, any other failure does", async (t) => {
  const handle = (error) => ({ sync: async () => { if (error) throw error; } });
  await flushFile(handle(null));
  await flushFile(handle(Object.assign(new Error("fsync API is disabled when Permission Model is enabled."), { code: "ERR_ACCESS_DENIED" })));
  await assert.rejects(flushFile(handle(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }))), /EIO/);
  // Under --permission, where Node refuses a FileHandle's sync() (24.22, 26.12) and chmod() (22.23, 24.15 … 24.22,
  // 25.9, 26.0, 26.12), every write the server makes goes through all the same — but for a copy root hands to the
  // config's owner, which needs the fchown it refuses: a write and an append; a client's config that is
  // new (Cursor's), one whose copy needs a chmod under a umask that clears a read or write bit (Gemini's, 0666), and one
  // of its owner's alone (Claude Code's, 0600), each added to, changed and cleaned, none left wider than it was; and a
  // backup. A umask hides a copy widened by the bits it clears, so the scenario runs twice:
  // under 0002, which clears a bit of 0666 and shows a copy widened by the group's write bit, and under 0000, which
  // shows one widened by the others'. The modes say so only where a new file takes its mode from the
  // umask, which is checked after the writes: a default ACL or a filesystem that ignores modes gives another.
  const umask = process.umask(0o002);
  t.after(() => process.umask(umask));
  for (const mask of [0o002, 0o000]) {
    process.umask(mask);
    const root = await fs.realpath(await tempRoot(t, "ai-dev-atomic-permission-"));
    await fs.mkdir(path.join(root, ".cursor"));
    await fs.mkdir(path.join(root, ".gemini"));
    await fs.writeFile(path.join(root, ".gemini", "settings.json"), "{}\n", { mode: 0o666 });
    await fs.chmod(path.join(root, ".gemini", "settings.json"), 0o666);
    await fs.writeFile(path.join(root, ".claude.json"), "{}\n", { mode: 0o600 });
    await fs.chmod(path.join(root, ".claude.json"), 0o600);
    await fs.mkdir(path.join(root, "vault"));
    await fs.mkdir(path.join(root, "runtime", "state"), { recursive: true });
    await fs.writeFile(path.join(root, "vault", "note.md"), "# Note\n");
    const module = (name) => JSON.stringify(new URL(`./${name}`, import.meta.url).href);
    const at = (...parts) => JSON.stringify(path.join(root, ...parts));
    const script = `const { appendJsonLines, atomicWriteFile } = await import(${module("atomic-files.mjs")});
const { discoverClients, installServer, removeServer } = await import(${module("mcp-clients.mjs")});
const { createBackup } = await import(${module("backup-archive.mjs")});
await atomicWriteFile(${at("state.json")}, "{}\\n");
await appendJsonLines(${at("ledger.jsonl")}, "{}\\n");
const targets = (await discoverClients({ home: ${JSON.stringify(root)}, env: {}, platform: process.platform })).filter((target) => ["claude-code", "cursor", "gemini"].includes(target.client));
const statuses = [];
for (const file of ["/a.mjs", "/b.mjs"]) statuses.push((await installServer({ targets, entryFor: () => ({ command: "node", args: [file] }) })).map((row) => row.status));
statuses.push((await removeServer({ targets })).map((row) => row.status));
const backup = await createBackup({ contentRoot: ${at("vault")}, runtimeRoot: ${at("runtime")}, destination: ${at("backups")}, now: new Date("2026-10-19T12:00:00Z") });
console.log(JSON.stringify({ statuses, files: backup.files }));`;
    const run = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", `--allow-fs-write=${root}`, "--input-type=module", "-e", script], { encoding: "utf8" });
    const named = `umask ${mask.toString(8).padStart(4, "0")}`;
    assert.equal(run.status, 0, `${named}: ${run.stderr}`);
    assert.deepEqual([await fs.readFile(path.join(root, "state.json"), "utf8"), await fs.readFile(path.join(root, "ledger.jsonl"), "utf8")], ["{}\n", "{}\n"], named);
    assert.deepEqual(JSON.parse(run.stdout), { statuses: [["added", "added", "added"], ["updated", "updated", "updated"], ["removed", "removed", "removed"]], files: 1 }, `${named}: ${run.stdout}`);
    if (process.platform !== "win32") {
      const mode = async (...parts) => ((await fs.stat(path.join(root, ...parts))).mode & 0o777).toString(8);
      await fs.writeFile(path.join(root, "umask-probe"), "", { mode: 0o666 });
      assert.equal(await mode("umask-probe"), (0o666 & ~mask).toString(8), `a file made here with 666 gets ${(0o666 & ~mask).toString(8)}, as ${named} gives: a default ACL or a filesystem that ignores modes gives another`);
      assert.equal(await mode(".claude.json"), "600", `${named}: a config of its owner's alone stays so`);
      assert.equal((await fs.stat(path.join(root, ".gemini", "settings.json"))).mode & ~0o666 & 0o7777, 0, `${named}: no wider than it was`);
    }
  }
});

test("a copy is given its file's mode where Node allows it: a mode it has is not set again, the permission model's refusal fails no write, any other failure does", async () => {
  const handle = (mode, error) => {
    const set = [];
    return { set, stat: async () => ({ mode: 0o100000 | mode }), chmod: async (to) => { set.push(to); if (error) throw error; } };
  };
  const same = handle(0o600);
  await keepMode(same, 0o600);
  assert.deepEqual(same.set, [], "the mode open() gave is the one the file had");
  const other = handle(0o644);
  await keepMode(other, 0o664);
  assert.deepEqual(other.set, [0o664]);
  await keepMode(handle(0o644, Object.assign(new Error("fchmod API is disabled when Permission Model is enabled."), { code: "ERR_ACCESS_DENIED" })), 0o664);
  await assert.rejects(keepMode(handle(0o644, Object.assign(new Error("EPERM: operation not permitted, fchmod"), { code: "EPERM" })), 0o664), /EPERM/);
});

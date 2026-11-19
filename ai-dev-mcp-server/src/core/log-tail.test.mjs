import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_TAIL_LINES, resolveLogFile, tailLines } from "./log-tail.mjs";

async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-log-tail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a log is named by its file in the logs folder, and nothing outside it can be", () => {
  const logs = path.join(path.sep, "home", "me", ".ai-dev", "logs");
  assert.deepEqual(resolveLogFile(logs), { log: "daemon", file: path.join(logs, "daemon.log") });
  assert.equal(resolveLogFile(logs, "daemon.1").file, path.join(logs, "daemon.log.1"));
  assert.equal(resolveLogFile(logs, "daemon.log").file, path.join(logs, "daemon.log"));
  assert.equal(resolveLogFile(logs, "daemon.log.1").file, path.join(logs, "daemon.log.1"));
  for (const name of ["../secret", "..", "a/b", "a\\b", "/etc/passwd", ".hidden", `x${"y".repeat(80)}`]) {
    assert.throws(() => resolveLogFile(logs, name), /is not a log name/, name);
  }
});

test("the last lines come from the file's end, whole, and say whether earlier ones exist", async (t) => {
  const root = await folder(t);
  const file = path.join(root, "daemon.log");
  assert.deepEqual(await tailLines(file), { exists: false, size: 0, lines: [], truncated: false });

  await fs.writeFile(file, "one\ntwo\nthree\n");
  assert.deepEqual(await tailLines(file, { lines: 2 }), { exists: true, size: 14, lines: ["two", "three"], truncated: true });
  assert.deepEqual((await tailLines(file, { lines: 5 })).lines, ["one", "two", "three"]);
  assert.equal((await tailLines(file, { lines: 5 })).truncated, false);

  // Lines longer than a chunk, and characters a chunk's edge would cut.
  const long = Array.from({ length: 300 }, (_, index) => `${index} ${"ёж🦔".repeat(500)}`);
  await fs.writeFile(file, `${long.join("\n")}\n`);
  const tail = await tailLines(file, { lines: 7 });
  assert.deepEqual(tail.lines, long.slice(-7));
  assert.ok(tail.lines.every((line) => !line.includes("�")));
  assert.equal(tail.truncated, true);

  // Without a final newline the last line is still a line; CRLF is one break.
  await fs.writeFile(file, "a\r\nb\r\nc");
  assert.deepEqual((await tailLines(file, { lines: 2 })).lines, ["b", "c"]);
});

test("the number of lines is bounded both ways", async (t) => {
  const root = await folder(t);
  const file = path.join(root, "daemon.log");
  await fs.writeFile(file, `${Array.from({ length: MAX_TAIL_LINES + 50 }, (_, index) => `line ${index}`).join("\n")}\n`);
  assert.equal((await tailLines(file, { lines: 100_000 })).lines.length, MAX_TAIL_LINES);
  assert.equal((await tailLines(file, { lines: 0 })).lines.length, 200, "0 is not a request for nothing: the default");
  assert.equal((await tailLines(file, { lines: -5 })).lines.length, 1);
});

test("a log that is a link to another file is refused, not followed", { skip: process.platform === "win32" && "symbolic links need privileges on Windows" }, async (t) => {
  const root = await folder(t);
  const logs = path.join(root, "logs");
  await fs.mkdir(logs);
  const secret = path.join(root, "secret.txt");
  await fs.writeFile(secret, "TOP SECRET LINE\n");
  await fs.symlink(secret, path.join(logs, "linked.log"));
  const { file } = resolveLogFile(logs, "linked");
  await assert.rejects(tailLines(file, { links: false }), /linked\.log is a link: only the logs folder's own files are read/);
  assert.deepEqual((await tailLines(file)).lines, ["TOP SECRET LINE"], "a caller that allows links reads through them, as before");
  assert.equal((await tailLines(path.join(logs, "missing.log"), { links: false })).exists, false);
});

test("a log that is a second name for a file elsewhere — a hard link — is refused too", async (t) => {
  const root = await folder(t);
  const logs = path.join(root, "logs");
  await fs.mkdir(logs);
  const secret = path.join(root, "secret.txt");
  await fs.writeFile(secret, "TOP SECRET LINE\n");
  try {
    await fs.link(secret, path.join(logs, "hard.log"));
  } catch (error) {
    return t.skip(`no hard links here: ${error.code}`);
  }
  const { file } = resolveLogFile(logs, "hard");
  await assert.rejects(tailLines(file, { links: false }), /hard\.log has another name elsewhere \(a hard link\): only the logs folder's own files are read/);
  await fs.writeFile(path.join(logs, "own.log"), "one\ntwo\n");
  assert.deepEqual((await tailLines(resolveLogFile(logs, "own").file, { links: false })).lines, ["one", "two"], "a log of its own is read");
});

test("a log is read only as the file looked at: one replaced meanwhile, a folder and a FIFO are refused for what they are, and nothing waits", async (t) => {
  const root = await folder(t);
  const logs = path.join(root, "logs");
  await fs.mkdir(logs);
  // Replaced between the look and the open — where no O_NOFOLLOW stops a link, as on Windows, so is a link.
  const swapped = path.join(logs, "swapped.log");
  await fs.writeFile(swapped, "harmless\n");
  const lstat = fs.lstat;
  fs.lstat = async (...args) => {
    const seen = await lstat.apply(fs, args);
    if (args[0] === swapped) {
      // Another file put in its place in one step, as a link would be.
      await fs.writeFile(path.join(root, "secret.txt"), "TOP SECRET LINE\n");
      await fs.rename(path.join(root, "secret.txt"), swapped);
    }
    return seen;
  };
  try {
    await assert.rejects(tailLines(swapped, { links: false }), /swapped\.log was replaced while it was opened/);
  } finally {
    fs.lstat = lstat;
  }
  await fs.mkdir(path.join(logs, "folder.log"));
  await assert.rejects(tailLines(path.join(logs, "folder.log"), { links: false }), /folder\.log is a folder: only the logs folder's own files are read/);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(logs, "pipe.log")]);
    const started = Date.now();
    await assert.rejects(tailLines(path.join(logs, "pipe.log"), { links: false }), /pipe\.log is not a plain file/);
    assert.ok(Date.now() - started < 2000, "refused at once, not waited on");
  }
});

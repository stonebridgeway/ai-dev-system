import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";

const writeQueues = new Map();

/*
 * Two layers order writers: this in-process queue, and the cross-process lock
 * (`file-lock.mjs`). They are always taken lock first, queue second. The other
 * way round deadlocks: an append that sat in the queue waiting for the lock,
 * while the lock's holder — a ledger rotation — waited in the queue behind it,
 * judged the lock stale after 30 s and wrote its line, which the rotation's
 * rewrite then dropped.
 */
function queueFor(filePath, operation) {
  const key = path.resolve(filePath).toLowerCase();
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}

async function replaceFile(tempPath, targetPath) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EPERM", "EEXIST"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  const backupPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.bak`;
  let movedOriginal = false;
  try {
    try {
      await fs.rename(targetPath, backupPath);
      movedOriginal = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(tempPath, targetPath);
    if (movedOriginal) await fs.unlink(backupPath).catch(() => undefined);
  } catch (error) {
    if (movedOriginal) {
      await fs.rename(backupPath, targetPath).catch(() => undefined);
    }
    throw lastError ?? error;
  }
}

/**
 * Rename a finished temp file over its target, with the retries Windows needs
 * while another process holds the target open. For writers that check the
 * target between writing the temp file and replacing it, as the MCP client
 * configuration writer does (`mcp-clients.mjs`).
 *
 * @param {string} tempPath - A complete file in the target's directory.
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
export async function renameOver(tempPath, targetPath) {
  await replaceFile(tempPath, targetPath);
}

/**
 * Flush an open file to disk. Node's permission model refuses a FileHandle's
 * sync() — of the x.y.0 releases measured, 24.22 and 26.12; 22.16 … 22.23,
 * 24.0 … 24.21, 25.0, 25.9 and 26.0 allow it — with "fsync API is disabled
 * when Permission Model is enabled." (`ERR_ACCESS_DENIED`), and no flag allows
 * it; there the write goes on unflushed rather than not at all. Any other
 * failure is the write's.
 *
 * @param {import("node:fs/promises").FileHandle} handle
 * @returns {Promise<void>}
 */
export async function flushFile(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (error?.code !== "ERR_ACCESS_DENIED") throw error;
  }
}

/**
 * Give a file opened with `mode` that mode unless it has it already: the copy
 * that takes a file's place keeps that file's mode. Node's permission model
 * refuses a FileHandle's chmod() — of the x.y.0 releases measured, 22.23,
 * 24.15 … 24.22, 25.9, 26.0 and 26.12 (22.16 … 22.22, 24.0 … 24.14 and 25.0
 * allow it). Where it is refused, the copy is left with the mode open() gave
 * it, the file's, which umask or a default ACL only narrows, rather than fail
 * the write. Any other failure is the write's.
 *
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {number} mode
 * @returns {Promise<void>}
 */
export async function keepMode(handle, mode) {
  if (((await handle.stat()).mode & 0o7777) === mode) return;
  try {
    await handle.chmod(mode);
  } catch (error) {
    if (error?.code !== "ERR_ACCESS_DENIED") throw error;
  }
}

/**
 * Write a file atomically: content goes to a unique temp file in the target
 * directory, is fsync'd ({@link flushFile}), then renamed over the destination. Concurrent writes to
 * the same path are serialised through an in-process queue, and rename retries
 * cover transient Windows EACCES/EPERM/EEXIST locking.
 *
 * @param {string} filePath - Destination path (created recursively if needed).
 * @param {string | NodeJS.ArrayBufferView} data - File contents.
 * @param {(import("node:fs").ObjectEncodingOptions & { mode?: number }) | BufferEncoding} [options="utf8"] - Encoding or write options passed to `FileHandle.writeFile`; `mode` is the new file's.
 * @returns {Promise<string>} Absolute path that was written.
 */
export async function atomicWriteFile(filePath, data, options = "utf8") {
  return queueFor(filePath, async () => {
    const absolute = path.resolve(filePath);
    const directory = path.dirname(absolute);
    await fs.mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await fs.open(tempPath, "wx", typeof options === "object" && options?.mode !== undefined ? options.mode : 0o666);
      await handle.writeFile(data, options);
      await flushFile(handle);
      await handle.close();
      handle = null;
      await replaceFile(tempPath, absolute);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
    }
    return absolute;
  });
}

/**
 * Serialise a value to pretty JSON (trailing newline) and write it atomically.
 *
 * @param {string} filePath - Destination path.
 * @param {unknown} value - JSON-serialisable value.
 * @param {{ spaces?: number }} [options] - `JSON.stringify` indent width.
 * @returns {Promise<string>} Absolute path that was written.
 */
export async function atomicWriteJson(filePath, value, { spaces = 2 } = {}) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, spaces)}\n`, "utf8");
}

function toBuffer(data, options) {
  if (typeof data !== "string") return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const encoding = typeof options === "string" ? options : options?.encoding || "utf8";
  return Buffer.from(data, encoding);
}

/**
 * Append to a file so that concurrent writers in other processes lose nothing.
 *
 * The append is one `write` on a descriptor opened with `O_APPEND`, made under
 * the cross-process lock for the file (`file-lock.mjs`). The previous version
 * read the whole file and renamed `old + new` over it, which kept one writer's
 * lines and dropped the others': three processes appending 200 lines each kept
 * about 210. A missing target is created.
 *
 * Nothing already in the file is touched, so this is safe for human-edited
 * Markdown. For JSONL ledgers use {@link appendJsonLines}, which also drops a
 * record torn by a killed writer.
 *
 * @param {string} filePath - Destination path.
 * @param {string | NodeJS.ArrayBufferView} data - Content to append.
 * @param {import("node:fs").ObjectEncodingOptions | BufferEncoding} [options="utf8"] - Encoding of `data` when it is a string.
 * @returns {Promise<string>} Absolute path that was written.
 */
export async function atomicAppendFile(filePath, data, options = "utf8") {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  return withFileLock(absolute, () => queueFor(absolute, () => appendUnderLock(absolute, toBuffer(data, options), { dropTornTail: false })));
}

/**
 * Append newline-terminated records (JSONL) to a ledger several processes write.
 *
 * Same guarantees as {@link atomicAppendFile}, plus one: a last line without
 * its newline is a record whose writer was killed mid-write, and it is cut off
 * before the new records go in, so a crash costs that one record rather than
 * gluing it to the next one and breaking both. `hooks/lib.mjs` appends to the
 * same ledgers with a synchronous copy of this (AGENTS.md, rule 3).
 *
 * @param {string} filePath - Destination path.
 * @param {string} text - One or more records, each ending in `\n`.
 * @returns {Promise<string>} Absolute path that was written.
 */
export async function appendJsonLines(filePath, text) {
  const absolute = path.resolve(filePath);
  const payload = String(text ?? "");
  if (payload && !payload.endsWith("\n")) throw new Error("appendJsonLines takes complete records, each ending in a newline.");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  return withFileLock(absolute, () => queueFor(absolute, () => appendUnderLock(absolute, Buffer.from(payload, "utf8"), { dropTornTail: true })));
}

async function appendUnderLock(absolute, buffer, { dropTornTail }) {
  if (dropTornTail) await truncateTornTail(absolute);
  const handle = await fs.open(absolute, "a");
  try {
    if (buffer.length) await handle.write(buffer);
    await flushFile(handle);
  } finally {
    await handle.close();
  }
  return absolute;
}

/**
 * Cut a trailing partial line — one without its newline — off a JSONL file.
 *
 * Called under the file's lock. A writer that does not take it — a 2.x hook
 * still installed in some repository — appends each record with one write(2),
 * which no reader sees half done, so what this cuts is a record a crash left
 * unfinished, not one being written.
 *
 * @param {string} filePath
 * @returns {Promise<number>} bytes removed
 */
export async function truncateTornTail(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r+");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        await handle.truncate(start + newline + 1);
        return size - (start + newline + 1);
      }
      end = start;
    }
    await handle.truncate(0);
    return size;
  } finally {
    await handle.close();
  }
}

/**
 * Read, change and rewrite a file that other processes rewrite too.
 *
 * Holds the cross-process lock for `filePath` across the read and the atomic
 * rename, so two writers cannot both read the old content and lose one of
 * their changes — the JSON stores (instincts, skill outcomes, pilots, task
 * records) lost two updates in three that way. Inside,
 * write with `atomicWriteFile`/`atomicWriteJson`: they queue after the lock, as
 * the appends do, so they cannot wait on a writer that waits on this lock.
 *
 * @template T
 * @param {string} filePath - The file to update.
 * @param {() => Promise<T>} update - Reads, decides and writes; runs under the lock.
 * @param {{ timeoutMs?: number }} [options] - `timeoutMs`: how long to wait for the lock (the lock's own default otherwise).
 * @returns {Promise<T>}
 */
export async function withExclusiveFile(filePath, update, { timeoutMs } = {}) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  return withFileLock(absolute, update, timeoutMs === undefined ? {} : { timeoutMs });
}

/**
 * Write a file atomically only when its content differs from `data`, avoiding
 * spurious mtime churn for generated artifacts.
 *
 * @param {string} filePath - Destination path.
 * @param {string} data - Desired content (compared verbatim against the current file).
 * @param {BufferEncoding} [options="utf8"] - Encoding used to read the current file.
 * @returns {Promise<{ path: string, changed: boolean }>} Absolute path and whether a write happened.
 */
export async function atomicWriteIfChanged(filePath, data, options = "utf8") {
  try {
    const current = await fs.readFile(filePath, options);
    if (current === data) return { path: path.resolve(filePath), changed: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWriteFile(filePath, data, options);
  return { path: path.resolve(filePath), changed: true };
}

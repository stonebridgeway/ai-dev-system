import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const writeQueues = new Map();

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
      handle = await fs.open(tempPath, "wx");
      await handle.writeFile(data, options);
      await handle.sync();
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

export async function atomicWriteJson(filePath, value, { spaces = 2 } = {}) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, spaces)}\n`, "utf8");
}

export async function atomicAppendFile(filePath, data, options = "utf8") {
  return queueFor(filePath, async () => {
    let current = "";
    try {
      current = await fs.readFile(filePath, options);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const absolute = path.resolve(filePath);
    const directory = path.dirname(absolute);
    await fs.mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await fs.open(tempPath, "wx");
      await handle.writeFile(`${current}${data}`, options);
      await handle.sync();
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

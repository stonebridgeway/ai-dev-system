import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function asFilePath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  const text = String(value || "");
  return text.startsWith("file:") ? fileURLToPath(text) : text;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function canonicalExecutablePath(value) {
  const resolved = path.resolve(asFilePath(value));
  const canonical = await fs.realpath(resolved).catch(() => resolved);
  return comparablePath(canonical);
}

export async function isDirectExecution(moduleUrl, argvEntry = process.argv[1]) {
  if (!argvEntry) return false;
  const [entryPath, modulePath] = await Promise.all([
    canonicalExecutablePath(argvEntry),
    canonicalExecutablePath(moduleUrl)
  ]);
  return entryPath === modulePath;
}

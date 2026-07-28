import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicAppendFile, atomicWriteFile, atomicWriteJson } from "./atomic-files.mjs";

test("atomic writes replace complete files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-atomic-"));
  const file = path.join(root, "state.json");
  await atomicWriteJson(file, { version: 1 });
  await atomicWriteJson(file, { version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 2 });
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("queued appends do not lose concurrent updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-append-"));
  const file = path.join(root, "events.log");
  await atomicWriteFile(file, "");
  await Promise.all(Array.from({ length: 20 }, (_, index) => atomicAppendFile(file, `${index}\n`)));
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  assert.deepEqual(new Set(lines), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

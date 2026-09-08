import assert from "node:assert/strict";
import test from "node:test";
import { execFileWithInput } from "./input-process-runner.mjs";

test("stdin subprocess capture rejects bounded output", async () => {
  await assert.rejects(
    execFileWithInput(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096))"],
      "",
      { cwd: process.cwd(), maxOutputBytes: 1024, timeoutMs: 10000 }
    ),
    /output exceeded 1024 bytes/
  );
});

test("stdin subprocess capture terminates on timeout", async () => {
  await assert.rejects(
    execFileWithInput(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      "",
      { cwd: process.cwd(), timeoutMs: 50 }
    ),
    /timed out after 50ms/
  );
});

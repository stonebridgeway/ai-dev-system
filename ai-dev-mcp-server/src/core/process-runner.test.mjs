import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSpawnEnvironment,
  resolveSpawnInvocation,
  runProcess
} from "./process-runner.mjs";

test("direct commands keep argv execution without a shell", async () => {
  const invocation = await resolveSpawnInvocation(process.execPath, ["--version"]);
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.adapter, "direct");
  const result = await runProcess({
    executable: process.execPath,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 10000
  });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /^v\d+/);
});

test("Windows package-manager shims resolve to a Node entrypoint", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-pnpm-"));
  const shim = path.join(root, "bin", "fallback", "pnpm.cmd");
  const entrypoint = path.join(root, "node", "node_modules", "pnpm", "bin", "pnpm.mjs");
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(shim, "@echo off\r\n", "utf8");
  await fs.writeFile(entrypoint, "process.exit(0);\n", "utf8");
  try {
    const invocation = await resolveSpawnInvocation(shim, ["run", "dev"]);
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.packageManagerEntrypoint, entrypoint);
    assert.deepEqual(invocation.args.slice(1), ["run", "dev"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows npm quality commands can use the bundled pnpm entrypoint", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-npm-fallback-"));
  const shim = path.join(root, "bin", "fallback", "npm.cmd");
  const entrypoint = path.join(root, "node", "node_modules", "pnpm", "bin", "pnpm.mjs");
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(shim, "@echo off\r\n", "utf8");
  await fs.writeFile(entrypoint, "process.exit(0);\n", "utf8");
  try {
    const invocation = await resolveSpawnInvocation(shim, ["run", "test"]);
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.adapter, "npm-via-pnpm-node-entrypoint");
    assert.equal(invocation.packageManagerEntrypoint, entrypoint);
    assert.deepEqual(invocation.args.slice(1), ["run", "test"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pnpm adapters expose bundled Node and disable dependency auto-install", () => {
  const environment = buildSpawnEnvironment(
    { adapter: "npm-via-pnpm-node-entrypoint" },
    { PATH: "C:\\project-bin" }
  );
  assert.equal(
    environment.PATH.split(path.delimiter)[0],
    path.dirname(process.execPath)
  );
  assert.equal(environment.pnpm_config_verify_deps_before_run, "false");
});

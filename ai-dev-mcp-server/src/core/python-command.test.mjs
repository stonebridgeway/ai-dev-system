import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledPythonPath, probePython, resolvePythonCommand } from "./python-command.mjs";

const nothing = () => false;

test("without AI_DEV_PYTHON or a bundled runtime, each platform gets the name its installers provide", () => {
  assert.equal(resolvePythonCommand({ env: {}, platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", exists: nothing }), "python");
  assert.equal(resolvePythonCommand({ env: {}, platform: "darwin", execPath: "/usr/local/bin/node", exists: nothing }), "python3");
  assert.equal(resolvePythonCommand({ env: {}, platform: "linux", execPath: "/usr/bin/node", exists: nothing }), "python3");
});

test("AI_DEV_PYTHON wins, and a blank one counts as unset", () => {
  assert.equal(resolvePythonCommand({ env: { AI_DEV_PYTHON: "C:\\Python312\\python.exe" }, platform: "win32", exists: nothing }), "C:\\Python312\\python.exe");
  assert.equal(resolvePythonCommand({ env: { AI_DEV_PYTHON: "  " }, platform: "win32", execPath: "C:\\node\\node.exe", exists: nothing }), "python");
});

test("a runtime that ships Python beside Node uses it, on either separator", () => {
  const windows = bundledPythonPath({ platform: "win32", execPath: "C:\\runtime\\node\\bin\\node.exe" });
  assert.equal(windows, "C:\\runtime\\python\\python.exe");
  assert.equal(resolvePythonCommand({ env: {}, platform: "win32", execPath: "C:\\runtime\\node\\bin\\node.exe", exists: (file) => file === windows }), windows);

  const posix = bundledPythonPath({ platform: "linux", execPath: "/opt/runtime/node/bin/node" });
  assert.equal(posix, "/opt/runtime/python/bin/python");
  assert.equal(resolvePythonCommand({ env: {}, platform: "linux", execPath: "/opt/runtime/node/bin/node", exists: (file) => file === posix }), posix);
});

test("a Python counts only when it answers --version as Python 3", async () => {
  const locate = async (command) => (command.startsWith("/") ? command : `/usr/bin/${command}`);
  const answering = (answer) => async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...answer });
  assert.deepEqual(await probePython("python3", { locate, runner: answering({ stdout: "Python 3.13.16\n" }) }), { command: "python3", version: "3.13.16" });
  assert.deepEqual(await probePython("python", { locate: async () => "" }), { command: "python", missing: true }, "not on PATH: nothing is run");
  const moved = await probePython("/gone/bin/python3", {
    locate,
    runner: async () => { throw Object.assign(new Error("spawn /gone/bin/python3 ENOENT"), { code: "ENOENT" }); }
  });
  assert.deepEqual(moved, { command: "/gone/bin/python3", missing: true }, "a path the locator returned as given, and that is not there");
  const store = await probePython("python", {
    locate,
    runner: answering({ ok: false, exitCode: 9009, stderr: "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.\r\n" })
  });
  assert.match(store.failure, /^Python was not found; run without arguments to install from the Microsoft Store/);
  assert.deepEqual(await probePython("python", { locate, runner: answering({ stderr: "Python 2.7.18\n" }) }), { command: "python", failure: "Python 2.7.18" });
  assert.deepEqual(await probePython("python3", { locate, runner: answering({ ok: false, exitCode: null, timedOut: true }) }), { command: "python3", failure: "it did not answer in time" });
});

test("the probe runs the real thing: a missing file is missing, a program that is not Python is not one", async () => {
  assert.deepEqual(await probePython(path.join(os.tmpdir(), "no-such-dir", "python3")), { command: path.join(os.tmpdir(), "no-such-dir", "python3"), missing: true });
  const node = await probePython(process.execPath);
  assert.equal(node.version, undefined);
  assert.match(node.failure, /^v\d+\./, "node --version answers, but not as Python");
});

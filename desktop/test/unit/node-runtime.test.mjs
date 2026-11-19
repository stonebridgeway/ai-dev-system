import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { findNode, nodeVersion, parseVersion, supportedVersion } from "../../src/main/node-runtime.mjs";

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A file that passes for an executable; its "version" is what `versions` says. */
function fakeNode(dir, name = process.platform === "win32" ? "node.exe" : "node") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

test("versions: 22.16 and later, not the 23 line", () => {
  assert.deepEqual(parseVersion("v22.16.0"), [22, 16, 0]);
  assert.deepEqual(parseVersion("24.3.1\n"), [24, 3, 1]);
  assert.equal(parseVersion("node"), null);
  const ok = (text) => supportedVersion(parseVersion(text));
  assert.deepEqual(["v22.15.1", "v22.16.0", "v23.11.0", "v24.0.0", "v26.1.0", "v20.19.0"].map(ok), [false, true, false, true, true, false]);
  assert.equal(supportedVersion(null), false);
});

test("the Node of AI_DEV_NODE, else the clients', else PATH, else where installers put it; each checked", (t) => {
  const root = folder(t);
  const home = path.join(root, "home");
  const clients = fakeNode(path.join(root, "clients"));
  const onPath = fakeNode(path.join(root, "bin"));
  const pinned = fakeNode(path.join(root, "pinned"));
  const old = fakeNode(path.join(root, "old"));
  const versions = new Map([[clients, "v24.1.0"], [onPath, "v22.16.0"], [pinned, "v22.20.0"], [old, "v20.11.0"]]);
  const versionOf = (file) => versions.get(file) ?? null;
  const env = { PATH: path.dirname(onPath) };
  // The fakes are this machine's files, so the lookup is this machine's: on
  // Windows a PATH of "C:\\…" split as Linux splits it found nothing.
  const base = { env, platform: process.platform, home, versionOf };
  assert.deepEqual(findNode({ ...base, clientNodes: [clients] }), { path: clients, version: "v24.1.0", source: "client" });
  assert.deepEqual(findNode(base), { path: onPath, version: "v22.16.0", source: "PATH" });
  assert.deepEqual(findNode({ ...base, env: { ...env, AI_DEV_NODE: pinned }, clientNodes: [clients] }), { path: pinned, version: "v22.20.0", source: "AI_DEV_NODE" });
  // AI_DEV_NODE is the person's word: a wrong one is said, not passed over.
  assert.match(findNode({ ...base, env: { ...env, AI_DEV_NODE: old } }).problem, /AI_DEV_NODE names Node v20\.11\.0; AI Dev needs 22\.16 or newer/);
  assert.match(findNode({ ...base, env: { ...env, AI_DEV_NODE: path.join(root, "nothing") } }).problem, /not an executable file/);
  // A client's Node too old is passed over for the next.
  assert.equal(findNode({ ...base, clientNodes: [old] }).path, onPath);
  const programs = path.join(root, "programs");
  const none = findNode({ env: { PATH: path.join(root, "empty"), ProgramFiles: programs }, platform: process.platform, home, versionOf });
  assert.equal(none.path, null);
  assert.match(none.problem, /No Node\.js 22\.16 or newer was found/);
  const installed = process.platform === "win32" ? path.join(programs, "nodejs", "node.exe") : "/usr/local/bin/node";
  assert.ok(none.tried.includes(installed), "it says where it looked");
});

test("nvm's versions are tried newest first", (t) => {
  const root = folder(t);
  const home = path.join(root, "home");
  // nvm's layout, as on Linux and macOS, wherever the test runs.
  const older = fakeNode(path.join(home, ".nvm", "versions", "node", "v22.16.0", "bin"), "node");
  const newer = fakeNode(path.join(home, ".nvm", "versions", "node", "v24.2.0", "bin"), "node");
  const found = findNode({ env: { PATH: "" }, platform: "linux", home, versionOf: (file) => (file === newer ? "v24.2.0" : file === older ? "v22.16.0" : null) });
  assert.equal(found.path, newer);
});

test("the version of this Node is read by running it", () => {
  assert.equal(nodeVersion(process.execPath), process.version);
  assert.equal(nodeVersion(path.join(os.tmpdir(), "no-such-node-here")), null);
});

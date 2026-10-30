import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_MARKER, KEPT_APP_COPIES, appCli, appFolder, installAppHome } from "./app-home.mjs";

const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-app-home-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A package as npx unpacks one: its files and the distribution.json that lists them. */
async function writePackage(root, { version = "3.0.0", tag = "a" } = {}) {
  const files = {
    "package.json": JSON.stringify({ name: "ai-dev-system", version }),
    "npm-shrinkwrap.json": "{}",
    "ai-dev-mcp-server/bin/ai-dev.mjs": `// cli ${tag}\n`,
    "seed/public-seed.manifest.json": "{}"
  };
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const fingerprint = sha(`${tag}:${entries.map((entry) => entry.sha256).join(",")}`);
  await fs.writeFile(path.join(root, "distribution.json"), JSON.stringify({ name: "ai-dev-system", version, content_fingerprint: fingerprint, files: entries }));
  return { root, fingerprint };
}

function fakeNpm(calls, { fail = false } = {}) {
  return async (args, { cwd }) => {
    calls.push({ args, cwd });
    if (fail) throw new Error("npm ci exited with code 1.");
    await fs.mkdir(path.join(cwd, "node_modules", "zod"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "zod", "index.js"), "");
  };
}

test("a package npx unpacked is installed once into the app home, with its dependencies, and found there after", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const pkg = await writePackage(path.join(root, "npx", "node_modules", "ai-dev-system"));
  const calls = [];
  const first = await installAppHome({ packageRoot: pkg.root, runtimeRoot: runtime, runNpm: fakeNpm(calls) });
  assert.equal(first.status, "installed");
  assert.equal(first.folder, path.join(runtime, "app", `3.0.0-${pkg.fingerprint.slice(0, 8)}`));
  assert.equal(first.cli, appCli(first.folder));
  assert.equal(await fs.readFile(first.cli, "utf8"), "// cli a\n");
  assert.deepEqual(calls[0].args, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
    "no install scripts: no CUDA download");
  assert.notEqual(calls[0].cwd, first.folder, "npm runs in a staging folder, so a stopped install is never taken for a finished one");
  await fs.access(path.join(first.folder, "node_modules", "zod", "index.js"));
  const marker = JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8"));
  assert.equal(marker.content_fingerprint, pkg.fingerprint);

  const again = await installAppHome({ packageRoot: pkg.root, runtimeRoot: runtime, runNpm: fakeNpm(calls) });
  assert.equal(again.status, "present");
  assert.equal(calls.length, 1, "nothing is installed twice");
});

test("a damaged package or a failed npm leaves no copy behind, and nothing half-made", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const pkg = await writePackage(path.join(root, "pkg"));
  await fs.writeFile(path.join(pkg.root, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "// edited in the cache\n");
  await assert.rejects(installAppHome({ packageRoot: pkg.root, runtimeRoot: runtime, runNpm: fakeNpm([]) }),
    /is not the one its distribution\.json describes \(ai-dev-mcp-server\/bin\/ai-dev\.mjs\)/);
  assert.deepEqual(await fs.readdir(path.join(runtime, "app")), []);

  const whole = await writePackage(path.join(root, "whole"));
  await assert.rejects(installAppHome({ packageRoot: whole.root, runtimeRoot: runtime, runNpm: fakeNpm([], { fail: true }) }), /npm ci exited with code 1/);
  assert.deepEqual(await fs.readdir(path.join(runtime, "app")), []);
});

test("the newest copies stay; older ones, stopped installs and nothing of anyone else's go", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const apps = path.join(runtime, "app");
  await fs.mkdir(path.join(apps, "mine-not-yours"), { recursive: true });
  await fs.mkdir(path.join(apps, "3.0.0-old.1.abc.partial"), { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(path.join(apps, "3.0.0-old.1.abc.partial"), old, old);
  await fs.mkdir(path.join(apps, "3.0.0-new.2.def.partial"), { recursive: true });

  // The installs are a minute apart; partial folders are judged by their real age.
  let clock = Date.now();
  const now = () => new Date((clock += 60_000));
  const installed = [];
  for (const tag of ["a", "b", "c"]) {
    const pkg = await writePackage(path.join(root, tag), { version: "3.0.0", tag });
    installed.push(await installAppHome({ packageRoot: pkg.root, runtimeRoot: runtime, runNpm: fakeNpm([]), now }));
  }
  assert.equal(new Set(installed.map((item) => item.folder)).size, 3, "the same version rebuilt gets a folder of its own");
  assert.deepEqual(installed[2].removed, [installed[0].folder]);
  const left = (await fs.readdir(apps)).sort();
  assert.equal(left.filter((name) => name.startsWith("3.0.0-") && !name.endsWith(".partial")).length, KEPT_APP_COPIES);
  assert.ok(left.includes("mine-not-yours"), "a folder without a marker is not this module's to remove");
  assert.ok(left.includes("3.0.0-new.2.def.partial"), "an install that may still be running is left alone");
  assert.ok(!left.includes("3.0.0-old.1.abc.partial"), "one stopped hours ago is cleared");
});

test("the folder is named by version and fingerprint, and nothing in either escapes it", () => {
  assert.equal(appFolder("/r", { version: "3.0.0", content_fingerprint: "0123456789abcdef" }), path.join("/r", "app", "3.0.0-01234567"));
  assert.equal(appFolder("/r", { version: "../../x", content_fingerprint: "" }), path.join("/r", "app", ".._.._x-unknown"));
  assert.equal(appFolder("/r", { version: "3.0.0", content_fingerprint: "../../.." }), path.join("/r", "app", "3.0.0-unknown"));
  assert.equal(appFolder("/r", { version: "3.0.0", content_fingerprint: "ab/../cd" }), path.join("/r", "app", "3.0.0-abcd"));
});

test("a copy setup chose again is the current one: the prune keeps it, not the one installed after it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  let clock = Date.now();
  const now = () => new Date((clock += 60_000));
  const steps = [];
  for (const [version, tag] of [["3.0.0", "a"], ["3.1.0", "b"], ["3.0.0", "a"], ["3.2.0", "c"]]) {
    const pkg = await writePackage(path.join(root, `${version}-${tag}`), { version, tag });
    const result = await installAppHome({ packageRoot: pkg.root, runtimeRoot: runtime, runNpm: fakeNpm([]), now });
    steps.push([result.status, path.basename(result.folder), result.removed.map((folder) => path.basename(folder))]);
  }
  assert.equal(steps[2][0], "present");
  assert.deepEqual(steps[3][2], [steps[1][1]], "3.1.0 goes: 3.0.0 was chosen after it");
  const left = (await fs.readdir(path.join(runtime, "app"))).filter((name) => !name.endsWith(".partial")).sort();
  assert.deepEqual(left, [steps[0][1], steps[3][1]].sort());
});

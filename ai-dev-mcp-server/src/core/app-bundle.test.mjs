import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleFingerprint, currentLink, parseBundle, pointCurrent, provisionBundle, stableLaunch } from "./app-bundle.mjs";
import { APP_MARKER, copiesNamedByClients, installAppHome } from "./app-home.mjs";

const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-app-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A runtime as the installer ships one: the package, a dependency, a Node, and the bundle.json that lists them. */
async function writeBundle(root, { version = "3.0.0", tag = "a", extra = {} } = {}) {
  const files = {
    "distribution.json": JSON.stringify({ name: "ai-dev-system", version, files: [] }),
    "package.json": JSON.stringify({ name: "ai-dev-system", version }),
    "ai-dev-mcp-server/bin/ai-dev.mjs": `// cli ${tag}\n`,
    "node_modules/zod/index.js": "export {};\n",
    "node/node.exe": `node ${tag}`,
    "ai-dev.cmd": "@echo off\r\n",
    ...extra
  };
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const marker = {
    schema_version: 1,
    name: "ai-dev-system",
    version,
    platform: "win32",
    arch: "x64",
    node: { version: "24.22.0", file: "node/node.exe", sha256: sha(files["node/node.exe"]) },
    fingerprint: bundleFingerprint(entries),
    files: entries
  };
  await fs.writeFile(path.join(root, "bundle.json"), JSON.stringify(marker));
  return { root, marker };
}

/** A home of the test's own: the client configs a provisioning reads are its, never the machine's. */
function isolated(root) {
  const home = path.join(root, "home");
  return { home, env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: path.join(home, ".config") } };
}

const clock = (start = Date.parse("2026-10-18T10:00:00Z")) => {
  let at = start;
  return () => new Date((at += 60_000));
};

test("the shipped runtime is copied into the app home once, file by file, and the stable link points at the copy", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot, marker } = await writeBundle(path.join(root, "resources", "runtime"));
  const now = clock();
  const progress = [];
  const first = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime, now, onProgress: (step) => progress.push(step) });
  assert.equal(first.status, "installed");
  assert.equal(first.folder, path.join(runtime, "app", `3.0.0-${marker.fingerprint.slice(0, 8)}`));
  assert.equal(first.current, currentLink(runtime));
  assert.equal(first.node, path.join(runtime, "app", "current", "node", "node.exe"), "the config names the link, never the versioned copy");
  assert.equal(first.cli, path.join(runtime, "app", "current", "ai-dev-mcp-server", "bin", "ai-dev.mjs"));
  assert.equal(first.serverRoot, path.join(runtime, "app", "current", "ai-dev-mcp-server"));
  assert.equal(first.moved, true);
  assert.equal(await fs.realpath(first.current), await fs.realpath(first.folder));
  assert.equal(await fs.readFile(first.cli, "utf8"), "// cli a\n", "the CLI is reached through the link");
  assert.equal(await fs.readFile(path.join(first.folder, "node", "node.exe"), "utf8"), "node a");
  const copied = JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8"));
  assert.equal(copied.kind, "bundle");
  assert.equal(copied.content_fingerprint, marker.fingerprint);
  assert.equal(progress.at(-1).progress, progress.at(-1).total, "the progress ends at the whole runtime");
  await fs.access(path.join(first.folder, "bundle.json"));

  const again = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime, now });
  assert.equal(again.status, "present", "a runtime already copied is not copied again");
  assert.equal(again.moved, false);
  const chosen = JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8"));
  assert.ok(Date.parse(chosen.chosen_at) > Date.parse(copied.chosen_at), "chosen again, so a prune keeps it");
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), ["3.0.0-" + marker.fingerprint.slice(0, 8), "current"].sort(),
    "nothing left behind: no staging folder, no spare link");
});

test("a file that is not what the installer shipped stops the copy, and leaves neither a copy nor a link", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot, marker } = await writeBundle(path.join(root, "runtime"));
  await fs.writeFile(path.join(bundleRoot, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "// changed after the build\n");
  await assert.rejects(provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime }), /ai-dev-mcp-server\/bin\/ai-dev\.mjs .* is not the file the installer shipped; run the installer again/);
  const left = await fs.readdir(path.join(runtime, "app")).catch(() => []);
  assert.deepEqual(left, [], `no partial copy and no link: ${left.join(", ")}`);
  assert.equal(marker.files.length, 6);
});

test("an update copies the new runtime beside the old, moves the link, and keeps the old copy for clients still running it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const now = clock();
  const one = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r1"), { version: "3.0.0", tag: "one" })).root, runtimeRoot: runtime, now });
  const two = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r2"), { version: "3.0.1", tag: "two" })).root, runtimeRoot: runtime, now });
  assert.equal(two.status, "installed");
  assert.equal(two.moved, true);
  assert.equal(two.current, one.current, "the path clients run did not change");
  assert.equal(await fs.readFile(two.cli, "utf8"), "// cli two\n", "and now runs the new runtime");
  assert.equal(await fs.readFile(path.join(one.folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "utf8"), "// cli one\n",
    "the old copy is untouched: a client started before the update still reads it");
  const three = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r3"), { version: "3.0.2", tag: "three" })).root, runtimeRoot: runtime, now });
  assert.deepEqual(three.removed, [one.folder], "two copies stay: the current one and the one before it");
  await fs.access(two.folder);
  assert.equal(await fs.readFile(three.cli, "utf8"), "// cli three\n");
});

test("the copy the link names is never pruned, however many npx copies come after it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const now = clock();
  const bundle = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime, now });
  for (const tag of ["b", "c", "d"]) {
    const pkg = path.join(root, `npx-${tag}`);
    const content = `// npx ${tag}\n`;
    await fs.mkdir(path.join(pkg, "ai-dev-mcp-server", "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), content);
    await fs.writeFile(path.join(pkg, "distribution.json"), JSON.stringify({
      name: "ai-dev-system",
      version: "3.0.0",
      content_fingerprint: sha(tag),
      files: [{ path: "ai-dev-mcp-server/bin/ai-dev.mjs", bytes: Buffer.byteLength(content), sha256: sha(content) }]
    }));
    await installAppHome({ packageRoot: pkg, runtimeRoot: runtime, runNpm: async () => undefined, now });
  }
  await fs.access(bundle.folder);
  assert.equal(await fs.realpath(bundle.current), await fs.realpath(bundle.folder));
  const folders = (await fs.readdir(path.join(runtime, "app"))).filter((name) => name !== "current");
  assert.equal(folders.length, 3, `the linked copy and the two newest npx copies, kept by a count of their own: ${folders.join(", ")}`);
});

test("an update of the app prunes its own copies only: the npx copy the clients set up by npx run stays", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const now = clock();
  const pkg = path.join(root, "npx");
  const content = "// npx\n";
  await fs.mkdir(path.join(pkg, "ai-dev-mcp-server", "bin"), { recursive: true });
  await fs.writeFile(path.join(pkg, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), content);
  await fs.writeFile(path.join(pkg, "distribution.json"), JSON.stringify({
    name: "ai-dev-system",
    version: "3.0.0",
    content_fingerprint: sha("npx"),
    files: [{ path: "ai-dev-mcp-server/bin/ai-dev.mjs", bytes: Buffer.byteLength(content), sha256: sha(content) }]
  }));
  const one = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r1"), { tag: "one" })).root, runtimeRoot: runtime, now });
  const npx = await installAppHome({ packageRoot: pkg, runtimeRoot: runtime, runNpm: async () => undefined, now });
  // The app starts again (its copy is chosen again), then two updates come.
  await provisionBundle({ ...isolated(root), bundleRoot: path.join(root, "r1"), runtimeRoot: runtime, now });
  const two = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r2"), { version: "3.0.1", tag: "two" })).root, runtimeRoot: runtime, now });
  const three = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r3"), { version: "3.0.2", tag: "three" })).root, runtimeRoot: runtime, now });
  assert.deepEqual([...two.removed, ...three.removed], [one.folder], "the app's oldest copy goes, nothing else");
  await fs.access(npx.cli);
});

test("on Windows a junction is asked for, and the old link goes aside before the new one takes its name", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const made = [];
  // A junction is a Windows link; here the spy records the kind asked for and makes a symbolic link.
  const symlink = async (target, link, type) => {
    made.push({ target, link: path.basename(link).replace(/\.\d+\.[0-9a-f]{8}\./, ".<tag>."), type });
    await fs.symlink(target, link, "dir");
  };
  const now = clock();
  const one = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r1"), { tag: "one" })).root, runtimeRoot: runtime, now, platform: "win32", symlink });
  const two = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "r2"), { version: "3.0.1", tag: "two" })).root, runtimeRoot: runtime, now, platform: "win32", symlink });
  assert.deepEqual(made.map((entry) => [entry.link, entry.type]), [["current.<tag>.next", "junction"], ["current.<tag>.next", "junction"]]);
  assert.equal(made[1].target, await fs.realpath(two.folder), "the junction names the copy's real path");
  assert.equal(await fs.readFile(two.cli, "utf8"), "// cli two\n");
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).filter((name) => name.startsWith("current")), ["current"], "the old link was removed after the move");
  await fs.access(one.folder);
});

test("links a stopped move left behind are cleared, and a real folder named current is not taken for the link", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const folder = path.join(runtime, "app", "3.0.0-abcdef12");
  await fs.mkdir(folder, { recursive: true });
  await fs.symlink(folder, path.join(runtime, "app", "current.123.0a1b2c3d.next"), "dir");
  await fs.symlink(folder, path.join(runtime, "app", "current.456.0a1b2c3d.old"), "dir");
  assert.equal(await pointCurrent({ runtimeRoot: runtime, folder }), true);
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), ["3.0.0-abcdef12", "current"]);
  assert.equal(await pointCurrent({ runtimeRoot: runtime, folder }), false, "already there: nothing moves");

  const other = path.join(root, "other");
  await fs.mkdir(path.join(other, "app", "current"), { recursive: true });
  await fs.mkdir(path.join(other, "app", "x"), { recursive: true });
  await assert.rejects(pointCurrent({ runtimeRoot: other, folder: path.join(other, "app", "x") }), /is not the link AI Dev keeps there; move it aside/);
  await fs.access(path.join(other, "app", "current"));
});

test("a bundle.json is refused before anything is copied by it when it names a file outside its folder or lies about its files", () => {
  const file = (relative, content = "x") => ({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  const base = [file("distribution.json"), file("ai-dev-mcp-server/bin/ai-dev.mjs"), file("node/node.exe")];
  const marker = (files, extra = {}) => JSON.stringify({ schema_version: 1, version: "3.0.0", node: { file: "node/node.exe" }, fingerprint: bundleFingerprint(files), files, ...extra });
  assert.equal(parseBundle(marker(base), "b.json").version, "3.0.0");
  for (const bad of ["../escape.txt", "/etc/passwd", "C:/Windows/x.dll", "a\\..\\b", "a//b", "./a"]) {
    assert.throws(() => parseBundle(marker([...base, file(bad)]), "b.json"), /a file outside the runtime/, bad);
  }
  assert.throws(() => parseBundle(marker([...base, file("Node/node.exe")]), "b.json"), /listed twice/, "Windows reads names without case");
  assert.throws(() => parseBundle(marker(base, { fingerprint: "0".repeat(64) }), "b.json"), /a fingerprint that is not its files'/);
  assert.throws(() => parseBundle(marker(base, { node: { file: "node/missing.exe" } }), "b.json"), /no Node among its files/);
  assert.throws(() => parseBundle(marker(base.slice(1)), "b.json"), /no distribution\.json/);
  assert.throws(() => parseBundle(marker(base, { schema_version: 2 }), "b.json"), /schema_version 2/);
  assert.throws(() => parseBundle("{", "b.json"), /b\.json is not JSON/);
});

test("the stable launch names the link's Node and CLI, and only for the Windows install", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const provisioned = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime });
  const layout = { kind: "package", bundle: true, root: provisioned.folder, runtimeRoot: runtime };
  assert.deepEqual(stableLaunch(layout), { command: provisioned.node, cli: provisioned.cli });
  assert.deepEqual(stableLaunch({ ...layout, root: path.join(root, "resources", "runtime") }), { command: provisioned.node, cli: provisioned.cli },
    "the installer's own runtime names the link too: it is what the app makes current");
  assert.equal(stableLaunch({ ...layout, bundle: false }), null, "an npx copy or a clone is launched as before");
  assert.equal(stableLaunch({ ...layout, runtimeRoot: path.join(root, "elsewhere") }), null, "no link: the copy is named as any install's is");
  await fs.rm(path.join(provisioned.folder, "bundle.json"));
  assert.equal(stableLaunch(layout), null, "a link to something that is not a runtime is not trusted");
});

test("a drive that cannot hold the link still runs the copy, whatever it answers: the paths name the copy, and say why there is no link", async (t) => {
  const root = await scratch(t);
  // Wine says ENOTSUP; FAT32 and exFAT, through libuv, EISDIR; a share EPERM; anything else as well.
  for (const code of ["ENOTSUP", "EISDIR", "EPERM", "EIO"]) {
    const runtime = path.join(root, `.ai-dev-${code}`);
    const refuse = async () => { throw Object.assign(new Error(`${code}: no link here, symlink`), { code }); };
    const provisioned = await provisionBundle({ ...isolated(root), bundleRoot: (await writeBundle(path.join(root, "runtime"))).root, runtimeRoot: runtime, symlink: refuse });
    assert.equal(provisioned.status, "installed", code);
    assert.equal(provisioned.current, "");
    assert.equal(provisioned.linkError, `${code}: no link here, symlink`, "the code once, though Node's message starts with it");
    assert.equal(provisioned.node, path.join(provisioned.folder, "node", "node.exe"));
    assert.equal(await fs.readFile(provisioned.cli, "utf8"), "// cli a\n");
    assert.equal(stableLaunch({ kind: "package", bundle: true, root: provisioned.folder, runtimeRoot: runtime }), null, "no link: configs name the copy, as any install's do");
  }
  // What is not the making of the link still stops the start: a folder that took the link's name.
  const taken = path.join(root, ".ai-dev-taken");
  await fs.mkdir(path.join(taken, "app", "current"), { recursive: true });
  await assert.rejects(provisionBundle({ ...isolated(root), bundleRoot: path.join(root, "runtime"), runtimeRoot: taken }), /is not the link AI Dev keeps there/);
});

test("without a link, the copy a client's config names is not pruned by the updates that come after it", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { home, env } = isolated(root);
  const now = clock();
  const refuse = async () => { throw Object.assign(new Error("not supported"), { code: "EISDIR" }); };
  const one = await provisionBundle({ env, home, bundleRoot: (await writeBundle(path.join(root, "r1"), { tag: "one" })).root, runtimeRoot: runtime, now, symlink: refuse });
  // The wizard connected Cursor while the app ran this copy: its config names the copy itself.
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: one.node, args: [one.cli, "mcp"] } } }));
  const removed = [];
  for (const [index, version] of ["3.0.1", "3.0.2", "3.0.3"].entries()) {
    const next = await provisionBundle({ env, home, bundleRoot: (await writeBundle(path.join(root, `r${index + 2}`), { version, tag: version })).root, runtimeRoot: runtime, now, symlink: refuse });
    removed.push(...next.removed.map((folder) => path.basename(folder)));
  }
  await fs.access(one.cli);
  assert.equal(removed.includes(path.basename(one.folder)), false);
  assert.equal(removed.length, 1, `the copies nobody names are kept by the count: ${removed.join(", ")}`);
});

test("the copies the clients' entries name by their own folder, never through the link or by a relative word", async (t) => {
  const root = await scratch(t);
  const { home, env } = isolated(root);
  const appsRoot = path.join(root, ".ai-dev", "app");
  const copy = path.join(appsRoot, "3.0.0-abcdef12");
  const legacy = path.join(appsRoot, "2.9.0-0badcafe");
  await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
    "ai-dev": { command: path.join(copy, "node", "node.exe"), args: [path.join(appsRoot, "current", "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "mcp"] },
    "ai-dev-system": { command: "node", args: [path.join(legacy, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "3.0.0-11111111/x"] },
    other: { command: path.join(appsRoot, "9.9.9-99999999", "node.exe") }
  } }));
  assert.deepEqual(await copiesNamedByClients({ appsRoot, env, home }), [legacy, copy].sort());
});

test("a copy that lost a file is put back from the installer at the next start; a damaged installer is said so", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot } = await writeBundle(path.join(root, "runtime"), { extra: { "node_modules/onnxruntime-node/bin/onnxruntime.dll": "dll" } });
  const first = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime });
  const dll = path.join(first.folder, "node_modules", "onnxruntime-node", "bin", "onnxruntime.dll");
  const cli = path.join(first.folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs");
  await fs.rm(dll); // an antivirus took it away
  await fs.writeFile(cli, "// edited by hand\n");
  await fs.rm(path.join(first.folder, "bundle.json"));
  const again = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime });
  assert.equal(again.status, "repaired");
  assert.deepEqual(again.repaired.sort(), ["ai-dev-mcp-server/bin/ai-dev.mjs", "bundle.json", "node_modules/onnxruntime-node/bin/onnxruntime.dll"]);
  assert.equal(await fs.readFile(dll, "utf8"), "dll");
  assert.equal(await fs.readFile(cli, "utf8"), "// cli a\n");
  await fs.access(path.join(first.folder, "bundle.json"));
  assert.equal((await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime })).status, "present", "whole again");
  assert.deepEqual((await fs.readdir(path.dirname(dll))).sort(), ["onnxruntime.dll"], "no partial file left beside it");

  // The installer's own copy lost the file too: the copy is not trusted to it, and the person is told.
  await fs.rm(dll);
  await fs.rm(path.join(bundleRoot, "node_modules", "onnxruntime-node", "bin", "onnxruntime.dll"));
  await assert.rejects(provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime }), /onnxruntime\.dll in .* run the installer again/);
});

test("a folder at the copy's name that is not a finished copy is moved aside whole, not removed in place", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot, marker } = await writeBundle(path.join(root, "runtime"));
  const folder = path.join(runtime, "app", `3.0.0-${marker.fingerprint.slice(0, 8)}`);
  await fs.mkdir(path.join(folder, "node"), { recursive: true });
  await fs.writeFile(path.join(folder, "node", "node.exe"), "a copy that stopped before its marker");
  const provisioned = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime });
  assert.equal(provisioned.status, "installed");
  assert.equal(await fs.readFile(path.join(folder, "node", "node.exe"), "utf8"), "node a");
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), [path.basename(folder), "current"], "nothing left aside");
});

test("a copy whose marker is not JSON is copied again, not a start that stops", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot } = await writeBundle(path.join(root, "runtime"));
  const first = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime });
  for (const broken of ["", "{ truncated", "null"]) {
    await fs.writeFile(path.join(first.folder, APP_MARKER), broken);
    const again = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime });
    assert.equal(again.status, "installed", JSON.stringify(broken));
    assert.equal(JSON.parse(await fs.readFile(path.join(first.folder, APP_MARKER), "utf8")).kind, "bundle");
  }
  assert.deepEqual((await fs.readdir(path.join(runtime, "app"))).sort(), [path.basename(first.folder), "current"], "nothing left aside");
});

test("the npx prune leaves a copy a client's config still names, as the app's does", async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { home, env } = isolated(root);
  const now = clock();
  const installs = [];
  for (const tag of ["b", "c", "d", "e"]) {
    const pkg = path.join(root, `npx-${tag}`);
    const content = `// npx ${tag}\n`;
    await fs.mkdir(path.join(pkg, "ai-dev-mcp-server", "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), content);
    await fs.writeFile(path.join(pkg, "distribution.json"), JSON.stringify({
      name: "ai-dev-system",
      version: "3.0.0",
      content_fingerprint: sha(tag),
      files: [{ path: "ai-dev-mcp-server/bin/ai-dev.mjs", bytes: Buffer.byteLength(content), sha256: sha(content) }]
    }));
    installs.push(await installAppHome({ packageRoot: pkg, runtimeRoot: runtime, runNpm: async () => undefined, now, env, home }));
    if (tag === "b") {
      // Cursor was connected to the first copy, and a later setup did not connect it again.
      await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
      await fs.writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "ai-dev": { command: "node", args: [installs[0].cli, "mcp"] } } }));
    }
  }
  await fs.access(installs[0].cli);
  assert.deepEqual(installs.flatMap((install) => install.removed).map((folder) => path.basename(folder)), [path.basename(installs[1].folder)],
    "the copies nobody names go by the count; the one Cursor runs stays");
});

test("on macOS the copy is the files' bytes and modes, not their attributes: a quarantine stays with the app", { skip: process.platform === "win32" && "file modes" }, async (t) => {
  const root = await scratch(t);
  const runtime = path.join(root, ".ai-dev");
  const { root: bundleRoot } = await writeBundle(path.join(root, "resources", "runtime"), { extra: { "ai-dev": "#!/bin/sh\n", "node/bin/node": "node mac" } });
  await fs.chmod(path.join(bundleRoot, "ai-dev"), 0o755);
  await fs.chmod(path.join(bundleRoot, "node", "bin", "node"), 0o755);
  const copied = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime, now: clock(), platform: "darwin" });
  assert.equal(copied.status, "installed");
  assert.equal(copied.command, path.join(runtime, "app", "current", "ai-dev"));
  for (const [file, mode] of [["ai-dev", 0o755], [path.join("node", "bin", "node"), 0o755], ["package.json", (await fs.stat(path.join(bundleRoot, "package.json"))).mode & 0o777]]) {
    assert.equal((await fs.stat(path.join(copied.folder, file))).mode & 0o777, mode, `${file} keeps its mode`);
    assert.deepEqual(await fs.readFile(path.join(copied.folder, file)), await fs.readFile(path.join(bundleRoot, file)));
  }
  // A file lost later is put back the same way.
  await fs.rm(path.join(copied.folder, "ai-dev"));
  const repaired = await provisionBundle({ ...isolated(root), bundleRoot, runtimeRoot: runtime, now: clock(), platform: "darwin" });
  assert.deepEqual(repaired.repaired, ["ai-dev"]);
  assert.equal((await fs.stat(path.join(copied.folder, "ai-dev"))).mode & 0o777, 0o755);
});

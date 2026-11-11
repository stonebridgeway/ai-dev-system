import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { circlePng } from "../../src/main/tray-icon.mjs";
import {
  BUNDLE_SHIM,
  POSIX_SHIM,
  RELEASES,
  TARGETS,
  builderConfig,
  commandFile,
  compositionProblems,
  compositionReport,
  danglingDependencies,
  dropEmptySigning,
  extractTarGz,
  hostTarget,
  icoFrom,
  listFiles,
  targetOf,
  trimRuntime,
  versionProblem,
  writeBundleMarker
} from "../../scripts/runtime-bundle.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverRoot = path.resolve(desktopRoot, "..", "ai-dev-mcp-server");
const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-windows-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
}

test("the runtime's dependencies lose what win32-x64 never loads, and keep what it does", async (t) => {
  const runtime = folder(t);
  const binaries = "node_modules/onnxruntime-node/bin/napi-v6";
  write(runtime, {
    [`${binaries}/darwin/arm64/onnxruntime_binding.node`]: "mac",
    [`${binaries}/linux/x64/onnxruntime_binding.node`]: "linux",
    [`${binaries}/win32/arm64/onnxruntime_binding.node`]: "arm",
    [`${binaries}/win32/x64/onnxruntime_binding.node`]: "x64",
    "node_modules/onnxruntime-node/package.json": "{}",
    "node_modules/onnxruntime-web/dist/ort.min.js": "web",
    "node_modules/@img/sharp-wasm32/lib/sharp.wasm": "wasm",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": "linux",
    "node_modules/@img/sharp-win32-x64/lib/sharp.node": "win",
    "node_modules/@img/colour/index.js": "colour",
    "node_modules/@emnapi/runtime/index.js": "emnapi",
    "node_modules/tslib/tslib.js": "tslib",
    "node_modules/zod/index.js": "zod"
  });
  fs.mkdirSync(path.join(runtime, "node_modules", ".bin"));
  fs.symlinkSync("../zod/index.js", path.join(runtime, "node_modules", ".bin", "zod"));
  const removed = await trimRuntime(runtime);
  assert.deepEqual(removed.map((item) => item.path).sort(), [
    "node_modules/.bin",
    "node_modules/@emnapi/runtime",
    "node_modules/@img/sharp-linux-x64",
    "node_modules/@img/sharp-wasm32",
    `${binaries}/darwin`,
    `${binaries}/linux`,
    `${binaries}/win32/arm64`,
    "node_modules/onnxruntime-web",
    "node_modules/tslib"
  ].sort());
  assert.ok(removed.every((item) => item.why), "each cut says why");
  const left = (await listFiles(runtime)).map((file) => file.path);
  assert.deepEqual(left, [
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-win32-x64/lib/sharp.node",
    `${binaries}/win32/x64/onnxruntime_binding.node`,
    "node_modules/onnxruntime-node/package.json",
    "node_modules/zod/index.js"
  ]);
  assert.deepEqual(await trimRuntime(runtime), [], "a second pass has nothing to cut");
});

test("a cut that went too far is found: a dependency nothing ships any more", async (t) => {
  const modules = path.join(folder(t), "node_modules");
  write(modules, {
    "sharp/package.json": JSON.stringify({ dependencies: { "@img/colour": "^1", "detect-libc": "^2" } }),
    "@img/colour/package.json": "{}",
    "@huggingface/transformers/package.json": JSON.stringify({ dependencies: { "onnxruntime-web": "1", "onnxruntime-node": "1" } }),
    "onnxruntime-node/package.json": "{}",
    "@huggingface/transformers/node_modules/inner/package.json": "{}",
    "with-nested/package.json": JSON.stringify({ dependencies: { inner: "1" } }),
    "with-nested/node_modules/inner/package.json": "{}"
  });
  assert.deepEqual(await danglingDependencies(modules), [{ package: "sharp", missing: "detect-libc" }],
    "onnxruntime-web is cut on purpose; a nested dependency is found where it is");
});

test("only the pairs cut on purpose pass: a cut package another one needs is found, inside nested node_modules too", async (t) => {
  const modules = path.join(folder(t), "node_modules");
  write(modules, {
    // A dependency update: a package the runtime loads comes to need tslib, which the trim cuts.
    "some-lib/package.json": JSON.stringify({ dependencies: { tslib: "^2" } }),
    "outer/package.json": JSON.stringify({ dependencies: { inner: "1" } }),
    "outer/node_modules/inner/package.json": JSON.stringify({ dependencies: { "left-pad": "1", shared: "1", deeper: "1" } }),
    "outer/node_modules/inner/node_modules/deeper/package.json": "{}",
    // Found as Node finds it: in a node_modules above the one the package is in.
    "shared/package.json": "{}",
    "@scope/pkg/package.json": JSON.stringify({ dependencies: { "onnxruntime-web": "1" } })
  });
  assert.deepEqual(await danglingDependencies(modules), [
    { package: "@scope/pkg", missing: "onnxruntime-web" },
    { package: "outer/node_modules/inner", missing: "left-pad" },
    { package: "some-lib", missing: "tslib" }
  ], "the transformers → onnxruntime-web pair passes; the same dependency of another package does not");
  write(modules, { "broken/package.json": "{ not json" });
  await assert.rejects(danglingDependencies(modules), /broken[\\/]package\.json is not JSON: /, "a manifest it cannot read stops the build by its name");
});

test("the files of a runtime: sorted, each with its size and sha256, and a link refused", async (t) => {
  const root = folder(t);
  write(root, { "b.txt": "bee", "a/c.txt": "sea" });
  assert.deepEqual(await listFiles(root), [
    { path: "a/c.txt", bytes: 3, sha256: sha("sea") },
    { path: "b.txt", bytes: 3, sha256: sha("bee") }
  ]);
  fs.symlinkSync(path.join(root, "b.txt"), path.join(root, "link.txt"));
  await assert.rejects(listFiles(root), /link\.txt is a link; the runtime ships files only/);
});

test("bundle.json, as the build writes it, is what the server's provisioning reads", async (t) => {
  const runtime = folder(t);
  write(runtime, {
    "distribution.json": "{}",
    "ai-dev-mcp-server/bin/ai-dev.mjs": "// cli\n",
    "node/node.exe": "node",
    "node/LICENSE": "MIT",
    "ai-dev.cmd": BUNDLE_SHIM
  });
  const { bundleFingerprint, parseBundle } = await import(pathToFileURL(path.join(serverRoot, "src", "core", "app-bundle.mjs")).href);
  const marker = await writeBundleMarker({ runtimeDir: runtime, name: "ai-dev-system", version: "3.0.0", node: { version: "24.22.0", sha256: sha("node") }, fingerprintOf: bundleFingerprint });
  const read = parseBundle(fs.readFileSync(path.join(runtime, "bundle.json"), "utf8"), "bundle.json");
  assert.equal(read.fingerprint, marker.fingerprint);
  assert.deepEqual(read.node, { version: "24.22.0", file: "node/node.exe", sha256: sha("node") });
  assert.equal(read.files.some((file) => file.path === "bundle.json"), false, "it does not list itself");
  assert.equal(BUNDLE_SHIM, "@echo off\r\n\"%~dp0node\\node.exe\" \"%~dp0ai-dev-mcp-server\\bin\\ai-dev.mjs\" %*\r\n",
    "the shim names the Node and CLI beside it, quoted for a profile with a space");
  // Two names Windows takes for one — possible in a tree npm builds on Linux — stop the build, read back as the app reads it.
  write(runtime, { "node_modules/pkg/README.md": "a", "node_modules/pkg/readme.md": "b" });
  // Only a filesystem that tells the two apart holds both; on Windows and macOS
  // the second write is the first file, and there is nothing to refuse.
  if (fs.readdirSync(path.join(runtime, "node_modules", "pkg")).length === 2) {
    await assert.rejects(writeBundleMarker({ runtimeDir: runtime, name: "x", version: "3.0.0", node: { version: "24.22.0", sha256: sha("node") }, fingerprintOf: bundleFingerprint, parse: parseBundle }),
      /bundle\.json is not a runtime this AI Dev can install: node_modules\/pkg\/readme\.md listed twice/);
  }
});

test("the composition check names what must not ship, what is missing, a Node that is not the pinned one, and a runtime over its budget", () => {
  const file = (relative, bytes = 1, content = relative) => ({ path: relative, bytes, sha256: sha(content) });
  const complete = [
    "distribution.json", "ai-dev.cmd", "node/LICENSE", "ai-dev-mcp-server/bin/ai-dev.mjs", "ai-dev-mcp-server/src/core/app-bundle.mjs",
    "seed/public-seed.manifest.json", "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node", "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
    "node_modules/@img/sharp-win32-x64/package.json", "node_modules/@huggingface/transformers/package.json"
  ].map((relative) => file(relative));
  const node = file("node/node.exe", 1, "node");
  assert.deepEqual(compositionProblems([...complete, node], { nodeSha256: sha("node") }), []);
  const problems = compositionProblems([
    ...complete.filter((item) => item.path !== "ai-dev.cmd"),
    file("node/node.exe", 1, "another node"),
    file("node_modules/onnxruntime-web/dist/ort.js"),
    file("node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node"),
    file("node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime_binding.node"),
    file("node_modules/@img/sharp-wasm32/lib/sharp.wasm")
  ], { nodeSha256: sha("node"), budget: 5 });
  assert.equal(problems.filter((problem) => /must not ship/.test(problem)).length, 4, problems.join("\n"));
  assert.ok(problems.includes("ai-dev.cmd is missing"));
  assert.ok(problems.some((problem) => /node\/node\.exe has sha256 .* not the pinned/.test(problem)));
  assert.ok(problems.some((problem) => /over its budget of 5/.test(problem)));
  const report = compositionReport([...complete, node, file("node_modules/@img/sharp-win32-x64/lib/libvips-42.dll", 100)]);
  assert.equal(report.files, complete.length + 2);
  assert.deepEqual(Object.keys(report.groups)[0], "node_modules/@img/sharp-win32-x64", "inside node_modules, by package, heaviest first");
  assert.equal(report.largest[0].path, "node_modules/@img/sharp-win32-x64/lib/libvips-42.dll");
});

test("the app's icon is an ICO of PNG images, drawn at build time", () => {
  const images = [256, 32].map((size) => ({ size, data: circlePng([46, 160, 67], size) }));
  const ico = icoFrom(images);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "type 1: icon");
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 0, "256 pixels are written as 0");
  assert.equal(ico[6 + 16], 32);
  const first = ico.readUInt32LE(6 + 12);
  assert.equal(first, 6 + 32);
  assert.deepEqual(ico.subarray(first, first + 8), images[0].data.subarray(0, 8), "the PNG signature where the directory says");
  assert.equal(ico.readUInt32LE(6 + 16 + 12), first + images[0].data.length);
  assert.throws(() => icoFrom([{ size: 512, data: Buffer.alloc(1) }]), /512 pixels/);
});

test("electron-builder's configuration: NSIS for the current user without an administrator, the runtime in resources, updates from the production releases", () => {
  const config = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.ico", output: "/x/out", env: {} });
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false, "per user: no administrator");
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, true, "Electron's own cache; AI Dev's data is asked about");
  assert.ok(fs.existsSync(config.nsis.include), "the uninstaller's questions are part of the build");
  assert.deepEqual(config.nsis.installerLanguages, ["en_US", "ru_RU"], "the strings installer.nsh defines (1033, 1049)");
  assert.deepEqual(config.publish, [RELEASES]);
  assert.deepEqual(RELEASES, { provider: "github", owner: "stonebridgeway", repo: "ai-dev-system", releaseType: "release" });
  assert.deepEqual(config.extraResources, [
    { from: "/x/runtime", to: "runtime", filter: ["**/*"] },
    { from: path.join("/x/runtime", "node_modules"), to: "runtime/node_modules", filter: ["**/*"] }
  ], "electron-builder leaves out a node_modules at the top of what it copies: the dependencies are an entry of their own");
  assert.deepEqual(config.files, ["package.json", "src/**/*"], "no tests, no scripts, no build files in the app");
  assert.equal(config.asar, true);
  assert.equal(config.win.azureSignOptions, undefined, "unsigned unless the environment names a signer");
  const azure = { AI_DEV_SIGN_AZURE_ENDPOINT: "https://eus.codesigning.azure.net", AI_DEV_SIGN_AZURE_ACCOUNT: "acct", AI_DEV_SIGN_AZURE_PROFILE: "prof" };
  const signed = builderConfig({ desktopRoot, runtimeDir: "/x", icon: "/x.ico", output: "/o", env: { ...azure, AI_DEV_SIGN_PUBLISHER: "Stonebridgeway LLC" } });
  assert.deepEqual(signed.win.azureSignOptions, { publisherName: "Stonebridgeway LLC", endpoint: "https://eus.codesigning.azure.net", codeSigningAccountName: "acct", certificateProfileName: "prof" });
  // No publisher guessed: the updater checks every update against it.
  assert.throws(() => builderConfig({ desktopRoot, runtimeDir: "/x", icon: "/x.ico", output: "/o", env: { ...azure, AI_DEV_SIGN_PUBLISHER: "" } }),
    /Azure signing is set up \(AI_DEV_SIGN_AZURE_ENDPOINT\) but not AI_DEV_SIGN_PUBLISHER: AI_DEV_SIGN_PUBLISHER is the signing certificate's name/);
  assert.throws(() => builderConfig({ desktopRoot, runtimeDir: "/x", icon: "/x.ico", output: "/o", env: { AI_DEV_SIGN_AZURE_ENDPOINT: "https://x", AI_DEV_SIGN_PUBLISHER: "P" } }),
    /but not AI_DEV_SIGN_AZURE_ACCOUNT, AI_DEV_SIGN_AZURE_PROFILE:/);
});

test("the app's version is its runtime's: the updater reads the app's", () => {
  assert.equal(versionProblem({ app: "3.0.0", runtime: "3.0.0" }), "");
  assert.match(versionProblem({ app: "2.0.0", runtime: "3.0.0" }), /^the app is version 2\.0\.0 and its runtime 3\.0\.0: /);
  const app = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
  const server = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8")).version;
  assert.equal(versionProblem({ app, runtime: server }), "", "as the repository stands");
});

test("the Node each build ships is pinned: the LTS line, a version, the archive's sha256 and the binary's", () => {
  const archives = { "win32-x64": "win-x64.zip", "darwin-arm64": "darwin-arm64.tar.gz", "linux-x64": "linux-x64.tar.gz" };
  const versions = new Set();
  for (const target of Object.values(TARGETS)) {
    const pin = JSON.parse(fs.readFileSync(path.join(desktopRoot, "build", target.pin), "utf8"));
    versions.add(pin.version);
    assert.match(pin.version, /^24\.\d+\.\d+$/, "Node 24 LTS until 26 is LTS (end of October 2026)");
    assert.equal(pin.url, `https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-${archives[target.id]}`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.match(pin.binary_sha256, /^[0-9a-f]{64}$/);
    const folder = `node-v${pin.version}-${archives[target.id].replace(/\.(zip|tar\.gz)$/, "")}`;
    assert.equal(pin.entry, target.platform === "win32" ? `${folder}/node.exe` : `${folder}/bin/node`);
    assert.equal(pin.license, `${folder}/LICENSE`);
  }
  assert.equal(versions.size, 1, "one Node for every system");
});

test("each system's runtime keeps its own native builds: sharp with its libvips, onnxruntime-node for its processor", async (t) => {
  const binaries = "node_modules/onnxruntime-node/bin/napi-v6";
  const tree = {
    [`${binaries}/darwin/arm64/onnxruntime_binding.node`]: "mac",
    [`${binaries}/linux/arm64/onnxruntime_binding.node`]: "linux arm",
    [`${binaries}/linux/x64/onnxruntime_binding.node`]: "linux",
    [`${binaries}/win32/x64/onnxruntime_binding.node`]: "win",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": "linux",
    "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8": "vips",
    "node_modules/@img/sharp-linuxmusl-x64/lib/sharp.node": "musl",
    "node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8": "musl vips",
    "node_modules/@img/sharp-darwin-arm64/lib/sharp.node": "mac",
    "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib": "mac vips",
    "node_modules/@img/colour/index.js": "colour"
  };
  const kept = async (id) => {
    const runtime = folder(t);
    write(runtime, tree);
    await trimRuntime(runtime, { target: targetOf(id) });
    return (await listFiles(runtime)).map((file) => file.path);
  };
  assert.deepEqual(await kept("linux-x64"), [
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node",
    `${binaries}/linux/x64/onnxruntime_binding.node`
  ], "glibc only: the musl builds go");
  assert.deepEqual(await kept("darwin-arm64"), [
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-darwin-arm64/lib/sharp.node",
    "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib",
    `${binaries}/darwin/arm64/onnxruntime_binding.node`
  ]);
});

test("each system's runtime is checked for its own Node, command and native files", () => {
  const file = (relative, content = relative) => ({ path: relative, bytes: 1, sha256: sha(content) });
  const linux = targetOf("linux-x64");
  const complete = [
    "distribution.json", "ai-dev", "node/LICENSE", "ai-dev-mcp-server/bin/ai-dev.mjs", "ai-dev-mcp-server/src/core/app-bundle.mjs",
    "seed/public-seed.manifest.json", "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node", "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
    "node_modules/@img/sharp-linux-x64/package.json", "node_modules/@img/sharp-libvips-linux-x64/package.json", "node_modules/@huggingface/transformers/package.json"
  ].map((relative) => file(relative));
  const node = file("node/bin/node", "node");
  assert.deepEqual(compositionProblems([...complete, node], { nodeSha256: sha("node"), target: linux }), []);
  const problems = compositionProblems([
    ...complete.filter((item) => item.path !== "ai-dev"),
    file("node/bin/node", "another"),
    file("node_modules/@img/sharp-win32-x64/package.json"),
    file("node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node")
  ], { nodeSha256: sha("node"), target: linux });
  assert.ok(problems.includes("ai-dev is missing"), problems.join("\n"));
  assert.ok(problems.some((problem) => /node\/bin\/node has sha256 .* not the pinned/.test(problem)));
  assert.equal(problems.filter((problem) => /must not ship/.test(problem)).length, 2);
  // The Windows runtime is no Linux one.
  assert.ok(compositionProblems([...complete, node], { nodeSha256: sha("node") }).includes("node/node.exe is missing"));
});

test("the command beside the runtime: ai-dev.cmd on Windows, a shell script that runs its own Node elsewhere", async (t) => {
  assert.deepEqual(commandFile(targetOf("win32-x64")), { name: "ai-dev.cmd", text: BUNDLE_SHIM, mode: 0o644 });
  const posix = commandFile(targetOf("linux-x64"));
  assert.deepEqual([posix.name, posix.mode, posix.text], ["ai-dev", 0o755, POSIX_SHIM]);
  assert.equal(commandFile(targetOf("darwin-arm64")).text, POSIX_SHIM);
  assert.throws(() => targetOf("darwin-x64"), /There is no target "darwin-x64": the app is built for win32-x64, darwin-arm64, linux-x64\./);
  assert.equal(hostTarget("linux", "x64"), TARGETS["linux-x64"]);
  assert.equal(hostTarget("darwin", "x64"), null, "an Intel Mac: onnxruntime-node has no build for it");
  if (process.platform === "win32") return;
  // Run it: through a link to its folder, as AI clients reach it, with arguments that need quoting.
  const root = folder(t);
  const runtime = path.join(root, "copy");
  write(runtime, { "ai-dev-mcp-server/bin/ai-dev.mjs": "console.log(JSON.stringify(process.argv.slice(2)));\n" });
  fs.mkdirSync(path.join(runtime, "node", "bin"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(runtime, "node", "bin", "node"));
  fs.writeFileSync(path.join(runtime, "ai-dev"), POSIX_SHIM, { mode: 0o755 });
  fs.symlinkSync(runtime, path.join(root, "current"), "dir");
  const { spawnSync } = await import("node:child_process");
  const ran = spawnSync(path.join(root, "current", "ai-dev"), ["skills", "new", "a b", "it's"], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), ["skills", "new", "a b", "it's"]);
});

/** A `.tar.gz` of `entries` ([name, content, type]), with a GNU long name and a pax path, as Node's archives may hold. */
async function tarGz(file, entries) {
  const { gzipSync } = await import("node:zlib");
  const blocks = [];
  const header = (name, size, type, mode = 0o755) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 99), 0, "utf8");
    block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
    block.write("0000000\0", 108);
    block.write("0000000\0", 116);
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    block.write("00000000000\0", 136);
    block.write("        ", 148);
    block.write(type, 156);
    block.write("ustar\0", 257);
    block.write("00", 263);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return block;
  };
  const data = (content) => {
    const bytes = Buffer.from(content);
    return [bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
  };
  for (const [name, content, type = "0", mode] of entries) {
    if (type === "L" || type === "x") blocks.push(header(type === "L" ? "././@LongLink" : "PaxHeader", Buffer.byteLength(content), type), ...data(content));
    else blocks.push(header(name, Buffer.byteLength(content), type, mode), ...data(content));
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(file, gzipSync(Buffer.concat(blocks)));
}

test("a .tar.gz gives up the files asked for, with their modes, long names included", async (t) => {
  const root = folder(t);
  const archive = path.join(root, "node.tar.gz");
  const long = `node-v24/${"deep/".repeat(30)}bin/node`;
  const pax = `${long.length + 6 + String(long.length + 6).length} path=${long}\n`;
  await tarGz(archive, [
    ["node-v24/", "", "5"],
    ["node-v24/LICENSE", "the licence", "0", 0o644],
    ["node-v24/big", "x".repeat(70_000), "0", 0o644],
    ["", `${long}\0`, "L"],
    ["ignored-short-name", "#!/bin/node\n", "0", 0o755],
    ["", pax, "x"],
    ["ignored-too", "pax body", "0", 0o600],
    ["node-v24/link", "", "2"]
  ]);
  const out = path.join(root, "out");
  const written = await extractTarGz(archive, new Map([
    ["node-v24/LICENSE", path.join(out, "LICENSE")],
    [long, path.join(out, "node")],
    ["node-v24/link", path.join(out, "link")],
    ["node-v24/missing", path.join(out, "missing")]
  ]));
  assert.deepEqual(written, ["node-v24/LICENSE", long, long]);
  assert.equal(fs.readFileSync(path.join(out, "LICENSE"), "utf8"), "the licence");
  assert.equal(fs.readFileSync(path.join(out, "node"), "utf8"), "pax body", "the last entry of that name wins, as tar's own does");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(out, "node")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(out, "link")), false, "a link is not written");
});

test("electron-builder: a .dmg and a .zip for Apple silicon, signed ad hoc without a certificate; an AppImage and a .deb for Linux", () => {
  const mac = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.png", output: "/x/out", env: {}, target: targetOf("darwin-arm64") });
  assert.deepEqual(mac.mac.target, [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
  assert.deepEqual([mac.mac.identity, mac.mac.hardenedRuntime, mac.extraMetadata], ["-", false, undefined]);
  // Signing a Mach-O rewrites it: the runtime is left as bundle.json lists it.
  const runtimeFile = "/build/mac-arm64/AI Dev.app/Contents/Resources/runtime/node/bin/node";
  assert.ok(mac.mac.signIgnore.some((pattern) => new RegExp(pattern).test(runtimeFile)));
  assert.ok(!mac.mac.signIgnore.some((pattern) => new RegExp(pattern).test("/build/mac-arm64/AI Dev.app/Contents/MacOS/AI Dev")), "the app itself is signed");
  assert.equal(mac.win, undefined);
  assert.deepEqual(mac.extraResources.map((item) => item.to), ["runtime", "runtime/node_modules"]);
  const signed = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.png", output: "/x/out", env: { CSC_LINK: "/secret/id.p12" }, target: targetOf("darwin-arm64") });
  assert.deepEqual([signed.mac.identity, signed.mac.hardenedRuntime, signed.extraMetadata], [undefined, true, { aiDevSigned: true }], "a signed Mac app updates itself");
  const linux = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.png", output: "/x/out", env: {}, target: targetOf("linux-x64") });
  assert.deepEqual(linux.linux.target, [{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] }]);
  assert.equal(linux.executableName, "ai-dev-desktop", "a name a shell and a .desktop file take as it is");
  assert.equal(linux.linux.category, "Development");
  assert.deepEqual(linux.appImage.executableArgs, [], "the sandbox is AppRun's call, not the menu entry's");
  assert.deepEqual(linux.publish, [RELEASES]);
});

test("a signing secret that is set but empty is taken as not set: electron-builder would import it as a certificate", () => {
  const env = { CSC_LINK: "", CSC_KEY_PASSWORD: " ", APPLE_ID: "", APPLE_TEAM_ID: "TEAM", CSC_NAME: "Developer ID Application: X", PATH: "" };
  assert.deepEqual(dropEmptySigning(env), ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID"]);
  assert.deepEqual(env, { APPLE_TEAM_ID: "TEAM", CSC_NAME: "Developer ID Application: X", PATH: "" }, "what is set stays, and nothing else is touched");
  const adHoc = builderConfig({ desktopRoot, runtimeDir: "/x/runtime", icon: "/x/icon.png", output: "/x/out", env: { CSC_LINK: "" }, target: targetOf("darwin-arm64") });
  assert.equal(adHoc.mac.identity, "-", "the same empty secret means ad hoc to the config");
  assert.deepEqual(dropEmptySigning({}), []);
});

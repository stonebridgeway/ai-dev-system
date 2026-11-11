/**
 * The parts of the desktop app's build that can be checked without building
 * it (docs/DESKTOP.md, "The desktop install"): what is cut from the runtime's
 * dependencies, the runtime's `bundle.json`, its composition, the app's icon
 * and electron-builder's configuration, for each system the app is built
 * for. `build-desktop.mjs` (`npm run dist:win`, `dist:mac`, `dist:linux`)
 * runs them in order.
 */
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * The systems the app is built for, each with what its runtime holds: the
 * Node it ships and where, the command beside the runtime's stable link, and
 * the native builds of sharp and onnxruntime-node it keeps. macOS is Apple
 * silicon only: onnxruntime-node ships no build for an Intel Mac, and the
 * local model would not load there.
 */
export const TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    pin: "node-win-x64.json",
    node: "node/node.exe",
    command: "ai-dev.cmd",
    sharp: Object.freeze(["sharp-win32-x64"]),
    onnx: Object.freeze(["onnxruntime_binding.node", "onnxruntime.dll"])
  }),
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    pin: "node-darwin-arm64.json",
    node: "node/bin/node",
    command: "ai-dev",
    sharp: Object.freeze(["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"]),
    onnx: Object.freeze(["onnxruntime_binding.node", "libonnxruntime.1.dylib"])
  }),
  "linux-x64": Object.freeze({
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    pin: "node-linux-x64.json",
    node: "node/bin/node",
    command: "ai-dev",
    sharp: Object.freeze(["sharp-linux-x64", "sharp-libvips-linux-x64"]),
    onnx: Object.freeze(["onnxruntime_binding.node", "libonnxruntime.so.1"])
  })
});

/** A target by its id, or an error that lists them. */
export function targetOf(id) {
  if (Object.hasOwn(TARGETS, id)) return TARGETS[id];
  throw new Error(`There is no target ${JSON.stringify(id)}: the app is built for ${Object.keys(TARGETS).join(", ")}.`);
}

/** The system the build runs on, when the app is built for it. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  return TARGETS[`${platform}-${arch}`] ?? null;
}

/**
 * What the runtime never loads on any system, cut from its `node_modules`.
 * Checked on the code it ships: the dense model's end-to-end test passes
 * without them.
 */
export const TRIMMED = Object.freeze([
  Object.freeze({ path: "onnxruntime-web", why: "transformers 4.3.0 carries the web runtime inside its own file; its Node build loads onnxruntime-node" }),
  Object.freeze({ path: "@img/sharp-wasm32", why: "sharp loads its native build for the system; npm installs the WebAssembly build only as a leftover nothing requires (npm ls: extraneous)" }),
  Object.freeze({ path: "@emnapi/runtime", why: "only @img/sharp-wasm32 requires it" }),
  Object.freeze({ path: "tslib", why: "only @emnapi/runtime requires it" }),
  Object.freeze({ path: ".bin", why: "npm's command links: the runtime runs none of them, and a link is not a file to ship" })
]);

/** Where onnxruntime-node keeps a native build per system and processor: only the target's stays. */
export const ONNX_BINARIES = "onnxruntime-node/bin/napi-v6";

/** The Windows install's own command beside its stable link: its Node, its CLI, the arguments as given. */
export const BUNDLE_SHIM = "@echo off\r\n\"%~dp0node\\node.exe\" \"%~dp0ai-dev-mcp-server\\bin\\ai-dev.mjs\" %*\r\n";

/**
 * The same command on macOS and Linux: a shell script that runs the
 * runtime's own Node from the folder it lies in — reached through the stable
 * link, the link's folder, whose `node` the link leads into.
 */
export const POSIX_SHIM = [
  "#!/bin/sh",
  "here=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
  "exec \"$here/node/bin/node\" \"$here/ai-dev-mcp-server/bin/ai-dev.mjs\" \"$@\"",
  ""
].join("\n");

/** The command a target's runtime is run by from a terminal, and its text. */
export function commandFile(target) {
  return target.platform === "win32" ? { name: target.command, text: BUNDLE_SHIM, mode: 0o644 } : { name: target.command, text: POSIX_SHIM, mode: 0o755 };
}

/** What an installed runtime may weigh, unpacked; the build stops above it. */
export const RUNTIME_BUDGET_BYTES = 360 * 1024 * 1024;

async function bytesOf(target) {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(target)) total += await bytesOf(path.join(target, entry));
  return total;
}

/**
 * Cut what the runtime never loads on the target from `<runtime>/node_modules`:
 * the web builds, and the native builds of every other system and processor.
 *
 * @param {string} runtimeDir
 * @param {{ target?: typeof TARGETS[keyof typeof TARGETS] }} [options] - Windows when left out.
 * @returns {Promise<Array<{ path: string, bytes: number, why: string }>>} what was cut
 */
export async function trimRuntime(runtimeDir, { target = TARGETS["win32-x64"] } = {}) {
  const modules = path.join(runtimeDir, "node_modules");
  const removed = [];
  const cut = async (relative, why) => {
    const target = path.join(modules, ...relative.split("/"));
    const bytes = await bytesOf(target);
    if (!bytes && !await fs.lstat(target).then(() => true, () => false)) return;
    await fs.rm(target, { recursive: true, force: true });
    removed.push({ path: `node_modules/${relative}`, bytes, why });
  };
  for (const item of TRIMMED) await cut(item.path, item.why);
  // sharp's native builds of other systems, should a build machine have put any there.
  for (const name of await fs.readdir(path.join(modules, "@img")).catch(() => [])) {
    if (name.startsWith("sharp-") && !target.sharp.includes(name)) await cut(`@img/${name}`, "a native sharp of another system");
  }
  const binaries = path.join(modules, ...ONNX_BINARIES.split("/"));
  for (const system of await fs.readdir(binaries).catch(() => [])) {
    if (system !== target.platform) {
      await cut(`${ONNX_BINARIES}/${system}`, "onnxruntime-node for another system");
      continue;
    }
    for (const arch of await fs.readdir(path.join(binaries, system)).catch(() => [])) {
      if (arch !== target.arch) await cut(`${ONNX_BINARIES}/${system}/${arch}`, "onnxruntime-node for another processor");
    }
  }
  return removed;
}

/**
 * What a package names among its dependencies and the trimmed runtime does not
 * have, on purpose — the dependent and the dependency, exactly: transformers
 * names the web runtime it carries inside its own file (`TRIMMED`).
 */
export const CUT_DEPENDENCIES = Object.freeze([
  Object.freeze({ from: "@huggingface/transformers", to: "onnxruntime-web" })
]);

/**
 * Packages whose dependencies the trimmed tree no longer has — a cut that
 * went too far. A dependency is looked for as Node looks for it: in the
 * package's own `node_modules`, then in each one above it; the packages inside
 * other packages' `node_modules` are checked as well. Only the pairs in
 * `allowed` are not reported: a package cut here that another one comes to
 * need is.
 *
 * @param {string} modules - `<runtime>/node_modules`.
 * @param {{ allowed?: ReadonlyArray<{ from: string, to: string }> }} [options]
 * @returns {Promise<Array<{ package: string, missing: string }>>} `package`: its folder under `modules`
 */
export async function danglingDependencies(modules, { allowed = CUT_DEPENDENCIES } = {}) {
  const packages = [];
  const visit = async (name, folder, above) => {
    packages.push({ name, folder, lookup: [path.join(folder, "node_modules"), ...above] });
    await walk(path.join(folder, "node_modules"), above);
  };
  // `parent` is a node_modules folder; `outer`, the ones above it, nearest first.
  const walk = async (parent, outer) => {
    for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      if (!entry.name.startsWith("@")) {
        await visit(entry.name, path.join(parent, entry.name), [parent, ...outer]);
        continue;
      }
      for (const inner of await fs.readdir(path.join(parent, entry.name), { withFileTypes: true }).catch(() => [])) {
        if (inner.isDirectory()) await visit(`${entry.name}/${inner.name}`, path.join(parent, entry.name, inner.name), [parent, ...outer]);
      }
    }
  };
  await walk(modules, []);
  const dangling = [];
  for (const { name, folder, lookup } of packages) {
    const file = path.join(folder, "package.json");
    const text = await fs.readFile(file, "utf8").catch(() => null);
    let manifest = null;
    try {
      manifest = text === null ? null : JSON.parse(text);
    } catch (error) {
      // A dependency the runtime would fail to load: the build says which.
      throw new Error(`${file} is not JSON: ${error.message}`);
    }
    for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
      if (allowed.some((pair) => pair.from === name && pair.to === dependency)) continue;
      const found = await Promise.all(lookup.map((dir) => fs.access(path.join(dir, ...dependency.split("/"), "package.json")).then(() => true, () => false)));
      if (!found.includes(true)) dangling.push({ package: path.relative(modules, folder).split(path.sep).join("/"), missing: dependency });
    }
  }
  return dangling;
}

/**
 * The app's version against its runtime's: the updater compares the app's
 * version with the release's, so a release that changed only the runtime
 * would reach no installed app.
 *
 * @param {{ app: string, runtime: string }} versions
 * @returns {string} what is wrong, or ""
 */
export function versionProblem({ app, runtime }) {
  return app === runtime ? "" : `the app is version ${app} and its runtime ${runtime}: desktop/package.json and the server's package.json must name one version, the updater reads the app's`;
}

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Every file under `root`, by its `/`-separated path, with size and sha256,
 * sorted. Links are refused: the runtime is copied file by file, and a link
 * would be followed into whatever it names.
 *
 * @param {string} root
 * @param {{ skip?: (relative: string) => boolean }} [options]
 * @returns {Promise<Array<{ path: string, bytes: number, sha256: string }>>}
 */
export async function listFiles(root, { skip = () => false } = {}) {
  const files = [];
  const walk = async (folder, prefix) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip(relative)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${full} is a link; the runtime ships files only.`);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files.push({ path: relative, bytes: (await fs.stat(full)).size, sha256: await sha256Of(full) });
    }
  };
  await walk(root, "");
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Write `<runtime>/bundle.json`: what the installer ships, file by file, and
 * the fingerprint the app names its copy by — and read it back by `parse`, the
 * app's own parser, when given: a runtime the app would refuse on every
 * machine (two names Windows takes for one) stops the build, not the person.
 *
 * @param {{ runtimeDir: string, name: string, version: string, node: { version: string, sha256: string, file?: string }, fingerprintOf: (files: Array<{ path: string, sha256: string }>) => string, parse?: (text: string, where: string) => unknown, target?: typeof TARGETS[keyof typeof TARGETS] }} input
 *   `node.file` — where the Node is in the runtime: the target's (`node/node.exe` on Windows) unless given; `target` — Windows when left out.
 */
export async function writeBundleMarker({ runtimeDir, name, version, node, fingerprintOf, parse, target = TARGETS["win32-x64"] }) {
  const files = await listFiles(runtimeDir, { skip: (relative) => relative === "bundle.json" });
  const marker = {
    schema_version: 1,
    name,
    version,
    platform: target.platform,
    arch: target.arch,
    node: { version: node.version, file: node.file ?? target.node, sha256: node.sha256 },
    fingerprint: fingerprintOf(files),
    files
  };
  const file = path.join(runtimeDir, "bundle.json");
  const text = `${JSON.stringify(marker, null, 1)}\n`;
  await fs.writeFile(file, text);
  parse?.(text, file);
  return marker;
}

/** What a runtime holds, by top-level folder (and inside node_modules, by package): the composition the build report carries. */
export function compositionReport(files) {
  const groups = new Map();
  for (const file of files) {
    const parts = file.path.split("/");
    let key = parts.length > 1 ? parts[0] : "(top level)";
    if (parts[0] === "node_modules" && parts.length > 2) key = `node_modules/${parts[1].startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1]}`;
    const group = groups.get(key) ?? { files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += file.bytes;
    groups.set(key, group);
  }
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    groups: Object.fromEntries([...groups].sort((left, right) => right[1].bytes - left[1].bytes)),
    largest: [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 10).map(({ path: file, bytes }) => ({ path: file, bytes }))
  };
}

/** Paths a target's runtime must not hold: the cuts above, made sure of. */
function forbidden(target) {
  const onnx = `node_modules/${ONNX_BINARIES}`;
  return [
    /^node_modules\/onnxruntime-web\//,
    { test: (file) => file.startsWith("node_modules/@img/sharp-") && !target.sharp.some((name) => file.startsWith(`node_modules/@img/${name}/`)) },
    { test: (file) => file.startsWith(`${onnx}/`) && !file.startsWith(`${onnx}/${target.platform}/`) },
    { test: (file) => file.startsWith(`${onnx}/${target.platform}/`) && !file.startsWith(`${onnx}/${target.platform}/${target.arch}/`) },
    /(?:^|\/)\.git\//
  ];
}

/** Files a target's runtime cannot work without. */
function required(target) {
  return [
    "distribution.json",
    target.command,
    target.node,
    "node/LICENSE",
    "ai-dev-mcp-server/bin/ai-dev.mjs",
    "ai-dev-mcp-server/src/core/app-bundle.mjs",
    "seed/public-seed.manifest.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    ...target.onnx.map((file) => `node_modules/${ONNX_BINARIES}/${target.platform}/${target.arch}/${file}`),
    ...target.sharp.map((name) => `node_modules/@img/${name}/package.json`),
    "node_modules/@huggingface/transformers/package.json"
  ];
}

/**
 * What is wrong with a runtime's composition, in words; empty when nothing is.
 *
 * @param {Array<{ path: string, bytes: number, sha256: string }>} files
 * @param {{ nodeSha256: string, budget?: number, target?: typeof TARGETS[keyof typeof TARGETS] }} expected - Windows when no target is given.
 * @returns {string[]}
 */
export function compositionProblems(files, { nodeSha256, budget = RUNTIME_BUDGET_BYTES, target = TARGETS["win32-x64"] }) {
  const problems = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const pattern of forbidden(target)) {
    const found = files.filter((file) => pattern.test(file.path));
    if (found.length) problems.push(`${found.length} file(s) that must not ship, such as ${found[0].path}`);
  }
  for (const file of required(target)) {
    if (!byPath.has(file)) problems.push(`${file} is missing`);
  }
  const node = byPath.get(target.node);
  if (node && node.sha256 !== nodeSha256) problems.push(`${target.node} has sha256 ${node.sha256}, not the pinned ${nodeSha256}`);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > budget) problems.push(`the runtime weighs ${total} bytes, over its budget of ${budget}`);
  return problems;
}

/**
 * An `.ico` of PNG images (Windows Vista and later read PNG inside ICO): the
 * app's icon, drawn at build time — the repository keeps binaries out.
 *
 * @param {Array<{ size: number, data: Buffer }>} images - square PNGs, 256 at most
 * @returns {Buffer}
 */
export function icoFrom(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError(`an icon image of ${size} pixels`);
    const at = index * 16;
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

/** Azure Trusted Signing: named all together, or not at all. */
export const AZURE_SIGNING = Object.freeze(["AI_DEV_SIGN_AZURE_ENDPOINT", "AI_DEV_SIGN_AZURE_ACCOUNT", "AI_DEV_SIGN_AZURE_PROFILE", "AI_DEV_SIGN_PUBLISHER"]);

/**
 * electron-builder's Azure signing options, when the endpoint is named. The
 * publisher is what electron-builder writes into `app-update.yml` and what
 * electron-updater checks every update's signature against: the signing
 * certificate's own name, which nothing here can guess — a wrong one refuses
 * every update to every installed app. So the four
 * are named together, or the build stops.
 */
function azureSigning(env) {
  if (!String(env.AI_DEV_SIGN_AZURE_ENDPOINT ?? "").trim()) return {};
  const missing = AZURE_SIGNING.filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) {
    throw new Error(`Azure signing is set up (AI_DEV_SIGN_AZURE_ENDPOINT) but not ${missing.join(", ")}: `
      + "AI_DEV_SIGN_PUBLISHER is the signing certificate's name, as the updater checks it.");
  }
  return {
    azureSignOptions: {
      publisherName: env.AI_DEV_SIGN_PUBLISHER,
      endpoint: env.AI_DEV_SIGN_AZURE_ENDPOINT,
      codeSigningAccountName: env.AI_DEV_SIGN_AZURE_ACCOUNT,
      certificateProfileName: env.AI_DEV_SIGN_AZURE_PROFILE
    }
  };
}

/** The production repository: where updates come from. */
export const RELEASES = Object.freeze({ provider: "github", owner: "stonebridgeway", repo: "ai-dev-system", releaseType: "release" });

/** What electron-builder leaves unsigned in the Mac app: the runtime, whose files bundle.json lists by sha256. */
export const MAC_RUNTIME_UNSIGNED = "/Contents/Resources/runtime/";

/** A Mac build is signed when a certificate is named (CSC_LINK or CSC_NAME, which electron-builder reads itself). */
const macCertificate = (env) => Boolean(String(env.CSC_LINK ?? "").trim() || String(env.CSC_NAME ?? "").trim());

/** The signing variables electron-builder reads itself. */
export const SIGNING_VARIABLES = Object.freeze(["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);

/**
 * Take out the signing variables that are set but empty — a secret a fork,
 * or a repository with no certificate yet, does not have. Set, electron-builder
 * takes an empty CSC_LINK for a certificate and imports the folder it runs in;
 * unset, the build is signed ad hoc, as `builderConfig` says.
 *
 * @returns {string[]} the names taken out
 */
export function dropEmptySigning(env = process.env) {
  const dropped = SIGNING_VARIABLES.filter((name) => Object.hasOwn(env, name) && !String(env[name] ?? "").trim());
  for (const name of dropped) delete env[name];
  return dropped;
}

/**
 * electron-builder's configuration of the app for a target.
 *
 * Windows: an NSIS installer for the current user, no administrator. Signing
 * comes from the environment: a certificate file in `CSC_LINK` /
 * `WIN_CSC_LINK` with its password, which electron-builder reads itself, or
 * Azure Trusted Signing named by the `AI_DEV_SIGN_AZURE_*` variables. Without
 * either the build is unsigned.
 *
 * macOS: a `.dmg` to drag the app from and a `.zip` beside it, for Apple
 * silicon. With a Developer ID certificate in `CSC_LINK` it is signed with the
 * hardened runtime (and notarized when the `APPLE_*` variables are set);
 * without one it is signed ad hoc, which Apple silicon needs to run it at
 * all, and opened the first time with Open in the Finder's menu.
 *
 * Linux: an AppImage, which runs anywhere and updates itself, and a `.deb`.
 *
 * @param {{ desktopRoot: string, runtimeDir: string, icon: string, output: string, env?: NodeJS.ProcessEnv, target?: typeof TARGETS[keyof typeof TARGETS] }} input
 *   `icon`: an `.ico` for Windows, a PNG of 1024 pixels for the others; `target`: Windows when left out.
 * @returns {object}
 */
export function builderConfig({ desktopRoot, runtimeDir, icon, output, env = process.env, target = TARGETS["win32-x64"] }) {
  const common = {
    appId: "com.stonebridgeway.ai-dev",
    productName: "AI Dev",
    executableName: "AI Dev",
    copyright: "Copyright © 2026 stonebridgeway",
    directories: { output, buildResources: path.join(desktopRoot, "build") },
    // The app's own code; its production dependencies (electron-updater) are added by electron-builder.
    files: ["package.json", "src/**/*"],
    // electron-builder leaves out a `node_modules` folder at the top of what
    // it copies, so the runtime's dependencies are a second entry of their own:
    // without it the installed runtime would have none.
    extraResources: [
      { from: runtimeDir, to: "runtime", filter: ["**/*"] },
      { from: path.join(runtimeDir, "node_modules"), to: "runtime/node_modules", filter: ["**/*"] }
    ],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    publish: [RELEASES]
  };
  if (target.platform === "darwin") {
    const signed = macCertificate(env);
    return {
      ...common,
      mac: {
        target: [{ target: "dmg", arch: [target.arch] }, { target: "zip", arch: [target.arch] }],
        icon,
        category: "public.app-category.developer-tools",
        artifactName: "AI-Dev-${version}-mac-${arch}.${ext}",
        // "-" is an ad-hoc signature: no certificate, but a binary Apple silicon runs.
        ...(signed ? { hardenedRuntime: true } : { identity: "-", hardenedRuntime: false }),
        // The runtime keeps the bytes bundle.json lists: signing a Mach-O rewrites it, and the
        // app would refuse its own runtime. Its Node is signed by Node.js, its native modules by
        // their linker; the app's own signature seals them as resources.
        signIgnore: [MAC_RUNTIME_UNSIGNED]
      },
      // Only a Developer ID build updates itself on macOS (`updates.mjs`).
      ...(signed ? { extraMetadata: { aiDevSigned: true } } : {}),
      dmg: { artifactName: "AI-Dev-${version}-mac-${arch}.${ext}" }
    };
  }
  if (target.platform === "linux") {
    return {
      ...common,
      // A name a shell and a .desktop file take as it is; the window is that .desktop file's.
      executableName: "ai-dev-desktop",
      extraMetadata: { desktopName: "ai-dev-desktop.desktop" },
      linux: {
        target: [{ target: "AppImage", arch: [target.arch] }, { target: "deb", arch: [target.arch] }],
        icon,
        category: "Development",
        maintainer: "stonebridgeway",
        synopsis: "A tray, a first-run wizard and a status screen over the AI Dev daemon",
        artifactName: "AI-Dev-${version}-linux-${arch}.${ext}",
        syncDesktopName: true
      },
      // The AppImage's AppRun turns Chromium's sandbox off only where it cannot start (no user
      // namespaces, as on Ubuntu 24.04); its menu entry would otherwise turn it off everywhere.
      appImage: { executableArgs: [] },
      deb: { packageName: "ai-dev-desktop" }
    };
  }
  const azure = azureSigning(env);
  return {
    ...common,
    win: {
      target: [{ target: "nsis", arch: [target.arch] }],
      icon,
      artifactName: "AI-Dev-Setup-${version}.${ext}",
      ...azure
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "AI Dev",
      // Electron's own cache in %APPDATA%; AI Dev's data is asked about (installer.nsh).
      deleteAppDataOnUninstall: true,
      include: path.join(desktopRoot, "build", "installer.nsh"),
      installerLanguages: ["en_US", "ru_RU"],
      multiLanguageInstaller: true
    }
  };
}

/** A field of a tar header: text up to its first NUL. */
const tarText = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");

/**
 * Take some files out of a `.tar.gz` — the Node of macOS and Linux comes as
 * one — streaming, with their modes: `wanted` maps an entry's path in the
 * archive to the file it is written to. A long name (GNU `L`, or a pax
 * `path`) is read; links and folders are not written.
 *
 * @param {string} archive
 * @param {Map<string, string>} wanted
 * @returns {Promise<string[]>} the entries written
 */
export async function extractTarGz(archive, wanted) {
  const { createGunzip } = await import("node:zlib");
  const written = [];
  let buffer = Buffer.alloc(0);
  let entry = null; // { name, size, left, mode, type, out, chunks }
  let longName = null;
  const finish = async () => {
    if (entry.out) {
      await entry.out.close();
      written.push(entry.name);
    }
    if (entry.type === "L") longName = Buffer.concat(entry.chunks).toString("utf8").replace(/\0[\s\S]*$/, "");
    if (entry.type === "x") {
      const pax = Buffer.concat(entry.chunks).toString("utf8");
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax);
      if (found) longName = found[1];
    }
    entry = null;
  };
  for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (!entry) {
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) continue;
        const prefix = tarText(header, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${tarText(header, 0, 100)}` : tarText(header, 0, 100));
        longName = null;
        const size = Number.parseInt(tarText(header, 124, 12).trim() || "0", 8);
        const mode = Number.parseInt(tarText(header, 100, 8).trim() || "644", 8) & 0o777;
        const type = String.fromCharCode(header[156] || 48);
        const target = (type === "0" || type === "\0") && wanted.get(name);
        let out = null;
        if (target) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          out = await fs.open(target, "w", mode);
        }
        entry = { name, size, left: size, padding: (512 - (size % 512)) % 512, mode, type, out, chunks: [] };
      }
      const take = Math.min(entry.left, buffer.length);
      if (take) {
        const piece = buffer.subarray(0, take);
        if (entry.out) await entry.out.write(piece);
        else if (entry.type === "L" || entry.type === "x") entry.chunks.push(Buffer.from(piece));
        buffer = buffer.subarray(take);
        entry.left -= take;
      }
      if (entry.left) break;
      if (buffer.length < entry.padding) break;
      buffer = buffer.subarray(entry.padding);
      if (entry.out) await entry.out.chmod(entry.mode);
      await finish();
    }
  }
  if (entry?.out) await entry.out.close();
  return written;
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dockerCommand, dockerEmbedCommand, frontendQaHint, hint, isEphemeralInstall, OWN_SERVER_ROOT, PACKAGE_NAME, resolveInstallLayout, runtimeRepairHint } from "./install-layout.mjs";

const home = path.resolve("/home/me");
const env = (extra = {}) => ({ HOME: home, USERPROFILE: "", ...extra });

/** A filesystem of the given paths, for `exists`. */
function only(...paths) {
  const present = new Set(paths.map((item) => path.resolve(item)));
  return (target) => present.has(path.resolve(target));
}

test("a checkout of this repository is a clone: its content is the bundled seed", () => {
  const layout = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env() });
  assert.equal(layout.kind, "clone");
  assert.equal(layout.contentRoot, path.join(path.dirname(OWN_SERVER_ROOT), "docker", "public-seed"));
  assert.equal(layout.seedRoot, "", "a clone's seed is its content: nothing to sync");
  assert.equal(layout.runtimeRoot, path.join(home, ".ai-dev"));
});

test("a clone its user cannot write to serves a vault of the user's own, filled from its seed", () => {
  const seed = path.join(path.dirname(OWN_SERVER_ROOT), "docker", "public-seed");
  const readOnly = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env(), writable: (target) => target !== seed });
  assert.equal(readOnly.kind, "clone", "commands are still spelled as a clone's");
  assert.equal(readOnly.contentRoot, path.join(home, ".ai-dev", "vault"));
  assert.equal(readOnly.seedRoot, seed);

  const asked = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env({ AI_DEV_VAULT: " Home " }), writable: () => true });
  assert.equal(asked.contentRoot, path.join(home, ".ai-dev", "vault"), "AI_DEV_VAULT=home asks for it where the clone is writable");
  assert.equal(asked.seedRoot, seed);
  assert.equal(resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env({ AI_DEV_VAULT: "clone" }), writable: () => true }).contentRoot, seed,
    "any other value leaves a writable clone as it was");

  const named = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env({ AI_DEV_VAULT: "home", AI_DEV_VAULT_ROOT: "/srv/notes" }), writable: () => false });
  assert.equal(named.contentRoot, path.resolve("/srv/notes"), "a vault named is read where it is");
  assert.equal(named.seedRoot, "", "and is not filled from the seed");

  const root = path.resolve("/usr/lib/node_modules/ai-dev-system");
  const pkg = resolveInstallLayout({
    serverRoot: path.join(root, "ai-dev-mcp-server"),
    env: env({ AI_DEV_VAULT: "home" }),
    exists: only(path.join(root, "distribution.json"), path.join(root, "seed", "public-seed.manifest.json")),
    writable: () => false
  });
  assert.equal(pkg.kind, "package", "a package's vault is the user's already");
  assert.equal(pkg.seedRoot, path.join(root, "seed"));
});

test("a full vault two levels above the server is a vault; AI_DEV_VAULT_ROOT moves the content, not the kind", () => {
  const server = path.resolve("/vault/09-mcp/ai-dev-mcp-server");
  const inVault = resolveInstallLayout({ serverRoot: server, env: env(), exists: only("/vault/03-skills-catalog") });
  assert.equal(inVault.kind, "vault");
  assert.equal(inVault.contentRoot, path.resolve("/vault"));
  const named = resolveInstallLayout({ serverRoot: OWN_SERVER_ROOT, env: env({ AI_DEV_VAULT_ROOT: "/elsewhere/notes" }) });
  assert.equal(named.kind, "clone", "the code is still a clone, and its commands are still npm run");
  assert.equal(named.contentRoot, path.resolve("/elsewhere/notes"));
});

test("a package npx runs with AI_DEV_VAULT_ROOT set is still a package in npx's cache", () => {
  const root = path.resolve("/home/me/.npm/_npx/abc/node_modules/ai-dev-system");
  const layout = resolveInstallLayout({
    serverRoot: path.join(root, "ai-dev-mcp-server"),
    env: env({ AI_DEV_VAULT_ROOT: "/home/me/notes" }),
    exists: only(path.join(root, "distribution.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.ephemeral, true, "so setup installs the app home, and clients are never pointed here");
  assert.equal(layout.contentRoot, path.resolve("/home/me/notes"));
  assert.equal(layout.seedRoot, "", "a vault of the user's own is not filled from the package's seed");
  assert.equal(hint("npm run setup -- --model", layout), `npx ${PACKAGE_NAME} setup --model`);
  assert.match(runtimeRepairHint(layout), /^run `npx ai-dev-system setup`/);
});

test("a package keeps its seed read-only and the user's vault under the runtime folder", () => {
  const root = path.resolve("/usr/lib/node_modules/ai-dev-system");
  const server = path.join(root, "ai-dev-mcp-server");
  const layout = resolveInstallLayout({
    serverRoot: server,
    env: env(),
    exists: only(path.join(root, "distribution.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.root, root);
  assert.equal(layout.seedRoot, path.join(root, "seed"));
  assert.equal(layout.contentRoot, path.join(home, ".ai-dev", "vault"));
  assert.equal(layout.ephemeral, false);
  assert.equal(layout.appHome, false);

  const custom = resolveInstallLayout({ serverRoot: server, env: env({ AI_DEV_HOME: "/data/ai" }), exists: only() });
  assert.equal(custom.contentRoot, path.resolve("/data/ai/vault"), "AI_DEV_HOME is the runtime folder");
  assert.equal(custom.seedRoot, "", "no marker, no seed: nothing is copied from a folder that is not a distribution");
});

test("the image is docker, whatever the folders say", () => {
  const layout = resolveInstallLayout({ serverRoot: "/opt/ai-dev/app", env: env({ AI_DEV_RUNTIME: "Docker" }), exists: () => true });
  assert.equal(layout.kind, "docker");
  assert.equal(layout.contentRoot, path.resolve("/data/ai-dev-system"));
  const named = resolveInstallLayout({ serverRoot: "/opt/ai-dev/app", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/vault" }) });
  assert.equal(named.contentRoot, path.resolve("/data/vault"));
});

test("the 3.0 image is a distribution: its seed is synced into the volume's vault, which the image names itself", () => {
  const image = only("/opt/ai-dev/distribution.json", "/opt/ai-dev/seed/public-seed.manifest.json", "/opt/ai-dev/frontend-qa");
  const layout = resolveInstallLayout({ serverRoot: "/opt/ai-dev/ai-dev-mcp-server", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/ai-dev-system" }), exists: image });
  assert.equal(layout.kind, "docker");
  assert.equal(layout.contentRoot, path.resolve("/data/ai-dev-system"));
  assert.equal(layout.seedRoot, path.resolve("/opt/ai-dev/seed"));
  assert.equal(layout.bundle, false);
  // A 2.x image has no distribution: its entrypoint copied the seed, and nothing syncs it.
  const old = resolveInstallLayout({ serverRoot: "/opt/ai-dev/app", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/ai-dev-system" }), exists: only("/opt/ai-dev/public-seed/public-seed.manifest.json") });
  assert.equal(old.seedRoot, "");
  // A package keeps the rule: a vault of the user's own is not seeded.
  const own = resolveInstallLayout({ serverRoot: "/pkg/ai-dev-mcp-server", env: env({ AI_DEV_VAULT_ROOT: "/home/me/Vault" }), exists: only("/pkg/distribution.json", "/pkg/seed/public-seed.manifest.json") });
  assert.deepEqual([own.kind, own.seedRoot], ["package", ""]);
});

test("in the image a vault the user named is theirs, read where it is — unless a seed is there already", () => {
  const files = ["/opt/ai-dev/distribution.json", "/opt/ai-dev/seed/public-seed.manifest.json"];
  // A 2.x manifest is a manifest by its content: a file of the user's with its name is not one.
  const manifests = new Set([path.resolve("/data/myvault/public-seed.manifest.json")]);
  const layoutWith = (...extra) => resolveInstallLayout({
    serverRoot: "/opt/ai-dev/ai-dev-mcp-server", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/myvault" }), exists: only(...files, ...extra),
    isManifest: (file) => only(...extra)(file) && manifests.has(path.resolve(file))
  });
  const mine = layoutWith();
  assert.deepEqual([mine.kind, mine.contentRoot, mine.seedRoot], ["docker", path.resolve("/data/myvault"), ""], "nothing is copied into it, nothing removed from it");
  assert.equal(layoutWith("/data/myvault/.ai-dev-seed.json").seedRoot, path.resolve("/opt/ai-dev/seed"), "a vault the sync filled before");
  assert.equal(layoutWith("/data/myvault/public-seed.manifest.json").seedRoot, path.resolve("/opt/ai-dev/seed"), "a vault 2.x's cp -n filled, its manifest with it");
  manifests.clear();
  assert.equal(layoutWith("/data/myvault/public-seed.manifest.json").seedRoot, "", "a file of the user's named like the manifest");
  const trailing = resolveInstallLayout({ serverRoot: "/opt/ai-dev/ai-dev-mcp-server", env: env({ AI_DEV_RUNTIME: "docker", AI_DEV_VAULT_ROOT: "/data/ai-dev-system/" }), exists: only(...files) });
  assert.equal(trailing.seedRoot, path.resolve("/opt/ai-dev/seed"), "the image's own vault, however it is spelled");
});

test("npx's cache, pnpm's and yarn's dlx and bunx are one-run folders; the app home is not", () => {
  assert.equal(isEphemeralInstall("/home/me/.npm/_npx/0123abcd/node_modules/ai-dev-system/ai-dev-mcp-server"), true);
  assert.equal(isEphemeralInstall("C:\\Users\\Me\\AppData\\Local\\npm-cache\\_npx\\0123\\node_modules\\x"), true);
  assert.equal(isEphemeralInstall("/home/me/.cache/pnpm/dlx/abc/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/tmp/xfs-1234/dlx-5678/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/tmp/bunx-1000-x@latest/node_modules/x"), true);
  assert.equal(isEphemeralInstall("/home/me/.ai-dev/app/3.0.0/ai-dev-mcp-server"), false);
  assert.equal(isEphemeralInstall("/home/me/src/npx-tools/ai-dev"), false, "a folder merely named like one is not");

  const server = path.join(home, ".ai-dev", "app", "3.0.0", "ai-dev-mcp-server");
  const layout = resolveInstallLayout({ serverRoot: server, env: env(), exists: only() });
  assert.equal(layout.appHome, true);
  assert.equal(layout.ephemeral, false);
});

test("hints are spelled the way each layout runs them", () => {
  const clone = { kind: "clone", ephemeral: false, appHome: false };
  const global = { kind: "package", ephemeral: false, appHome: false };
  const npx = { kind: "package", ephemeral: true, appHome: false };
  const appHome = { kind: "package", ephemeral: false, appHome: true };
  assert.equal(hint("npm run setup -- --model", clone), "npm run setup -- --model");
  assert.equal(hint("npm run setup -- --model", global), "ai-dev setup --model");
  assert.equal(hint("npm run setup -- --model", npx), `npx ${PACKAGE_NAME} setup --model`);
  assert.equal(hint("npm run setup", appHome), `npx ${PACKAGE_NAME} setup`);
  assert.equal(hint("npm run dense:doctor", global), "ai-dev model doctor");
  assert.equal(hint("npm run clients:install -- --clients all", global), "ai-dev clients install --clients all");
  assert.equal(hint("npm run ai-dev -- clients doctor", global), "ai-dev clients doctor");
  // Nobody has a shell in a client's container: the host runs one of its own.
  const docker = { kind: "docker", ephemeral: false, appHome: false, serverRoot: "/opt/ai-dev/ai-dev-mcp-server" };
  assert.equal(hint("npm run doctor", docker), "docker run --rm -it --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev doctor");
  assert.equal(hint("npm run setup -- --model", docker),
    "docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev model install",
    "the model goes into the volume, with the network that one run needs");
  assert.equal(hint("npm run model -- import <folder or .zip>", docker),
    "docker run --rm -it --mount type=volume,source=ai-dev-system-data,target=/data --mount type=bind,source=<folder or .zip>,target=/import,readonly <image> ai-dev model import /import");
  // The volume is the one at the image's /data, whatever the host named it; a mount there with no name, a placeholder.
  assert.equal(dockerCommand("setup --model", "team-data"),
    "docker run --rm -it --network bridge --mount type=volume,source=team-data,target=/data <image> ai-dev model install");
  assert.equal(dockerCommand("setup --model", null),
    "docker run --rm -it --network bridge --mount <what your sessions mount at /data> <image> ai-dev model install");
  // A model folder of the host's at /models is embedded with, offline, into the same place.
  assert.equal(dockerEmbedCommand("team-data"), "docker run --rm -it --mount type=volume,source=team-data,target=/data "
    + "--mount type=bind,source=<the model folder>,target=/models,readonly <image> ai-dev setup --model");
  assert.equal(dockerEmbedCommand(null), "docker run --rm -it --mount <what your sessions mount at /data> "
    + "--mount type=bind,source=<the model folder>,target=/models,readonly <image> ai-dev setup --model");
  assert.equal(hint("npm run check", global), "npm run check", "a script only a checkout has stays as written");
  assert.equal(hint("git pull", global), "git pull");
  const windows = { kind: "package", ephemeral: false, appHome: true, bundle: true, runtimeRoot: path.join(home, ".ai-dev"), platform: "win32" };
  assert.equal(hint("npm run setup -- --model", windows), `${path.join(home, ".ai-dev", "app", "current", "ai-dev.cmd")} setup --model`,
    "the Windows installer puts nothing on PATH: its shim beside the stable link, unquoted, as cmd and PowerShell both run it");
  const spaced = path.resolve("/home/John Smith/.ai-dev");
  assert.equal(hint("npm run doctor", { ...windows, runtimeRoot: spaced }), `& '${path.join(spaced, "app", "current", "ai-dev.cmd")}' doctor`,
    "a path with a space is quoted, and PowerShell runs a quoted path only after &");
  for (const name of ["O'Brien", "R&D", "dev(2)", "$admin"]) {
    const unusual = path.resolve(`/home/${name}/.ai-dev`);
    const shim = path.join(unusual, "app", "current", "ai-dev.cmd");
    assert.equal(hint("npm run doctor", { ...windows, runtimeRoot: unusual }), `& '${shim.replaceAll("'", "''")}' doctor`,
      `${name}: in single quotes, which PowerShell does not expand, ' doubled`);
  }
  const cyrillic = path.resolve("/home/Дмитрий/.ai-dev");
  assert.equal(hint("npm run doctor", { ...windows, runtimeRoot: cyrillic }), `${path.join(cyrillic, "app", "current", "ai-dev.cmd")} doctor`,
    "letters of any alphabet need no quotes");
  // The macOS and Linux app: the `ai-dev` shell script beside the link, quoted for a POSIX shell. Its paths are
  // a POSIX system's: on Windows the same layout would be written with backslashes, which a POSIX shell rightly
  // gets in quotes.
  if (process.platform === "win32") return;
  const posix = { ...windows, platform: "darwin" };
  assert.equal(hint("npm run doctor", posix), `${path.join(home, ".ai-dev", "app", "current", "ai-dev")} doctor`);
  const quoted = path.resolve("/Users/O'Brien Smith/.ai-dev");
  assert.equal(hint("npm run doctor", { ...posix, platform: "linux", runtimeRoot: quoted }), `'${path.join(quoted, "app", "current", "ai-dev").replaceAll("'", "'\\''")}' doctor`,
    "in single quotes, which a POSIX shell does not expand, ' closed, escaped and opened again");
});

test("without the stable link the Windows install's hint names the shim in the copy it runs", async (t) => {
  // Its long name: a Windows runner's temp folder is C:\Users\RUNNER~1\…, whose ~ the hint rightly quotes.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-hint-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "rt");
  const copy = path.join(runtimeRoot, "app", "3.0.0-abcdef12");
  const layout = { kind: "package", ephemeral: false, appHome: true, bundle: true, runtimeRoot, root: copy, platform: "win32" };
  assert.equal(hint("npm run doctor", layout), `${path.join(copy, "ai-dev.cmd")} doctor`, "a drive that holds no link");
  await fs.mkdir(copy, { recursive: true });
  await fs.writeFile(path.join(copy, "ai-dev.cmd"), "");
  await fs.symlink(copy, path.join(runtimeRoot, "app", "current"), "dir");
  assert.equal(hint("npm run doctor", layout), `${path.join(runtimeRoot, "app", "current", "ai-dev.cmd")} doctor`);
});

test("the Windows installer's runtime is a package with a bundle, wherever it lies", () => {
  const root = path.join(home, ".ai-dev", "app", "3.0.0-abcdef12");
  const layout = resolveInstallLayout({
    serverRoot: path.join(root, "ai-dev-mcp-server"),
    env: env(),
    exists: only(path.join(root, "distribution.json"), path.join(root, "bundle.json"), path.join(root, "seed", "public-seed.manifest.json"))
  });
  assert.equal(layout.kind, "package");
  assert.equal(layout.bundle, true);
  assert.equal(layout.appHome, true);
  assert.equal(layout.seedRoot, path.join(root, "seed"), "its seed fills the user's vault, as a package's does");
  assert.match(runtimeRepairHint(layout, { platform: "win32", arch: "x64" }), /^quit AI Dev and start it again — it puts back the files of its runtime that went missing — and, if it says the installer's copy is damaged too, run the AI Dev installer again$/,
    "a start puts back what went missing; the installer only when its own copy is damaged");
  const npm = resolveInstallLayout({ serverRoot: path.join(root, "ai-dev-mcp-server"), env: env(), exists: only(path.join(root, "distribution.json")) });
  assert.equal(npm.bundle, false, "an npx copy has no bundle.json");
});

test("the model runtime's way back depends on how the package got here", () => {
  const linux = { platform: "linux", arch: "x64" };
  assert.equal(runtimeRepairHint({ kind: "clone" }, linux), "run `npm ci` in ai-dev-mcp-server/");
  assert.match(runtimeRepairHint({ kind: "package", ephemeral: true }, linux), /^run `npx ai-dev-system setup`/);
  assert.equal(runtimeRepairHint({ kind: "package", appHome: true, root: "/home/me/.ai-dev/app/3.0.0-abcdef12" }, linux),
    "run `npm ci --omit=dev --ignore-scripts` in /home/me/.ai-dev/app/3.0.0-abcdef12");
  assert.match(runtimeRepairHint({ kind: "package" }, linux), /ONNXRUNTIME_NODE_INSTALL=skip npm install -g ai-dev-system$/);
  assert.equal(runtimeRepairHint({ kind: "package" }, { platform: "win32", arch: "x64" }), `install the package again: npm install -g ${PACKAGE_NAME}`,
    "only Linux x64 has the CUDA download to skip");
  assert.match(runtimeRepairHint({ kind: "docker" }), /image/);
});

test("Frontend QA's browser comes, in the image, from its -browser variant: nothing installs into a client's container", () => {
  assert.match(frontendQaHint({ kind: "docker", ephemeral: false, appHome: false }), /`-browser` variant .*`:latest-browser`/);
  assert.doesNotMatch(frontendQaHint({ kind: "docker", ephemeral: false, appHome: false }), /setup|--frontend-qa/);
  assert.equal(frontendQaHint({ kind: "clone", ephemeral: false, appHome: false }), "run `npm run setup -- --frontend-qa` to install it");
  assert.equal(frontendQaHint({ kind: "package", ephemeral: false, appHome: false }), "run `ai-dev setup --frontend-qa` to install it");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleFingerprint, provisionBundle } from "./app-bundle.mjs";
import { APP_MARKER } from "./app-home.mjs";
import { exitStatus } from "../cli/uninstall.mjs";
import { inspectDataFolder, refuseDataRemoval, runsBundle, uninstallBundle } from "./bundle-uninstall.mjs";

const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-uninstall-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeBundle(root) {
  const files = {
    "distribution.json": "{}",
    "ai-dev-mcp-server/bin/ai-dev.mjs": "// cli\n",
    "node/node.exe": "node"
  };
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  await fs.writeFile(path.join(root, "bundle.json"), JSON.stringify({
    schema_version: 1, version: "3.0.0", node: { version: "24.22.0", file: "node/node.exe" }, fingerprint: bundleFingerprint(entries), files: entries
  }));
  return root;
}

/** A home with the Windows install provisioned, an npx copy beside it, and two clients: one runs the install, one a clone. */
async function stageHome(t) {
  const root = await scratch(t);
  const home = path.join(root, "home");
  const runtime = path.join(home, ".ai-dev");
  const env = { HOME: home, USERPROFILE: home, AI_DEV_HOME: runtime, XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData", "Roaming") };
  const provisioned = await provisionBundle({ bundleRoot: await writeBundle(path.join(root, "resources", "runtime")), runtimeRoot: runtime, env, home });
  const npx = path.join(runtime, "app", "3.0.0-0badcafe");
  await fs.mkdir(npx, { recursive: true });
  await fs.writeFile(path.join(npx, APP_MARKER), JSON.stringify({ schema_version: 1, content_fingerprint: "0badcafe", chosen_at: new Date().toISOString() }));
  await fs.mkdir(path.join(runtime, "state"), { recursive: true });
  await fs.writeFile(path.join(runtime, "state", "decisions.json"), "[]");
  const claude = path.join(home, ".claude.json");
  await fs.writeFile(claude, JSON.stringify({
    mcpServers: {
      "ai-dev": { type: "stdio", command: provisioned.node, args: [provisioned.cli, "mcp"] },
      other: { command: "other-server" }
    }
  }, null, 2));
  const cursor = path.join(home, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(cursor), { recursive: true });
  const cloneEntry = { command: "/usr/bin/node", args: ["/src/ai-dev-system/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"] };
  await fs.writeFile(cursor, JSON.stringify({ mcpServers: { "ai-dev": cloneEntry } }, null, 2));
  return { root, home, runtime, env, provisioned, npx, claude, cursor, cloneEntry };
}

const noDaemons = async () => ({ daemons: [] });

test("without --yes the uninstaller only says what it would take out", async (t) => {
  const staged = await stageHome(t);
  const before = await fs.readFile(staged.claude, "utf8");
  const result = await uninstallBundle({ env: staged.env, home: staged.home, clients: true, apply: false, stop: async () => assert.fail("a dry run stops no daemon") });
  assert.deepEqual(result.copies.removed, [staged.provisioned.folder]);
  assert.equal(result.link, "would-remove");
  assert.deepEqual(result.clients.map((client) => [client.client, client.status]), [["claude-code", "would-remove"]]);
  assert.equal(await fs.readFile(staged.claude, "utf8"), before);
  await fs.access(staged.provisioned.folder);
  await fs.access(staged.provisioned.current);
});

test("the uninstaller takes out what the Windows install made, and nothing of any other install", async (t) => {
  const staged = await stageHome(t);
  // A link an update that stopped half-way left beside `current`.
  const stale = path.join(staged.runtime, "app", "current.4242.abcdef12.next");
  await fs.symlink(staged.provisioned.folder, stale, "dir");
  const stopped = [];
  const result = await uninstallBundle({ env: staged.env, home: staged.home, clients: true, apply: true, stop: async ({ env }) => { stopped.push(env.AI_DEV_HOME); return noDaemons(); } });
  assert.deepEqual(stopped, [staged.runtime], "the daemons go first: on Windows they hold the copy's files");
  assert.deepEqual(result.copies.removed, [staged.provisioned.folder]);
  assert.deepEqual(result.copies.left, []);
  assert.equal(result.link, "removed");
  assert.deepEqual(result.stale_links, [stale]);
  await assert.rejects(fs.lstat(stale), { code: "ENOENT" });
  await assert.rejects(fs.lstat(staged.provisioned.current), { code: "ENOENT" });
  await assert.rejects(fs.access(staged.provisioned.folder), { code: "ENOENT" });
  await fs.access(staged.npx);
  const claude = JSON.parse(await fs.readFile(staged.claude, "utf8"));
  assert.equal(claude.mcpServers["ai-dev"], undefined, "the entry that ran the install is gone");
  assert.deepEqual(claude.mcpServers.other, { command: "other-server" }, "another server in the same file stays");
  const cursor = JSON.parse(await fs.readFile(staged.cursor, "utf8"));
  assert.deepEqual(cursor.mcpServers["ai-dev"], staged.cloneEntry, "a clone's entry is not the install's to take");
  // The person's data stays unless asked.
  await fs.access(path.join(staged.runtime, "state", "decisions.json"));
  assert.deepEqual(result.data, { asked: false, removed: false });
  assert.equal(exitStatus(result), 0);
});

test("--data deletes the runtime home, and only a folder that holds nothing but what AI Dev makes", async (t) => {
  const staged = await stageHome(t);
  // What AI Dev leaves at the top of its home besides its folders: the settings, their lock, a write
  // that stopped, the locks of its moves, what Windows puts in an opened folder, the 2.x tree.
  const own = ["config.json", "config.json.lock", "config.json.lock.break", `.config.json.4242.${crypto.randomUUID()}.tmp`, `config.json.4242.${crypto.randomUUID()}.bak`,
    "codex-migration.lock", ".ai-dev.lock", "desktop.ini", "Thumbs.db"];
  for (const name of own) await fs.writeFile(path.join(staged.runtime, name), "");
  await fs.mkdir(path.join(staged.runtime, ".ai-dev", "state"), { recursive: true });
  for (const name of ["logs", "run", "vault", "artifacts", "python"]) await fs.mkdir(path.join(staged.runtime, name));
  // Inside the folders a person might name the same, what AI Dev makes there.
  for (const name of ["models/bge-m3-onnx", "models/bge-m3", "cache/search-index", "cache/dense-model", "cache/ai-dev-system"]) await fs.mkdir(path.join(staged.runtime, name), { recursive: true });
  for (const name of ["models/bge-m3-onnx.lock", "backups/ai-dev-system_2026-10-18T10-00-00Z_manual.zip", "backups/ai-dev-system_2026-10-18T10-00-00Z_manual.zip.sha256",
    "backups/ai-dev-system_2026-01-01_10-00-00_manual.zip", "backups/ai-dev-system_2026-10-18T11-00-00Z_x.zip.4242.tmp"]) {
    await fs.mkdir(path.dirname(path.join(staged.runtime, name)), { recursive: true });
    await fs.writeFile(path.join(staged.runtime, name), "");
  }
  const result = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true, JSON.stringify(result.data));
  await assert.rejects(fs.access(staged.runtime), { code: "ENOENT" });
  assert.equal(exitStatus(result), 0);

  const root = await scratch(t);
  assert.match(await refuseDataRemoval(root, { home: path.join(root, "me") }), /holds the home folder/);
  assert.match(await refuseDataRemoval(path.parse(root).root, { home: root }), /root of a drive/);
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  assert.equal(await refuseDataRemoval(empty, { home: path.join(root, "me") }), "");
});

test("--data keeps a folder the person keeps other things in, whole, and says what is not AI Dev's", async (t) => {
  const staged = await stageHome(t);
  // AI_DEV_HOME set to Documents: AI Dev made its folders there beside the person's files.
  const documents = path.join(staged.home, "Documents");
  await fs.mkdir(path.join(documents, "Taxes 2025"), { recursive: true });
  await fs.writeFile(path.join(documents, "Taxes 2025", "return.pdf"), "precious");
  await fs.writeFile(path.join(documents, "thesis.docx"), "precious");
  await fs.mkdir(path.join(documents, "logs"));
  await fs.mkdir(path.join(documents, "state"));
  const env = { ...staged.env, AI_DEV_HOME: documents };
  const result = await uninstallBundle({ env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, false);
  assert.equal(result.data.refused, true);
  assert.match(result.data.reason, /also holds what AI Dev did not make \(Taxes 2025, thesis\.docx\)/);
  for (const kept of ["thesis.docx", "Taxes 2025/return.pdf", "logs", "state"]) await fs.access(path.join(documents, kept));
  assert.equal(exitStatus(result), 4, "the uninstaller says the data was kept");
  // A dry run says the same, and stops no daemon.
  const dry = await uninstallBundle({ env, home: staged.home, data: true, apply: false, stop: async () => assert.fail("a dry run stops no daemon") });
  assert.equal(dry.data.refused, true);
  // Six names and more are counted, not listed.
  for (const name of ["a", "b", "c", "d", "e"]) await fs.writeFile(path.join(documents, name), "");
  assert.match((await inspectDataFolder(documents, { home: staged.home })).reason, /\(Taxes 2025, a, b, c, d, and 2 more\)/);
});

test("--data looks inside the folders a person might name the same, and at what each entry is", async (t) => {
  const root = await scratch(t);
  const home = path.join(root, "home");
  const make = async (name, files) => {
    const folder = path.join(root, name);
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(folder, relative)), { recursive: true });
      if (content === null) await fs.mkdir(path.join(folder, relative), { recursive: true });
      else await fs.writeFile(path.join(folder, relative), content);
    }
    return folder;
  };
  const ai = await make("AI", { "models/bge-m3-onnx/model.onnx": "m", "models/llama-3-70b.Q4_K_M.gguf": "the person's own", "backups/my-photos-2025.zip": "theirs", "state/tasks.json": "{}", "config.json": "{}" });
  assert.match(await refuseDataRemoval(ai, { home }), /also holds what AI Dev did not make \(backups\/my-photos-2025\.zip, models\/llama-3-70b\.Q4_K_M\.gguf\)/);
  const cache = await make("cache-of-theirs", { "cache/pip": null, "config.json": "{}" });
  assert.match(await refuseDataRemoval(cache, { home }), /\(cache\/pip\)/);
  const vaultFile = await make("vault-file", { vault: "a file named vault", "config.json": "{}" });
  assert.match(await refuseDataRemoval(vaultFile, { home }), /\(vault\)/, "a folder of AI Dev's name must be a folder");
  const configFolder = await make("config-folder", { "config.json/inner": "x" });
  assert.match(await refuseDataRemoval(configFolder, { home }), /\(config\.json\)/, "and a file of its name a file");
  const linked = await make("linked-vault", { "state/tasks.json": "{}" });
  await fs.mkdir(path.join(root, "my-obsidian"));
  await fs.writeFile(path.join(root, "my-obsidian", "note.md"), "mine");
  await fs.symlink(path.join(root, "my-obsidian"), path.join(linked, "vault"), "dir");
  assert.equal(await refuseDataRemoval(linked, { home }), "", "a link of AI Dev's name is taken away as a link, never followed");
  const result = await uninstallBundle({ env: { HOME: home, USERPROFILE: home, AI_DEV_HOME: linked }, home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true);
  assert.equal(await fs.readFile(path.join(root, "my-obsidian", "note.md"), "utf8"), "mine", "what the link named stays");
});

test("a marker that is not JSON is not a copy's, and stops nothing", async (t) => {
  const staged = await stageHome(t);
  await fs.writeFile(path.join(staged.npx, APP_MARKER), "");
  await fs.writeFile(path.join(staged.provisioned.folder, APP_MARKER), "{ truncated");
  const result = await uninstallBundle({ env: staged.env, home: staged.home, apply: true, stop: noDaemons });
  assert.deepEqual(result.copies.removed, [], "the copy whose marker broke is not taken for the installer's");
  assert.equal(result.link, "removed");
  assert.equal(exitStatus(result), 0);
});

test("while a copy is left in use, the data is not touched: it goes whole, when it is run again", async (t) => {
  const staged = await stageHome(t);
  // Leftovers of an earlier uninstall that could not finish deleting what it moved aside.
  const aside = `${staged.runtime}.4242.removing.partial`;
  await fs.mkdir(path.join(aside, "state"), { recursive: true });
  const copyAside = `${staged.provisioned.folder}.4343.removing.partial`;
  await fs.mkdir(copyAside, { recursive: true });
  const busy = async (from, to) => {
    if (from === staged.provisioned.folder) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
    return fs.rename(from, to);
  };
  const held = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons, move: busy });
  assert.deepEqual(held.copies.left.map((left) => [left.folder, left.reason, left.busy]), [[staged.provisioned.folder, "in use", true]]);
  assert.equal(held.data.removed, false);
  assert.equal(held.data.busy, true);
  assert.match(held.data.reason, /AI Dev's runtime in it is still in use/);
  await fs.access(path.join(staged.runtime, "state", "decisions.json"));
  assert.equal(exitStatus(held), 3, "Retry, once the clients are closed");
  await assert.rejects(fs.access(aside), { code: "ENOENT" }, "an earlier uninstall's leftover beside the home is finished off");
  await assert.rejects(fs.access(copyAside), { code: "ENOENT" }, "and one in app/");
  const again = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(again.data.removed, true);
  assert.equal(exitStatus(again), 0);
  await assert.rejects(fs.access(staged.runtime), { code: "ENOENT" });
});

test("--data through a runtime home that is a link deletes the folder it points at, then the link", async (t) => {
  const staged = await stageHome(t);
  const real = path.join(staged.root, "elsewhere", "ai-dev-data");
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.rename(staged.runtime, real);
  await fs.symlink(real, staged.runtime, "dir");
  // The removal names the link's target by its real path; the temp folder can be a link itself.
  const target = await fs.realpath(real);
  const result = await uninstallBundle({ env: staged.env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true, JSON.stringify(result.data));
  assert.equal(result.data.target, target);
  await assert.rejects(fs.access(real), { code: "ENOENT" });
  await assert.rejects(fs.lstat(staged.runtime), { code: "ENOENT" });
  await fs.access(path.dirname(real));
});

test("a runtime home under a linked folder is not itself a link: nothing is said of one", async (t) => {
  const staged = await stageHome(t);
  const store = path.join(staged.root, "store");
  await fs.mkdir(store);
  await fs.rename(staged.runtime, path.join(store, ".ai-dev"));
  const via = path.join(staged.root, "via");
  await fs.symlink(store, via, "dir");
  const env = { ...staged.env, AI_DEV_HOME: path.join(via, ".ai-dev") };
  const result = await uninstallBundle({ env, home: staged.home, data: true, apply: true, stop: noDaemons });
  assert.equal(result.data.removed, true);
  assert.equal(result.data.target, undefined);
  await assert.rejects(fs.access(path.join(store, ".ai-dev")), { code: "ENOENT" });
  await fs.access(via);
});

test("the exit status: in use before failed before data kept, so Retry is offered whenever it can help", () => {
  const base = { apply: true, daemons: [], clients: [], copies: { removed: [], left: [] }, data: { asked: false, removed: false } };
  assert.equal(exitStatus(base), 0);
  assert.equal(exitStatus({ ...base, copies: { removed: [], left: [{ folder: "x", reason: "in use", busy: true }] } }), 3);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, busy: true, reason: "some of its files are in use" } }), 3);
  assert.equal(exitStatus({ ...base, daemons: [{ pid: 1, stopped: false }] }), 1);
  assert.equal(exitStatus({ ...base, copies: { removed: [], left: [{ folder: "x", reason: "EIO", busy: false }] } }), 1);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true, reason: "…" } }), 4);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true }, daemons: [{ pid: 1, stopped: false }] }), 1);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, refused: true }, copies: { removed: [], left: [{ folder: "x", reason: "in use", busy: true }] } }), 3);
  assert.equal(exitStatus({ ...base, data: { asked: true, removed: false, reason: "the link could not be removed" } }), 1);
});

test("an entry runs the install when its command or an argument lies under the link or in one of its copies", () => {
  const appsRoot = path.resolve("/home/me/.ai-dev/app");
  const copies = [path.join(appsRoot, "3.0.0-abcdef12")];
  const where = { appsRoot, copies, platform: "linux" };
  assert.equal(runsBundle({ command: path.join(appsRoot, "current", "node", "node.exe"), args: [] }, where), true);
  assert.equal(runsBundle({ command: "node", args: [path.join(copies[0], "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "mcp"] }, where), true);
  assert.equal(runsBundle({ command: "node", args: [path.join(appsRoot, "3.0.0-0badcafe", "ai-dev-mcp-server", "bin", "ai-dev.mjs")] }, where), false, "an npx copy");
  assert.equal(runsBundle({ command: "docker", args: ["run", "-i", "ghcr.io/stonebridgeway/ai-dev-system"] }, where), false);
  assert.equal(runsBundle({ command: path.join(appsRoot, "CURRENT", "node", "node.exe") }, { ...where, platform: "win32" }), true, "Windows reads names without case");
  assert.equal(runsBundle({ command: path.join(appsRoot, "CURRENT", "node", "node.exe") }, where), false);
  assert.equal(runsBundle(undefined, where), false);
  assert.equal(runsBundle({ command: path.join(appsRoot, "..", "app-other", "x") }, where), false);
});

test("a bare word of an entry names no folder, whatever folder the uninstall runs in", async (t) => {
  // Out of the folders before they are removed: Windows removes no folder a
  // process is in (EBUSY), and after-hooks run in the order they were added.
  const before = process.cwd();
  t.after(() => process.chdir(before));
  const root = await scratch(t);
  const appsRoot = path.join(root, ".ai-dev", "app");
  const copy = path.join(appsRoot, "3.0.0-abcdef12");
  await fs.mkdir(copy, { recursive: true });
  await fs.symlink(copy, path.join(appsRoot, "current"), "dir");
  const where = { appsRoot, copies: [copy], platform: process.platform };
  const clone = { command: "/usr/bin/node", args: ["/src/ai-dev-system/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"] };
  const docker = { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/stonebridgeway/ai-dev-system"] };
  for (const folder of [root, path.join(appsRoot, "current"), copy]) {
    process.chdir(folder);
    assert.equal(runsBundle(clone, where), false, `a clone's entry, from ${folder}`);
    assert.equal(runsBundle(docker, where), false, `Docker's entry, from ${folder}`);
    assert.equal(runsBundle({ command: "current/node/node.exe", args: ["mcp"] }, where), false, "a relative path is not taken for the link");
  }
});

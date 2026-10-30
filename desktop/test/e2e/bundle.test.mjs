import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { listFiles, writeBundleMarker } from "../../scripts/runtime-bundle.mjs";
import { clientEnvironment, launch, mainCall, quitApp, serverModule, serverRoot, shot, stage } from "./harness.mjs";

// The Windows install's runtime (docs/DESKTOP.md, "The Windows install"), on
// this machine: a runtime the way the installer ships one — the server, the
// dependencies a daemon loads, a Node of its own, bundle.json — handed to the
// app with AI_DEV_DESKTOP_BUNDLE, as a packaged app finds its resources/runtime.

const { bundleFingerprint } = await serverModule("src/core/app-bundle.mjs");
const { Client } = await serverModule("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await serverModule("node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");

/** The production dependencies a daemon loads: the tree without the optional model runtime. */
function productionPackages() {
  const listed = spawnSync("npm", ["ls", "--omit=optional", "--omit=dev", "--all", "--parseable"], { cwd: serverRoot, encoding: "utf8", shell: false, windowsHide: true });
  const modules = path.join(serverRoot, "node_modules");
  return listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(`${modules}${path.sep}`));
}

/** A runtime as the installer ships one, with this machine's Node in it. */
async function makeBundle(dir, { version, note }) {
  await fs.cp(serverRoot, path.join(dir, "ai-dev-mcp-server"), {
    recursive: true,
    filter: (source) => {
      const parts = path.relative(serverRoot, source).split(path.sep);
      return !parts.includes("node_modules") && !parts.includes("test") && !source.endsWith(".test.mjs") && parts[0] !== ".npmrc";
    }
  });
  await fs.writeFile(path.join(dir, "ai-dev-mcp-server", "README.md"), `# AI Dev ${version}\n\n${note}\n`);
  for (const folder of productionPackages()) {
    await fs.cp(folder, path.join(dir, "node_modules", path.relative(path.join(serverRoot, "node_modules"), folder)), { recursive: true, dereference: false });
  }
  // The seed, as the distribution ships it: the server fills the user's vault from it on its first start.
  await fs.cp(path.join(serverRoot, "..", "docker", "public-seed"), path.join(dir, "seed"), { recursive: true });
  await fs.mkdir(path.join(dir, "node"), { recursive: true });
  await fs.copyFile(process.execPath, path.join(dir, "node", "node"));
  await fs.chmod(path.join(dir, "node", "node"), 0o755);
  await fs.writeFile(path.join(dir, "distribution.json"), JSON.stringify({ name: "ai-dev-system", version, files: [] }));
  const [{ sha256 }] = await listFiles(path.join(dir, "node"), { skip: (relative) => relative !== "node" });
  await writeBundleMarker({ runtimeDir: dir, name: "ai-dev-system", version, node: { version: process.versions.node, sha256, file: "node/node" }, fingerprintOf: bundleFingerprint });
  return dir;
}

/** The app as the installer starts it: its runtime from resources, no server, Node or vault of the test's own. */
function installedEnv(env, bundle) {
  const installed = { ...env, AI_DEV_DESKTOP_BUNDLE: bundle };
  delete installed.AI_DEV_NODE;
  delete installed.AI_DEV_SERVER_ROOT;
  delete installed.AI_DEV_VAULT_ROOT;
  return installed;
}

/** An AI client started as its config says, speaking MCP over its stdio. */
async function startClient(t, entry, env) {
  const clientEnv = clientEnvironment(env);
  delete clientEnv.AI_DEV_DESKTOP_BUNDLE;
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: clientEnv, stderr: "ignore" });
  const client = new Client({ name: "a-client", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close().catch(() => undefined));
  return client;
}

/** What /proc says the process runs: the executable's real path. */
const executableOf = (pid) => fs.realpath(`/proc/${pid}/exe`);

test("the Windows install: its runtime is copied once and run through the stable link; an update moves the link while a client keeps running", {
  timeout: 360_000,
  skip: process.platform !== "linux" ? "reads /proc for the daemon's executable" : false
}, async (t) => {
  const s = await stage(t);
  const one = await makeBundle(path.join(s.root, "bundle-1"), { version: "3.0.0", note: "first" });
  const env = installedEnv(s.env, one);
  const current = path.join(env.AI_DEV_HOME, "app", "current");

  const first = await launch(t, env);
  await first.page.waitForSelector('[data-screen="wizard"]', { timeout: 120_000 });
  const prepared = await first.app.evaluate(() => globalThis.aiDevTest.runtime());
  assert.equal(prepared.status, "installed");
  assert.equal(prepared.current, current);
  assert.equal(prepared.node, path.join(current, "node", "node"));
  assert.equal(await fs.realpath(current), await fs.realpath(prepared.folder));
  const node = await first.app.evaluate(() => globalThis.aiDevTest.node());
  assert.deepEqual([node.path, node.source], [prepared.node, "bundled"], "the app runs the runtime's own Node");
  // First run: the server filled the user's vault from the seed, and the wizard opened.
  const vault = path.join(env.AI_DEV_HOME, "vault");
  await fs.access(path.join(vault, "03-skills-catalog"));
  await fs.access(path.join(vault, "01-system"));
  const daemonPid = await first.app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  assert.equal(await executableOf(daemonPid), await fs.realpath(path.join(prepared.folder, "node", "node")), "the daemon runs the copy, not the shipped runtime");
  await shot(first.page, "bundle-wizard");

  // Connected from the app: the config names the link, not the copy.
  const installed = await mainCall(first.app, "clients_install", { clients: ["claude-code"] });
  assert.equal(installed.ok, true, installed.error);
  const configFile = path.join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  const entry = JSON.parse(await fs.readFile(configFile, "utf8")).mcpServers["ai-dev"];
  assert.equal(entry.command, path.join(current, "node", "node"));
  assert.deepEqual(entry.args, [path.join(current, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "mcp"]);

  // An AI client starts it from its config, and stays.
  const client = await startClient(t, entry, env);
  const before = await client.callTool({ name: "search_index_status", arguments: {} });
  assert.notEqual(before.isError, true, JSON.stringify(before).slice(0, 300));

  // The update: the app quits, a new runtime is shipped, the app starts again.
  await quitApp(first.app);
  const two = await makeBundle(path.join(s.root, "bundle-2"), { version: "3.0.1", note: "second" });
  const second = await launch(t, installedEnv(s.env, two));
  await second.page.waitForSelector('[data-screen="wizard"]', { timeout: 120_000 });
  const updated = await second.app.evaluate(() => globalThis.aiDevTest.runtime());
  assert.equal(updated.status, "installed");
  assert.notEqual(updated.folder, prepared.folder);
  assert.equal(updated.current, current, "the path clients run did not change");
  assert.equal(await fs.realpath(current), await fs.realpath(updated.folder), "and it now leads to the new runtime");
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, "utf8")).mcpServers["ai-dev"], entry, "no client config was written by the update");
  const newDaemon = await second.app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  assert.equal(await executableOf(newDaemon), await fs.realpath(path.join(updated.folder, "node", "node")));

  // The client started before the update is still answered, from the old copy, which is still there.
  const after = await client.callTool({ name: "search_index_status", arguments: {} });
  assert.notEqual(after.isError, true, JSON.stringify(after).slice(0, 300));
  assert.equal(await executableOf(daemonPid), await fs.realpath(path.join(prepared.folder, "node", "node")), "its daemon still runs the old copy");
  await fs.access(path.join(prepared.folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs"));
  const readme = await fs.readFile(path.join(current, "ai-dev-mcp-server", "README.md"), "utf8");
  assert.match(readme, /^# AI Dev 3\.0\.1/);
  assert.equal(crypto.createHash("sha256").update(readme).digest("hex").length, 64);
});

test("a runtime that is not what the installer shipped is not run: the window says so, and Try again is there", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const bundle = await makeBundle(path.join(s.root, "bundle"), { version: "3.0.0", note: "damaged" });
  await fs.appendFile(path.join(bundle, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "\n// changed after the build\n");
  const { page } = await launch(t, installedEnv(s.env, bundle));
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  const text = await page.textContent('[data-screen="broken"]');
  assert.match(text, /AI Dev could not prepare its runtime\./);
  assert.match(text, /run the AI Dev installer again/);
  assert.equal(await page.isVisible("#retry"), true);
  await assert.rejects(fs.lstat(path.join(s.env.AI_DEV_HOME, "app", "current")), { code: "ENOENT" }, "no link to a runtime that was not checked");
  await shot(page, "bundle-damaged");
});

test("a copy that lost files since it was made is put back at the next start, and Status says so", { timeout: 240_000 }, async (t) => {
  const s = await stage(t);
  const bundle = await makeBundle(path.join(s.root, "bundle"), { version: "3.0.0", note: "repaired" });
  const env = installedEnv(s.env, bundle);
  const { provisionBundle } = await serverModule("src/core/app-bundle.mjs");
  const made = await provisionBundle({ bundleRoot: bundle, runtimeRoot: env.AI_DEV_HOME, env, home: env.HOME });
  // An antivirus took a file away; another was edited by hand.
  const readme = path.join(made.folder, "ai-dev-mcp-server", "README.md");
  await fs.rm(readme);
  await fs.appendFile(path.join(made.folder, "ai-dev-mcp-server", "package.json"), "\n");

  const { app, page } = await launch(t, env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 120_000 });
  const runtime = await app.evaluate(() => globalThis.aiDevTest.runtime());
  assert.equal(runtime.status, "repaired");
  assert.deepEqual([...runtime.repaired].sort(), ["ai-dev-mcp-server/README.md", "ai-dev-mcp-server/package.json"]);
  assert.match(await fs.readFile(readme, "utf8"), /^# AI Dev 3\.0\.0/);
  await page.click('[data-nav="status"]');
  const said = await page.waitForSelector('[data-field="repaired"]', { timeout: 30_000 });
  assert.match(await said.textContent(), /AI Dev put back 2 file\(s\) of its runtime that had gone missing or changed, such as ai-dev-mcp-server\/(README\.md|package\.json), ai-dev-mcp-server\/(README\.md|package\.json)\. If this happens at every start, an antivirus may be taking them away\./);
  assert.equal(await page.isVisible('[data-field="no-link"]'), false, "the link is there");
  await shot(page, "bundle-repaired");
});

// The app's folder made immutable refuses the link with EPERM, as a FAT32 or
// exFAT drive refuses a junction; only root may make a folder so.
const immutable = process.platform === "linux" && process.getuid?.() === 0 && spawnSync("chattr", ["--help"], { stdio: "ignore" }).error === undefined;

test("a drive that cannot hold the link: the app runs its copy, connects clients to the copy, and Status says why and what to do", {
  timeout: 240_000,
  skip: immutable ? false : "needs root and chattr: an immutable folder is how this machine refuses a link"
}, async (t) => {
  // node:test runs a test's after hooks in the order they were added: this one first, so the
  // stage's own cleanup, which comes after it, finds the folder it removes changeable again.
  let unlock = () => undefined;
  t.after(() => unlock());
  const s = await stage(t);
  const bundle = await makeBundle(path.join(s.root, "bundle"), { version: "3.0.0", note: "no link" });
  const env = installedEnv(s.env, bundle);
  const { provisionBundle } = await serverModule("src/core/app-bundle.mjs");
  const made = await provisionBundle({ bundleRoot: bundle, runtimeRoot: env.AI_DEV_HOME, env, home: env.HOME });
  const apps = path.dirname(made.folder);
  await fs.unlink(made.current);
  unlock = () => spawnSync("chattr", ["-i", apps]);
  assert.equal(spawnSync("chattr", ["+i", apps]).status, 0);

  const { app, page } = await launch(t, env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 120_000 });
  const runtime = await app.evaluate(() => globalThis.aiDevTest.runtime());
  assert.equal(runtime.current, "");
  assert.match(runtime.linkError, /^EPERM: /);
  assert.equal(runtime.node, path.join(made.folder, "node", "node"));
  const installed = await mainCall(app, "clients_install", { clients: ["claude-code"] });
  assert.equal(installed.ok, true, installed.error);
  const entry = JSON.parse(await fs.readFile(path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8")).mcpServers["ai-dev"];
  assert.deepEqual(entry.args, [path.join(made.folder, "ai-dev-mcp-server", "bin", "ai-dev.mjs"), "mcp"], "without a link the config names the copy itself");
  await page.click('[data-nav="status"]');
  const said = await page.waitForSelector('[data-field="no-link"]', { timeout: 30_000 });
  const text = await said.textContent();
  assert.ok(text.includes(made.folder), text);
  assert.match(text, /cannot hold the link AI clients run \(EPERM: .*\)\. After an update, run setup again and connect your AI clients, so that they run the new version\./);
  await shot(page, "bundle-no-link");
});

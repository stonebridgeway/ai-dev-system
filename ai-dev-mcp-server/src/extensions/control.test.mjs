import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startModelHost } from "../../test/fixtures/model-host.mjs";
import { CONTROL_API_VERSION, CONTROL_TOOLS } from "../core/control-contract.mjs";
import { stopDaemons } from "../core/daemon-client.mjs";
import { DaemonClientTransport } from "../core/daemon-transport.mjs";
import { syntheticManifest, syntheticModelFiles, writeSyntheticModel } from "../core/synthetic-model.mjs";

// The control API as the desktop app meets it: the MCP SDK's own client over
// the daemon's socket, through `DaemonClientTransport`, with the `control`
// profile — and the SDK checking every answer against the tool's outputSchema
// (docs/CONTROL-API.md). Real processes: the daemon this test starts, and stops.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const STALLED_FILE = "onnx/model_int8.onnx";
const STALL_BYTES = 1000;
const BIG_MODEL_BYTES = 48 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stage(t, { bigModel = false, stall = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-control-"));
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  await fs.mkdir(path.join(vault, "02-knowledge"), { recursive: true });
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.writeFile(path.join(vault, "02-knowledge", "storage.md"), "# Storage\n\nThe postgres schema keeps every table.\n");
  await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]");
  await fs.mkdir(home, { recursive: true });
  // The synthetic model; its largest file stops halfway the first time it is
  // asked for, so the download can be cancelled there. A big one, to copy and
  // hash for long enough to be cancelled midway, when asked for.
  const usb = path.join(root, "usb", "bge-m3-onnx");
  let { manifest, files } = await writeSyntheticModel(usb);
  if (bigModel) {
    files = { ...syntheticModelFiles(), [STALLED_FILE]: Buffer.alloc(BIG_MODEL_BYTES, 7) };
    manifest = syntheticManifest(files);
    await fs.writeFile(path.join(usb, STALLED_FILE), files[STALLED_FILE]);
  }
  const host = await startModelHost({ files, stallAfter: new Map(stall ? [[STALLED_FILE, STALL_BYTES]] : []) });
  const manifestFile = path.join(root, "synthetic.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, sources: [host.base] }));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude-config"),
    CODEX_HOME: path.join(home, ".codex"),
    AI_DEV_HOME: path.join(home, ".ai-dev"),
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_MODEL_MANIFEST: manifestFile,
    AI_DEV_IDLE_TIMEOUT_MS: "60000"
  };
  t.after(async () => {
    await stopDaemons({ timeoutMs: 5000, env });
    await host.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, home, vault, env, host, usb };
}

async function connect(t, env) {
  const client = new Client({ name: "control-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new DaemonClientTransport({ serverRoot, env, profiles: "control" }));
  t.after(() => client.close().catch(() => undefined));
  return client;
}

/** A tool's answer, the contract already checked by the SDK. */
async function call(client, name, args = {}, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000, ...options });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "isError");
  return result.structuredContent.result;
}

/** A refused call: its text, and nothing else. */
async function refusal(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} should be refused`);
  return result.content[0].text;
}

test("the control tools answer through the daemon as the contract says, refuse what is wrong, and stop when cancelled", { timeout: 300_000 }, async (t) => {
  const { env, host, usb, vault } = await stage(t);
  const client = await connect(t, env);

  // Listed to a session that names the profile, each with its contract.
  const listed = (await client.listTools()).tools;
  for (const name of CONTROL_TOOLS) {
    const tool = listed.find((item) => item.name === name);
    assert.ok(tool, `${name} is listed`);
    assert.ok(tool.outputSchema?.properties?.result?.properties, `${name} carries its answer's schema`);
  }
  assert.equal(listed.find((item) => item.name === "model_remove").annotations.destructiveHint, true);
  assert.equal(listed.find((item) => item.name === "system_status").annotations.readOnlyHint, true);

  const status = await call(client, "system_status", { checks: false });
  assert.equal(status.api_version, CONTROL_API_VERSION);
  assert.equal(status.served_by.kind, "daemon", "answered by the daemon");
  assert.equal(status.status, "failed", "nothing built yet");
  assert.match(await refusal(client, "system_status", { check: false }), /Unknown argument: check/);

  // A misspelt client is refused before anything is built.
  assert.match(await refusal(client, "setup_run", { clients: "claude-code,notepad" }), /Not a client: notepad/);
  assert.equal((await call(client, "system_status", { checks: false })).index.exists, false, "nothing was built for the refused call");

  // Setup: a cancelled run keeps what it did; the next one finishes.
  const controller = new AbortController();
  const cancelled = call(client, "setup_run", {}, { signal: controller.signal, onprogress: () => undefined });
  setTimeout(() => controller.abort("the user pressed Cancel"), 50);
  await assert.rejects(cancelled, /the user pressed Cancel/);
  const setup = await call(client, "setup_run", {});
  assert.equal(setup.succeeded, true, JSON.stringify(setup.steps));
  assert.ok(setup.steps.some((step) => step.id === "search_index"));
  assert.match(await refusal(client, "setup_run", { model: "yes" }), /model must be true or false/);
  assert.equal((await call(client, "system_status", { checks: false })).index.exists, true);
  // A note the index has not seen: the state is degraded, and the summary says why.
  const later = path.join(vault, "02-knowledge", "added-later.md");
  await fs.writeFile(later, "# Added later\n\nA note the index has not seen.\n");
  const stale = await call(client, "system_status", { checks: false });
  assert.deepEqual([stale.status, /^the search index is out of date: 1 added/.test(stale.summary)], ["degraded", true], stale.summary);
  await fs.rm(later);

  // With the health checks: each says whether the install fails without it,
  // and the ones this call does not run are not listed as if they were a state.
  const checked = await call(client, "system_status", {});
  const indexFile = checked.checks.find((check) => check.name === "search_index_file");
  assert.deepEqual([indexFile?.status, indexFile?.critical], ["ok", true], JSON.stringify(indexFile));
  assert.equal(checked.checks.find((check) => check.name === "required_notes")?.critical, false);
  assert.deepEqual(checked.checks.filter((check) => ["search_smoke", "dense_smoke", "search_eval"].includes(check.name)), []);

  // The model: a download cancelled midway keeps its bytes and continues.
  const part = path.join(env.AI_DEV_HOME, "models", "bge-m3-onnx", `${STALLED_FILE}.part`);
  let progressed = 0;
  const stop = new AbortController();
  const install = call(client, "model_install", {}, { signal: stop.signal, onprogress: () => { progressed += 1; } });
  install.catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while ((await fs.stat(part).catch(() => null))?.size !== STALL_BYTES && Date.now() < deadline) await sleep(20);
  stop.abort("cancel the download");
  await assert.rejects(install, /cancel the download/);
  assert.ok(progressed > 0, "progress came before the cancel");
  const halfway = await call(client, "system_status", { checks: false });
  assert.equal(halfway.model.installed, false);
  assert.equal((await fs.stat(part)).size, STALL_BYTES, "the bytes fetched are kept");
  // The daemon let go of the download: the next one is not refused as busy.
  const placed = await call(client, "model_install", {});
  assert.equal(placed.ready, true);
  assert.equal(placed.resumed, 1);
  assert.ok(host.requests.some((request) => request.path.endsWith(`/${STALLED_FILE}`) && request.range === `bytes=${STALL_BYTES}-`), "asked for the rest only");
  assert.equal(placed.model.installed, true);
  assert.equal((await call(client, "model_verify", {}, { onprogress: () => undefined })).ready, true);
  assert.match(await refusal(client, "model_remove", {}), /confirm true/);
  const removed = await call(client, "model_remove", { confirm: true });
  assert.ok(removed.removed.length > 0);
  assert.match(await refusal(client, "model_import", { source: "relative/folder" }), /absolute path/);
  const imported = await call(client, "model_import", { source: usb });
  assert.equal(imported.ready, true);
  assert.deepEqual([imported.present.length > 0, imported.missing], [true, []], "what is there after the import");

  // Clients: a dry run writes nothing; removing needs confirm.
  const clients = await call(client, "clients_list");
  assert.ok(clients.clients.length >= 6);
  const planned = await call(client, "clients_install", { clients: ["cursor"], dry_run: true });
  assert.equal(planned.results[0].status, "would-add");
  assert.equal(existsSync(planned.results[0].file), false);
  assert.match(await refusal(client, "clients_install", { clients: "notepad" }), /Not a client/);
  const written = await call(client, "clients_install", { clients: "cursor" });
  assert.equal(written.changed, 1);
  assert.match(await refusal(client, "clients_remove", { clients: "cursor" }), /confirm true/);
  assert.equal((await call(client, "clients_remove", { clients: "cursor", confirm: true })).changed, 1);

  // Logs, settings, the overview.
  const log = await call(client, "logs_tail", { lines: 5 });
  assert.equal(log.exists, true);
  assert.ok(log.lines.some((line) => /daemon \d+: listening at/.test(line)) || log.truncated);
  assert.match(await refusal(client, "logs_tail", { log: "../../etc/passwd" }), /not a log name/);
  const saved = await call(client, "settings_set", { settings: { language: "en", model_mirror: "https://hf-mirror.com/" } });
  assert.deepEqual(saved.changed.sort(), ["language", "model_mirror"]);
  assert.equal((await call(client, "settings_get")).settings.model_mirror, "https://hf-mirror.com");
  assert.match(await refusal(client, "settings_set", { settings: { language: "de" } }), /language must be ru, en or empty/);
  const overview = await call(client, "workspace_overview", { limit: 5 });
  assert.ok(overview.usage.tool_calls > 0);
  assert.match(await refusal(client, "workspace_overview", { limit: 0 }), /limit must be a whole number/);

  // Every tool refuses an argument it does not take, and changes nothing.
  for (const name of CONTROL_TOOLS) {
    assert.match(await refusal(client, name, { confirm: true, source: usb, settings: {}, bogus: 1 }), /Unknown argument.*bogus/, name);
  }
  assert.equal((await call(client, "system_status", { checks: false })).model.installed, true, "nothing was removed by a refused call");
});

test("copying and checking the model stop when cancelled midway, and keep what is done", { timeout: 300_000 }, async (t) => {
  const { env, usb } = await stage(t, { bigModel: true });
  const client = await connect(t, env);
  const cancelAtFirstProgress = (name, args) => {
    const stop = new AbortController();
    let progressed = 0;
    const pending = call(client, name, args, { signal: stop.signal, onprogress: () => { progressed += 1; stop.abort(`cancel ${name}`); } });
    return pending.then(() => ({ finished: true, progressed }), (error) => ({ finished: false, progressed, error }));
  };

  const imported = await cancelAtFirstProgress("model_import", { source: usb });
  assert.equal(imported.finished, false, "the import was cancelled before it finished");
  assert.match(String(imported.error), /cancel model_import/);
  // The daemon let go of the copy: removing the model does not wait for it.
  const removed = await call(client, "model_remove", { confirm: true });
  assert.ok(removed.removed.every((file) => typeof file === "string"));
  const afterImport = await call(client, "system_status", { checks: false });
  assert.equal(afterImport.model.installed, false);

  assert.equal((await call(client, "model_import", { source: usb })).ready, true);
  const verified = await cancelAtFirstProgress("model_verify", {});
  assert.equal(verified.finished, false, "the check was cancelled before it finished");
  assert.match(String(verified.error), /cancel model_verify/);
  // The daemon answers on, and the next check runs whole.
  assert.equal((await call(client, "model_verify", {}, { onprogress: () => undefined })).ready, true);
});

test("the settings file counts for the app's transport as for a client: its model folder, and a mirror saved in the same session", { timeout: 300_000 }, async (t) => {
  const { root, env, host } = await stage(t, { stall: false });
  // No daemon runs, and the settings name a model folder: the daemon the
  // transport starts applies them, and so must the transport, or it waits
  // for a daemon of another build.
  const folder = path.join(root, "models-from-settings");
  await fs.mkdir(env.AI_DEV_HOME, { recursive: true });
  await fs.writeFile(path.join(env.AI_DEV_HOME, "config.json"), JSON.stringify({ schema_version: 1, model_dir: folder }));
  // The manifest's own source answers nothing: only a mirror can serve the model.
  const manifestFile = path.join(root, "no-source.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(await fs.readFile(env.AI_DEV_MODEL_MANIFEST, "utf8")), sources: ["http://127.0.0.1:9/nowhere"] }));
  const client = await connect(t, { ...env, AI_DEV_MODEL_MANIFEST: manifestFile });
  assert.equal((await call(client, "system_status", { checks: false })).model.dir, folder, "the model folder the settings name");
  // A mirror saved in this session is the one this session's download uses.
  await call(client, "settings_set", { settings: { model_mirror: host.base } });
  const before = host.requests.length;
  const placed = await call(client, "model_install", {});
  assert.equal(placed.ready, true);
  assert.equal(placed.dir, folder);
  assert.ok(host.requests.slice(before).some((request) => request.path.includes("/resolve/")), "the files came from the mirror");

  // A model folder saved in this session is the next session's: the daemon's
  // search loaded the folder it started with, and these tools look where it
  // does.
  const chosen = path.join(root, "models-chosen");
  const saved = await call(client, "settings_set", { settings: { model_dir: chosen } });
  assert.equal(saved.applies.model_dir, "new_session");
  assert.match(saved.note, /model_dir: used by sessions started from now on/);
  assert.equal((await call(client, "system_status", { checks: false })).model.dir, folder, "this session keeps its folder");
  // And says so: in force is what it started with, the new one is pending,
  // and no model goes to the folder it is leaving.
  const shown = await call(client, "settings_get", {});
  assert.deepEqual([shown.settings.model_dir, shown.pending.model_dir, shown.sources.model_dir], [folder, chosen, "file, as this session started"]);
  const moved = /The model folder was changed to .*models-chosen; this session still uses .*models-from-settings.*Reconnect/;
  await assert.rejects(call(client, "model_install", {}), moved);
  await assert.rejects(call(client, "model_import", { source: folder }), moved);
  await assert.rejects(call(client, "setup_run", { model: true, clients: false }), moved);
  const next = await connect(t, { ...env, AI_DEV_MODEL_MANIFEST: manifestFile });
  assert.equal((await call(next, "system_status", { checks: false })).model.dir, chosen, "a session started afterwards has the new one");

  // A program that names no profiles gets what a client's `ai-dev mcp` gets:
  // the profiles the settings name.
  await call(next, "settings_set", { settings: { profiles: "core" } });
  const listed = async (profiles) => {
    const program = new Client({ name: "program", version: "1.0.0" }, { capabilities: {} });
    await program.connect(new DaemonClientTransport({ serverRoot, env: { ...env, AI_DEV_MODEL_MANIFEST: manifestFile }, ...(profiles === undefined ? {} : { profiles }) }));
    t.after(() => program.close().catch(() => undefined));
    return (await program.listTools()).tools.length;
  };
  const [plain, core, every] = [await listed(undefined), await listed("core"), await listed("")];
  assert.equal(plain, core, "the settings' profiles");
  assert.ok(plain < every, `${plain} of ${every} tools`);
});

test("a person's own skills through the daemon: listed, added from a folder or a template, removed; the seed's are kept", { timeout: 300_000 }, async (t) => {
  const { root, vault, env } = await stage(t, { stall: false });
  const custom = path.join(vault, "03-skills-catalog", "sources", "custom");
  await fs.mkdir(path.join(custom, "seeded"), { recursive: true });
  await fs.writeFile(path.join(custom, "seeded", "SKILL.md"), "---\nname: seeded\ndescription: Came with AI Dev.\n---\n# Seeded\n");
  // The vault's own manifest says which skills came with AI Dev, as a checkout's seed does.
  await fs.writeFile(path.join(vault, "public-seed.manifest.json"), JSON.stringify({ schema_version: 1, files: [{ path: "03-skills-catalog/sources/custom/seeded/SKILL.md", bytes: 1, sha256: "0".repeat(64) }] }));
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find((item) => item.name === "custom_skills_remove").annotations.destructiveHint, true);
  assert.equal(tools.find((item) => item.name === "custom_skills_list").annotations.readOnlyHint, true);

  const before = await call(client, "custom_skills_list");
  assert.equal(before.root, custom);
  assert.deepEqual(before.skills.map((skill) => [skill.name, skill.origin]), [["seeded", "seed"]]);

  const source = path.join(root, "mine", "release-notes");
  await fs.mkdir(path.join(source, "refs"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes from merged pull requests.\n---\n# Release notes\n");
  await fs.writeFile(path.join(source, "refs", "style.md"), "Short lines.\n");
  const added = await call(client, "custom_skills_add", { source });
  assert.deepEqual([added.name, added.created, added.replaced, added.files, added.skipped], ["release-notes", false, false, 2, []]);
  assert.equal(added.registry.custom, 2, "the registry was rebuilt with it");
  const registry = JSON.parse(await fs.readFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "utf8"));
  assert.ok(registry.some((skill) => skill.name === "release-notes"), "search and routing see it at once");
  assert.match(await refusal(client, "custom_skills_add", { source }), /There is a skill release-notes already/);
  assert.equal((await call(client, "custom_skills_add", { source, replace: true })).replaced, true);
  assert.match(await refusal(client, "custom_skills_add", { source: "mine/release-notes" }), /source must be an absolute path/);
  assert.match(await refusal(client, "custom_skills_add", { source, description: "x" }), /description goes with a new skill/);
  assert.match(await refusal(client, "custom_skills_add", { name: "deploy-check" }), /description must be a non-empty string/);
  assert.match(await refusal(client, "custom_skills_add", { name: "deploy-check", description: "Check.", replace: true }), /replace goes with source/);
  assert.match(await refusal(client, "custom_skills_add", { path: source }), /Unknown argument: path/);

  const created = await call(client, "custom_skills_add", { name: "deploy-check", description: "Check a deploy before calling it done." });
  assert.equal(created.created, true);
  assert.match(await fs.readFile(path.join(created.folder, "SKILL.md"), "utf8"), /^---\nname: deploy-check\n/);
  assert.equal(created.registry.custom, 3);

  assert.match(await refusal(client, "custom_skills_remove", { name: "seeded", confirm: true }), /comes with AI Dev/);
  assert.match(await refusal(client, "custom_skills_remove", { name: "deploy-check" }), /confirm must be true/);
  assert.match(await refusal(client, "custom_skills_remove", { name: "../custom", confirm: true }), /lowercase letters/);
  const removed = await call(client, "custom_skills_remove", { name: "deploy-check", confirm: true });
  assert.equal(removed.registry.custom, 2);
  assert.deepEqual((await call(client, "custom_skills_list")).skills.map((skill) => [skill.name, skill.origin]), [["release-notes", "yours"], ["seeded", "seed"]]);
});

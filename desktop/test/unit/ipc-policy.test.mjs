import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIRMED_SETTINGS, EVENT_CHANNELS, INVOKE_CHANNELS, PAGE_CONFIRMED_TOOLS, PAGE_REQUIRED_ARGUMENTS, PAGE_TOOLS, PAGE_TOOL_ARGUMENTS, callToConfirm, refuseCall, refuseClients, settingsToConfirm, validCallId } from "../../src/main/ipc-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the page may call only the interface's tools, with a well-formed id and plain arguments", () => {
  assert.equal(refuseCall({ tool: "system_status", args: { checks: false }, id: "call-1" }), null);
  assert.equal(refuseCall({ tool: "rebuild_search_index", id: "call-lx2-2" }), null, "no arguments is an empty object");
  for (const tool of ["model_remove", "clients_remove", "record_decision", "run_command", "workspace_overview", "model_verify", "", undefined, 42]) {
    assert.match(refuseCall({ tool, args: {}, id: "call-a" }), /The interface does not call/, String(tool));
  }
  assert.match(refuseCall({ tool: "system_status", args: {}, id: "../x" }), /id is call- and/);
  assert.match(refuseCall({ tool: "system_status", args: {}, id: "tray-rebuild" }), /id is call- and/, "the main process's own ids are not the page's");
  assert.match(refuseCall({ tool: "system_status", args: {}, id: `call-${"a".repeat(60)}` }), /id is call- and/);
  assert.match(refuseCall({ tool: "system_status", args: [], id: "call-a" }), /arguments are an object/);
  assert.match(refuseCall({ tool: "model_import", args: { source: "x".repeat(70 * 1024) }, id: "call-a" }), /at most 65536 bytes/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(refuseCall({ tool: "system_status", args: cyclic, id: "call-a" }), /plain JSON/);
  assert.match(refuseCall(null), /A call is an object/);
  assert.match(refuseCall(["system_status"]), /A call is an object/);
  assert.equal(validCallId("call-lx2-1"), true);
  assert.equal(validCallId("tray-rebuild"), false);
  assert.equal(validCallId("call 1"), false);
  assert.equal(validCallId({ toString: () => "call-1" }), false);
});

test("only the arguments the interface sends, of the kind it sends", () => {
  const call = (tool, args) => refuseCall({ tool, args, id: "call-1" });
  assert.equal(call("settings_set", { settings: { projects_root: "/home/me/code" } }), null);
  // The Settings screen changes these, each of its kind; null puts one back to its default.
  assert.equal(call("settings_set", { settings: { profiles: "core,git", model_mirror: "https://hf-mirror.com", model_dir: "/models", daemon_idle_minutes: 30, daemon_autostart: false } }), null);
  assert.equal(call("settings_set", { settings: { profiles: null, model_mirror: null, model_dir: null, daemon_idle_minutes: null, projects_root: null } }), null);
  assert.match(call("settings_set", { settings: { daemon_idle_minutes: "30" } }), /daemon_idle_minutes is a number/);
  assert.match(call("settings_set", { settings: { daemon_autostart: null } }), /daemon_autostart is true or false/);
  assert.match(call("settings_set", { settings: { profiles: "x".repeat(5000) } }), /profiles is text of at most 4096/);
  // The language goes through setLanguage, never settings_set.
  assert.match(call("settings_set", { settings: { language: "ru" } }), /does not change "language"/);
  assert.match(call("settings_set", { settings: {} }), /names something to change/);
  assert.match(call("settings_set", { settings: { projects_root: 7 } }), /is a path/);
  // The data screens' tools, with the arguments those screens send.
  assert.equal(call("logs_tail", { log: "daemon.1", lines: 200 }), null);
  assert.match(call("logs_tail", { log: "../../etc/passwd" }), /log is one of daemon, daemon\.1/);
  assert.equal(call("search_skills", { query: "tests", limit: 30 }), null);
  assert.match(call("search_skills", { limit: 30 }), /search_skills needs query/);
  assert.match(call("list_tasks", { project_path: "/p", limit: 50, status: "open" }), /does not send "status" to list_tasks/);
  assert.equal(call("setup_run", { model: true }), null);
  for (const name of ["frontend_qa", "force", "clients"]) assert.match(call("setup_run", { [name]: true }), new RegExp(`does not send "${name}" to setup_run`));
  assert.match(call("setup_run", { model: "yes" }), /model is true or false/);
  assert.equal(call("clients_install", { clients: ["cursor", "claude-code"] }), null);
  assert.match(call("clients_install", { clients: "all" }), /list of client names/);
  assert.match(call("clients_install", { clients: ["Cursor; rm"] }), /list of client names/);
  assert.match(call("clients_install", { clients: ["cursor"], dry_run: true }), /does not send "dry_run"/);
  assert.equal(call("model_import", { source: "/media/usb/bge-m3-onnx" }), null);
  assert.match(call("model_import", { source: "" }), /is a path/);
  assert.match(call("model_install", { mirror: "http://x" }), /does not send "mirror"/);
  assert.match(call("system_status", { checks: "no" }), /checks is true or false/);
  assert.deepEqual(PAGE_TOOLS, Object.keys(PAGE_TOOL_ARGUMENTS));
});

test("nothing the page may call takes back what it cannot undo", () => {
  assert.deepEqual(PAGE_TOOLS.filter((tool) => /remove|delete/.test(tool)), []);
});

test("the preload exposes exactly the policy's channels", () => {
  const preload = fs.readFileSync(path.join(root, "src", "preload", "preload.cjs"), "utf8");
  const named = (block) => Object.fromEntries([...block.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const invoke = named(/const invoke = \{([^}]*)\}/.exec(preload)[1]);
  const events = named(/const events = \{([^}]*)\}/.exec(preload)[1]);
  assert.deepEqual(invoke, { ...INVOKE_CHANNELS });
  assert.deepEqual(events, { ...EVENT_CHANNELS });
  // The page gets functions over these channels, never ipcRenderer itself.
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
  assert.match(preload, /Object\.freeze\(\{/);
});

test("the page connects only the clients the wizard offers, with plain JSON arguments", () => {
  const listed = [
    { client: "claude-code", found: true, entry: "none" },
    { client: "cursor", found: true, entry: "unreadable" },
    { client: "codex", found: false, entry: "none" }
  ];
  assert.equal(refuseClients(["claude-code"], listed), null);
  for (const names of [["all"], ["codex"], ["cursor"], ["claude-code", "codex"]]) {
    assert.match(refuseClients(names, listed), /only the clients it found on this computer/, names.join(","));
  }
  assert.match(refuseCall({ tool: "settings_set", args: { settings: new Map([["projects_root", "/x"]]) }, id: "call-1" }), /is an object/);
  assert.match(refuseCall({ tool: "system_status", args: new Date(0), id: "call-1" }), /arguments are an object/);
  assert.equal(refuseCall({ tool: "settings_set", args: { settings: Object.assign(Object.create(null), { projects_root: "/x" }) }, id: "call-1" }), null);
});

test("a call without an argument the interface always sends is refused in words: no clients is not all of them", () => {
  assert.match(refuseCall({ tool: "clients_install", args: {}, id: "call-1" }), /^clients_install needs clients\.$/);
  assert.match(refuseCall({ tool: "clients_install", id: "call-1" }), /^clients_install needs clients\.$/, "no arguments at all");
  assert.match(refuseCall({ tool: "model_import", args: {}, id: "call-1" }), /needs source/);
  assert.match(refuseCall({ tool: "settings_set", args: {}, id: "call-1" }), /needs settings/);
  for (const [tool, names] of Object.entries(PAGE_REQUIRED_ARGUMENTS)) {
    for (const name of names) assert.ok(Object.hasOwn(PAGE_TOOL_ARGUMENTS[tool], name), `${tool}.${name} is an argument the interface sends`);
  }
});

test("the model's mirror and folder and the profiles change only after a confirmation; the rest of Settings at once", () => {
  assert.deepEqual(CONFIRMED_SETTINGS, ["model_mirror", "model_dir", "profiles"]);
  const call = (settings) => ({ tool: "settings_set", args: { settings }, id: "call-s" });
  assert.deepEqual(settingsToConfirm(call({ model_mirror: "http://127.0.0.1:9/x", daemon_autostart: false })), { model_mirror: "http://127.0.0.1:9/x" });
  assert.deepEqual(settingsToConfirm(call({ model_dir: null, profiles: "core" })), { model_dir: null, profiles: "core" }, "back to the default too");
  assert.equal(settingsToConfirm(call({ projects_root: "/p", daemon_idle_minutes: 30, daemon_autostart: true })), null);
  assert.equal(settingsToConfirm({ tool: "system_status", args: { checks: true }, id: "call-s" }), null);
  // Each of them is one the screens may send — after the confirmation.
  for (const name of CONFIRMED_SETTINGS) assert.ok(Object.hasOwn(PAGE_TOOL_ARGUMENTS.settings_set.settings, name), name);
});

test("the screens that change the library and a repository's rules: their arguments only, each change confirmed first, a removal only through the console", () => {
  const call = (tool, args) => refuseCall({ tool, args, id: "call-own-1" });
  assert.equal(call("custom_skills_add", { source: "/home/me/skills/deploy-check" }), null);
  assert.equal(call("custom_skills_add", { name: "release-notes", description: "Write release notes." }), null);
  assert.match(call("custom_skills_add", { source: "/x", overwrite: true }), /does not send "overwrite" to custom_skills_add/);
  assert.equal(call("import_skill_repo", { repository_url: "https://github.com/o/r", select_skills: true }), null);
  assert.match(call("import_skill_repo", { repository_url: "https://github.com/o/r", source_group: "custom" }), /does not send "source_group"/, "the screen imports where the policy says, nowhere else");
  const rule = { id: "no-force-push", event: "bash", pattern: "git push .*--force", action: "block", message: "No.", example: "git push --force" };
  assert.equal(call("upsert_policy_rule", { project_path: "/repo", rule }), null);
  assert.match(call("upsert_policy_rule", { project_path: "/repo", rule: { ...rule, event: "network" } }), /rule\.event is one of bash, file, all/);
  assert.match(call("upsert_policy_rule", { project_path: "/repo", rule: { ...rule, counter_example: "x" } }), /does not change "counter_example"/);
  assert.match(call("upsert_policy_rule", { rule }), /upsert_policy_rule needs project_path/);
  assert.match(call("install_agent_hooks", { project_path: "/repo", profile: "loose" }), /profile is one of minimal, standard, strict/);
  assert.match(call("install_project_rules", { project_path: "/repo", overwrite: true }), /does not send "overwrite"/, "a person's own edits are never written over from a screen");
  assert.equal(call("list_mcp_servers", { project_path: "/repo", include_user_scope: true }), null);
  for (const tool of ["custom_skills_remove", "remove_policy_rule"]) assert.match(call(tool, {}), /The interface does not call/, `${tool}: the console's, which asks first`);

  assert.equal(callToConfirm({ tool: "custom_skills_add", args: { name: "x", description: "y" } }), true);
  assert.equal(callToConfirm({ tool: "install_project_rules", args: { project_path: "/repo" } }), true);
  assert.equal(callToConfirm({ tool: "install_project_rules", args: { project_path: "/repo", dry_run: true } }), false, "a preview writes nothing");
  assert.equal(callToConfirm({ tool: "upsert_policy_rule", args: { project_path: "/repo", rule } }), true);
  for (const tool of ["custom_skills_list", "list_policy_rules", "agent_hooks_status", "list_rule_packs", "list_mcp_servers", "rebuild_index"]) {
    assert.equal(callToConfirm({ tool, args: {} }), false, `${tool} changes nothing a person keeps`);
  }
  for (const tool of PAGE_CONFIRMED_TOOLS) assert.ok(PAGE_TOOLS.includes(tool), tool);
});

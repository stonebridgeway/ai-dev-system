import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SETTINGS, applySettingsToEnvironment, readSettings, sessionEnvironment, settingsPath, writeSettings } from "./settings.mjs";

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { AI_DEV_HOME: root };
}

test("with no file every setting is its default, and says so", async (t) => {
  const env = await home(t);
  const current = readSettings({ env });
  assert.equal(current.file, path.join(env.AI_DEV_HOME, "config.json"));
  assert.deepEqual(current.settings, Object.fromEntries(Object.entries(SETTINGS).map(([name, setting]) => [name, setting.default])));
  assert.ok(Object.values(current.sources).every((source) => source === "default"));
  assert.deepEqual(current.problems, []);
});

test("a change is checked, stored with mode 0600, and a null puts the default back", async (t) => {
  const env = await home(t);
  const result = await writeSettings({ model_mirror: "https://hf-mirror.com/", profiles: "git,core", daemon_idle_minutes: 5, language: "RU" }, { env });
  assert.deepEqual(result.changed.sort(), ["daemon_idle_minutes", "language", "model_mirror", "profiles"]);
  assert.equal(result.settings.model_mirror, "https://hf-mirror.com");
  // This process started with no profiles: the change is a new session's.
  assert.equal(result.pending.profiles, "core,git", "in the profiles' own order");
  assert.equal(result.settings.profiles, "");
  // `all` alone is no setting at all; the desktop app's opt-in profile is not
  // put into what every agent client gets.
  assert.equal((await writeSettings({ profiles: "all" }, { env })).settings.profiles, "");
  await assert.rejects(writeSettings({ profiles: "control, all" }, { env }), /profiles cannot name control/);
  await assert.rejects(writeSettings({ profiles: "control" }, { env }), /AI_DEV_PROFILES=control itself/);
  await writeSettings({ profiles: "git,core" }, { env });
  assert.equal(result.settings.language, "ru");
  const stored = JSON.parse(await fs.readFile(settingsPath(env), "utf8"));
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.daemon_idle_minutes, 5);
  if (process.platform !== "win32") assert.equal((await fs.stat(settingsPath(env))).mode & 0o777, 0o600);
  assert.deepEqual((await writeSettings({ model_mirror: "https://hf-mirror.com" }, { env })).changed, [], "the same value again changes nothing");
  await writeSettings({ model_mirror: null }, { env });
  assert.equal(readSettings({ env }).settings.model_mirror, "");
  assert.equal(readSettings({ env }).sources.profiles, "default, as this session started");
  const fresh = { ...env };
  applySettingsToEnvironment(fresh);
  assert.equal(readSettings({ env: fresh }).sources.profiles, "file", "a process started now has the file's");
});

test("a wrong value is refused with what is wrong, and nothing of the change is written", async (t) => {
  const env = await home(t);
  await writeSettings({ language: "en" }, { env });
  const before = await fs.readFile(settingsPath(env), "utf8");
  const refused = [
    [{ model_mirror: "ftp://mirror" }, /model_mirror must be an http\(s\) address/],
    [{ model_mirror: "https://user:secret@mirror.example" }, /must not carry a user name or password/],
    [{ profiles: "core,nonsense" }, /profiles names "nonsense", which is not a profile/],
    [{ model_dir: "relative/models" }, /model_dir must be an absolute path/],
    [{ daemon_idle_minutes: -1 }, /daemon_idle_minutes must be a number of minutes/],
    [{ daemon_idle_minutes: "abc" }, /daemon_idle_minutes must be a number/],
    // Not numbers, whatever they convert to, and not a fraction of a minute.
    [{ daemon_idle_minutes: "" }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: "5" }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: true }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: [7] }, /daemon_idle_minutes must be a number/],
    [{ daemon_idle_minutes: 0.0001 }, /from 1 to 10080/],
    [{ daemon_idle_minutes: 10081 }, /from 1 to 10080/],
    [{ model_dir: `${path.resolve("/models")}\u0000evil` }, /must not hold a NUL/],
    // The environment cuts a value at a NUL, and a process given one does not start.
    [{ model_mirror: "https://hf-mirror.com/\u0000" }, /model_mirror must not hold a NUL/],
    [{ model_mirror: "https://hf-mirror.com/a\nb" }, /model_mirror must not hold a NUL or another control character/],
    [{ daemon_autostart: "yes" }, /daemon_autostart must be true or false/],
    [{ language: "de" }, /language must be ru, en or empty/],
    [{ colour: "blue" }, /There is no setting "colour"/],
    [{ language: "ru", model_mirror: "nope" }, /model_mirror must be an http/]
  ];
  for (const [change, message] of refused) await assert.rejects(writeSettings(change, { env }), message, JSON.stringify(change));
  await assert.rejects(writeSettings([], { env }), /takes an object/);
  assert.equal(await fs.readFile(settingsPath(env), "utf8"), before);
});

test("a stored value that is no longer valid is reported and replaced by its default; a file that is not JSON stops the read", async (t) => {
  const env = await home(t);
  await fs.writeFile(settingsPath(env), JSON.stringify({ language: "fr", daemon_idle_minutes: 12, future_setting: 1 }));
  const current = readSettings({ env });
  assert.equal(current.settings.language, "");
  assert.equal(current.stored.daemon_idle_minutes, 12);
  assert.match(current.problems.join(" "), /language: language must be ru, en or empty/);
  await fs.writeFile(settingsPath(env), "{ not json");
  assert.throws(() => readSettings({ env }), /is not JSON\. Fix or remove it/);
  await assert.rejects(writeSettings({ language: "en" }, { env }), /is not JSON/);
  // A folder in its place fails at the read, where Node names no file: the error names it.
  await fs.rm(settingsPath(env));
  await fs.mkdir(settingsPath(env));
  assert.throws(() => readSettings({ env }), (error) => error.code === "EISDIR" && error.message.startsWith(`${settingsPath(env)} cannot be read: EISDIR`));
  // Where Node names the file itself, it is named once. Windows says a
  // path through a file is not there (ENOENT), which reads as no settings yet.
  const plain = path.join(env.AI_DEV_HOME, "plain-file");
  await fs.writeFile(plain, "");
  const inside = path.join(plain, "config.json");
  if (process.platform === "win32") assert.doesNotThrow(() => readSettings({ env, file: inside }));
  else assert.throws(() => readSettings({ env, file: inside }), (error) => error.code === "ENOTDIR" && error.message.split(inside).length === 2);
});

test("unsetOnly leaves a setting the file gives a readable value, the empty language too; the lock's wait can be bounded", async (t) => {
  const env = await home(t);
  const file = settingsPath(env);
  const stored = async () => JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, language: "en" }));
  assert.deepEqual((await writeSettings({ language: "ru" }, { env, unsetOnly: true })).changed, []);
  assert.equal((await stored()).language, "en");
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, language: "" }));
  assert.deepEqual((await writeSettings({ language: "ru" }, { env, unsetOnly: true })).changed, []);
  assert.equal((await stored()).language, "", "the empty language is the system's: a value of its own");
  // A value this version does not read is no value: it is replaced, as with no key at all.
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, language: "fr" }));
  assert.deepEqual((await writeSettings({ language: "ru" }, { env, unsetOnly: true })).changed, ["language"]);
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, daemon_idle_minutes: 12 }));
  assert.deepEqual((await writeSettings({ language: "ru" }, { env, unsetOnly: true })).changed, ["language"]);
  assert.deepEqual(await stored(), { schema_version: 1, daemon_idle_minutes: 12, language: "ru" });
  // Without it, the change is written over the file's value.
  assert.deepEqual((await writeSettings({ language: "en" }, { env })).changed, ["language"]);
  // Another writer holds the lock: the wait ends when asked, and nothing is written.
  const { acquireFileLock } = await import("./file-lock.mjs");
  const release = await acquireFileLock(file);
  t.after(() => release());
  const started = Date.now();
  await assert.rejects(writeSettings({ language: "ru" }, { env, lockTimeoutMs: 300 }), /Timed out after 300 ms/);
  assert.ok(Date.now() - started < 5_000, `waited ${Date.now() - started} ms`);
  assert.equal((await stored()).language, "en");
});

test("the file sets the variables the environment leaves unset, and never one set by hand", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://hf-mirror.com", daemon_idle_minutes: 2, profiles: "core", model_dir: path.resolve("/models/bge") }, { env });
  const process1 = { ...env, BGE_M3_ONNX_DIR: "/mine" };
  assert.deepEqual(applySettingsToEnvironment(process1), ["AI_DEV_IDLE_TIMEOUT_MS", "AI_DEV_MODEL_MIRROR", "AI_DEV_PROFILES"]);
  assert.equal(process1.AI_DEV_MODEL_MIRROR, "https://hf-mirror.com");
  assert.equal(process1.AI_DEV_IDLE_TIMEOUT_MS, "120000");
  assert.equal(process1.AI_DEV_PROFILES, "core");
  assert.equal(process1.BGE_M3_ONNX_DIR, "/mine", "set by hand: the file does not override it");
  const sources = readSettings({ env: process1 }).sources;
  assert.equal(sources.model_mirror, "file", "a variable the file set still counts as the file's");
  assert.equal(sources.model_dir, "environment (BGE_M3_ONNX_DIR)");

  // The file changes while the process runs: what came from it follows, the rest stays.
  await writeSettings({ model_mirror: null, profiles: "" }, { env });
  applySettingsToEnvironment(process1);
  assert.equal(process1.AI_DEV_MODEL_MIRROR, undefined);
  assert.equal(process1.AI_DEV_PROFILES, undefined, "empty profiles: every tool, as no variable");
  assert.equal(process1.AI_DEV_IDLE_TIMEOUT_MS, "120000");
  assert.equal(process1.BGE_M3_ONNX_DIR, "/mine");

  const broken = { ...env };
  await fs.writeFile(settingsPath(env), "{");
  assert.deepEqual(applySettingsToEnvironment(broken), [], "a broken file leaves a starting process as it is");
});

test("the file is replaced whole through a link to it, and one a newer version wrote is left alone", async (t) => {
  const env = await home(t);
  // Settings kept in a dotfiles repository, linked into the AI Dev home.
  const dotfiles = path.join(env.AI_DEV_HOME, "dotfiles");
  await fs.mkdir(dotfiles);
  const real = path.join(dotfiles, "ai-dev.json");
  await fs.writeFile(real, JSON.stringify({ schema_version: 1, language: "en", trusted_projects: ["/work/a"] }));
  try {
    await fs.symlink(real, settingsPath(env));
  } catch (error) {
    if (process.platform === "win32") return t.skip(`no symbolic links here: ${error.code}`);
    throw error;
  }
  await writeSettings({ language: "ru" }, { env });
  assert.equal((await fs.lstat(settingsPath(env))).isSymbolicLink(), true, "the link stays");
  const written = JSON.parse(await fs.readFile(real, "utf8"));
  assert.deepEqual([written.language, written.trusted_projects], ["ru", ["/work/a"]], "the linked file holds the change and keeps what it had");
  if (process.platform !== "win32") assert.equal((await fs.stat(real)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dotfiles)).sort(), ["ai-dev.json"], "no temporary file is left");

  const newer = JSON.stringify({ schema_version: 2, language: "en", future: { kept: true } });
  await fs.writeFile(real, newer);
  await assert.rejects(writeSettings({ language: "ru" }, { env }), /written by a newer AI Dev \(settings schema 2/);
  assert.equal(await fs.readFile(real, "utf8"), newer);
});

test("the value in force is a variable's where one overrides the file", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://from-file.example", daemon_idle_minutes: 5 }, { env });
  const current = readSettings({ env: { ...env, AI_DEV_MODEL_MIRROR: "https://from-env.example", AI_DEV_IDLE_TIMEOUT_MS: "90000" } });
  assert.deepEqual([current.settings.model_mirror, current.sources.model_mirror], ["https://from-env.example", "environment (AI_DEV_MODEL_MIRROR)"]);
  assert.deepEqual([current.settings.daemon_idle_minutes, current.stored.daemon_idle_minutes], [1.5, 5], "in minutes, and the file's own beside it");
});

test("a change says when it takes effect; a variable the file did not set is applied only when asked for", async (t) => {
  const env = await home(t);
  const result = await writeSettings({ model_mirror: "https://hf-mirror.com", model_dir: path.resolve("/models/chosen"), profiles: "core", daemon_idle_minutes: 3, language: "en" }, { env });
  assert.deepEqual(result.applies, { model_mirror: "now", model_dir: "new_session", profiles: "new_session", daemon_idle_minutes: "next_daemon", language: "app" });
  assert.deepEqual(Object.fromEntries(Object.entries(SETTINGS).map(([name, setting]) => [name, setting.applies])), {
    projects_root: "app", profiles: "new_session", model_mirror: "now", model_dir: "new_session", daemon_idle_minutes: "next_daemon", daemon_autostart: "app", language: "app"
  });
  const session = { ...env };
  assert.deepEqual(applySettingsToEnvironment(session, { only: ["AI_DEV_MODEL_MIRROR"] }), ["AI_DEV_MODEL_MIRROR"]);
  assert.equal(session.AI_DEV_MODEL_MIRROR, "https://hf-mirror.com");
  assert.equal(session.BGE_M3_ONNX_DIR, undefined, "the model folder is not this call's to change");
});

test("what is in force is what this session started with; a change since is pending, for sessions started afterwards", async (t) => {
  const env = await home(t);
  const first = path.resolve("/models/first");
  await writeSettings({ model_dir: first, profiles: "core", model_mirror: "https://one.example" }, { env });
  const session = { ...env };
  applySettingsToEnvironment(session);
  const chosen = path.resolve("/models/chosen");
  const changed = await writeSettings({ model_dir: chosen, profiles: null, model_mirror: "https://two.example", daemon_idle_minutes: 5 }, { env: session });
  assert.deepEqual(changed.settings.model_dir, first, "the folder this session's daemon loaded");
  assert.deepEqual(changed.pending, { profiles: "", model_dir: chosen, daemon_idle_minutes: 5 });
  const now = readSettings({ env: session });
  assert.equal(now.settings.model_dir, first);
  assert.equal(now.sources.model_dir, "file, as this session started");
  assert.equal(now.settings.profiles, "core", "taken out of the file since: still this session's");
  assert.equal(now.settings.daemon_idle_minutes, 30, "the file had none when this session started");
  assert.equal(now.sources.daemon_idle_minutes, "default, as this session started");
  assert.equal(now.settings.model_mirror, "https://two.example", "a mirror applies at once: never pending");
  // A session started now has the file's, and nothing pending.
  const next = { ...env };
  applySettingsToEnvironment(next);
  assert.deepEqual(readSettings({ env: next }).pending, {});
  assert.equal(readSettings({ env: next }).settings.model_dir, chosen);
  // A variable set by hand is the person's: never pending.
  const byHand = { ...env, BGE_M3_ONNX_DIR: path.resolve("/models/mine") };
  assert.deepEqual(readSettings({ env: byHand }).pending.model_dir, undefined);
});

test("a value the file put in the environment and a person changed since is the person's", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://from-file.example" }, { env });
  const shell = { ...env };
  applySettingsToEnvironment(shell);
  assert.match(shell.AI_DEV_SETTINGS_APPLIED, /^AI_DEV_MODEL_MIRROR:[0-9a-f]{8}$/, "the list holds what it put there");
  // A shell that inherited the list; the person sets the mirror by hand.
  shell.AI_DEV_MODEL_MIRROR = "https://by-hand.example";
  await writeSettings({ model_mirror: "https://changed-file.example" }, { env });
  applySettingsToEnvironment(shell);
  assert.equal(shell.AI_DEV_MODEL_MIRROR, "https://by-hand.example");
  assert.equal(shell.AI_DEV_SETTINGS_APPLIED, undefined, "and it is no longer listed as the file's");
  assert.equal(readSettings({ env: shell }).sources.model_mirror, "environment (AI_DEV_MODEL_MIRROR)");
  // A name listed without a fingerprint says nothing of its value: the person's too.
  const listed = { ...env, AI_DEV_MODEL_MIRROR: "https://typed-by-hand.example", AI_DEV_SETTINGS_APPLIED: "AI_DEV_MODEL_MIRROR" };
  applySettingsToEnvironment(listed);
  assert.equal(listed.AI_DEV_MODEL_MIRROR, "https://typed-by-hand.example");
});

test("on Windows a variable set by hand in another case is the one in force, and the file adds no second spelling", async (t) => {
  const env = await home(t);
  await writeSettings({ model_dir: path.resolve("/models/from-file"), model_mirror: "https://hf-mirror.com" }, { env });
  const client = { ...env, Bge_M3_Onnx_Dir: "C:\\models\\mine", ai_dev_settings_applied: "" };
  applySettingsToEnvironment(client, { platform: "win32" });
  assert.equal(Object.keys(client).filter((key) => key.toUpperCase() === "BGE_M3_ONNX_DIR").length, 1, "one spelling");
  assert.equal(client.Bge_M3_Onnx_Dir, "C:\\models\\mine");
  assert.equal(client.AI_DEV_MODEL_MIRROR, "https://hf-mirror.com");
  assert.equal(readSettings({ env: client, platform: "win32" }).sources.model_dir, "environment (BGE_M3_ONNX_DIR)");
  // Off Windows a name is its case: the same spelling is another variable.
  const posix = { ...env, Bge_M3_Onnx_Dir: "/mine" };
  applySettingsToEnvironment(posix, { platform: "linux" });
  assert.equal(posix.BGE_M3_ONNX_DIR, path.resolve("/models/from-file"));
});

test("what is shown is what the daemon makes of the variable, a stored opt-in profile drops alone, and a newer file says so", async (t) => {
  const env = await home(t);
  const shown = (value) => readSettings({ env: { ...env, AI_DEV_IDLE_TIMEOUT_MS: value } }).settings.daemon_idle_minutes;
  assert.equal(shown("abc"), 30, "a variable that is no number: the daemon's default");
  assert.equal(shown("-60000"), 0, "a negative one: kept until stopped, as the daemon does");
  assert.equal(shown("90000"), 1.5);
  await fs.writeFile(settingsPath(env), JSON.stringify({ schema_version: 1, profiles: "core,control" }));
  const repaired = readSettings({ env });
  assert.equal(repaired.stored.profiles, "core", "what the old file named besides control is kept");
  assert.match(repaired.problems.join(" "), /profiles cannot name control.*core is kept/);
  const process1 = { ...env };
  applySettingsToEnvironment(process1);
  assert.equal(process1.AI_DEV_PROFILES, "core");
  await fs.writeFile(settingsPath(env), JSON.stringify({ schema_version: 2, language: "en" }));
  const newer = readSettings({ env });
  assert.equal(newer.schema_version, 2, "the file's own version");
  assert.match(newer.problems.join(" "), /written by a newer AI Dev \(settings schema 2, this one knows 1\)/);
  assert.equal(newer.settings.language, "en");
});

test("a link to a settings file not made yet is written through, and stays a link", async (t) => {
  const env = await home(t);
  const dotfiles = path.join(env.AI_DEV_HOME, "dotfiles");
  await fs.mkdir(dotfiles);
  try {
    await fs.symlink(path.join(dotfiles, "ai-dev.json"), settingsPath(env));
  } catch (error) {
    if (process.platform === "win32") return t.skip(`no symbolic links here: ${error.code}`);
    throw error;
  }
  await writeSettings({ language: "ru" }, { env });
  assert.equal((await fs.lstat(settingsPath(env))).isSymbolicLink(), true, "the link stays");
  assert.equal(JSON.parse(await fs.readFile(path.join(dotfiles, "ai-dev.json"), "utf8")).language, "ru");
});

test("a link is followed as the system follows it: from the folder it lies in, through a chain, never into a folder that is not there", { skip: process.platform === "win32" && "symbolic links need a privilege on Windows" }, async (t) => {
  const root = (await home(t)).AI_DEV_HOME;
  // The AI Dev home is itself a link, and the file a relative link up and out of it.
  await fs.mkdir(path.join(root, "data", "aidev"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "dotfiles"));
  await fs.symlink(path.join(root, "data", "aidev"), path.join(root, "home-link"));
  const linked = { AI_DEV_HOME: path.join(root, "home-link") };
  await fs.symlink("../dotfiles/ai-dev.json", settingsPath(linked));
  await writeSettings({ language: "ru" }, { env: linked });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "data", "dotfiles", "ai-dev.json"), "utf8")).language, "ru", "where the link really leads");
  assert.equal(readSettings({ env: linked }).settings.language, "ru");

  // A chain of links to a file not made yet: the file at its end, every link kept.
  const chain = { AI_DEV_HOME: path.join(root, "chain") };
  await fs.mkdir(path.join(root, "chain", "dotfiles"), { recursive: true });
  await fs.symlink(path.join(root, "chain", "dotfiles", "real.json"), path.join(root, "chain", "dotfiles", "middle.json"));
  await fs.symlink(path.join(root, "chain", "dotfiles", "middle.json"), settingsPath(chain));
  await writeSettings({ language: "en" }, { env: chain });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "chain", "dotfiles", "real.json"), "utf8")).language, "en");
  assert.equal((await fs.lstat(path.join(root, "chain", "dotfiles", "middle.json"))).isSymbolicLink(), true, "the middle link stays");

  // A link into a folder that is not there — a drive not mounted — is refused, and says which.
  const unmounted = { AI_DEV_HOME: path.join(root, "unmounted") };
  await fs.mkdir(unmounted.AI_DEV_HOME);
  await fs.symlink(path.join(root, "not-mounted", "ai-dev.json"), settingsPath(unmounted));
  await assert.rejects(writeSettings({ language: "en" }, { env: unmounted }), /is a link to .*not-mounted.*whose folder .*not-mounted is not there/);
  assert.equal((await fs.lstat(settingsPath(unmounted))).isSymbolicLink(), true, "and the link is left as it is");
});

test("a schema version the file gives is read and written the same way", async (t) => {
  const env = await home(t);
  for (const given of ["1.5", "1e400", "\"abc\"", "0"]) {
    await fs.writeFile(settingsPath(env), `{ "schema_version": ${given}, "language": "en" }`);
    const read = readSettings({ env });
    assert.equal(read.schema_version, 1, given);
    assert.match(read.problems.join(" "), /which is no version: it is read as 1/, given);
    assert.deepEqual((await writeSettings({ language: "ru" }, { env })).changed, ["language"], `${given}: written as version 1`);
    assert.equal(JSON.parse(await fs.readFile(settingsPath(env), "utf8")).schema_version, 1);
  }
  await fs.writeFile(settingsPath(env), `{ "schema_version": "2", "language": "en" }`);
  assert.equal(readSettings({ env }).schema_version, 2, "a newer one, spelled as text");
  await assert.rejects(writeSettings({ language: "ru" }, { env }), /written by a newer AI Dev/);
});

test("a session's environment for the tools: the mirror read again, the model folder its own, a name found whatever its case on Windows", async (t) => {
  const env = await home(t);
  await writeSettings({ model_mirror: "https://hf-mirror.com", model_dir: path.resolve("/models/from-file") }, { env });
  const session = sessionEnvironment({ ...env, BGE_M3_ONNX_DIR: path.resolve("/models/started-with") }, { platform: "linux" });
  assert.equal(session.AI_DEV_MODEL_MIRROR, "https://hf-mirror.com");
  assert.equal(session.BGE_M3_ONNX_DIR, path.resolve("/models/started-with"), "the folder the session started with");
  const windows = sessionEnvironment({ ...env, Bge_M3_Onnx_Dir: "C:\\models\\mine" }, { platform: "win32" });
  assert.equal(windows.BGE_M3_ONNX_DIR, "C:\\models\\mine", "read as Windows reads it");
  assert.equal(Object.keys(windows).filter((key) => key.toUpperCase() === "BGE_M3_ONNX_DIR").length, 1);
});

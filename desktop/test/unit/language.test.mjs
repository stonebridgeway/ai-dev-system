import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCK_WAIT_MS, LOOK_EVERY_MS, createLanguageKeeper } from "../../src/main/language.mjs";

// The language the person chose, against the install's own settings code: a
// real file, a real lock.

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverRoot = path.resolve(process.env.AI_DEV_SERVER_ROOT || path.join(desktopRoot, "..", "ai-dev-mcp-server"));
const load = (relative) => import(pathToFileURL(path.join(serverRoot, relative)).href);
const settings = await load("src/core/settings.mjs");
const { acquireFileLock } = await load("src/core/file-lock.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `check` to hold, a few seconds at most; what it says then. */
async function until(check, ms = 3_000) {
  for (const deadline = Date.now() + ms; !(await check()) && Date.now() < deadline;) await sleep(20);
  return check();
}

/** A settings file holding `text` (none when undefined), and a keeper on it whose writes are counted. */
async function stage(t, text) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-language-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { AI_DEV_HOME: home };
  const file = settings.settingsPath(env);
  if (text !== undefined) await fs.writeFile(file, text);
  const writes = [];
  const module = {
    ...settings,
    writeSettings: (changes, options) => {
      writes.push(options);
      return settings.writeSettings(changes, options);
    }
  };
  const outcomes = [];
  const keeper = createLanguageKeeper({ server: () => module, env, settled: (outcome) => outcomes.push(outcome) });
  t.after(() => keeper.stop());
  const stored = async () => (await fs.readFile(file, "utf8").then(JSON.parse, () => null))?.language;
  // Another writer — `ai-dev`, the daemon — holds the file's lock.
  const hold = async () => {
    const release = await acquireFileLock(file);
    let held = true;
    const free = async () => {
      if (held) await release();
      held = false;
    };
    t.after(free);
    return free;
  };
  return { file, keeper, writes, stored, hold, outcomes };
}

test("a choice the file takes is written at once, waiting a second at most for its lock", async (t) => {
  const { keeper, writes, stored, outcomes } = await stage(t, JSON.stringify({ schema_version: 1 }));
  assert.equal(await keeper.choose("ru"), true);
  assert.equal(await stored(), "ru");
  assert.equal(keeper.waiting(), null);
  // The app hears of it: the file changed, and it names Russian.
  assert.deepEqual(outcomes, [{ changed: true, language: "ru" }]);
  assert.equal(await keeper.choose("ru"), true);
  assert.deepEqual(outcomes.at(-1), { changed: false, language: "ru" }, "the same language again changes nothing");
  assert.ok(LOCK_WAIT_MS <= 1_000);
  assert.deepEqual([writes[0].lockTimeoutMs, writes[0].unsetOnly], [LOCK_WAIT_MS, false]);
});

test("a choice made while the file is broken waits, and is written within a look once the file is fixed", async (t) => {
  const { file, keeper, stored } = await stage(t, "{ not json");
  const chosen = Date.now();
  assert.equal(await keeper.choose("ru"), false);
  assert.equal(keeper.waiting(), "ru");
  assert.equal(await fs.readFile(file, "utf8"), "{ not json", "a broken file is not written over");
  assert.ok(LOOK_EVERY_MS <= 500, "looked at twice a second");
  await fs.rm(file);
  assert.equal(await until(async () => (await stored()) === "ru", 10_000), true);
  // The first look comes half a second after the choice, not seconds later.
  assert.ok(Date.now() - chosen < 2_500, `written ${Date.now() - chosen} ms after the choice`);
  // The file is renamed into place a moment before the write returns.
  assert.equal(await until(() => keeper.waiting() === null), true);
});

test("it gives way to a language the person writes into the fixed file — decided under the file's lock, the empty one too", async (t) => {
  const { file, keeper, writes, stored, hold, outcomes } = await stage(t, "{ not json");
  await keeper.choose("ru");
  const free = await hold();
  await fs.writeFile(file, JSON.stringify({ schema_version: 1 }));
  // The keeper's write now waits for the lock; the person names English in an editor, which takes none.
  const before = writes.length;
  assert.equal(await until(() => writes.length > before), true);
  await sleep(50);
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, language: "en" }));
  await free();
  assert.equal(await until(() => keeper.waiting() === null), true);
  assert.equal(await stored(), "en");
  // The app hears the file's own language, which it then speaks.
  assert.deepEqual(outcomes, [{ changed: false, language: "en" }]);
  await sleep(2 * LOOK_EVERY_MS);
  assert.equal(await stored(), "en", "and nothing is written over it later");
  // The empty language is the system's: a language of the file's own.
  const empty = await stage(t, "{ not json");
  await empty.keeper.choose("ru");
  await fs.writeFile(empty.file, JSON.stringify({ schema_version: 1, language: "" }));
  assert.equal(await until(() => empty.keeper.waiting() === null), true);
  assert.equal(await empty.stored(), "");
});

test("a later choice is never written over by an earlier one that waited", async (t) => {
  const { file, keeper, writes, stored, hold } = await stage(t, "{ not json");
  await keeper.choose("ru");
  const free = await hold();
  await fs.rm(file);
  const before = writes.length;
  assert.equal(await until(() => writes.length > before), true, "the write of Russian waits for the lock");
  const english = keeper.choose("en");
  await sleep(50);
  await free();
  assert.equal(await english, true);
  assert.equal(await stored(), "en");
  assert.equal(keeper.waiting(), null);
  await sleep(2 * LOOK_EVERY_MS);
  assert.equal(await stored(), "en");
});

test("a later choice made while the file is still broken is not given way to the earlier one this app wrote", async (t) => {
  const { file, keeper, writes, stored, hold } = await stage(t, "{ not json");
  await keeper.choose("ru");
  const free = await hold();
  const before = writes.length;
  assert.equal(await until(() => writes.length > before), true, "the write of Russian waits for the lock");
  // English is chosen while the file is still broken; then the file is fixed.
  const english = keeper.choose("en");
  await fs.rm(file);
  await free();
  await english;
  assert.equal(await until(() => keeper.waiting() === null), true);
  assert.equal(await stored(), "en", "Russian, which this app wrote, is no language of the person's own");
});

test("a choice whose write failed on a readable file is written once it can be, over the file's language", async (t) => {
  const { keeper, stored, hold } = await stage(t, JSON.stringify({ schema_version: 1, language: "en" }));
  const free = await hold();
  const started = Date.now();
  assert.equal(await keeper.choose("ru"), false);
  assert.ok(Date.now() - started < LOCK_WAIT_MS + 1_000, `the choice waited ${Date.now() - started} ms`);
  assert.equal(keeper.waiting(), "ru");
  await free();
  assert.equal(await until(async () => (await stored()) === "ru"), true);
  assert.equal(await until(() => keeper.waiting() === null), true);
});

test("a file a newer AI Dev wrote: the choice holds, and the file is not tried again", async (t) => {
  const { file, keeper, writes } = await stage(t, JSON.stringify({ schema_version: 2, projects_root: "" }));
  assert.equal(await keeper.choose("ru"), false);
  assert.equal(keeper.waiting(), "ru");
  const tried = writes.length;
  await sleep(3 * LOOK_EVERY_MS);
  assert.equal(writes.length, tried, "no look writes again");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { schema_version: 2, projects_root: "" });
});

test("Quit: one more write of what waits, the lock waited for a second at most, the look already waiting included", async (t) => {
  const { file, keeper, writes, stored, hold } = await stage(t, "{ not json");
  await keeper.choose("ru");
  const free = await hold();
  await fs.rm(file);
  // A look is already waiting for the lock when Quit comes.
  const before = writes.length;
  assert.equal(await until(() => writes.length > before), true);
  const started = Date.now();
  assert.equal(await keeper.quit(), false);
  assert.ok(Date.now() - started < LOCK_WAIT_MS + 400, `Quit waited ${Date.now() - started} ms`);
  assert.equal(await stored(), undefined);
  await free();
  assert.equal(await keeper.settle(), true);
  assert.equal(await stored(), "ru");
});

test("Quit's second bounds a choice made just before it too, behind the look already waiting", async (t) => {
  const { file, keeper, writes, hold } = await stage(t, "{ not json");
  await keeper.choose("ru");
  const free = await hold();
  await fs.rm(file);
  const before = writes.length;
  assert.equal(await until(() => writes.length > before), true, "a look waits for the lock");
  // English, chosen now, waits behind that look; Quit comes right after.
  const english = keeper.choose("en");
  const started = Date.now();
  await keeper.quit();
  assert.ok(Date.now() - started < LOCK_WAIT_MS + 400, `Quit waited ${Date.now() - started} ms`);
  await english;
  await free();
});

test("at start-up the choice holds — unless it was made while the file could not be read and the file, fixed, names a language", async (t) => {
  const broken = await stage(t, "{ not json");
  await broken.keeper.choose("ru");
  assert.equal(broken.keeper.atStart({}), "ru", "a fixed file that names none: the choice");
  assert.equal(broken.keeper.atStart({ language: "en" }), null, "one that names its own: the file's");
  assert.equal(broken.keeper.waiting(), null);
  // The empty language is the system's: a language of the file's own too.
  const empty = await stage(t, "{ not json");
  await empty.keeper.choose("ru");
  assert.equal(empty.keeper.atStart({ language: "" }), null);
  // Made while the file could be read, the choice is newer than what the file says.
  const readable = await stage(t, JSON.stringify({ schema_version: 1, language: "en" }));
  const free = await readable.hold();
  await readable.keeper.choose("ru");
  assert.equal(readable.keeper.atStart({ language: "en" }), "ru");
  await free();
  // Made with nothing to read the file with (the install did not load): the choice.
  const keeper = createLanguageKeeper({ server: () => null, env: {} });
  t.after(() => keeper.stop());
  assert.equal(await keeper.choose("ru"), false);
  assert.equal(keeper.atStart({ language: "en" }), "ru");
});

/** A stand-in for the install's settings code whose first write is slow, and counts the writes begun. */
function slowFirst() {
  const file = { language: undefined };
  const started = { count: 0 };
  const module = {
    SETTINGS_SCHEMA_VERSION: 1,
    readSettings: () => ({ schema_version: 1, stored: {}, settings: { language: file.language ?? "" } }),
    async writeSettings({ language }) {
      started.count += 1;
      if (started.count === 1) await sleep(200);
      const changed = file.language === language ? [] : ["language"];
      file.language = language;
      return { changed, settings: { language } };
    }
  };
  return { file, started, module };
}

test("a slow earlier write in flight is never landed over a later choice", async (t) => {
  const { file, started, module } = slowFirst();
  const keeper = createLanguageKeeper({ server: () => module, env: {} });
  t.after(() => keeper.stop());
  const russian = keeper.choose("ru");
  // Russian's write is in flight, and slow, when English is chosen.
  while (started.count < 1) await sleep(1);
  const english = keeper.choose("en");
  await Promise.all([russian, english]);
  assert.equal(file.language, "en");
});

test("only the last choice's outcome is said: a write a later choice superseded says nothing", async (t) => {
  const { started, module } = slowFirst();
  const outcomes = [];
  const keeper = createLanguageKeeper({ server: () => module, env: {}, settled: (outcome) => outcomes.push(outcome) });
  t.after(() => keeper.stop());
  const russian = keeper.choose("ru");
  while (started.count < 1) await sleep(1);
  const english = keeper.choose("en");
  await Promise.all([russian, english]);
  assert.deepEqual(outcomes, [{ changed: true, language: "en" }]);
});

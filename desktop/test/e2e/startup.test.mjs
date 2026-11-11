import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { NO_SANDBOX, desktopRoot, launch, serverModule, serverRoot, shot, stage, trayNow } from "./harness.mjs";

const require = createRequire(import.meta.url);

// What the window says when the app cannot get going.

/** Another writer — `ai-dev`, the daemon — holds the settings file's lock until the returned function is called. */
async function holdSettings(t, file) {
  const { acquireFileLock } = await serverModule("src/core/file-lock.mjs");
  const release = await acquireFileLock(file);
  let held = true;
  const free = async () => {
    if (held) await release();
    held = false;
  };
  t.after(free);
  return free;
}

test("a broken settings file is said with what to do, and Try again goes on once it is fixed", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev could not start");
  assert.match(await page.textContent('[data-field="broken-error"]'), /config\.json is not JSON\.$/);
  // What to do is said once, in the app's words.
  assert.doesNotMatch(await page.textContent('[data-field="broken-error"]'), /Fix or remove it/);
  assert.equal(await page.textContent('[data-field="broken-hint"]'), "Fix the file or remove it — without it the defaults are used — then press Try again.");
  assert.equal(await page.textContent("#retry"), "Try again");
  assert.equal(await app.evaluate(() => globalThis.aiDevTest.tray.state()), "offline", "the tray is there");
  await shot(page, "broken-settings");
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("a server without its packages is said, with the command that installs them and Restart", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  // A copy of the server as a checkout without `npm ci`: no node_modules.
  const bare = path.join(s.root, "server-without-packages");
  await fs.cp(serverRoot, bare, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const { page } = await launch(t, { ...s.env, AI_DEV_SERVER_ROOT: bare });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.match(await page.textContent('[data-field="broken-error"]'), /has no packages installed/);
  assert.match(await page.textContent('[data-field="broken-hint"]'), /Run npm ci in .*server-without-packages, then restart AI Dev/);
  assert.equal(await page.textContent("#retry"), "Restart AI Dev");
  await shot(page, "broken-no-packages");
});

test("on a Russian system the start-up failure is said in Russian, and again in the language chosen after", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  await fs.writeFile(path.join(s.home, ".ai-dev", "config.json"), "{ this is not json");
  const { page } = await launch(t, { ...s.env, LANG: "ru_RU.UTF-8", LC_ALL: "ru_RU.UTF-8", LANGUAGE: "ru" });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev не смог запуститься");
  assert.match(await page.textContent('[data-field="broken-hint"]'), /^Исправьте файл или удалите его — /, "what to do, in Russian");
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "AI Dev could not start");
  assert.match(await page.textContent('[data-field="broken-hint"]'), /^Fix the file or remove it — /, "the main process's words in the new language too");
});

test("a language chosen on the failure screen holds once Try again gets going, and is written then", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev could not start");
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "AI Dev не смог запуститься");
  // The main process has tried to write it, and could not, before the file is fixed.
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  assert.equal(await fs.readFile(settings, "utf8"), "{ this is not json", "a broken file is not written over");
  // Fixed, and Try again pressed, while another writer holds the settings lock: what the page says
  // is the start-up's rule alone, not a write that came first.
  const free = await holdSettings(t, settings);
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal(await page.textContent('[data-nav="status"]'), "Статус");
  assert.equal((await trayNow(app)).menu[0].label, "Открыть AI Dev");
  assert.equal(JSON.parse(await fs.readFile(settings, "utf8")).language, undefined, "nothing written while the lock is held");
  await free();
  assert.equal(await storedLanguage(settings), "ru", "written once the file could be");
});

test("a second launch tries a failed start again: fixed meanwhile, the first window goes on", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  const second = spawn(require("electron"), [...(NO_SANDBOX ? ["--no-sandbox"] : []), desktopRoot], { env: s.env, stdio: "ignore", shell: false });
  t.after(() => {
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  });
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("Restart AI Dev asks Electron to start the app again, and to leave this run", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const bare = path.join(s.root, "server-without-packages");
  await fs.cp(serverRoot, bare, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const { app, page } = await launch(t, { ...s.env, AI_DEV_SERVER_ROOT: bare });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  // What Restart asks of Electron, seen in this process instead of done.
  await app.evaluate(({ app: electronApp }) => {
    globalThis.restartAsked = [];
    electronApp.relaunch = () => globalThis.restartAsked.push("relaunch");
    electronApp.exit = (code) => globalThis.restartAsked.push(`exit ${code}`);
  });
  await page.click("#retry");
  const deadline = Date.now() + 10_000;
  while ((await app.evaluate(() => globalThis.restartAsked.length)) < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await app.evaluate(() => globalThis.restartAsked), ["relaunch", "exit 0"]);
});

test("a fixed settings file that names a language of its own is not written over", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  await page.selectOption("#language", "ru");
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  const free = await holdSettings(t, settings);
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1, language: "en" }));
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal(await page.textContent('[data-nav="status"]'), "Status");
  await free();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(JSON.parse(await fs.readFile(settings, "utf8")).language, "en", "and nothing is written over it once the lock is free");
});

test("the tray's Quit writes a language that waits, and waits for the settings lock a second at most", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  // The lock is free a moment after Quit: the language is written before the app leaves. It is held
  // for seconds: the app leaves without it, about a second after Quit — the look already waiting
  // for the lock included.
  for (const [holdMs, written] of [[900, "ru"], [8_000, undefined]]) {
    await fs.writeFile(settings, "{ this is not json");
    const { app, page } = await launch(t, s.env);
    await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
    await page.selectOption("#language", "ru");
    await page.evaluate(() => window.aiDev.setLanguage("ru"));
    const free = await holdSettings(t, settings);
    await fs.rm(settings);
    // The looks meanwhile find the lock held.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const child = app.process();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const quitAt = Date.now();
    app.evaluate(() => {
      globalThis.aiDevTest.quit();
    }).catch(() => undefined);
    const freed = new Promise((resolve) => setTimeout(resolve, holdMs)).then(free);
    await exited;
    const took = Date.now() - quitAt;
    t.diagnostic(`lock held ${holdMs} ms: the app left ${took} ms after Quit`);
    assert.ok(took < 2_500, `the app left ${took} ms after Quit`);
    await freed;
    const stored = await fs.readFile(settings, "utf8").then(JSON.parse, () => null);
    assert.equal(stored?.language, written, `lock held ${holdMs} ms: ${JSON.stringify(stored)}`);
  }
});

/** The settings file once it names `language`, or what it holds after 30 s. */
async function storedLanguage(file) {
  let stored = null;
  for (const deadline = Date.now() + 30_000; stored?.language === undefined && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    stored = await fs.readFile(file, "utf8").then(JSON.parse, () => null);
  }
  return stored?.language;
}

test("a language chosen while the settings file is broken is written once it is fixed — online", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await fs.writeFile(settings, "{ this is not json");
  await page.selectOption("#language", "ru");
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  assert.equal(await fs.readFile(settings, "utf8"), "{ this is not json", "not written over a broken file");
  await fs.rm(settings);
  assert.equal(await storedLanguage(settings), "ru");
});

test("a language chosen while the settings file is broken is written once it is fixed — offline, with no daemon", { timeout: 180_000 }, async (t) => {
  const s = await stage(t, { settings: { daemon_autostart: false } });
  const settings = path.join(s.home, ".ai-dev", "config.json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="offline"]', { timeout: 60_000 });
  await fs.writeFile(settings, "{ this is not json");
  await page.selectOption("#language", "ru");
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  assert.equal(await fs.readFile(settings, "utf8"), "{ this is not json");
  await fs.rm(settings);
  assert.equal(await storedLanguage(settings), "ru");
  assert.equal(await page.getAttribute("[data-screen]", "data-screen"), "offline", "no daemon was needed");
});

test("a language chosen online that fixes the settings file is checked again at once", { timeout: 180_000 }, async (t) => {
  const s = await stage(t, { settings: { language: "fr" } });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const problems = () => app.evaluate(() => globalThis.aiDevTest.link.status?.settings_problems ?? null);
  for (const deadline = Date.now() + 60_000; (await problems()) === null && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match((await problems()).join(" "), /language must be ru, en or empty/);
  // The checks the main process asks for, counted.
  await app.evaluate(() => {
    const { link } = globalThis.aiDevTest;
    const ask = link.refreshStatus.bind(link);
    globalThis.checksAsked = 0;
    link.refreshStatus = (options = {}) => {
      if (options.checks !== false) globalThis.checksAsked += 1;
      return ask(options);
    };
  });
  await page.selectOption("#language", "ru");
  const chosen = Date.now();
  for (const deadline = chosen + 20_000; (await problems())?.length && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await problems(), []);
  // Well before the quick look every thirty seconds would have noticed.
  assert.ok(Date.now() - chosen < 10_000, `the verdict lost the problem ${Date.now() - chosen} ms after the choice`);
  // The same language again changes nothing in the file: the checks are not asked for.
  const asked = await app.evaluate(() => globalThis.checksAsked);
  assert.ok(asked >= 1);
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(await app.evaluate(() => globalThis.checksAsked), asked);
});

test("a choice that gives way to the language the fixed file names: the window speaks the file's at once", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await fs.writeFile(settings, "{ this is not json");
  await page.selectOption("#language", "ru");
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  assert.equal(await page.textContent('[data-nav="status"]'), "Статус");
  // The person fixes the file with a language of its own: the choice gives way, and the window says so.
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1, language: "en" }));
  await page.waitForFunction(() => document.querySelector('[data-nav="status"]')?.textContent === "Status", null, { timeout: 10_000 });
  assert.equal(await page.inputValue("#language"), "en");
  assert.equal(JSON.parse(await fs.readFile(settings, "utf8")).language, "en");
  // The tray follows.
  for (const deadline = Date.now() + 5_000; (await trayNow(app)).menu[0].label !== "Open AI Dev" && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await trayNow(app)).menu[0].label, "Open AI Dev");
});

test("on the failure screen, a choice that gives way to the fixed file's language: the screen's words follow", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  await page.selectOption("#language", "ru");
  await page.evaluate(() => window.aiDev.setLanguage("ru"));
  assert.equal(await page.textContent("h1"), "AI Dev не смог запуститься");
  // Fixed with a language of its own, before Try again: the main process's words on the screen come back in English.
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1, language: "en" }));
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "AI Dev could not start", null, { timeout: 10_000 });
  await page.waitForFunction(() => !/[а-яё]/i.test(document.querySelector('[data-screen="broken"]')?.textContent ?? "x"), null, { timeout: 10_000 });
});

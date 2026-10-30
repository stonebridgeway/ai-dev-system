import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { NO_SANDBOX, clientEnvironment, desktopRoot, launch, mainCall, serverModule, serverRoot, shot, stage, trayNow } from "./harness.mjs";

const require = createRequire(import.meta.url);

test("without a daemon: a clear screen with a Start button, which brings it up", { timeout: 180_000 }, async (t) => {
  // Autostart off: the app reaches only a daemon that already runs.
  const s = await stage(t, { settings: { daemon_autostart: false } });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="offline"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "The AI Dev daemon is not running");
  assert.equal(await page.isVisible("#start-daemon"), true);
  assert.equal(await page.isVisible("nav"), false, "nothing to navigate to without the daemon");
  const tray = await trayNow(app);
  assert.equal(tray.state, "offline");
  assert.deepEqual(tray.menu.filter((item) => !item.enabled).map((item) => item.id), ["rebuild", "stop"]);
  await shot(page, "offline");
  await page.click("#start-daemon");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal((await trayNow(app)).state, "failed", "online, and nothing built yet");
});

test("the tray's Stop brings the window back to the Start screen", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // A daemon that cannot answer will not stop: the tray says so, from the daemon's answer, and the
  // app stays on it with its one session.
  const pid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  process.kill(pid, "SIGSTOP");
  t.after(() => {
    try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
  });
  try {
    await app.evaluate(() => globalThis.aiDevTest.stop());
  } finally {
    process.kill(pid, "SIGCONT");
  }
  assert.equal((await trayNow(app)).menu.find((item) => item.id === "stop").label, "Stop failed — try again");
  assert.match(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), new RegExp(`Still running after Stop: daemon ${pid} \\(No handshake`));
  assert.equal(await app.evaluate(() => globalThis.aiDevTest.link.state.phase), "online");
  assert.equal(await page.getAttribute("[data-screen]", "data-screen"), "wizard");
  const kept = await mainCall(app, "system_status", { checks: false });
  assert.deepEqual([kept.result.served_by.pid, kept.result.served_by.sessions], [pid, 1], "the same session, not a second one");
  // An error on the way — none is expected, but one would not go unsaid either.
  await app.evaluate(async () => {
    const { link, stop } = globalThis.aiDevTest;
    link.stopDaemon = async () => { throw new Error("EACCES: permission denied, scandir"); };
    try {
      await stop();
    } finally {
      delete link.stopDaemon;
    }
  });
  assert.match(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), /\nStop failed: EACCES/);
  // Then it stops.
  await app.evaluate(() => globalThis.aiDevTest.stop());
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  const tray = await trayNow(app);
  assert.equal(tray.state, "offline");
  assert.equal(tray.menu.find((item) => item.id === "stop").label, "Stop the daemon");
});

test("a daemon of another build that will not stop keeps the Stop's note, offline too, and Stop is offered again", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // Another build in the same runtime home — another vault, the same AI_DEV_HOME: its client starts its own daemon.
  const otherVault = path.join(s.root, "other-vault");
  await fs.mkdir(path.join(otherVault, "02-knowledge"), { recursive: true });
  const { openControlClient } = await serverModule("src/core/control-client.mjs");
  const { client } = await openControlClient({ serverRoot, env: { ...clientEnvironment(s.env), AI_DEV_VAULT_ROOT: otherVault }, execPath: process.execPath, start: true, name: "client-of-another-build" });
  t.after(() => client.close().catch(() => undefined));
  const other = (await client.callTool({ name: "system_status", arguments: { checks: false } })).structuredContent.result.served_by.pid;
  assert.notEqual(other, await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid));
  process.kill(other, "SIGSTOP");
  t.after(() => {
    try { process.kill(other, "SIGCONT"); } catch { /* gone */ }
  });
  const stopItem = async () => (await trayNow(app)).menu.find((item) => item.id === "stop");
  const stopping = app.evaluate(() => globalThis.aiDevTest.stop());
  // While it runs, the item says so and cannot be pressed.
  assert.deepEqual(await stopItem(), { id: "stop", label: "Stopping the daemon…", enabled: false });
  await stopping;
  // The app's own daemon stopped, the other did not: offline, and the note holds.
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  assert.deepEqual(await stopItem(), { id: "stop", label: "Stop failed — try again", enabled: true });
  assert.match(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), new RegExp(`^AI Dev: the daemon is not running\\nStill running after Stop: daemon ${other} \\(No handshake`));
  // It ends: the tray sees it by itself, within a look a second (5).
  process.kill(other, "SIGKILL");
  const ended = Date.now();
  for (const deadline = ended + 10_000; (await stopItem()).enabled && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await stopItem(), { id: "stop", label: "Stop the daemon", enabled: false });
  assert.ok(Date.now() - ended < 3_000, `the note went ${Date.now() - ended} ms after the daemon ended`);
  assert.doesNotMatch(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), /after Stop/);
  // Stop works with no session too: nothing runs, nothing is said.
  await app.evaluate(() => globalThis.aiDevTest.stop());
  assert.deepEqual(await stopItem(), { id: "stop", label: "Stop the daemon", enabled: false });
  const { listDaemons } = await serverModule("src/core/daemon-client.mjs");
  assert.deepEqual((await listDaemons({ env: s.env })).map((entry) => entry.info.pid), []);
});

test("a tray rebuild the daemon's death ended is said again in the language chosen after", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // The rebuild waits for the index's lock, which this test holds; the daemon is killed meanwhile.
  const index = await mainCall(app, "search_index_status", {});
  const { acquireFileLock } = await serverModule("src/core/file-lock.mjs");
  const release = await acquireFileLock(index.result.index_path);
  t.after(() => release().catch(() => undefined));
  const pid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  const rebuild = app.evaluate(() => globalThis.aiDevTest.rebuild());
  const item = async () => (await trayNow(app)).menu.find((entry) => entry.id === "rebuild");
  for (const deadline = Date.now() + 10_000; !(await item()).label.startsWith("Rebuilding") && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  process.kill(pid, "SIGKILL");
  await rebuild;
  const tip = () => app.evaluate(() => globalThis.aiDevTest.tray.tooltip());
  assert.match(await tip(), /\nThe last rebuild failed: The daemon went away\.$/);
  // Offline it cannot be pressed: the item offers no "try again".
  assert.deepEqual(await item(), { id: "rebuild", label: "Rebuild search index", enabled: false });
  await page.selectOption("#language", "ru");
  for (const deadline = Date.now() + 10_000; !(await tip()).startsWith("AI Dev: демон") && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await tip(), "AI Dev: демон не запущен\nПоследняя перестройка не удалась: Демон пропал.");
});

test("without Node.js the app says what it needs, and Try again finds one installed since", { timeout: 120_000 }, async (t) => {
  const s = await stage(t);
  const later = path.join(s.root, "installed-later", "node");
  const { page } = await launch(t, { ...s.env, AI_DEV_NODE: later });
  await page.waitForSelector('[data-screen="no-node"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "Node.js is not found");
  assert.match(await page.textContent('[data-screen="no-node"]'), /AI_DEV_NODE names .*installed-later.*node, which is not an executable file/);
  await shot(page, "no-node");
  // The language chosen here says the problem again, in it.
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Node.js не найден");
  assert.match(await page.textContent('[data-screen="no-node"]'), /AI_DEV_NODE указывает на .*installed-later.*node, а это не исполняемый файл/);
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Node.js is not found");
  await page.click("#retry");
  await page.waitForSelector('[data-screen="no-node"]');
  // Node arrives where AI_DEV_NODE says; Try again finds it.
  await fs.mkdir(path.dirname(later), { recursive: true });
  await fs.symlink(process.execPath, later);
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("a daemon that dies is said with its log, and one a client starts later brings the app back", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const pid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  process.kill(pid, "SIGKILL");
  await page.waitForSelector('[data-screen="offline"] [data-field="offline-error"]', { timeout: 30_000 });
  assert.match(await page.textContent('[data-field="offline-error"]'), /stopped unexpectedly/);
  // The app's own words, said again in the language chosen.
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector('[data-field="offline-error"]')?.textContent.includes("Демон неожиданно остановился"));
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector('[data-field="offline-error"]')?.textContent.includes("stopped unexpectedly"));
  await page.waitForSelector('[data-screen="offline"] details.log');
  assert.equal((await trayNow(app)).state, "offline");
  await shot(page, "offline-lost");
  // An AI client starts the daemon again, as clients do: the app comes back by itself.
  const { openControlClient } = await serverModule("src/core/control-client.mjs");
  const { client } = await openControlClient({ serverRoot: path.resolve(desktopRoot, "..", "ai-dev-mcp-server"), env: clientEnvironment(s.env), execPath: process.execPath, name: "a-client" });
  t.after(() => client.close().catch(() => undefined));
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 30_000 });
  assert.notEqual(await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid), pid);
});

test("a second launch hands over to the first, which shows its window", { timeout: 120_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const second = spawn(require("electron"), [...(NO_SANDBOX ? ["--no-sandbox"] : []), desktopRoot], { env: s.env, stdio: "ignore", shell: false });
  // A second instance that does not hand over must not outlive the test, or the run waits on it.
  t.after(() => {
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  });
  const code = await Promise.race([
    new Promise((resolve) => second.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 30_000, "still running after 30 s").unref())
  ]);
  assert.equal(code, 0, "the second launch hands over and exits");
  await page.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 10_000 });
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible())), [true]);
});

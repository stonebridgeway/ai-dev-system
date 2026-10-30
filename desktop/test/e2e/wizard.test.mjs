import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { STALLED_FILE, answerFolderDialog, launch, mainCall, serverModule, shot, stage, trayNow } from "./harness.mjs";

// The first-run wizard on a real daemon, as a person goes through it: the
// projects folder, a client, the model — a download cancelled midway, then
// the model imported from a folder — the index, and Status.

test("the wizard runs to the end on a real daemon; a cancelled download leaves a consistent state", { timeout: 300_000 }, async (t) => {
  const s = await stage(t, { stall: true, seed: true });
  // A client to find: Cursor's folder in the home.
  await fs.mkdir(path.join(s.home, ".cursor"), { recursive: true });
  const { app, page } = await launch(t, s.env);

  // A fresh install has no index: the wizard opens by itself.
  await page.waitForSelector('[data-screen="wizard"][data-step="projects"]', { timeout: 60_000 });
  assert.equal((await trayNow(app)).state, "failed", "the tray says it does not work yet");
  await shot(page, "wizard-1-projects");

  // 1. The projects folder, through the system's dialog.
  await answerFolderDialog(app, s.projects);
  await page.click('[data-action="choose-projects"]');
  await page.waitForSelector(`[data-field="projects-root"]:has-text("${path.basename(s.projects)}")`);
  const stored = JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));
  assert.equal(stored.projects_root, s.projects);
  await page.click('[data-action="next"]');

  // 2. The clients found, chosen, connected.
  await page.waitForSelector('[data-step="clients"] li[data-client="cursor"]');
  assert.equal(await page.isChecked('li[data-client="cursor"] input'), true, "a client found and not connected is chosen");
  assert.equal(await page.isDisabled('li[data-client="claude-desktop"] input'), true, "a client not found cannot be chosen");
  await shot(page, "wizard-2-clients");
  // With nothing chosen, Connect cannot be pressed rather than do nothing.
  await page.uncheck('li[data-client="cursor"] input');
  assert.equal(await page.isDisabled('[data-action="connect-clients"]'), true, "nothing chosen: Connect is disabled");
  await page.check('li[data-client="cursor"] input');
  await page.click('[data-action="connect-clients"]');
  await page.waitForSelector('[data-field="clients-result"]:has-text("0 failed")');
  const cursor = JSON.parse(await fs.readFile(path.join(s.home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers?.["ai-dev"], "Cursor's config has the ai-dev entry");
  await page.click('[data-action="next"]');

  // 3. The model: a download that stalls is cancelled midway.
  await page.waitForSelector('[data-action="download-model"]');
  assert.equal(await page.textContent('[data-action="next"]'), "Skip for now");
  await page.click('[data-action="download-model"]');
  await page.waitForSelector('[data-action="cancel"]');
  await page.waitForFunction(() => document.querySelector(".progress-text")?.textContent?.length > 0);
  await shot(page, "wizard-3-model-downloading");
  // While it runs the wizard stays on it; a person who goes to Status and
  // back finds it still running, with its Cancel.
  assert.deepEqual([await page.isDisabled('[data-action="next"]'), await page.isDisabled('[data-action="back"]')], [true, true]);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "cancel", "the focus is on Cancel, not lost");
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  await page.click('[data-nav="wizard"]');
  await page.waitForSelector('[data-step="model"] [data-action="cancel"]');
  // Let the download reach the stalled file, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.click('[data-action="cancel"]');
  await page.waitForSelector('.notice:has-text("Cancelled")', { timeout: 30_000 });
  await shot(page, "wizard-4-model-cancelled");
  // Consistent: no model, what was fetched kept for the next download, the daemon still answers.
  const after = await mainCall(app, "system_status", { checks: false });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.result.model.installed, false);
  assert.ok(after.result.model.present.length > 0 || after.result.model.partial.length > 0, "the bytes fetched are kept");
  assert.equal(existsSync(path.join(after.result.model.dir, STALLED_FILE)), false, "no half file under the model's own name");
  const verified = await mainCall(app, "model_verify", {});
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.result.ready, false);

  // Then imported from a folder (a USB stick).
  await answerFolderDialog(app, s.usb);
  await page.click('[data-action="import-model"]');
  await page.waitForSelector('[data-field="model-state"]', { timeout: 120_000 });
  assert.equal(await page.textContent('[data-action="next"]'), "Next");
  await shot(page, "wizard-5-model-installed");
  await page.click('[data-action="next"]');

  // 4. The index, with the model's vectors; the wizard waits for it.
  await page.click('[data-action="build-index"]');
  await page.waitForSelector('[data-step="index"] [data-action="cancel"]');
  assert.deepEqual([await page.isDisabled('[data-action="next"]'), await page.isDisabled('[data-action="back"]')], [true, true], "no leaving a build behind");
  await page.waitForSelector('[data-field="index-result"]', { timeout: 240_000 });
  const result = await page.textContent('[data-field="index-result"]');
  assert.match(result, /, 0 failed$/, result);
  assert.equal(await page.getAttribute('[data-step="dense_index"]', "data-status"), "done");
  // The focus goes on, to Next — not to Build again, which Enter would press.
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "next");
  await shot(page, "wizard-6-index");
  // Left and come back to, the step still shows the build's outcome.
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  await page.click('[data-nav="wizard"]');
  assert.equal(await page.textContent('[data-step="index"] [data-field="index-result"]'), result);
  // And it builds again from there — the way back from Status's "Run setup again".
  await page.evaluate(() => { document.querySelector('[data-field="index-result"]').dataset.before = "1"; });
  await page.click('[data-action="build-index"]');
  await page.waitForSelector('[data-field="index-result"]:not([data-before])', { timeout: 240_000 });
  assert.match(await page.textContent('[data-field="index-result"]'), /, 0 failed$/);
  await page.click('[data-action="next"]');

  // 5. Done, and on to Status.
  await page.waitForSelector('[data-step="done"]');
  await shot(page, "wizard-7-done");
  await page.click('[data-action="open-status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  const overall = await page.getAttribute('[data-field="overall"]', "data-status");
  const failing = await page.$$eval('li.check[data-status="fail"]', (items) => items.map((item) => `${item.dataset.check}: ${item.querySelector("p")?.textContent}`));
  assert.ok(["ok", "degraded"].includes(overall), `status ${overall}; failing: ${failing.join(" | ")}`);
  assert.match(await page.textContent('[data-field="index"]'), /with vectors/);
  await shot(page, "status-after-setup");
  const tray = await trayNow(app);
  assert.equal(tray.state, overall, "the tray's colour is the status");
  assert.deepEqual(tray.menu.map((item) => [item.id, item.enabled]), [["open", true], ["rebuild", true], ["stop", true], ["quit", true]]);

  // A settings problem is said once — by the summary, or under it — whatever else the summary
  // holds on this machine.
  const file = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), daemon_idle_minutes: "forever" }));
  await page.evaluate(() => { document.querySelector('[data-field="overall"]').dataset.before = "1"; });
  await page.click('[data-action="refresh"]');
  await page.waitForSelector('[data-field="overall"]:not([data-before])', { timeout: 120_000 });
  const problem = (await mainCall(app, "system_status", { checks: false })).result.settings_problems.find((item) => item.startsWith("daemon_idle_minutes"));
  assert.ok(problem, "the daemon reports the problem");
  const why = await page.textContent('[data-field="why"]');
  assert.equal(why.split(problem).length - 1, 1, why);
});

test("Status shows each health check with its details and what to do, in Russian too", { timeout: 300_000 }, async (t) => {
  const s = await stage(t, { settings: { daemon_idle_minutes: "forever" } });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  assert.equal(await page.getAttribute('[data-field="overall"]', "data-status"), "failed", "nothing is built yet");
  // The summary is full of what is not built: the settings problem is listed under it, once.
  const problem = (await mainCall(app, "system_status", { checks: false })).result.settings_problems[0];
  assert.match(problem, /^daemon_idle_minutes/);
  const why = await page.textContent('[data-field="why"]');
  assert.equal(why.split(problem).length - 1, 1, why);
  assert.equal(await page.locator('[data-field="settings-problems"] li').count(), 1);
  const checks = await page.$$eval("li.check", (items) => items.map((item) => ({
    name: item.dataset.check,
    status: item.dataset.status,
    advice: item.querySelector(".advice")?.textContent ?? "",
    details: Boolean(item.querySelector("details"))
  })));
  assert.ok(checks.length >= 10, `${checks.length} checks`);
  const unhappy = checks.filter((check) => check.status !== "ok");
  assert.ok(unhappy.length > 0 && unhappy.every((check) => check.advice.startsWith("What to do: ")), JSON.stringify(unhappy));
  assert.ok(checks.some((check) => check.details), "a check carries its details");
  await shot(page, "status-before-setup");

  // The tray's rebuild runs the tool and comes back to the menu.
  assert.equal((await trayNow(app)).state, "failed");

  // Russian: the page, the checks' names, the tray, the stored choice.
  await page.selectOption("#language", "ru");
  await page.waitForSelector('[data-nav="status"]:has-text("Статус")');
  await page.waitForSelector('h1:has-text("Статус")');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  assert.equal(await page.textContent('li.check[data-check="search_index_file"] strong'), "Поисковый индекс");
  assert.match(await page.textContent('[data-field="why"]'), /^Почему: /);
  assert.equal((await trayNow(app)).menu[0].label, "Открыть AI Dev");
  const stored = JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));
  assert.equal(stored.language, "ru");
  await shot(page, "status-ru");
});

test("a download the daemon's going away ends, while the person is on Status, is said on the step when they come back", { timeout: 180_000 }, async (t) => {
  const s = await stage(t, { stall: true });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-step="projects"]', { timeout: 60_000 });
  await page.click('[data-action="next"]');
  await page.click('[data-action="next"]');
  await page.click('[data-action="download-model"]');
  await page.waitForSelector('[data-action="cancel"]');
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  // The tray's Stop: the download ends, and not because the person cancelled it.
  await app.evaluate(() => globalThis.aiDevTest.link.stopDaemon());
  await page.waitForSelector("#start-daemon", { timeout: 30_000 });
  await page.click("#start-daemon");
  await page.waitForSelector('[data-step="model"] .step-body .error', { timeout: 60_000 });
  assert.match(await page.textContent('[data-step="model"] .step-body .error'), /The daemon went away/);
  // Absence is counted: a failing check on an element handle would print all of Playwright.
  assert.equal(await page.locator('[data-step="model"] .notice').count(), 0, "not called cancelled");
  // The link's own words, said again in the language chosen.
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector('[data-step="model"] .step-body .error')?.textContent.includes("Демон пропал."));
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector('[data-step="model"] .step-body .error')?.textContent.includes("The daemon went away."));
  // An answer that the model is not ready is said on the step. This daemon never gives
  // one — it throws instead — so the main process is handed one in its place.
  await app.evaluate(() => {
    const { link } = globalThis.aiDevTest;
    const real = link.call;
    link.call = function (tool, args, options) {
      if (tool !== "model_import") return real.call(this, tool, args, options);
      return Promise.resolve({ ok: true, result: { ready: false, dir: "/models/bge-m3-onnx", present: [], missing: [], mismatched: ["onnx/model_int8.onnx"] } });
    };
  });
  await answerFolderDialog(app, s.usb);
  await page.click('[data-action="import-model"]');
  await page.waitForSelector('[data-step="model"] .step-body .error:has-text("onnx/model_int8.onnx")', { timeout: 30_000 });
  await app.evaluate(() => { delete globalThis.aiDevTest.link.call; });
  // The model installed meanwhile, not from this screen: the step says installed, and the old
  // outcome no longer.
  assert.equal((await mainCall(app, "model_import", { source: s.usb })).ok, true);
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  await page.click('[data-nav="wizard"]');
  await page.waitForSelector('[data-step="model"] [data-field="model-state"]', { timeout: 60_000 });
  assert.equal(await page.locator('[data-step="model"] .step-body .error').count(), 0, "no outcome that the model's state contradicts");
});

test("Status's rebuild keeps its progress and Cancel across a visit elsewhere; Cancel ends it, and the focus comes back to Rebuild", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // A build or a rebuild waits for the index's lock, held here: it runs until Cancel, however fast the machine.
  const index = await mainCall(app, "search_index_status", {});
  assert.equal(index.ok, true, index.error);
  const { tryAcquireFileLock } = await serverModule("src/core/file-lock.mjs");
  let held = null;
  for (const deadline = Date.now() + 15_000; !held?.release && Date.now() < deadline;) {
    held = await tryAcquireFileLock(index.result.index_path, { heartbeatMs: 1000 });
    if (!held.release) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(typeof held.release, "function", "the test holds the rebuild lock");
  t.after(() => held.release().catch(() => undefined));
  // The wizard's build, cancelled: the focus goes to the step's own main button, not to Next.
  await page.click('[data-action="next"]');
  await page.waitForSelector('[data-step="clients"]');
  await page.click('[data-action="next"]');
  await page.waitForSelector('[data-step="model"] [data-action="download-model"]');
  await page.click('[data-action="next"]');
  await page.click('[data-step="index"] [data-action="build-index"]');
  await page.waitForSelector('[data-step="index"] [data-action="cancel"]');
  await page.click('[data-action="cancel"]');
  await page.waitForSelector('[data-step="index"] .notice:has-text("Cancelled")', { timeout: 30_000 });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "build-index");
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  await page.click('[data-action="rebuild"]');
  await page.waitForSelector('[data-action="cancel-rebuild"]');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "cancel-rebuild", "the focus on Cancel");
  assert.equal(await page.isDisabled('[data-action="rebuild"]'), true);
  // Elsewhere and back: still running, with its Cancel.
  await page.click('[data-nav="wizard"]');
  await page.waitForSelector('[data-screen="wizard"]');
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"] [data-action="cancel-rebuild"]');
  assert.equal(await page.isDisabled('[data-action="rebuild"]'), true);
  await page.click('[data-action="cancel-rebuild"]');
  await page.waitForSelector('[data-screen="status"] .notice:has-text("Cancelled")', { timeout: 30_000 });
  assert.equal(await page.isDisabled('[data-action="rebuild"]'), false);
  assert.equal(await page.locator('[data-action="cancel-rebuild"]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "rebuild", "the focus back on Rebuild, not lost");
  // A rebuild that ends while the person is elsewhere leaves the focus where they put it.
  await page.click('[data-action="rebuild"]');
  await page.waitForSelector('[data-action="cancel-rebuild"]');
  await page.focus('[data-action="refresh"]');
  await held.release();
  await page.waitForSelector('[data-action="cancel-rebuild"]', { state: "detached", timeout: 60_000 });
  assert.equal(await page.isDisabled('[data-action="rebuild"]'), false);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "refresh");
});

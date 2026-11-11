import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { answerFolderDialog, answerMessageBox, launch, mainCall, messageBoxes, shot, stage } from "./harness.mjs";

const open = async (page, route) => {
  await page.click(`[data-nav="${route}"]`);
  await page.waitForSelector(`[data-screen="${route}"]`);
};

const stored = async (s) => JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));

test("Settings: a change is saved and says when it applies; one for new sessions reaches the app when it reconnects", { timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "settings");
  await page.waitForSelector('[data-form="settings"]');

  // A wrong value: nothing is written, the daemon's reason is shown.
  await page.fill("#setting-daemon_idle_minutes", "99999");
  await page.click('[data-action="save"]');
  await page.waitForSelector('[data-field="save-error"]');
  assert.match(await page.textContent('[data-field="save-error"]'), /10080/);
  await assert.rejects(stored(s), "no file was written");

  // The mirror applies at once; the model folder to new sessions. Both are
  // saved only once the person confirms them in the system's dialog.
  const models = path.join(s.root, "models-elsewhere");
  await page.fill("#setting-daemon_idle_minutes", "");
  await page.fill("#setting-model_mirror", "https://hf-mirror.example");
  await answerFolderDialog(app, models);
  await page.click('[data-action="choose-model_dir"]');
  await page.waitForFunction((folder) => document.querySelector("#setting-model_dir").value === folder, models);
  await answerMessageBox(app, 1);
  await page.click('[data-action="save"]');
  await page.waitForSelector('[data-field="not-confirmed"]');
  await assert.rejects(stored(s), "Cancel: nothing was written");
  const [asked] = await messageBoxes(app);
  assert.equal(asked.message, "Save these settings?");
  assert.deepEqual(asked.detail.replace(/\n {4}/g, "").split("\n").slice(2), ['model_mirror: "https://hf-mirror.example"', `model_dir: ${JSON.stringify(models)}`]);
  await answerMessageBox(app, 0);
  await page.click('[data-action="save"]');
  await page.waitForSelector('[data-field="saved"]');
  assert.equal((await messageBoxes(app)).length, 2);
  const saved = await page.textContent('[data-field="saved"]');
  assert.match(saved, /Model download mirror: applies at once/);
  assert.match(saved, /Model folder: applies to AI client sessions started afterwards/);
  assert.deepEqual(await stored(s), { schema_version: 1, model_mirror: "https://hf-mirror.example", model_dir: models });
  await page.waitForSelector('[data-pending="model_dir"]');
  await page.waitForSelector('[data-field="reconnect"]');
  await shot(page, "p11-settings-pending");
  // This session still has the old folder: installing a model is refused until it reconnects.
  const refused = await mainCall(app, "model_install", {});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Reconnect — a session started now uses the new folder/);

  // Reconnect: a new session, the same screen, nothing pending.
  await page.click('[data-action="reconnect"]');
  await page.waitForSelector('[data-screen="settings"] [data-form="settings"]', { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector("[data-pending]") && !document.querySelector('[data-field="reconnect"]'), null, { timeout: 30_000 });
  const status = await mainCall(app, "system_status", { checks: false });
  assert.equal(status.result.model.dir, models, "the new session uses the new folder");
  assert.match(await page.textContent('[data-setting="model_dir"]'), /from the settings file/);
});

test("a screen whose daemon stops says so and offers Start; Follow on the Log stops with it", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "log");
  await page.waitForSelector(".log-lines");
  // Every read of the log that reaches the main process is counted: a Follow
  // that goes on after its screen is gone shows nowhere on the page.
  await app.evaluate(() => {
    const { link } = globalThis.aiDevTest;
    const call = link.call.bind(link);
    globalThis.logReads = 0;
    link.call = (tool, ...rest) => {
      if (tool === "logs_tail") globalThis.logReads += 1;
      return call(tool, ...rest);
    };
  });
  const reads = () => app.evaluate(() => globalThis.logReads);
  await page.check("#log-follow");
  const following = Date.now();
  while ((await reads()) < 2 && Date.now() - following < 10_000) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok((await reads()) >= 2, "Follow reads the log again");
  await app.evaluate(() => globalThis.aiDevTest.link.stopDaemon());
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  const atStop = await reads();
  // Two Follow periods later the page is still the Start screen, and the log was not read again.
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(await reads(), atStop, "no read of the log once its screen is gone");
  assert.equal(await page.isVisible('[data-screen="offline"] #start-daemon'), true);
  assert.equal(await page.locator('[data-state="error"]').count(), 0);
  await page.click("#start-daemon");
  await page.waitForSelector('[data-screen="wizard"], [data-screen="status"]', { timeout: 60_000 });
});

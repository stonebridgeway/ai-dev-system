import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { clientEnvironment, launch, mainCall, serverModule, serverRoot, shot, stage, trayNow } from "./harness.mjs";

// The app and the daemon every AI client shares: one daemon for both, the
// tray's verdict, and a daemon replaced by a newer one.

test("the app and an AI client of the install share one daemon, whatever the app's own variables", { timeout: 120_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const appPid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  // A client with the clients' environment — no AI_DEV_SERVER_ROOT, no test variables — and no
  // permission to start a daemon: it reaches the app's, or fails.
  const { openControlClient } = await serverModule("src/core/control-client.mjs");
  const { client } = await openControlClient({ serverRoot, env: clientEnvironment(s.env), execPath: process.execPath, start: false, name: "a-client" });
  t.after(() => client.close().catch(() => undefined));
  const answer = (await client.callTool({ name: "system_status", arguments: { checks: false } })).structuredContent.result;
  assert.equal(answer.served_by.pid, appPid);
  assert.equal(answer.served_by.sessions, 2);
});

test("the tray's colour is the health checks' verdict: red for a failing critical check with a fresh index", { timeout: 240_000 }, async (t) => {
  const s = await stage(t, { seed: true });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal((await mainCall(app, "setup_run", {})).ok, true);
  // A registry that is not there is built at the first request that needs it;
  // an empty one, newer than every skill, is current and fails.
  await fs.writeFile(path.join(s.vault, "03-skills-catalog", "registries", "skills.index.json"), "[]\n");
  assert.equal((await mainCall(app, "rebuild_search_index", {})).ok, true);
  // The rebuild changed something: the checks ran again after it.
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 30_000;
  while ((await trayNow(app)).state !== "failed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await trayNow(app)).state, "failed");
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  assert.equal(await page.getAttribute('[data-field="overall"]', "data-status"), "failed");
  assert.equal(await page.getAttribute("li.check:first-child", "data-critical"), "true", "a failing critical check comes first");
  assert.match(await page.textContent('[data-field="why"]'), /skill_registry/);
  await shot(page, "status-critical");
});

test("a daemon replaced by a newer one is left for it, and the window stays where it is", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 60_000 });
  const old = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  // What a daemon of new code does to the one it replaces in place.
  const { listDaemons } = await serverModule("src/core/daemon-client.mjs");
  const { controlRequest } = await serverModule("src/core/daemon-channel.mjs");
  const entry = (await listDaemons({ env: s.env })).find((item) => item.info.pid === old);
  assert.equal((await controlRequest(entry.info, "retire")).retiring, true);
  // The next look at the daemon finds it retired, and the app moves on.
  await app.evaluate(() => globalThis.aiDevTest.link.refreshStatus({ checks: false }));
  const deadline = Date.now() + 30_000;
  let now = old;
  while ((now === old || now === undefined) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    now = await app.evaluate(() => globalThis.aiDevTest.link.status?.served_by?.pid);
  }
  assert.notEqual(now, old, "a daemon of the current code serves the app");
  assert.equal(await page.getAttribute("[data-screen]", "data-screen"), "status", "the window kept its screen");
  // The retired one had only the app's session: it goes.
  const gone = Date.now() + 15_000;
  const alive = () => { try { process.kill(old, 0); return true; } catch { return false; } };
  while (alive() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(), false);
});

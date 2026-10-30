import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { answerMessageBox, launch, mainCall, messageBoxes, shot, stage } from "./harness.mjs";

// The tool console on a real daemon. The confirmation is the system's message
// box, which the main process shows; here it is answered by a stand-in that
// also remembers what it was asked.

const open = async (page, route) => {
  await page.click(`[data-nav="${route}"]`);
  await page.waitForSelector(`[data-screen="${route}"]`);
};

test("a read-only tool runs at once; one that changes something runs only after the person confirms it", { timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await answerMessageBox(app, 1);
  await open(page, "console");
  await page.waitForSelector('[data-tool="list_projects"]');
  const listed = Number((await page.textContent('[data-field="tool-count"]')).replace(/\D/g, ""));
  assert.ok(listed > 140, `${listed} tools: every tool an agent gets, and the control API`);
  assert.equal(await page.getAttribute('[data-tool="list_projects"] [data-kind]', "data-kind"), "read");
  assert.equal(await page.getAttribute('[data-tool="record_decision"] [data-kind]', "data-kind"), "write");
  assert.equal(await page.getAttribute('[data-tool="model_remove"] [data-kind]', "data-kind"), "destructive");

  // Read-only: runs, no dialog, the answer readable and as JSON.
  await page.click('[data-tool="settings_get"]');
  await page.waitForSelector('[data-selected="settings_get"]');
  assert.equal(await page.isVisible('[data-field="confirm-note"]'), false);
  await page.click('[data-action="run"]');
  await page.waitForSelector('[data-field="result"]');
  assert.deepEqual(await messageBoxes(app), [], "no confirmation for a tool that only reads");
  assert.match(await page.textContent('[data-panel="readable"]'), /daemon_autostart/);
  await page.click('[data-tab="json"]');
  const json = JSON.parse(await page.textContent('[data-panel="json"] pre'));
  assert.equal(json.settings.daemon_autostart, true);
  await shot(page, "p11-console-read");

  // A form that is not filled in is not sent: no dialog either.
  await page.click('[data-tool="record_decision"]');
  await page.waitForSelector('[data-selected="record_decision"]');
  assert.equal(await page.isVisible('[data-field="confirm-note"]'), true);
  await page.click('[data-action="run"]');
  await page.waitForSelector('[data-arg="title"] .field-error:not(:empty)');
  assert.equal(await page.getAttribute("#arg-title", "aria-invalid"), "true");
  assert.deepEqual(await messageBoxes(app), []);

  // Changes something: the person cancels, nothing is written.
  await page.fill("#arg-project_path", s.projects);
  await page.fill("#arg-title", "Use Stripe for payments");
  await page.fill("#arg-decision", "Payments go through Stripe Checkout.");
  await page.fill("#arg-alternatives", "PayPal\nAdyen");
  await page.click('[data-action="run"]');
  await page.waitForSelector('[data-field="not-confirmed"]');
  const [asked] = await messageBoxes(app);
  // A long value goes on in indented rows: read each argument whole.
  asked.detail = asked.detail.replace(/\n {4}/g, "");
  assert.match(asked.message, /Run record_decision\?/);
  assert.match(asked.detail, /^title: "Use Stripe for payments"$/m);
  assert.match(asked.detail, /^alternatives: \["PayPal","Adyen"\]$/m);
  assert.match(asked.detail, new RegExp(`^project_path: ${JSON.stringify(s.projects).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}$`, "m"));
  assert.deepEqual([asked.buttons, asked.defaultId, asked.cancelId], [["Run", "Cancel"], 1, 1], "Cancel is the default");
  assert.equal(existsSync(path.join(s.projects, ".ai-dev", "decisions")), false, "nothing was written");
  await shot(page, "p11-console-not-confirmed");

  // The person confirms: it runs.
  await answerMessageBox(app, 0);
  await page.click('[data-action="run"]');
  await page.waitForSelector('[data-field="result"]');
  assert.equal((await messageBoxes(app)).length, 2);
  const decisions = await mainCall(app, "list_decisions", { project_path: s.projects });
  assert.equal(decisions.result.count, 1);
  assert.equal(decisions.result.decisions[0].title, "Use Stripe for payments");
  await shot(page, "p11-console-write");

  // The page cannot skip the dialog: the console channel asks every time, and
  // the screens' channel still refuses a tool outside the interface's list.
  await answerMessageBox(app, 1);
  const direct = await page.evaluate(async () => ({
    console: await window.aiDev.consoleCall("record_decision", { project_path: "/tmp", title: "x", decision: "y" }, "call-probe-1"),
    screens: await window.aiDev.call("record_decision", { project_path: "/tmp", title: "x", decision: "y" }, "call-probe-2"),
    unknown: await window.aiDev.consoleCall("run_anything", {}, "call-probe-3")
  }));
  assert.deepEqual([direct.console.ok, direct.console.cancelled, direct.console.confirmed], [false, true, false]);
  assert.match(direct.screens.error, /The interface does not call "record_decision"/);
  assert.match(direct.unknown.error, /lists no tool "run_anything"/);
  assert.equal((await messageBoxes(app)).length, 3, "the direct call met the dialog too");
});

test("the keyboard reaches everything: a skip link, the header, a screen, a visible focus ring", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // A screen puts the focus on its heading; before the header, the skip link leads back to it.
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1");
  await page.focus('[data-nav="status"]');
  await page.keyboard.press("Shift+Tab");
  const first = await page.evaluate(() => ({ className: document.activeElement.className, top: document.activeElement.getBoundingClientRect().top }));
  assert.equal(first.className, "skip-link");
  assert.ok(first.top >= 0, "the skip link shows when it has focus");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "screen");
  // Through the header to Projects, by keyboard only.
  await page.focus('[data-nav="status"]');
  let guard = 0;
  while ((await page.evaluate(() => document.activeElement.dataset.nav)) !== "projects" && guard < 10) {
    await page.keyboard.press("Tab");
    guard += 1;
  }
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(ring, "solid", "the focused button shows its focus ring");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-screen="projects"]');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Projects", "the screen's heading takes the focus");
  assert.equal(await page.getAttribute('[data-nav="projects"]', "aria-current"), "page");
  await shot(page, "p11-keyboard");
});

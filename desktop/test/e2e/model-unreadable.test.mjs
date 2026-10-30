import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerFolderDialog, launch, mainCall, shot, stage } from "./harness.mjs";

// A model this user cannot read is not a model to download: the wizard and
// Status say what is wrong with the folder, in both languages, and offer no
// download over it. The folder is made unreadable the
// way root cannot read past either: a file stands where a folder of its path
// should be (ENOTDIR).

test("a model that cannot be read: the wizard says why and offers no download; Status says the same", { timeout: 180_000 }, async (t) => {
  const blocked = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-unreadable-"));
  t.after(() => fs.rm(blocked, { recursive: true, force: true }));
  await fs.writeFile(path.join(blocked, "models.zip"), "not a folder");
  const modelDir = path.join(blocked, "models.zip", "bge-m3-onnx");
  const s = await stage(t, { env: { BGE_M3_ONNX_DIR: modelDir } });
  const { app, page } = await launch(t, s.env);

  await page.waitForSelector('[data-screen="wizard"][data-step="projects"]', { timeout: 60_000 });
  const status = await mainCall(app, "system_status", { checks: false });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.result.model.installed, false);
  assert.match(status.result.model.unreadable ?? "", /^ENOTDIR/, "the daemon says the model cannot be read, and why");

  await answerFolderDialog(app, s.projects);
  await page.click('[data-action="choose-projects"]');
  await page.waitForSelector(`[data-field="projects-root"]:has-text("${path.basename(s.projects)}")`);
  await page.click('[data-action="next"]');
  await page.waitForSelector('[data-step="clients"]');
  await page.click('[data-action="next"]');

  await page.waitForSelector('[data-step="model"] [data-field="model-unreadable"]', { timeout: 60_000 });
  await shot(page, "model-unreadable-wizard");
  const said = await page.textContent('[data-field="model-unreadable"]');
  assert.match(said, /cannot be read/);
  assert.ok(said.includes(modelDir), `it names the folder: ${said}`);
  assert.match(said, /ENOTDIR/, "and the reason");
  assert.equal(await page.$('[data-action="download-model"]'), null, "no download over a folder that cannot be read");
  assert.equal(await page.$('[data-action="import-model"]'), null, "nor an import into it");
  assert.equal(await page.textContent('[data-action="next"]'), "Skip for now");
  // Checked again, it says the same: nothing changed.
  await page.click('[data-action="check-model"]');
  await page.waitForSelector('[data-step="model"] [data-field="model-unreadable"]');

  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"] [data-field="model"]');
  const row = await page.textContent('[data-field="model"]');
  assert.match(row, /^cannot be read \(ENOTDIR/, `Status: ${row}`);
  assert.doesNotMatch(row, /not installed/);
  await shot(page, "model-unreadable-status");

  // In Russian too.
  await page.selectOption("#language", "ru");
  await page.waitForSelector('h1:has-text("Статус")');
  await page.waitForSelector('[data-screen="status"] [data-field="model"]');
  assert.match(await page.textContent('[data-field="model"]'), /^не читается \(ENOTDIR/);
  await page.click('[data-nav="wizard"]');
  await page.waitForSelector('[data-step="projects"], [data-step="model"]');
});

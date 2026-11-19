import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { answerFolderDialog, answerMessageBox, launch, messageBoxes, shot, stage } from "./harness.mjs";

// What a person adds and changes from the app: their own skills on the
// Skills screen, and a repository's rules, hooks and MCP servers on the Rules
// screen — on a real daemon, each change confirmed in the main process's dialog.

const open = async (page, route) => {
  await page.click(`[data-nav="${route}"]`);
  await page.waitForSelector(`[data-screen="${route}"]`);
};

const exists = (file) => fs.access(file).then(() => true, () => false);

test("Your skills: a new one from the template, one from a folder, a refusal, and one removed through the console", { timeout: 420_000 }, async (t) => {
  const s = await stage(t, { seed: true });
  const custom = path.join(s.vault, "03-skills-catalog", "sources", "custom");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "skills");
  await page.waitForSelector('[data-section="own-skills"] [data-field="own-skills"] [data-state="empty"]');
  assert.match(await page.textContent('[data-section="own-skills"]'), /more came with AI Dev/);

  // A new skill, from the template: confirmed, written, listed, found by the catalog's search.
  await answerMessageBox(app, 0);
  await page.click('[data-action="new-skill"]');
  await page.fill("#new-skill-name", "release-notes");
  await page.fill("#new-skill-description", "Write release notes from the merged pull requests of a version.");
  await page.click('[data-action="new-skill-submit"]');
  await page.waitForSelector('[data-own="release-notes"]');
  assert.match(await page.textContent('[data-field="skills-done"]'), /release-notes is started from the template/);
  assert.match(await fs.readFile(path.join(custom, "release-notes", "SKILL.md"), "utf8"), /^---\nname: release-notes\n/);
  const asked = await messageBoxes(app);
  assert.match(asked.at(-1).message, /custom_skills_add/);
  assert.match(asked.at(-1).detail, /release-notes/);
  await page.fill("#skills-query", "release notes merged pull requests");
  await page.press("#skills-query", "Enter");
  await page.waitForSelector('[data-field="catalog"] [data-skill="release-notes"]');

  // One from a folder the system's dialog gives.
  const folder = path.join(s.root, "skills", "deploy-check");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "SKILL.md"), "---\nname: deploy-check\ndescription: Check a deploy before calling it done.\n---\n# Deploy check\n");
  await answerFolderDialog(app, folder);
  await page.click('[data-action="add-folder"]');
  await page.waitForSelector('[data-own="deploy-check"]');
  assert.ok(await exists(path.join(custom, "deploy-check", "SKILL.md")));
  await shot(page, "own-skills-en");

  // Not confirmed: nothing is written, and the screen says why.
  await answerMessageBox(app, 1);
  await page.click('[data-action="new-skill"]');
  await page.fill("#new-skill-name", "never-made");
  await page.fill("#new-skill-description", "Must not exist.");
  await page.click('[data-action="new-skill-submit"]');
  await page.waitForSelector('[data-form="new-skill"] [data-field="not-confirmed"]');
  assert.equal(await exists(path.join(custom, "never-made")), false);
  await page.click('[data-action="close-form"]');

  // Removed through the tool console's confirmation: a removed folder does not come back.
  await answerMessageBox(app, 0);
  await page.click('[data-action="remove-skill"][data-skill="deploy-check"]');
  await page.waitForFunction(() => !document.querySelector('[data-own="deploy-check"]'));
  assert.equal(await exists(path.join(custom, "deploy-check")), false);
  assert.match((await messageBoxes(app)).at(-1).message, /custom_skills_remove/);
});

test("Rules: a guard rule added, switched off and removed; the hooks, the engineering rules and the MCP servers of a repository", { timeout: 420_000 }, async (t) => {
  const s = await stage(t);
  const repo = path.join(s.projects, "shop");
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "shop", version: "1.0.0" })}\n`);
  await fs.writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { pg: { command: "npx", args: ["-y", "@example/pg"] } } }));
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "rules");
  await answerFolderDialog(app, repo);
  await page.click('[data-action="choose-project"]');
  await page.waitForSelector('[data-section="guard-rules"] [data-state="empty"]');

  // The MCP servers its config starts, with what to check before trusting them.
  await page.waitForSelector('[data-table="mcp-servers"]');
  assert.match(await page.textContent('[data-table="mcp-servers"]'), /pg.*npx -y @example\/pg/s);
  assert.match(await page.textContent('[data-field="server-findings"]'), /fetches and runs whatever the registry serves/);

  // A guard rule: checked against its sample, saved after the confirmation.
  await answerMessageBox(app, 0);
  await page.fill("#rule-id", "no-force-push");
  await page.fill("#rule-pattern", "git push .*--force");
  await page.fill("#rule-example", "git push origin main --force");
  await page.fill("#rule-message", "Never force-push.");
  await page.click('[data-action="add-rule"]');
  await page.waitForSelector('[data-table="guard-rules"]');
  assert.match(await page.textContent('[data-table="guard-rules"]'), /no-force-push.*blocks.*Never force-push\./s);
  const policy = JSON.parse(await fs.readFile(path.join(repo, ".ai-dev", "policy.json"), "utf8"));
  assert.ok(policy.rules.some((rule) => rule.id === "no-force-push" && rule.action === "block"));
  // A pattern that does not match its own sample is refused, and says so.
  await page.fill("#rule-id", "too-broad");
  await page.fill("#rule-pattern", "rm -rf");
  await page.fill("#rule-example", "ls");
  await page.fill("#rule-message", "x");
  await page.click('[data-action="add-rule"]');
  await page.waitForSelector('[data-section="guard-rules"] [data-field="rules-error"]');
  assert.match(await page.textContent('[data-section="guard-rules"] [data-field="rules-error"]'), /does not match its own example/);

  await page.click('[data-action="toggle-no-force-push"]');
  await page.waitForFunction(() => /off/.test(document.querySelector('[data-table="guard-rules"]')?.textContent ?? ""));

  // The hooks that enforce them, and the engineering rules: a preview writes nothing.
  await page.click('[data-action="preview-rules"]');
  await page.waitForFunction(() => /Would write: .*AGENTS\.md/.test(document.querySelector('[data-section="hooks-and-packs"]')?.textContent ?? ""));
  assert.equal(await exists(path.join(repo, "AGENTS.md")), false);
  await page.click('[data-action="install-hooks"]');
  await page.waitForSelector('[data-field="hooks-state"]');
  await page.waitForFunction(() => /are installed/.test(document.querySelector('[data-field="hooks-state"]')?.textContent ?? ""));
  assert.ok(await exists(path.join(repo, ".ai-dev", "hooks", "guard.mjs")));
  await shot(page, "rules-en");

  // Removed through the tool console's confirmation.
  await page.click('[data-action="remove-no-force-push"]');
  await page.waitForSelector('[data-section="guard-rules"] [data-field="rules-done"]');
  assert.match(await page.textContent('[data-section="guard-rules"] [data-field="rules-done"]'), /no-force-push is removed/);
  // The table read again: the hooks' default rules stay, this one is gone.
  await page.waitForFunction(() => {
    const table = document.querySelector('[data-table="guard-rules"]');
    return table && !/no-force-push/.test(table.textContent) && /warn-eval/.test(table.textContent);
  });
  const after = JSON.parse(await fs.readFile(path.join(repo, ".ai-dev", "policy.json"), "utf8"));
  assert.equal(after.rules.some((rule) => rule.id === "no-force-push"), false);
  assert.match((await messageBoxes(app)).at(-1).message, /remove_policy_rule/);
});

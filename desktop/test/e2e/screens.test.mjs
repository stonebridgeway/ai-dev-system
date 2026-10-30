import assert from "node:assert/strict";
import test from "node:test";
import { launch, mainCall, seedWork, shot, stage } from "./harness.mjs";

// The data screens on a real daemon, with work an AI client would have made:
// a project with an epic, a decision, a handoff and usage. Each screen is
// opened from the header, read, and photographed in English and Russian.

const open = async (page, route) => {
  await page.click(`[data-nav="${route}"]`);
  await page.waitForSelector(`[data-screen="${route}"]`);
};

const loaded = (page, scope = "") => page.waitForFunction((selector) => !document.querySelector(`${selector} [data-state="loading"]`), scope, { timeout: 60_000 });

test("Projects, Costs, Skills, Log and Settings show the work, in English and Russian", { timeout: 420_000 }, async (t) => {
  const s = await stage(t, { seed: true });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const { repo, epicId } = await seedWork(app, s);

  // Projects: the list, then the card with each section filled.
  await open(page, "projects");
  await page.waitForSelector('[data-project="shop"]');
  await shot(page, "p11-projects-en");
  await page.click('[data-project="shop"] button');
  await page.waitForSelector('[data-open="shop"]');
  await loaded(page, '[data-open="shop"]');
  const card = await page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent ?? "";
    return {
      tasks: [...document.querySelectorAll('[data-table="tasks"] tbody tr')].map((row) => row.cells[0].textContent),
      epic: text("[data-epic]"),
      decision: text('[data-decision="ADR-0001"]'),
      handoff: text("[data-session]"),
      path: text(".project p.muted")
    };
  });
  assert.equal(card.tasks.length, 3, JSON.stringify(card.tasks));
  assert.ok(card.tasks.some((task) => task.startsWith("Add a checkout page")), JSON.stringify(card.tasks));
  assert.match(card.epic, /Add a checkout page/);
  assert.match(card.epic, /0 of 2 done \(0%\)/);
  assert.match(card.epic, /Next: Draw the checkout form/);
  assert.match(card.decision, /Use Stripe for payments/);
  assert.match(card.handoff, /Checkout page/);
  assert.match(card.handoff, /Next step: Wire the payment call\./);
  assert.equal(card.path, repo);
  assert.equal(await page.getAttribute(`[data-epic="${epicId}"] progress`, "value"), "0");
  assert.equal(await page.locator('[data-field="more"]').count(), 0, "everything is shown: no list says there is more");
  await shot(page, "p11-project-card-en");

  // Costs: the periods, the model, the task.
  await open(page, "costs");
  await loaded(page, '[data-screen="costs"]');
  assert.equal(await page.textContent('[data-period="today"] .tile-value'), "$0.42");
  assert.match(await page.textContent('[data-table="models"]'), /claude-sonnet-4-5/);
  assert.match(await page.textContent('[data-table="tasks"]'), new RegExp(epicId));
  assert.match(await page.textContent('[data-table="tools"]'), /record_usage/);
  await shot(page, "p11-costs-en");

  // Skills: the groups, a search, a skill read.
  await open(page, "skills");
  await page.waitForSelector(".groups [data-group]");
  await page.fill("#skills-query", "react testing");
  await page.press("#skills-query", "Enter");
  await page.waitForSelector('[data-skill="react-testing"]');
  await shot(page, "p11-skills-en");
  await page.click('[data-skill="react-testing"] button');
  await page.waitForSelector('[data-reading="react-testing"] h2');
  assert.match(await page.textContent('[data-reading="react-testing"] h2'), /React Testing/);
  await shot(page, "p11-skill-en");
  await page.click('[data-action="back"]');
  await page.waitForSelector('[data-skill="react-testing"]');

  // Log: the daemon's own lines.
  await open(page, "log");
  await page.waitForSelector(".log-lines");
  assert.match(await page.textContent(".log-lines"), /daemon|listening|session/i);
  await shot(page, "p11-log-en");

  // Settings: every setting the app changes, with what it does.
  await open(page, "settings");
  await page.waitForSelector('[data-form="settings"]');
  const settings = await page.$$eval("[data-setting]", (rows) => rows.map((row) => row.dataset.setting));
  assert.deepEqual(settings, ["projects_root", "profiles", "model_mirror", "model_dir", "daemon_idle_minutes", "daemon_autostart"]);
  assert.match(await page.textContent('[data-field="paths"]'), /config\.json/);
  await shot(page, "p11-settings-en");

  // The same screens in Russian.
  await page.selectOption("#language", "ru");
  await page.waitForSelector('[data-nav="projects"]:has-text("Проекты")');
  for (const route of ["costs", "skills", "log", "settings"]) {
    await open(page, route);
    await loaded(page, `[data-screen="${route}"]`);
    await page.waitForFunction((name) => document.querySelector(`[data-screen="${name}"] h1`)?.textContent && document.documentElement.lang === "ru", route);
    await shot(page, `p11-${route}-ru`);
  }
  assert.equal(await page.textContent('[data-screen="settings"] h1'), "Настройки");
  // Projects keeps its place: the card that was open opens again, in Russian.
  await open(page, "projects");
  await page.waitForSelector('[data-open="shop"]');
  await loaded(page, '[data-open="shop"]');
  assert.match(await page.textContent("[data-epic]"), /готово 0 из 2 \(0%\)/);
  await shot(page, "p11-project-card-ru");
  await page.click('[data-action="all-projects"]');
  await page.waitForSelector('[data-project="shop"]');
  await shot(page, "p11-projects-ru");
  const answer = await mainCall(app, "list_decisions", { project_path: repo });
  assert.equal(answer.result.count, 1, "reading the screens changed nothing");
});

test("a fresh install: each data screen says why it is empty, Skills says what to run", { timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });

  await open(page, "projects");
  await page.waitForSelector('[data-screen="projects"] [data-state="empty"]');
  assert.match(await page.textContent('[data-screen="projects"] [data-state="empty"]'), /register_project/);
  await shot(page, "p11-projects-empty");

  await open(page, "costs");
  await page.waitForSelector('[data-screen="costs"] [data-state="empty"], [data-screen="costs"] .tiles');
  // The app's own calls are recorded as tool calls, so a fresh install shows them and no cost.
  const costs = await page.textContent('[data-screen="costs"]');
  assert.match(costs, /\$0\.00|Nothing is recorded yet/);

  await open(page, "skills");
  await page.waitForSelector('[data-field="catalog"] [data-state="empty"], [data-field="catalog"] [data-state="error"]');
  assert.match(await page.textContent('[data-field="catalog"]'), /setup/i);
  await shot(page, "p11-skills-empty");
});

test("more than a screen shows: the project card and the skill search say so", { timeout: 420_000 }, async (t) => {
  const s = await stage(t, { seed: true });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const { repo } = await seedWork(app, s);
  const must = async (tool, args) => {
    const answer = await mainCall(app, tool, args);
    if (!answer.ok) throw new Error(`${tool}: ${answer.error}`);
    return answer.result;
  };
  // One more of each than the card shows: 51 decisions, 21 handoffs, 11 epics and 51 tasks in all.
  for (let index = 2; index <= 51; index += 1) await must("record_decision", { project_path: repo, title: `Decision ${index}`, decision: "d" });
  for (let index = 2; index <= 21; index += 1) await must("save_session", { project_path: repo, topic: `Handoff ${index}`, building: "b", next_step: "n", worked: [{ item: "i", evidence: "e" }] });
  for (let index = 2; index <= 11; index += 1) {
    const task = await must("begin_task", { project_path: repo, task: `Epic ${index}`, acceptance_criteria: ["done"] });
    await must("decompose_task", { task_id: task.id, subtasks: [{ task: `Epic ${index} part one`, key: "a" }, { task: `Epic ${index} part two`, depends_on: ["a"] }] });
  }
  for (let index = 1; (await must("list_tasks", { project_path: repo, limit: 100 })).length < 51; index += 1) await must("begin_task", { project_path: repo, task: `Task ${index}`, acceptance_criteria: ["done"] });

  await page.click('[data-nav="projects"]');
  await page.waitForSelector('[data-project="shop"]');
  await page.click('[data-project="shop"] button');
  await page.waitForSelector('[data-open="shop"]');
  await page.waitForFunction(() => !document.querySelector('[data-open="shop"] [data-state="loading"]'), null, { timeout: 120_000 });
  const card = await page.evaluate(() => {
    const more = (name) => document.querySelector(`[data-section="${name}"] [data-field="more"]`)?.textContent ?? null;
    return {
      tasks: [document.querySelectorAll('[data-table="tasks"] tbody tr').length, more("tasks")],
      epics: [document.querySelectorAll("[data-epic]").length, more("epics")],
      decisions: [document.querySelectorAll("[data-decision]").length, more("decisions")],
      handoffs: [document.querySelectorAll("[data-session]").length, more("handoffs")]
    };
  });
  assert.deepEqual(card, {
    tasks: [50, "The first 50 are shown; there are more."],
    epics: [10, "The first 10 are shown; there are more."],
    decisions: [50, "The first 50 are shown; there are more."],
    handoffs: [20, "The first 20 are shown; there are more."]
  });
  await shot(page, "p11-project-card-more");

  // The skill search: the seed catalog has more than 20 matches for "test".
  await page.click('[data-nav="skills"]');
  await page.waitForSelector(".groups [data-group]");
  await page.fill("#skills-query", "test");
  await page.press("#skills-query", "Enter");
  await page.waitForSelector('[data-field="results"]');
  assert.equal(await page.textContent('[data-field="results"]'), "The first 20 matches; there are more.");
  assert.equal(await page.locator("[data-skill]").count(), 20);
  // A search with no more than it shows: the count, as before.
  await page.fill("#skills-query", "zzqxvw");
  await page.press("#skills-query", "Enter");
  await page.waitForFunction(() => /found/.test(document.querySelector('[data-field="results"]')?.textContent ?? ""));
  assert.equal(await page.textContent('[data-field="results"]'), "0 found");
});

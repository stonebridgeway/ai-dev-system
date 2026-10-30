import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DECISION_STATUSES } from "../../../ai-dev-mcp-server/src/core/decision-ledger.mjs";
import { SETTINGS } from "../../../ai-dev-mcp-server/src/core/settings.mjs";
import { EPIC_CHILD_STATES } from "../../../ai-dev-mcp-server/src/core/task-epics.mjs";
import { LANGUAGES, MESSAGES, pickLanguage, translate } from "../../src/renderer/i18n.js";

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("Russian and English have the same keys and the same placeholders", () => {
  assert.deepEqual(LANGUAGES, ["en", "ru"]);
  const english = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.ru).sort(), english);
  for (const key of english) assert.deepEqual(placeholders(MESSAGES.ru[key]), placeholders(MESSAGES.en[key]), key);
  for (const key of english) assert.notEqual(MESSAGES.ru[key].trim(), "", key);
});

test("every key the code names is in the table", () => {
  const sources = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(m?js|html)$/.test(entry.name) && !["i18n.js", "messages-en.js", "messages-ru.js"].includes(entry.name)) sources.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(renderer);
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\("([a-z][\w.]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 40, `${keys.size} keys found`);
  const missing = [...keys].filter((key) => !Object.hasOwn(MESSAGES.en, key));
  assert.deepEqual(missing, []);
});

test("every key the code builds from parts is in the table, for every value the part takes", () => {
  const source = (file) => fs.readFileSync(path.join(renderer, "renderer", file), "utf8");
  const shownSettings = Object.keys(SETTINGS).filter((name) => name !== "language");
  // Each family the code builds a key of, and the values it builds it with —
  // the server's own where it declares them.
  const families = {
    "console.kind": ["read", "write", "destructive"],
    "console.error": [...new Set([...source("schema-form.js").matchAll(/code: "(\w+)"/g)].map((match) => match[1]))],
    "settings.name": shownSettings,
    "settings.help": shownSettings,
    "settings.applies": [...new Set(Object.values(SETTINGS).map((definition) => definition.applies))],
    "settings.source": ["file", "default"],
    "task.status": ["active", "complete"],
    "epic.state": [...EPIC_CHILD_STATES, "missing"],
    "decision.status": DECISION_STATUSES,
    "status.check": ["ok", "warn", "fail", "skipped"],
    "status.overall": ["ok", "degraded", "failed"],
    "wizard.step.status": ["done", "skipped", "failed"],
    // A guard rule's words: the server's own values (upsert_policy_rule's schema).
    "rules.event": ["bash", "file", "all"],
    "rules.action": ["block", "warn"],
    "rules.profile": ["minimal", "standard", "strict"],
    "wizard.clients": [...new Set([...source("setup-words.js").match(/const known = \{([^}]*)\}/)[1].matchAll(/: "(\w+)"/g)].map((match) => match[1]))],
    // What to do about a model that cannot be read, by why: the lower-case words of the choice.
    "wizard.model.unreadable": [...source("setup-words.js").match(/const advice = ([^;]*);/)[1].matchAll(/"([a-z]\w*)"/g)].map((match) => match[1]),
    wizard: [...source("wizard.js").match(/const STEPS = \[([^\]]*)\]/)[1].matchAll(/"(\w+)"/g)].map((match) => `${match[1]}.title`)
  };
  assert.ok(families["wizard.clients"].length >= 5 && families.wizard.length === 5, JSON.stringify([families["wizard.clients"], families.wizard]));
  assert.deepEqual(families["wizard.model.unreadable"], ["access", "permission", "notDirectory", "loop", "share", "other"]);
  assert.ok(families["console.error"].length >= 6, families["console.error"].join(", "));
  const missing = Object.entries(families).flatMap(([family, values]) => values.map((value) => `${family}.${value}`)).filter((key) => !Object.hasOwn(MESSAGES.en, key));
  assert.deepEqual(missing, []);
  // A family the code builds that this test does not know fails it: name its values above.
  const built = new Set();
  for (const file of fs.readdirSync(path.join(renderer, "renderer"))) {
    for (const match of source(file).matchAll(/\bt\(`([a-z][\w.]*?)\.\$\{/g)) built.add(match[1]);
  }
  for (const match of source("projects.js").matchAll(/word\(view, "([\w.]+)"/g)) built.add(match[1]);
  assert.deepEqual([...built].filter((family) => !Object.hasOwn(families, family)), []);
});

test("the language: a stored choice of ours, else the system's, else English; placeholders filled", () => {
  assert.equal(pickLanguage("ru", "en-US"), "ru");
  assert.equal(pickLanguage("", "ru-RU"), "ru");
  assert.equal(pickLanguage("de", "de-DE"), "en");
  assert.equal(pickLanguage(undefined, undefined), "en");
  assert.equal(translate("ru", "tray.rebuilding", { percent: 7 }), "Перестройка индекса… 7%");
  assert.equal(translate("en", "no.such.key"), "no.such.key");
  assert.equal(translate("xx", "app.title"), "AI Dev");
  assert.equal(translate("en", "common.error", {}), "Something went wrong: {message}", "an unknown placeholder stays visible");
});

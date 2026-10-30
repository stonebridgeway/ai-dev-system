import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ADVICE, checkTitle, orderedChecks, recommendation, unsaidProblems } from "../../src/renderer/checks.js";
import { MESSAGES, translate } from "../../src/renderer/i18n.js";

/**
 * Every health check the server runs, read from its code (`runCheck("name"`),
 * so a new one cannot go unnamed — but the three
 * `system_status` never lists (`NOT_RUN_HERE` in src/extensions/control.mjs).
 */
function serverCheckNames() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ai-dev-mcp-server", "src");
  const names = new Set();
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        for (const match of fs.readFileSync(file, "utf8").matchAll(/runCheck\("([a-z_]+)"/g)) names.add(match[1]);
      }
    }
  };
  walk(root);
  for (const unlisted of ["search_smoke", "dense_smoke", "search_eval"]) names.delete(unlisted);
  return [...names].sort();
}

const CHECK_NAMES = serverCheckNames();

const view = (language) => ({ t: (key, params) => translate(language, key, params) });

test("every piece of advice belongs to a real check and says something specific", () => {
  for (const [name, key] of Object.entries(ADVICE)) {
    assert.ok(CHECK_NAMES.includes(name), `${name} is a check`);
    for (const language of ["en", "ru"]) assert.ok(Object.hasOwn(MESSAGES[language], key), `${key} in ${language}`);
  }
  const indexMissing = { name: "search_index_file", status: "fail", critical: true };
  assert.equal(recommendation(view("en"), indexMissing), "Build the index: Setup → Search index.");
  assert.equal(recommendation(view("en"), { name: "embedding_backend", status: "skipped" }), "Install the local model: Setup → Local search model.");
  assert.match(recommendation(view("en"), { name: "something_new", status: "skipped" }), /Not set up/);
  assert.equal(recommendation(view("en"), { name: "vault_root", status: "ok" }), null);
});

test("each check has a name in both languages, and the order is failing first, the critical ones first of all", () => {
  assert.ok(CHECK_NAMES.length >= 22 && CHECK_NAMES.includes("vault_seed"), CHECK_NAMES.join(", "));
  for (const name of CHECK_NAMES) {
    assert.notEqual(checkTitle(name, view("ru").t), checkTitle(name), `${name} has a Russian name`);
  }
  assert.equal(checkTitle("search_index_file", view("en").t), "Search index");
  assert.equal(checkTitle("frontend_qa_runner"), "Frontend QA runner", "without words of the page, the dashboard's form");
  const ordered = orderedChecks([
    { name: "a", status: "ok" }, { name: "b", status: "warn" }, { name: "c", status: "fail" }, { name: "d", status: "skipped" }, { name: "e", status: "fail", critical: true }
  ]).map((check) => check.name);
  assert.deepEqual(ordered, ["e", "c", "b", "d", "a"]);
});

test("a settings problem is listed under the summary only when the summary does not say it", () => {
  const problem = 'daemon_idle_minutes: must be a number of minutes, not "forever". The default is used.';
  assert.deepEqual(unsaidProblems({ summary: problem, settings_problems: [problem] }), [], "said by the summary: not again");
  const full = "the search index is not built (setup_run builds it); required_notes: 2 required notes are missing.; search_index_file: SQLite search index is missing.";
  assert.deepEqual(unsaidProblems({ summary: full, settings_problems: [problem] }), [problem], "a full summary: the list says it");
  // The summary is the first problems joined: one among them is said already.
  assert.deepEqual(unsaidProblems({ summary: `the search index is not built (setup_run builds it); ${problem}`, settings_problems: [problem] }), []);
  assert.deepEqual(unsaidProblems({ summary: full }), []);
  assert.deepEqual(unsaidProblems(null), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalResultKey,
  collapseSearchResults,
  commonFilters,
  ftsQuery,
  keywordSearch,
  resultEntityPriority,
  splitCsv
} from "./search-query.mjs";
import { openDatabase, sqliteSupport } from "./search-sqlite.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

test("words become quoted FTS5 terms, long ones as prefixes", () => {
  assert.equal(ftsQuery("a bc def"), '"a" "bc" "def"*');
  assert.equal(ftsQuery("na\u00efve caf\u00e9_bar 2024"), '"na\u00efve"* "caf\u00e9_bar"* "2024"*');
  assert.equal(ftsQuery("\u0451\u043b\u043a\u0430 \u0438 \u043f\u0430\u043b\u043a\u0438"), '"\u0451\u043b\u043a\u0430"* "\u0438" "\u043f\u0430\u043b\u043a\u0438"*');
  assert.equal(ftsQuery("\u{1F600}\u{1F600}x"), '"x"', "an emoji is not a word");
  assert.equal(ftsQuery("--- ..."), "");
});

test("AND, OR, NOT and NEAR in a question are words, not operators (\u0414-117)", needsSqlite, () => {
  const db = openDatabase(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
    db.prepare("INSERT INTO t VALUES (?)").run("frontend and backend testing near the login, which is not working, or is it");
    for (const question of ["frontend AND backend testing", "login NOT working", "frontend OR backend", "NEAR login", "AND", "OR"]) {
      const { n } = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get(ftsQuery(question));
      assert.equal(n, 1, question);
    }
  } finally {
    db.close();
  }
});

test("lists are split on commas and trimmed", () => {
  assert.deepEqual(splitCsv(" a, b ,,c,"), ["a", "b", "c"]);
  assert.deepEqual(splitCsv(""), []);
});

test("filters are the helper's SQL", () => {
  assert.deepEqual(commonFilters({}), { where: [], params: [] });
  assert.deepEqual(commonFilters({ scope: "quality" }), {
    where: ["(d.scope = ? OR d.categories LIKE ? OR d.source LIKE ?)"],
    params: ["quality", "%quality%", "%quality%"]
  });
  assert.deepEqual(commonFilters({ scope: "skills", project: "web", source: "custom,external", categories: "a", folders: "02-knowledge/, 06-prompts" }), {
    where: [
      "d.scope = ?",
      "(d.title LIKE ? OR d.path LIKE ? OR d.source LIKE ?)",
      "(d.source LIKE ? OR d.source LIKE ?)",
      "(d.categories LIKE ?)",
      "d.path LIKE ?",
      "d.path LIKE ?"
    ],
    params: ["skills", "%web%", "%web%", "%web%", "%custom%", "%external%", "%a%", "02-knowledge%", "06-prompts%"]
  });
});

// A ranked list and what `collapse_search_results` made of it in Python.
const RANKED = [
  { scope: "skills", title: "Code  Reviewer", path: "03-skills-catalog/cards/code-reviewer.md", source: "vault-note", categories: "", score: -9.5, preview: "card" },
  { scope: "skills", title: "code reviewer", path: "03-skills-catalog/sources/custom/code-reviewer/SKILL.md", source: "custom", categories: "review", score: -8.0, preview: "registry" },
  { scope: "skills", title: "CODE REVIEWER", path: "03-skills-catalog/sources/external/x/code-reviewer/SKILL.md", source: "external/x", categories: "", score: -7.0, preview: "external" },
  { scope: "knowledge", title: "Notes", path: "02-knowledge/notes.md", source: "vault-note", categories: "", score: -6.0, preview: "n" },
  { scope: "knowledge", title: "Notes again", path: "02-knowledge/Notes.md", source: "vault-note", categories: "", score: -5.0, preview: "n2" },
  { scope: "skills", title: "Stra\u00dfe", path: "03-skills-catalog/cards/strasse.md", source: "vault-note", categories: "", score: -4.0, preview: "s" },
  { scope: "skills", title: "STRASSE", path: "03-skills-catalog/sources/design/strasse/SKILL.md", source: "design", categories: "", score: -3.0, preview: "S" },
  { scope: "skills", title: "", path: "03-skills-catalog/cards/empty.md", source: "vault-note", categories: "", score: -2.0, preview: "e" }
];

test("copies of one skill fold into its first rank, showing the preferred copy", () => {
  assert.deepEqual(RANKED.map(canonicalResultKey), [
    "skill:code reviewer", "skill:code reviewer", "skill:code reviewer", "path:02-knowledge/notes.md",
    "path:02-knowledge/notes.md", "skill:strasse", "skill:strasse", "path:03-skills-catalog/cards/empty.md"
  ]);
  assert.deepEqual(RANKED.map(resultEntityPriority), [20, 40, 30, 10, 10, 20, 30, 20]);
  const collapsed = collapseSearchResults(RANKED);
  assert.deepEqual(JSON.parse(JSON.stringify(collapsed)), [
    { scope: "skills", title: "code reviewer", path: "03-skills-catalog/sources/custom/code-reviewer/SKILL.md", source: "custom", categories: "review", score: -9.5, preview: "registry",
      duplicate_count: 2, collapsed_duplicates: ["03-skills-catalog/cards/code-reviewer.md", "03-skills-catalog/sources/external/x/code-reviewer/SKILL.md"] },
    { scope: "knowledge", title: "Notes", path: "02-knowledge/notes.md", source: "vault-note", categories: "", score: -6.0, preview: "n",
      duplicate_count: 1, collapsed_duplicates: ["02-knowledge/Notes.md"] },
    { scope: "skills", title: "STRASSE", path: "03-skills-catalog/sources/design/strasse/SKILL.md", source: "design", categories: "", score: -4.0, preview: "S",
      duplicate_count: 1, collapsed_duplicates: ["03-skills-catalog/cards/strasse.md"] },
    { scope: "skills", title: "", path: "03-skills-catalog/cards/empty.md", source: "vault-note", categories: "", score: -2.0, preview: "e" }
  ]);
  assert.deepEqual(Object.keys(collapsed[0]).slice(-2), ["duplicate_count", "collapsed_duplicates"], "key order is the helper's");
});

test("a table FTS5 cannot search falls back to a substring search by scope", needsSqlite, () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY, scope TEXT, title TEXT, path TEXT, source TEXT, categories TEXT, preview TEXT, mtime REAL, content_hash TEXT);
      CREATE TABLE docs_fts(id, title, body, path, source, categories);`);
    const insert = (id, scope, title, body) => {
      db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, 'vault-note', '', ?, 0, '')").run(id, scope, title, `${id}.md`, `preview of ${id}`);
      db.prepare("INSERT INTO docs_fts VALUES (?, ?, ?, ?, 'vault-note', '')").run(id, title, body, `${id}.md`);
    };
    insert("a", "knowledge", "Deploy guide", "how to deploy safely");
    insert("b", "skills", "Deploy skill", "deploy safely, as a skill");
    const all = keywordSearch(db, { query: "deploy safely" });
    assert.deepEqual(all.map((item) => item.title).sort(), ["Deploy guide", "Deploy skill"]);
    assert.ok(all.every((item) => item.score === 0 && item.preview.startsWith("preview of")));
    assert.deepEqual(keywordSearch(db, { query: "deploy safely", scope: "skills" }).map((item) => item.title), ["Deploy skill"]);
  } finally {
    db.close();
  }
});

test("an empty question, or one with no words, finds nothing", needsSqlite, () => {
  const db = openDatabase(":memory:");
  try {
    assert.deepEqual(keywordSearch(db, { query: "   " }), []);
    assert.deepEqual(keywordSearch(db, { query: "?!" }), []);
  } finally {
    db.close();
  }
});

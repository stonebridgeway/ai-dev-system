import assert from "node:assert/strict";
import test from "node:test";
import { GALAXY_MAX_LINKS_PER_NOTE, galaxyPreview, markdownToText, noteWikilinks, semanticRow } from "./galaxy-export.mjs";
import { SEMANTIC_DIMENSIONS } from "./search-semantic.mjs";

// Expected values are what the 2.x helper's `markdown_to_text`, `galaxy_preview`,
// `note_wikilinks` and `semantic_row` printed for the same input
// (`search-index/search_cli.py` at b73ae2f); the whole export is compared with
// it byte for byte by `npm run search:parity`.

test("markdown reads as text: link text, no marks, no bullets — any decimal digit numbers a list", () => {
  assert.equal(
    markdownToText("See [[Notes/Deploy Runbook|the runbook]] and ![[img.png]], [docs](https://x.y) **bold** `code` ~~gone~~"),
    "See the runbook and img.png, docs bold code gone"
  );
  assert.equal(
    markdownToText("  # Heading\n> quote\n- item\n12. twelfth\n١٢. arabic digits\n   * star"),
    "Heading\nquote\nitem\ntwelfth\narabic digits\nstar"
  );
  assert.equal(markdownToText("__under__ text\n\t- tab bullet"), "under text\ntab bullet");
});

test("a note's preview skips its frontmatter and title; a registry entry's is its longest line", () => {
  const note = "---\ntitle: X\n---\n# Title line\n\nBody **with** [[Link|alias]] text.\n\n- bullet one";
  assert.equal(galaxyPreview(note, "stored", true), "Body with alias text. bullet one");
  assert.equal(galaxyPreview("", "stored", true), "stored", "no body: the index's own preview");
  assert.equal(galaxyPreview("# Only title", "stored", true), "stored", "nothing past the title");
  const entry = "name: x\ndescription: short\nuse_when: when the user asks for a thorough code review of a pull request with tests\ncategories: a, b";
  assert.equal(galaxyPreview(entry, "stored", false), "use_when: when the user asks for a thorough code review of a pull request with tests");
  assert.equal(galaxyPreview("a: b\nc: d", "stored", false), "stored", "no line of 40 characters");
});

test("wikilinks: distinct targets in order, heading and block parts dropped, at most 200", () => {
  assert.deepEqual(noteWikilinks("[[A]] [[B|b]] [[A#h]] [[ C ]] [[D^x]] [[]] [[E]]"), ["A", "B", "C", "D", "E"]);
  const many = Array.from({ length: 300 }, (_, index) => `[[n${index}]]`).join(" ");
  assert.equal(noteWikilinks(many).length, GALAXY_MAX_LINKS_PER_NOTE);
  assert.deepEqual(noteWikilinks(null), []);
});

test("a sparse vector becomes a float32 row key by key, as Python's int() reads keys", () => {
  const row = new Float32Array(SEMANTIC_DIMENSIONS);
  semanticRow('{"3": 0.5, " 7 ": 0.25, "+9": 1, "1_0": 2, "x": 3, "-1": 4, "999999": 5, "4.5": 6}', row);
  const set = Object.fromEntries([...row.entries()].filter(([, value]) => value !== 0));
  assert.deepEqual(set, { 3: 0.5, 7: 0.25, 9: 1, 10: 2 });
  // Text that is not JSON is an empty row, as in the helper; JSON that is not an
  // object stopped the helper's whole export, and is an empty row here.
  for (const broken of ["not json", "", "[1, 2]", "null"]) {
    const empty = new Float32Array(SEMANTIC_DIMENSIONS);
    semanticRow(broken, empty);
    assert.ok(empty.every((value) => value === 0), broken);
  }
});

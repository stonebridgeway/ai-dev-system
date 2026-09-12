import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanDescription,
  markdownTable,
  scoreText,
  shorten,
  slugPart,
  stripBom,
  toStringList,
  yamlString
} from "./text-format.mjs";

test("stripBom removes a leading byte order mark and nothing else", () => {
  assert.equal(stripBom("\uFEFF{\"a\":1}"), "{\"a\":1}");
  assert.equal(stripBom("{\"a\":1}"), "{\"a\":1}");
  assert.equal(stripBom("a\uFEFFb"), "a\uFEFFb");
});

test("cleanDescription collapses whitespace and tolerates nullish input", () => {
  assert.equal(cleanDescription("  a\n\tb   c "), "a b c");
  assert.equal(cleanDescription(undefined), "");
  assert.equal(cleanDescription(null), "");
});

test("shorten neutralizes pipes and truncates with an ellipsis", () => {
  assert.equal(shorten("a | b", 80), "a / b");
  assert.equal(shorten("abcdefghij", 10), "abcdefghij");
  assert.equal(shorten("abcdefghijk", 10), "abcdefg...");
});

test("slugPart lowercases, hyphenates, trims and falls back", () => {
  assert.equal(slugPart("Design/Taste Skill"), "design-taste-skill");
  assert.equal(slugPart("---"), "item");
  assert.equal(slugPart("", "source"), "source");
  assert.equal(slugPart("x".repeat(200)).length, 90);
});

test("yamlString quotes any scalar as valid YAML", () => {
  assert.equal(yamlString('say "hi"'), '"say \\"hi\\""');
  assert.equal(yamlString(undefined), '""');
  assert.equal(yamlString(7), '"7"');
});

test("markdownTable renders a heading, header row and one row per item", () => {
  const table = markdownTable("Skills", [{ name: "a" }, { name: "b" }], [
    { title: "Skill", value: (row) => row.name }
  ]);
  assert.equal(table, ["# Skills", "", "| Skill |", "| --- |", "| a |", "| b |", ""].join("\n"));
});

test("markdownTable still renders a header for an empty row set", () => {
  const table = markdownTable("Empty", [], [{ title: "Skill", value: (row) => row.name }]);
  assert.equal(table, ["# Empty", "", "| Skill |", "| --- |", ""].join("\n"));
});

test("scoreText adds a point per term and three for a whole-query field match", () => {
  assert.equal(scoreText("", ["anything"]), 0);
  assert.equal(scoreText("   ", ["anything"]), 0);
  assert.equal(scoreText("alpha beta", ["alpha", "gamma"]), 1);
  assert.equal(scoreText("alpha beta", ["alpha", "beta"]), 2);
  assert.equal(scoreText("alpha beta", ["an alpha beta field"]), 5);
});

test("toStringList accepts arrays, comma strings and emptiness", () => {
  assert.deepEqual(toStringList(["a", " b ", "", null]), ["a", "b"]);
  assert.deepEqual(toStringList("a, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(toStringList(""), []);
  assert.deepEqual(toStringList(undefined), []);
  assert.deepEqual(toStringList(null), []);
});

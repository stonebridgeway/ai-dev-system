import assert from "node:assert/strict";
import test from "node:test";
import { READABLE_LIMITS, readableValue } from "../../src/renderer/readable.js";

const h = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) });
const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ""}`;

test("an answer reads as names and values, lists, and text", () => {
  const shown = readableValue({ action: "created", count: 2, ok: true, tags: ["a", "b"], empty: [], none: null, nested: {} }, h, t);
  assert.equal(shown.tag, "dl");
  const pairs = [];
  for (let index = 0; index < shown.children.length; index += 2) pairs.push([shown.children[index].children[0], shown.children[index + 1].children[0]]);
  assert.deepEqual(pairs.map(([key]) => key), ["action", "count", "ok", "tags", "empty", "none", "nested"]);
  assert.equal(pairs[0][1], "created");
  assert.equal(pairs[1][1], "2");
  assert.equal(pairs[2][1], "true");
  assert.equal(pairs[3][1].tag, "ol");
  assert.deepEqual(pairs[3][1].children.map((item) => item.children[0]), ["a", "b"]);
  assert.equal(pairs[4][1].children[0], "console.emptyList");
  assert.equal(pairs[5][1].children[0], "console.nothing");
  assert.equal(pairs[6][1].children[0], "console.emptyObject");
});

test("long or multi-line text is Markdown, and markup in it stays text", () => {
  const card = readableValue("# Shop\n\n<script>alert(1)</script>", h, t);
  assert.equal(card.tag, "div");
  assert.equal(card.children[0].tag, "h4", "a card's heading sits under the console's h3");
  assert.equal(card.children[1].children[0], "<script>alert(1)</script>");
  assert.equal(JSON.stringify(card).includes('"tag":"script"'), false);
  assert.equal(readableValue("short", h, t), "short");
});

test("a long list and a deep object are cut, and say so", () => {
  const long = readableValue(Array.from({ length: READABLE_LIMITS.items + 7 }, (_, index) => index), h, t);
  assert.equal(long.children.length, READABLE_LIMITS.items + 1);
  assert.equal(long.children.at(-1).children[0], 'console.more{"count":7}');
  const deep = readableValue({ a: { b: { c: { d: { e: 1 } } } } }, h, t);
  const level4 = deep.children[1].children[0].children[1].children[0].children[1].children[0].children[1].children[0];
  assert.equal(level4.tag, "code");
  assert.equal(level4.children[0], '{"e":1}');
});

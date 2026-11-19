import assert from "node:assert/strict";
import test from "node:test";
import { inlineParts, markdownBlocks, renderMarkdown } from "../../src/renderer/markdown.js";

// A fake `h`: the element as a plain object, so the test reads what the page would get.
const h = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) });

const SKILL = `---
name: react-testing
description: Component tests.
---

# React Testing

Test what the user **sees**, not \`state\`.

## Library Choice

| Runner | When |
|---|---|
| **Vitest** | Vite |
| Jest | Next.js |

- Render with the real providers
- Query by role,
  then by label
1. Accessible queries
2. Test ids

\`\`\`tsx
screen.getByRole("button");
<script>alert(1)</script>
\`\`\`

---
Last line.`;

test("the blocks of a skill: front matter, headings, paragraphs, a table, lists, code, a rule", () => {
  const blocks = markdownBlocks(SKILL);
  assert.deepEqual(blocks.map((block) => block.type), ["code", "heading", "paragraph", "heading", "table", "list", "list", "code", "rule", "paragraph"]);
  assert.equal(blocks[0].text, "name: react-testing\ndescription: Component tests.");
  assert.deepEqual([blocks[1].level, blocks[1].text], [1, "React Testing"]);
  assert.deepEqual(blocks[4].rows, [["Runner", "When"], ["**Vitest**", "Vite"], ["Jest", "Next.js"]]);
  assert.deepEqual(blocks[5], { type: "list", ordered: false, items: ["Render with the real providers", "Query by role, then by label"] });
  assert.deepEqual(blocks[6], { type: "list", ordered: true, items: ["Accessible queries", "Test ids"] });
  assert.equal(blocks[7].text, 'screen.getByRole("button");\n<script>alert(1)</script>');
  assert.deepEqual(markdownBlocks(""), []);
  assert.deepEqual(markdownBlocks(null), []);
});

test("inside a line: code and bold, the rest as it is", () => {
  assert.deepEqual(inlineParts("Test what the user **sees**, not `state`."), [
    { text: "Test what the user " }, { text: "sees", strong: true }, { text: ", not " }, { text: "state", code: true }, { text: "." }
  ]);
  assert.deepEqual(inlineParts("plain"), [{ text: "plain" }]);
  assert.deepEqual(inlineParts(""), []);
});

test("rendered, markup in a note stays text and headings sit under the screen's own", () => {
  const elements = renderMarkdown(SKILL, h);
  assert.equal(elements[1].tag, "h2", "a note's # is under the screen's h1");
  const code = elements[7];
  assert.equal(code.tag, "pre");
  assert.equal(code.children[0].children[0], 'screen.getByRole("button");\n<script>alert(1)</script>', "a script tag is text in a code block");
  const strings = JSON.stringify(elements);
  assert.equal(strings.includes('"tag":"script"'), false);
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>", h)[0].children[0], "<img src=x onerror=alert(1)>");
  assert.equal(renderMarkdown("###### deep", h)[0].tag, "h6", "a heading never goes past h6");
});

/**
 * The documentation's links hold: every relative link names a file or folder
 * git tracks, and every #anchor names a heading of its target the way GitHub
 * slugs it. This keeps every edit of the documents from leaving a reader at a
 * 404 or at the top of the wrong page.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { anchorsOf, checkDocumentation, documentationFiles, githubSlug, judgeLink, linksOf, trackedTree } from "./doc-links.mjs";

test("a heading's anchor is what GitHub makes of it", () => {
  assert.equal(githubSlug("What narrowing actually costs and saves"), "what-narrowing-actually-costs-and-saves");
  assert.equal(githubSlug("Install — Docker"), "install--docker", "a dash is dropped and both spaces stay");
  assert.equal(githubSlug("Установка на Windows"), "установка-на-windows");
  assert.equal(githubSlug("3.0.0: what changed"), "300-what-changed");
  assert.equal(githubSlug("✅ Done"), "-done");
  assert.equal(githubSlug("snake_case stays"), "snake_case-stays");
  const anchors = anchorsOf([
    "# The `ai-dev` command",
    "## Links [in](x.md) a **heading**",
    "## Twice", "## Twice", "## Twice",
    "```", "## Not a heading, in code", "```",
    "<!-- ## nor in a comment -->",
    '<a id="by-hand"></a>',
    "## Closed heading ##"
  ].join("\n"));
  assert.deepEqual([...anchors], ["the-ai-dev-command", "links-in-a-heading", "twice", "twice-1", "twice-2", "by-hand", "closed-heading"]);
});

test("links are read where Markdown makes them, and not in code or comments", () => {
  const links = linksOf([
    "A [link](a.md) and an ![image](img/b.png \"title\") and [nested ![x](c.svg)](d.md#part).",
    "`[not](in-code.md)` and <!-- [not](in-a-comment.md) -->",
    "```md", "[not](in-a-fence.md)", "```",
    "[defined]: e.md",
    "A [reference][defined], a [collapsed][] one with no definition.",
    '<a href="f.md">html</a> <img src="g.png">'
  ].join("\n"));
  assert.deepEqual(links.map((link) => link.target ?? `[${link.label}]`), ["a.md", "img/b.png", "c.svg", "d.md#part", "e.md", "f.md", "g.png", "[collapsed]"]);
  assert.equal(links.find((link) => link.target === "f.md").line, 8);
});

test("a link is judged against what git tracks and the headings of its target", () => {
  const tree = trackedTree();
  const judge = (target, from = "README.md") => judgeLink({ target, line: 1, kind: "inline" }, from, { tree });
  assert.equal(judge("docs/INSTALL.md"), null);
  assert.equal(judge("docs/"), null, "a folder");
  assert.equal(judge("#licences"), null, "a heading of the same page");
  assert.equal(judge("../README.md#licences", "docs/INSTALL.md"), null);
  assert.equal(judge("/docs/INSTALL.md"), null, "from the repository's root");
  assert.equal(judge("https://github.com/stonebridgeway/ai-dev-system/blob/main/docs/INSTALL.md"), null, "a link into this repository, written out in full");
  assert.match(judge("https://github.com/stonebridgeway/ai-dev-system/blob/main/docs/NOPE.md").reason, /docs\/NOPE\.md does not exist/);
  assert.deepEqual(judge("https://example.com/x"), { external: true });
  assert.equal(judge("mailto:someone@example.com"), null);
  assert.match(judge("docs/NOPE.md").reason, /does not exist/);
  assert.match(judge("#no-such-heading").reason, /has no heading #no-such-heading/);
  assert.match(judge("../outside.md").reason, /outside the repository/);
  assert.match(judge("docs/#x").reason, /on a folder/);
  assert.equal(judge("ai-dev-mcp-server/package.json#L3"), null, "a line of a file GitHub shows");
  assert.match(judge("ai-dev-mcp-server/package.json#scripts").reason, /not Markdown/);
  assert.match(judgeLink({ target: null, label: "gone", line: 4, kind: "undefined-reference" }, "README.md", { tree }).reason, /no definition for the reference \[gone\]/);
});

test("the documentation has no broken link", () => {
  const tree = trackedTree();
  const files = documentationFiles(tree);
  assert.ok(files.includes("README.md") && files.includes("docs/ru/INSTALL.md"), "the documents are read");
  assert.ok(!files.some((file) => file.startsWith("docker/public-seed/")), "the vault seed is not documentation");
  const result = checkDocumentation({ tree, files });
  assert.ok(result.checked > 200, `${result.checked} links read`);
  assert.deepEqual(result.broken.map((link) => `${link.file}:${link.line}: ${link.target} — ${link.reason}`), []);
});

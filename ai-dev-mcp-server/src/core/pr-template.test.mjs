import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fillTemplate,
  findPullRequestTemplate,
  matchSectionKey,
  parseTemplate,
  renderSections,
  stripComments,
  trimBlankLines
} from "./pr-template.mjs";

async function tempProject(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-template-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

test("parseTemplate splits preamble and headings and ignores headings inside code fences", () => {
  const parsed = parseTemplate("intro\n\n## What\n\nbody\n\n```sh\n# not a heading\n```\n\n### Checklist\n- [ ] one\n");
  assert.deepEqual(parsed.preamble, ["intro", ""]);
  assert.deepEqual(parsed.sections.map((item) => [item.level, item.title]), [[2, "What"], [3, "Checklist"]]);
  assert.ok(parsed.sections[0].body.includes("# not a heading"));
  assert.deepEqual(parsed.sections[1].body, ["- [ ] one", ""]);
});

test("stripComments removes single-line, trailing and multi-line HTML comments", () => {
  assert.deepEqual(stripComments(["<!-- gone -->", "kept", ""]), ["kept", ""]);
  assert.deepEqual(stripComments(["text <!-- tail -->"]), ["text"]);
  assert.deepEqual(stripComments(["<!-- start", "middle", "end --> after", "last"]), [" after", "last"]);
  assert.deepEqual(trimBlankLines(["", " ", "a", "", ""]), ["a"]);
});

test("matchSectionKey prefers the specific heading and leaves author-owned headings alone", () => {
  assert.equal(matchSectionKey("Test plan"), "test_plan");
  assert.equal(matchSectionKey("Implementation plan"), "plan");
  assert.equal(matchSectionKey("What and why"), "summary");
  assert.equal(matchSectionKey("Changed files"), "changes");
  assert.equal(matchSectionKey("Acceptance criteria"), "acceptance");
  assert.equal(matchSectionKey("What is still open"), "outstanding");
  assert.equal(matchSectionKey("Open questions"), "outstanding");
  assert.equal(matchSectionKey("Checklist"), "");
  assert.equal(matchSectionKey("Type"), "");
  assert.equal(matchSectionKey("Breaking changes"), "");
  assert.equal(matchSectionKey("Screenshots"), "");
  assert.equal(matchSectionKey(""), "");
});

test("fillTemplate fills matched sections, keeps author sections and appends the rest", () => {
  const markdown = [
    "<!-- Thanks for contributing! -->",
    "",
    "## What and why",
    "",
    "<!-- describe your change -->",
    "",
    "## Type",
    "",
    "- [ ] Bug fix",
    "- [ ] Feature",
    "",
    "## Checklist",
    "",
    "- [ ] `npm run check` passes",
    ""
  ].join("\n");
  const sections = [
    { key: "summary", title: "Summary", lines: ["Adds the thing."] },
    { key: "acceptance", title: "Acceptance criteria", lines: ["| AC-1 | met |"] },
    { key: "decisions", title: "Decisions", lines: [] }
  ];
  const filled = fillTemplate({ markdown, sections });
  assert.deepEqual(filled.filled, [{ key: "summary", heading: "What and why" }]);
  assert.deepEqual(filled.appended, ["acceptance"]);
  assert.deepEqual(filled.kept, ["Type", "Checklist"]);
  assert.equal(filled.markdown, [
    "## What and why",
    "",
    "Adds the thing.",
    "",
    "## Type",
    "",
    "- [ ] Bug fix",
    "- [ ] Feature",
    "",
    "## Checklist",
    "",
    "- [ ] `npm run check` passes",
    "",
    "## Acceptance criteria",
    "",
    "| AC-1 | met |",
    ""
  ].join("\n"));
});

test("fillTemplate keeps the checklist a matched section carried, and keeps a template with no headings", () => {
  const withChecklist = fillTemplate({
    markdown: "## Testing\n\n<!-- how did you test? -->\n- [ ] unit tests\nfree text\n",
    sections: [{ key: "test_plan", title: "Test plan", lines: ["`npm test` — passed"] }]
  });
  assert.match(withChecklist.markdown, /## Testing\n\n`npm test` — passed\n\n- \[ \] unit tests\n$/);

  const headless = fillTemplate({
    markdown: "<!-- only instructions -->\nPlease describe your change.\n",
    sections: [{ key: "summary", title: "Summary", lines: ["Adds the thing."] }]
  });
  assert.equal(headless.markdown, "Please describe your change.\n\n## Summary\n\nAdds the thing.\n");
  assert.deepEqual(headless.appended, ["summary"]);
});

test("renderSections drops empty sections and renders the rest at the given level", () => {
  const markdown = renderSections([
    { key: "summary", title: "Summary", lines: ["One."] },
    { key: "decisions", title: "Decisions", lines: [] },
    { key: "outstanding", title: "Outstanding", lines: ["- AC-2 pending"] }
  ]);
  assert.equal(markdown, "## Summary\n\nOne.\n\n## Outstanding\n\n- AC-2 pending\n");
  assert.equal(renderSections([{ key: "summary", title: "Summary", lines: ["One."] }], 3), "### Summary\n\nOne.\n");
});

test("findPullRequestTemplate resolves files in GitHub's own order", async (t) => {
  const root = await tempProject(t, {
    ".github/PULL_REQUEST_TEMPLATE.md": "## Uppercase\n",
    "docs/PULL_REQUEST_TEMPLATE.md": "## Docs\n"
  });
  const found = await findPullRequestTemplate(root);
  assert.equal(found.path, ".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(found.markdown, /Uppercase/);
});

test("findPullRequestTemplate falls back to a template directory, preferring default.md", async (t) => {
  const root = await tempProject(t, {
    ".github/PULL_REQUEST_TEMPLATE/zebra.md": "## Zebra\n",
    ".github/PULL_REQUEST_TEMPLATE/default.md": "## Default\n",
    ".github/PULL_REQUEST_TEMPLATE/notes.txt": "ignored"
  });
  const found = await findPullRequestTemplate(root);
  assert.equal(found.path, ".github/PULL_REQUEST_TEMPLATE/default.md");
});

test("findPullRequestTemplate returns null without a template, honours an explicit path and rejects traversal", async (t) => {
  const root = await tempProject(t, { "README.md": "# project\n", "custom/pr.md": "## Custom\n", "empty.md": "   \n" });
  assert.equal(await findPullRequestTemplate(root), null);
  assert.equal((await findPullRequestTemplate(root, { explicitPath: "custom/pr.md" })).path, "custom/pr.md");
  await assert.rejects(findPullRequestTemplate(root, { explicitPath: "custom/missing.md" }), /not found or empty/);
  await assert.rejects(findPullRequestTemplate(root, { explicitPath: "empty.md" }), /not found or empty/);
  await assert.rejects(findPullRequestTemplate(root, { explicitPath: "../outside.md" }), /Unsafe template path/);
});

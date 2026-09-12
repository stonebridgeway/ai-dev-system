import assert from "node:assert/strict";
import test from "node:test";
import {
  architectureMarkdown,
  asBulletList,
  bulletValues,
  commandsByStatus,
  commandsTable,
  componentsTable,
  dangerousScriptsMarkdown,
  documentationMarkdown,
  environmentMarkdown,
  extractMarkdownSection,
  firstHeading,
  parseSimpleFrontmatterFields,
  projectSlug,
  recommendedSkillsForProject,
  recommendedSkillsMarkdown,
  scriptsTable
} from "./project-markdown.mjs";

test("a bullet list falls back to one bullet when there is nothing to list", () => {
  assert.equal(asBulletList(["a", "b"]), "- a\n- b");
  assert.equal(asBulletList([]), "- Not detected.");
  assert.equal(asBulletList([], "Nothing here."), "- Nothing here.");
});

test("the commands table names the cwd even when a command does not", () => {
  const table = commandsTable([
    { label: "Test", command: "npm test", source: "package script" },
    { label: "Lint", component: "api", cwd: "services/api", command: "ruff check", source: "detected" }
  ]).split("\n");
  assert.equal(table[0], "| Task | Component | CWD | Command | Source |");
  assert.equal(table[2], "| Test |  | . | npm test | package script |");
  assert.equal(table[3], "| Lint | api | services/api | ruff check | detected |");
});

test("a pipe inside a command cannot break the table out of its row", () => {
  const row = commandsTable([{ label: "Test", command: "a | b", source: "x" }]).split("\n")[2];
  assert.equal(row, "| Test |  | . | a \\| b | x |");
});

test("the components table says so rather than printing an empty table", () => {
  assert.equal(componentsTable(), "No project components detected.");
  const rows = componentsTable([
    { name: "web", path: "apps/web", ecosystem: "node", project_types: ["frontend"], stack: ["React", "Vite"] }
  ]).split("\n");
  assert.equal(rows[2], "| web | apps/web | node | frontend | React, Vite |");
});

test("architecture lists every axis, marking the ones nothing was found for", () => {
  const lines = architectureMarkdown({ source_roots: ["src"], ci: [] }).split("\n");
  assert.equal(lines[0], "- Source roots: `src`");
  assert.equal(lines[1], "- Test roots: not detected");
  assert.equal(lines.at(-1), "- CI workflows: not detected");
  assert.equal(architectureMarkdown().split("\n").length, 6);
});

test("the scripts table prints every script, or says there are none", () => {
  assert.equal(scriptsTable({}), "No package scripts detected.");
  assert.equal(scriptsTable({ dev: "vite" }).split("\n")[2], "| dev | vite |");
});

test("documentation is reported per file, present or missing", () => {
  assert.equal(documentationMarkdown({}), "- Documentation scan not available.");
  const rows = documentationMarkdown({
    documentation: { files: [{ path: "README.md", exists: true, type: "file" }, { path: "docs", exists: false, type: "missing" }] }
  }).split("\n");
  assert.equal(rows[2], "| README.md | present | file |");
  assert.equal(rows[3], "| docs | missing | missing |");
});

test("a local env file is called out as secret-bearing, an example is not", () => {
  assert.match(environmentMarkdown({}), /No `\.env\*` files detected/);
  const lines = environmentMarkdown({
    environment: { files: [{ path: ".env", type: "local" }, { path: ".env.example", type: "example" }], local_secret_files: [".env"], has_example: true }
  }).split("\n");
  assert.match(lines[0], /do not copy contents into chat or Obsidian/);
  assert.match(lines[1], /example\/template file/);

  const unbalanced = environmentMarkdown({
    environment: { files: [{ path: ".env", type: "local" }], local_secret_files: [".env"], has_example: false }
  });
  assert.match(unbalanced, /no `\.env\.example`\/sample file was detected/);
});

test("dangerous scripts carry the reason each was flagged", () => {
  assert.match(dangerousScriptsMarkdown({}), /No package scripts were automatically flagged/);
  assert.equal(
    dangerousScriptsMarkdown({ dangerous_scripts: [{ name: "deploy", reason: "deployment or release script", command: "./deploy.sh" }] }),
    "- `deploy`: deployment or release script. Command: `./deploy.sh`"
  );
});

test("a command counts as missing when the detector wrote `Not detected`", () => {
  const split = commandsByStatus([
    { label: "Test", command: "npm test" },
    { label: "Lint", command: "Not detected" },
    { label: "Build", command: "" }
  ]);
  assert.deepEqual(split.detected.map((item) => item.label), ["Test"]);
  assert.deepEqual(split.missing.map((item) => item.label), ["Lint", "Build"]);
});

test("a frontend project is recommended the frontend skills, and only then", () => {
  const plain = recommendedSkillsForProject({}).map(([name]) => name);
  assert.deepEqual(plain, ["repo-onboarding", "feature-builder", "bugfix-investigator", "code-reviewer", "knowledge-curator"]);

  const frontend = recommendedSkillsForProject({ is_frontend: true }).map(([name]) => name);
  assert.equal(frontend.length, 11);
  assert.ok(frontend.includes("frontend-product-builder"));
  assert.ok(frontend.includes("landing-conversion-reviewer"));
  assert.equal(frontend.at(-1), "knowledge-curator");
});

test("the recommended skills render as a table of skill and reason", () => {
  const rows = recommendedSkillsMarkdown({}).split("\n");
  assert.equal(rows[0], "| Skill | Use when |");
  assert.equal(rows[2], "| `repo-onboarding` | Repository setup, AGENTS.md, project map, quality gate. |");
  assert.equal(rows.length, 7);
});

test("a project slug is lowercase, dash-joined and bounded", () => {
  assert.equal(projectSlug("  Atlas Polyglot!  "), "atlas-polyglot");
  assert.equal(projectSlug("a".repeat(200)).length, 80);
  assert.equal(projectSlug(""), "project-0");
  // Nothing survives the slug, so the name is hashed instead of collapsing to "".
  assert.match(projectSlug("проект"), /^project-\d+$/);
  assert.notEqual(projectSlug("проект"), projectSlug("другой"));
});

test("frontmatter fields are read, JSON-quoted or bare", () => {
  const fields = parseSimpleFrontmatterFields([
    "---",
    'project_name: "Atlas: the sequel"',
    "status: registered",
    "quoted: 'single'",
    'broken: "not json',
    "not a field",
    "---",
    "# Body"
  ].join("\n"));
  assert.equal(fields.project_name, "Atlas: the sequel");
  assert.equal(fields.status, "registered");
  assert.equal(fields.quoted, "single");
  assert.equal(fields.broken, 'not json');
  assert.equal("not a field" in fields, false);
  assert.deepEqual(parseSimpleFrontmatterFields("# No frontmatter"), {});
});

test("the first heading is the first `# ` line, or nothing", () => {
  assert.equal(firstHeading("intro\n# Atlas\n# Later\n"), "Atlas");
  assert.equal(firstHeading("## Only a subheading"), "");
});

test("a markdown section ends at the next section of any name", () => {
  const doc = "# Card\n\n## Stack\n\n- Node.js\n\n## Notes\n\nkeep\n";
  assert.equal(extractMarkdownSection(doc, "Stack"), "- Node.js");
  assert.equal(extractMarkdownSection(doc, "Notes"), "keep");
  assert.equal(extractMarkdownSection(doc, "Missing"), "");
  // A section name is matched literally, not as a pattern.
  assert.equal(extractMarkdownSection("## A.B\n\nx\n", "A.B"), "x");
  assert.equal(extractMarkdownSection("## AXB\n\nx\n", "A.B"), "");
});

test("bullet values lose their backticks and their bullet", () => {
  assert.deepEqual(bulletValues("- `npm test`\n- plain\nnot a bullet\n-  \n"), ["npm test", "plain"]);
});

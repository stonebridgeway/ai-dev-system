import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGREEMENT_THRESHOLD,
  CONVENTION_PROBES,
  MIN_EVIDENCE_FILES,
  PROJECT_RULES_PATH,
  distillConventions,
  distillProjectRules,
  renderProjectRulesDraft
} from "./rules-distill.mjs";

const sample = (relative, source = "") => ({ relative, source });

async function tempProject(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-distill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

test("the catalogue of probes is well formed", () => {
  const ids = CONVENTION_PROBES.map((probe) => probe.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const probe of CONVENTION_PROBES) {
    assert.ok(probe.area, `${probe.id}: needs an area for the draft's headings`);
    assert.ok(probe.question, `${probe.id}: the evidence line names the question it answers`);
    assert.equal(typeof probe.applies, "function");
    const variants = Object.keys(probe.variants);
    assert.ok(variants.length >= 2, `${probe.id}: a convention needs something to be chosen over`);
    for (const variant of variants) {
      assert.ok(probe.rule[variant], `${probe.id}: variant ${variant} has no rule text`);
    }
  }
});

test("a convention the codebase keeps becomes a statement with its count", () => {
  const samples = [
    sample("src/a.mjs", "import fs from \"node:fs\";\nexport const a = 1;\n"),
    sample("src/b-two.mjs", "import path from \"node:path\";\nexport const b = 2;\n"),
    sample("src/c-three.mjs", "import os from \"node:os\";\nexport const c = 3;\n"),
    sample("src/d-four.mjs", "import util from \"node:util\";\nexport const d = 4;\n")
  ];
  const observations = distillConventions(samples);
  const byId = Object.fromEntries(observations.map((item) => [item.id, item]));

  assert.equal(byId.module_system.status, "settled");
  assert.equal(byId.module_system.variant, "esm");
  assert.equal(byId.module_system.share, 1);
  assert.equal(byId.module_system.files_with_signal, 4);
  assert.match(byId.module_system.statement, /^Use ES modules/);
  assert.deepEqual(byId.module_system.examples, ["src/a.mjs", "src/b-two.mjs", "src/c-three.mjs"]);

  assert.equal(byId.builtin_import_prefix.variant, "prefixed");
  assert.equal(byId.file_naming.variant, "kebab-case", "a.mjs matches no naming variant, so it is not a vote");
  assert.equal(byId.file_naming.files_with_signal, 3);
  // Nothing here is a test, so the test probes stay silent rather than guessing.
  assert.equal("test_runner" in byId, false);
  assert.equal("python_import_style" in byId, false);
});

test("a split convention is reported as split, not decided", () => {
  const samples = [
    sample("a.mjs", "import fs from \"node:fs\";\n"),
    sample("b.mjs", "import fs from \"node:fs\";\n"),
    sample("c.cjs", "const fs = require(\"node:fs\");\nmodule.exports = {};\n"),
    sample("d.cjs", "const fs = require(\"node:fs\");\nmodule.exports = {};\n")
  ];
  const [moduleSystem] = distillConventions(samples).filter((item) => item.id === "module_system");
  assert.equal(moduleSystem.status, "split");
  assert.equal(moduleSystem.variant, "");
  assert.equal(moduleSystem.share, 0.5);
  assert.match(moduleSystem.statement, /This repository does both: esm in 2 file\(s\), commonjs in 2 file\(s\)\. Pick one/);

  // A dominant variant that is still under the evidence floor is not a rule.
  const thin = distillConventions([
    sample("a.mjs", "import fs from \"node:fs\";\n"),
    sample("b.mjs", "import fs from \"node:fs\";\n"),
    sample("c.cjs", "module.exports = {};\n")
  ]).find((item) => item.id === "module_system");
  assert.equal(thin.status, "split", `2 of 3 is ${Math.round((2 / 3) * 100)}%, under the ${AGREEMENT_THRESHOLD * 100}% threshold`);
  assert.equal(MIN_EVIDENCE_FILES, 3);
});

test("test layout, runner and error style are read off the test files", () => {
  const samples = [
    sample("src/a-one.mjs", "export const a = 1;\n"),
    sample("src/a-one.test.mjs", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"a\", () => assert.ok(1));\n"),
    sample("src/b-two.test.mjs", "import test from \"node:test\";\ntest(\"b\", () => {});\n"),
    sample("src/c-three.test.mjs", "import test from \"node:test\";\ntest(\"c\", () => {});\n"),
    sample("src/d-four.mjs", "export function load() {\n  if (!1) throw new Error(\"nope\");\n  try { JSON.parse(\"\"); } catch { /* a broken record is not a failure */ }\n}\n"),
    sample("src/e-five.mjs", "export function save() {\n  throw new Error(\"not implemented\");\n}\n"),
    sample("src/f-six.mjs", "export function read() {\n  throw new Error(\"missing\");\n}\n")
  ];
  const byId = Object.fromEntries(distillConventions(samples).map((item) => [item.id, item]));
  assert.equal(byId.test_location.variant, "beside the source");
  assert.equal(byId.test_naming.variant, "*.test.*");
  assert.equal(byId.test_runner.variant, "node:test");
  assert.equal(byId.error_style.variant, "built-in Error");
  assert.equal(byId.swallowed_errors.variant, "handled or commented");
  assert.match(byId.swallowed_errors.statement, /An empty `catch` needs a comment/);
});

test("the draft says it is a draft, and carries the counts under each statement", () => {
  const observations = distillConventions([
    sample("src/a-one.mjs", "import fs from \"node:fs\";\nexport const a = 1;\n"),
    sample("src/b-two.mjs", "import path from \"node:path\";\nexport const b = 2;\n"),
    sample("src/c-three.mjs", "import os from \"node:os\";\nexport const c = 3;\n")
  ]);
  const draft = renderProjectRulesDraft({ observations, projectName: "Atlas", scannedFiles: 3, now: "2026-09-12T00:00:00.000Z" });
  assert.match(draft, /^---\nstatus: draft\n/);
  assert.match(draft, /generated_by: "ai-dev-system distill_project_rules"/);
  assert.match(draft, /# Atlas: Conventions this codebase already keeps/);
  assert.match(draft, /It is a \*\*draft\*\*/);
  assert.match(draft, /## Imports\n\n- Use ES modules/);
  assert.match(draft, /- Evidence \(how a module reaches another module\): esm: 3 — of 3 file\(s\) that say anything, 100% agree\./);
  assert.match(draft, /- For example: `src\/a-one\.mjs`/);
  assert.match(draft, /Every convention this scan looked for has one dominant form/);
  assert.match(draft, /complements `install_project_rules`/);

  const empty = renderProjectRulesDraft({ observations: [], scannedFiles: 0 });
  assert.match(empty, /Nothing could be distilled/);
});

test("the draft is written once and never over a person's edits", async (t) => {
  const root = await tempProject(t, {
    "src/a-one.mjs": "import fs from \"node:fs\";\nexport const a = 1;\n",
    "src/b-two.mjs": "import path from \"node:path\";\nexport const b = 2;\n",
    "src/c-three.mjs": "import os from \"node:os\";\nexport const c = 3;\n"
  });

  const planned = await distillProjectRules(root, { dryRun: true, projectName: "Atlas" });
  assert.equal(planned.action, "planned");
  assert.equal(planned.scanned_files, 3);
  assert.ok(planned.settled >= 2);
  assert.equal(await fs.stat(path.join(root, ...PROJECT_RULES_PATH.split("/"))).then(() => true).catch(() => false), false);

  const written = await distillProjectRules(root, { projectName: "Atlas" });
  assert.equal(written.action, "written");
  assert.equal(written.status, "draft");
  const onDisk = await fs.readFile(path.join(root, ...PROJECT_RULES_PATH.split("/")), "utf8");
  assert.match(onDisk, /^---\nstatus: draft/);

  // A draft that is already there is left alone, and says so.
  const again = await distillProjectRules(root);
  assert.equal(again.action, "kept_draft");
  assert.equal(await fs.readFile(path.join(root, ...PROJECT_RULES_PATH.split("/")), "utf8"), onDisk);

  const regenerated = await distillProjectRules(root, { overwrite: true, projectName: "Atlas" });
  assert.equal(regenerated.action, "updated");

  // Once a person removes the draft marker the file is theirs.
  await fs.writeFile(
    path.join(root, ...PROJECT_RULES_PATH.split("/")),
    "---\nstatus: confirmed\n---\n\n# Atlas rules\n\n- Use ES modules.\n",
    "utf8"
  );
  const confirmed = await distillProjectRules(root);
  assert.equal(confirmed.action, "kept_confirmed");
  assert.match(await fs.readFile(path.join(root, ...PROJECT_RULES_PATH.split("/")), "utf8"), /# Atlas rules/);
});

test("a repository with no readable sources produces a draft that says so", async (t) => {
  const root = await tempProject(t, { "main.go": "package main\n" });
  const result = await distillProjectRules(root);
  assert.equal(result.scanned_files, 0);
  assert.equal(result.settled, 0);
  assert.equal(result.split, 0);
  assert.match(result.content, /Nothing could be distilled/);
  assert.equal(result.action, "written");
});

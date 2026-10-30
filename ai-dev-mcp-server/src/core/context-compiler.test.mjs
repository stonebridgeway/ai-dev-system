import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContextPack, contextPackFreshness } from "./context-compiler.mjs";

test("context compiler selects task files, excludes secrets, and stays bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-compiler-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, "src", "components", "Checkout.tsx"), "export const Checkout = () => <button>Pay</button>;\n"),
    fs.writeFile(path.join(root, "src", "server.ts"), "export const server = true;\n"),
    fs.writeFile(path.join(root, ".env"), "PAYMENT_SECRET=do-not-read\n")
  ]);
  const pack = await compileContextPack({
    projectRoot: root,
    task: "Исправь frontend checkout component",
    project: {
      project_name: "Shop",
      project_types: ["frontend"],
      stack: ["React", "TypeScript"],
      commands: [{ label: "Test", command: "npm test", cwd: "." }]
    },
    identity: { project_id: "project-shop" },
    acceptanceCriteria: ["Checkout action works on mobile."],
    projectState: { fingerprint: "state-one", dirty_files: [] },
    skills: [{ name: "frontend-product-builder", source: "custom" }],
    agentRules: "Keep changes scoped.",
    projectBrief: "Commerce checkout.",
    qualityGate: "Run npm test.",
    maxChars: 12_000
  });
  assert.equal(pack.selected_files[0].path, "src/components/Checkout.tsx");
  assert.doesNotMatch(pack.markdown, /PAYMENT_SECRET/);
  assert.ok(pack.budget.actual_chars <= 12_000);
  assert.equal(contextPackFreshness(pack, { fingerprint: "state-one" }).fresh, true);
  assert.equal(contextPackFreshness(pack, { fingerprint: "state-two" }).fresh, false);
  assert.equal(pack.unknowns.some((item) => /quality-gate\.md/.test(item)), false, "the project has a gate");
});

test("a project with no quality gate is told what writes one", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-compiler-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "report.mjs"), "export const rows = () => [];\n");
  const pack = await compileContextPack({
    projectRoot: root,
    task: "add CSV export for the report",
    project: { project_name: "Reports", commands: [{ label: "Test", command: "npm test", cwd: "." }] },
    identity: { project_id: "project-reports" },
    acceptanceCriteria: ["The report exports as CSV."],
    projectState: { fingerprint: "state-one", dirty_files: [] }
  });
  const unknown = pack.unknowns.find((item) => /quality-gate\.md/.test(item));
  assert.match(unknown, /verify_task has no project checks to run: prepare_project writes one/);
  assert.ok(pack.markdown.includes(unknown), "and the agent reads it in the pack");
});

test("context compiler renders extra sections after routed skills and trims them under pressure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "context-compiler-extras-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.ts"), "export const x = 1;\n");
  const extras = {
    sections: [
      { id: "decisions", title: "Recent Decisions", markdown: "- ADR-0001: Keep SQLite", items: [{ id: "ADR-0001" }] },
      { id: "empty", title: "Ignored", markdown: "" }
    ]
  };
  const pack = await compileContextPack({
    projectRoot: root,
    task: "Refactor index",
    project: { project_name: "Fixture", project_types: ["backend"], commands: [] },
    projectState: { fingerprint: "s1", dirty_files: [] },
    extras,
    maxChars: 12_000
  });
  assert.deepEqual(pack.extra_sections.map((section) => section.id), ["decisions"]);
  const skillsIndex = pack.markdown.indexOf("## Routed Skills");
  const decisionsIndex = pack.markdown.indexOf("## Recent Decisions");
  const shapeIndex = pack.markdown.indexOf("## Project Shape");
  assert.ok(skillsIndex < decisionsIndex && decisionsIndex < shapeIndex);
  assert.match(pack.markdown, /- ADR-0001: Keep SQLite/);

  const squeezed = await compileContextPack({
    projectRoot: root,
    task: "Refactor index",
    project: { project_name: "Fixture", project_types: ["backend"], commands: [] },
    projectState: { fingerprint: "s1", dirty_files: [] },
    extras: { sections: [{ id: "big", title: "Big", markdown: "x".repeat(9_000) }] },
    maxChars: 8_000
  });
  assert.ok(squeezed.extra_sections[0].markdown.length <= 400);
  assert.ok(squeezed.budget.actual_chars <= 8_000 || squeezed.selected_files.length === 0);
});

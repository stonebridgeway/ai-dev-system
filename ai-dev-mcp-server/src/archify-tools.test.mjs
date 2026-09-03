import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool, tools, vaultRoot } from "./mcp-stdio.mjs";

function toolValue(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function call(name, args) {
  return toolValue(await callTool(name, args));
}

async function withProject(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "archify-tools-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

async function exampleSpec() {
  return JSON.parse(await fs.readFile(path.join(
    vaultRoot, "03-skills-catalog", "sources", "external", "archify", "examples", "web-app.architecture.json"
  ), "utf8"));
}

test("all Phase 2 Archify tools are defined", () => {
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "archify_doctor", "archify_guide", "archify_validate", "archify_render", "archify_deliver",
    "archify_visual_check", "archify_compare", "archify_migrate", "archify_brands"
  ]) assert.equal(names.has(name), true, `Missing ${name}`);
});

test("archify_doctor reports a ready vendored CLI", async () => {
  const result = await call("archify_doctor", {});
  assert.equal(result.status, "success", result.stderr || result.stdout);
  assert.match(result.checks, /Archify is ready\./);
  assert.ok(result.cli_path.endsWith(path.join("archify", "bin", "archify.mjs")));
});

test("archify_validate returns validation evidence for a shipped example", async (t) => {
  const projectRoot = await withProject(t);
  const result = await call("archify_validate", {
    project_path: projectRoot,
    artifact_location: "project",
    diagram_type: "architecture",
    spec: await exampleSpec()
  });
  assert.equal(result.status, "success", result.error);
  assert.equal(result.validation.ok, true);
  assert.ok(Array.isArray(result.validation.checks));
  assert.ok(result.validation.checks.length > 0);
});

test("archify_validate returns failure status and structured diagnostics for an invalid specification", async (t) => {
  const projectRoot = await withProject(t);
  const result = await call("archify_validate", {
    project_path: projectRoot,
    artifact_location: "project",
    diagram_type: "architecture",
    spec: {}
  });
  assert.equal(result.status, "failed");
  assert.ok(result.exit);
  assert.ok(result.diagnostics.length > 0);
  for (const diagnostic of result.diagnostics) {
    assert.ok(diagnostic.subject);
    assert.ok(diagnostic.evidence);
    assert.ok(Array.isArray(diagnostic.supportedFixes));
  }
});

test("archify_deliver writes HTML and a SHA-256 receipt", async (t) => {
  const projectRoot = await withProject(t);
  const result = await call("archify_deliver", {
    project_path: projectRoot,
    artifact_location: "project",
    output_path: "docs/diagrams/web-app.html",
    diagram_type: "architecture",
    spec: await exampleSpec()
  });
  assert.equal(result.status, "success", result.error);
  assert.equal(result.receipt.ok, true);
  assert.match(result.receipt.specification.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.artifact.sha256, /^[a-f0-9]{64}$/);
  await fs.access(path.join(projectRoot, "docs", "diagrams", "web-app.html"));
  await fs.access(result.report_path);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SKILL_SCHEMA_VERSION,
  analyzeDuplicateSkills,
  enrichSkillQuality,
  evaluateSkillQuality,
  inferFrameworks,
  summarizeSkillQuality
} from "./skill-quality.mjs";

const strongMarkdown = `---
name: backend-api-engineer
description: Use when implementing or changing a backend API, service boundary, endpoint, or asynchronous worker where contracts and operational safety matter.
---

# Backend API Engineer

## Workflow

1. Read repository rules, routes, schemas, persistence boundaries, and tests.
2. Identify the public contract, callers, failure modes, permissions, and rollback path.
3. Implement the smallest compatible change and preserve unrelated behavior.
4. Run focused tests, integration checks, and a smoke test for the changed path.

## Verification

- Verify success, validation failure, authorization failure, retry, and idempotency behavior.
- Record the commands, evidence, remaining risks, and rollback expectations.

## Guardrails

- Never expose credentials, weaken authorization, or perform destructive production actions.
- Require approval and a backup before irreversible operations.

## Output

Report contract changes, implementation scope, checks run, evidence, and residual risks.
`;

test("a complete workflow skill passes Skill Schema v2", () => {
  const item = {
    name: "backend-api-engineer",
    source: "custom",
    type: "development-workflow",
    description: "Use when implementing or changing a backend API, service boundary, endpoint, or asynchronous worker where contracts and operational safety matter."
  };
  const enriched = enrichSkillQuality(item, strongMarkdown);
  assert.equal(enriched.skill_schema_version, SKILL_SCHEMA_VERSION);
  assert.equal(enriched.quality_status, "pass");
  assert.equal(enriched.structure_status, "pass");
  assert.equal(enriched.maturity, "reviewed");
  assert.equal(enriched.validation_status, "provisional");
  assert.equal(enriched.empirical_status, "not-measured");
  assert.equal(enriched.quality_basis, "structure-only");
  assert.equal(enriched.trust_level, "trusted-local");
  assert(enriched.quality_score >= 75);
  assert(enriched.requires.length >= 2);
});

test("a placeholder skill fails with actionable findings", () => {
  const evaluation = evaluateSkillQuality(
    { name: "Weak Skill", source: "custom", description: "Do a thing." },
    "# Weak Skill\n\nTODO: fill in."
  );
  assert.equal(evaluation.status, "fail");
  assert(evaluation.findings.some((finding) => finding.code === "missing-frontmatter"));
  assert(evaluation.findings.some((finding) => finding.code === "placeholder-content"));
});

test("repository commit makes an upstream skill auditable", () => {
  const enriched = enrichSkillQuality({
    name: "vendor-workflow",
    source: "external/vendor",
    type: "development-workflow",
    description: "Use when reviewing a vendor workflow with a pinned repository revision and explicit verification.",
    repository: "https://example.test/vendor/repository.git",
    commit: "0123456789abcdef"
  }, strongMarkdown.replaceAll("backend-api-engineer", "vendor-workflow"));
  assert.equal(enriched.trust_level, "pinned-upstream");
});

test("integration quality distinguishes a generic catalog description", () => {
  const markdown = `---
name: sample-app
description: Sample App integration. Manage data, records, and automate workflows. Use when the user wants to interact with Sample App data.
---

# Sample App

## Sample App Overview

- **Record**

Official docs: https://example.test/docs

## Working with Sample App

Authentication and permissions are handled without exposing credentials. Never request tokens from the user.

## Popular actions

| Name | Key | Description |
|---|---|---|
| List | list | List records |
| Get | get | Get a record |
| Create | create | Create a record |
| Update | update | Update a record |
| Delete | delete | Delete a record with confirmation |

## Output

Run checks and return machine-readable JSON evidence.
`;
  const enriched = enrichSkillQuality({
    name: "sample-app",
    source: "membrane/application-skills",
    type: "app-integration",
    description: "Sample App integration. Manage data, records, and automate workflows. Use when the user wants to interact with Sample App data."
  }, markdown);
  assert(enriched.quality_score < 100);
  assert(enriched.quality_findings.some((finding) => finding.code === "generic-integration-description"));
});

test("framework inference does not confuse prose with Next.js or Express", () => {
  assert.deepEqual(inferFrameworks("Continue to the next step and express the result clearly."), []);
  assert.deepEqual(inferFrameworks("Build a Next.js app with an Express server."), ["next.js", "express"]);
});

test("duplicate analysis catches exact copies and ignores unrelated text", () => {
  const copied = strongMarkdown.replaceAll("backend-api-engineer", "copied-workflow");
  const records = [
    { item: { name: "copy-a", source: "custom", path: "a/SKILL.md" }, markdown: copied },
    { item: { name: "copy-b", source: "external/test", path: "b/SKILL.md" }, markdown: copied },
    { item: { name: "different", source: "external/test", path: "c/SKILL.md" }, markdown: "---\nname: different\ndescription: Use when drawing a chart.\n---\n\n## Workflow\n\n1. Inspect data.\n2. Draw chart.\n3. Verify labels." }
  ];
  const duplicates = analyzeDuplicateSkills(records, { threshold: 0.8 });
  assert.equal(duplicates.exact.length, 1);
  assert.equal(duplicates.exact[0].skills.length, 2);
});

test("quality summary separates structural readiness from empirical validation", () => {
  const item = enrichSkillQuality({
    name: "backend-api-engineer",
    source: "custom",
    type: "development-workflow",
    description: "Use when implementing or changing a backend API, service boundary, endpoint, or asynchronous worker where contracts and operational safety matter."
  }, strongMarkdown);
  const summary = summarizeSkillQuality([item]);
  assert.equal(summary.schema_current, 1);
  assert.equal(summary.important_skills, 1);
  assert.equal(summary.important_structure_ready, 1);
  assert.equal(summary.important_validated, 0);
  assert.equal(summary.important_empirical_ready, 0);
  assert.equal(summary.by_validation_status.provisional, 1);
});

const CATALOG_REGISTRY = fileURLToPath(
  new URL("../../../03-skills-catalog/registries/skills.index.json", import.meta.url)
);
const requiresCatalog = existsSync(CATALOG_REGISTRY)
  ? false
  : "requires the full skill catalog (03-skills-catalog/registries/skills.index.json)";

test("the generated registry persists Schema v2 for every current skill", { skip: requiresCatalog }, async () => {
  const registryUrl = new URL("../../../03-skills-catalog/registries/skills.index.json", import.meta.url);
  const registry = JSON.parse(await fs.readFile(registryUrl, "utf8"));
  const custom = registry.filter((item) => item.source === "custom");
  assert(registry.length > 3000);
  assert.equal(registry.filter((item) => item.skill_schema_version !== SKILL_SCHEMA_VERSION).length, 0);
  assert(custom.length >= 18);
  assert.equal(custom.filter((item) => !["reviewed", "validated"].includes(item.maturity)).length, 0);
  assert.equal(custom.filter((item) => item.quality_status !== "pass").length, 0);
});

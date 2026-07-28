import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanDistribution,
  auditDistributionTree,
  distributionPathFindings,
  distributionTextFindings
} from "./public-distribution.mjs";

test("distribution path policy rejects private vault and runtime state", () => {
  assert.ok(distributionPathFindings("02-knowledge/Projects/client.md").length > 0);
  assert.ok(distributionPathFindings(".ai-dev/context/task.md").length > 0);
  assert.ok(distributionPathFindings("runtime/search.sqlite").length > 0);
  assert.equal(distributionPathFindings("03-skills-catalog/sources/custom/reviewer/SKILL.md").length, 0);
});

test("distribution text policy reports secret classes without echoing values", () => {
  const token = ["gh", "p_", "a".repeat(30)].join("");
  const findings = distributionTextFindings(`token=${token}`, "unsafe.txt");
  assert.deepEqual(findings, [{ rule: "github-token", path: "unsafe.txt" }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test("distribution audit accepts a clean allowlisted tree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-public-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "01-system"), { recursive: true });
  await fs.writeFile(path.join(root, "01-system", "Rules.md"), "# Public rules\n");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(assertCleanDistribution(audit).total_files, 1);
});

test("distribution audit blocks owner context without exposing source text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-private-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "note.md"), "private-owner local context");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.findings, [{ rule: "private-owner-context", path: "note.md" }]);
});

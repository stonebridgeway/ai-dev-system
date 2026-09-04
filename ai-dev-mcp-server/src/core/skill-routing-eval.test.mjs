import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSkillRoutingCase, evaluateSkillRoutingSuite } from "./skill-routing-eval.mjs";

test("routing benchmark checks required, optional, forbidden, and cardinality contracts", () => {
  const result = evaluateSkillRoutingCase({
    id: "frontend-bug",
    task: "Исправь баг адаптивной формы на мобильном экране",
    expected_all: ["bugfix-investigator", "beta-frontend-maintainer", "frontend-quality-gate"],
    must_not: ["data-pipeline-engineer"]
  });
  assert.equal(result.status, "pass");
  assert.equal(result.selected.length, 3);
});

test("routing benchmark suite reports coverage and failures", () => {
  const suite = evaluateSkillRoutingSuite([
    {
      id: "db",
      task: "Добавь миграцию схемы базы данных",
      expected_all: ["feature-builder", "database-migration-guardian"],
      must_not: ["data-pipeline-engineer"]
    },
    {
      id: "impossible",
      task: "Review this change",
      expected_all: ["missing-skill"]
    }
  ]);
  assert.equal(suite.status, "fail");
  assert.equal(suite.summary.total, 2);
  assert.equal(suite.summary.failed, 1);
  assert(suite.summary.uncovered_expected_skills.includes("missing-skill"));
});

test("routing evaluation excludes capabilities from the three-skill cardinality contract", () => {
  const router = () => ({
    matched_rules: ["api", "diagramming"],
    skills: [
      { name: "feature-builder", role: "workflow" },
      { name: "backend-api-engineer", role: "domain" },
      { name: "api-contract-reviewer", role: "verification" },
      { name: "archify", role: "capability" }
    ]
  });
  const result = evaluateSkillRoutingCase({
    id: "diagram-capability",
    task: "Build an architecture diagram",
    expected_all: ["feature-builder", "backend-api-engineer", "api-contract-reviewer"],
    expected_any: ["archify"]
  }, router);
  const suite = evaluateSkillRoutingSuite([{
    id: "diagram-capability",
    task: "Build an architecture diagram",
    expected_any: ["archify"]
  }], router);

  assert.equal(result.status, "pass");
  assert.equal(result.failures.skill_limit, null);
  assert.equal(suite.summary.max_three_violations, 0);
});

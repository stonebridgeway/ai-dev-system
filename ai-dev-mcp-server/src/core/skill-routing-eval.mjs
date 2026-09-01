import fs from "node:fs/promises";
import path from "node:path";
import { routeSkills } from "./skill-router.mjs";

function list(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(4));
}

/**
 * Load a routing benchmark JSON file (`{ schema_version, description, cases[] }`).
 * Throws if `cases` is not an array.
 *
 * @param {string} filePath - Path to the benchmark file.
 * @returns {Promise<{ path: string, schema_version: number, description: string, cases: object[] }>}
 */
export async function readSkillRoutingCases(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (!Array.isArray(parsed.cases)) {
    throw new Error("Routing benchmark file must contain a cases array.");
  }
  return {
    path: resolved,
    schema_version: Number(parsed.schema_version || 1),
    description: String(parsed.description || ""),
    cases: parsed.cases
  };
}

/**
 * Run one benchmark case through the router and score it against
 * `expected_all` / `expected_any` / `must_not` plus the "1–3 skills" rule.
 *
 * @param {{ id?: string, task?: string, project_types?: string[], stack?: string[], expected_all?: string[], expected_any?: string[], must_not?: string[] }} testCase
 * @param {typeof routeSkills} [router] - Router override (for testing).
 * @returns {{ id: string, status: "pass" | "fail", task: string, project_types: string[], stack: string[], selected: object[], matched_rules: string[], expectations: object, failures: object }}
 */
export function evaluateSkillRoutingCase(testCase, router = routeSkills) {
  const route = router({
    task: String(testCase.task || ""),
    projectTypes: list(testCase.project_types),
    stack: list(testCase.stack),
    maxSkills: 3
  });
  const names = route.skills.map((item) => item.name);
  const expectedAll = list(testCase.expected_all);
  const expectedAny = list(testCase.expected_any);
  const mustNot = list(testCase.must_not);
  const missing = expectedAll.filter((name) => !names.includes(name));
  const anyMatched = !expectedAny.length || expectedAny.some((name) => names.includes(name));
  const forbidden = mustNot.filter((name) => names.includes(name));
  const limitPassed = names.length > 0 && names.length <= 3;
  const status = !missing.length && anyMatched && !forbidden.length && limitPassed ? "pass" : "fail";
  return {
    id: String(testCase.id || testCase.task || "unnamed"),
    status,
    task: String(testCase.task || ""),
    project_types: list(testCase.project_types),
    stack: list(testCase.stack),
    selected: route.skills,
    matched_rules: route.matched_rules,
    expectations: {
      expected_all: expectedAll,
      expected_any: expectedAny,
      must_not: mustNot
    },
    failures: {
      missing,
      expected_any_unmatched: expectedAny.length > 0 && !anyMatched ? expectedAny : [],
      forbidden,
      skill_limit: limitPassed ? null : names.length
    }
  };
}

/**
 * Evaluate a whole benchmark suite and aggregate pass rate, expected-skill
 * coverage, and "max three" / "empty route" violation counts.
 *
 * @param {object[]} cases - Benchmark cases.
 * @param {typeof routeSkills} [router] - Router override (for testing).
 * @returns {{ status: "pass" | "fail", generated_at: string, summary: object, cases: object[] }}
 */
export function evaluateSkillRoutingSuite(cases, router = routeSkills) {
  const results = cases.map((testCase) => evaluateSkillRoutingCase(testCase, router));
  const expectedSkills = new Set();
  const observedExpectedSkills = new Set();
  for (const result of results) {
    for (const name of [
      ...result.expectations.expected_all,
      ...result.expectations.expected_any
    ]) {
      expectedSkills.add(name);
      if (result.selected.some((item) => item.name === name)) observedExpectedSkills.add(name);
    }
  }
  const passed = results.filter((item) => item.status === "pass").length;
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    pass_rate: results.length ? rounded(passed / results.length) : 0,
    expected_skill_coverage: expectedSkills.size ? rounded(observedExpectedSkills.size / expectedSkills.size) : 0,
    expected_skills: expectedSkills.size,
    observed_expected_skills: observedExpectedSkills.size,
    uncovered_expected_skills: [...expectedSkills].filter((name) => !observedExpectedSkills.has(name)).sort(),
    max_three_violations: results.filter((item) => item.selected.length > 3).length,
    empty_route_violations: results.filter((item) => item.selected.length === 0).length
  };
  return {
    status: summary.failed === 0 && summary.max_three_violations === 0 && summary.empty_route_violations === 0
      ? "pass"
      : "fail",
    generated_at: new Date().toISOString(),
    summary,
    cases: results
  };
}

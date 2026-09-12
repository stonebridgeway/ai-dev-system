import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSearchEvalCase,
  findSearchEvalMatch,
  normalizeSearchEvalExpectations,
  searchEvalEntityKey,
  searchEvalExpectationLabel,
  searchEvalFieldMatches,
  searchEvalGroups,
  searchEvalNdcg,
  searchEvalNormalize,
  searchEvalRecommendations,
  searchEvalResultMatches,
  searchEvalResultText,
  searchEvalStatus,
  summarizeSearchEvalResult,
  visibleSearchDuplicates
} from "./search-eval.mjs";

function result(overrides = {}) {
  return {
    title: "feature-builder",
    path: "03-skills-catalog/cards/custom/feature-builder.md",
    scope: "skills",
    source: "custom",
    categories: "workflow",
    preview: "Implement a behaviour change end to end.",
    score: 1.5,
    ...overrides
  };
}

test("normalization lowercases and trims, and tolerates nullish", () => {
  assert.equal(searchEvalNormalize("  Feature-Builder "), "feature-builder");
  assert.equal(searchEvalNormalize(undefined), "");
  assert.equal(searchEvalNormalize(7), "7");
});

test("an absent expectation is not a check and never fails", () => {
  for (const empty of [undefined, null, ""]) {
    assert.deepEqual(searchEvalFieldMatches("anything", empty), { checked: false, ok: true });
  }
});

test("field matching is substring by default and exact on demand", () => {
  assert.equal(searchEvalFieldMatches("feature-builder", "builder").ok, true);
  assert.equal(searchEvalFieldMatches("feature-builder", "builder", { exact: true }).ok, false);
  assert.equal(searchEvalFieldMatches("feature-builder", "feature-builder", { exact: true }).ok, true);
});

test("field matching accepts alternatives and the three operators", () => {
  assert.equal(searchEvalFieldMatches("feature-builder", ["nope", "builder"]).ok, true);
  assert.equal(searchEvalFieldMatches("feature-builder", { equals: "Feature-Builder" }).ok, true);
  assert.equal(searchEvalFieldMatches("feature-builder", { equals: "builder" }).ok, false);
  assert.equal(searchEvalFieldMatches("feature-builder", { contains: "BUILD" }).ok, true);
  assert.equal(searchEvalFieldMatches("feature-builder", { regex: "^feature-" }).ok, true);
  assert.equal(searchEvalFieldMatches("feature-builder", { regex: "^builder" }).ok, false);
});

test("an unparseable regex fails the check instead of throwing", () => {
  assert.equal(searchEvalFieldMatches("anything", { regex: "([" }).ok, false);
});

test("a result is matched against every field an expectation names", () => {
  const matched = searchEvalResultMatches(result(), { title: "feature-builder", scope: "skills", source: "custom" });
  assert.equal(matched.matched, true);
  assert.equal(matched.checks.filter((check) => check.checked).length, 3);

  const missed = searchEvalResultMatches(result(), { title: "feature-builder", source: "membrane" });
  assert.equal(missed.matched, false);
});

test("an expectation that names nothing matches nothing", () => {
  assert.equal(searchEvalResultMatches(result(), {}).matched, false);
});

test("the searchable text of a result covers title, path, scope, source, categories and preview", () => {
  const text = searchEvalResultText(result());
  for (const part of ["feature-builder", "03-skills-catalog", "skills", "custom", "workflow", "behaviour"]) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(searchEvalResultText({}), "\n\n\n\n\n");
});

test("expectations normalize from one object, a list, or nothing", () => {
  assert.deepEqual(normalizeSearchEvalExpectations({ title: "a" }), [{ title: "a" }]);
  assert.deepEqual(normalizeSearchEvalExpectations([{ title: "a" }, null, "junk"]), [{ title: "a" }]);
  assert.deepEqual(normalizeSearchEvalExpectations(undefined), []);
  assert.deepEqual(normalizeSearchEvalExpectations("junk"), []);
});

test("required and any-of groups are read from all four case fields", () => {
  const groups = searchEvalGroups({
    expected: [{ title: "a" }],
    expect_all: [{ title: "b" }],
    expected_any: [{ title: "c" }],
    expect_any: [{ title: "d" }],
    top_k: 3
  });
  assert.deepEqual(groups.map((group) => group.mode), ["required", "required", "one_of"]);
  assert.deepEqual(groups.map((group) => group.top_k), [3, 3, 3]);
  assert.deepEqual(groups[2].any.map((item) => item.title), ["c", "d"]);
});

test("a group's top_k falls back through expectation, case, limit and default", () => {
  assert.equal(searchEvalGroups({ expected: [{ title: "a", top_k: 2 }], top_k: 9 })[0].top_k, 2);
  assert.equal(searchEvalGroups({ expected: [{ title: "a" }], limit: 7 })[0].top_k, 7);
  assert.equal(searchEvalGroups({ expected: [{ title: "a" }] })[0].top_k, 5);
  assert.equal(searchEvalGroups({ expected: [{ title: "a" }], top_k: 500 })[0].top_k, 50);
  assert.deepEqual(searchEvalGroups({}), []);
});

test("a required expectation may itself offer alternatives", () => {
  const [group] = searchEvalGroups({ expected: [{ any: [{ title: "a" }, { title: "b" }] }] });
  assert.equal(group.mode, "required");
  assert.deepEqual(group.any.map((item) => item.title), ["a", "b"]);
});

test("a match reports its rank, and a miss reports what it inspected", () => {
  const results = [result({ title: "other" }), result()];
  const hit = findSearchEvalMatch(results, [{ title: "feature-builder" }], 5);
  assert.equal(hit.matched, true);
  assert.equal(hit.rank, 2);
  assert.equal(hit.result.title, "feature-builder");

  const miss = findSearchEvalMatch(results, [{ title: "absent" }], 5);
  assert.equal(miss.matched, false);
  assert.equal(miss.rank, null);
  assert.ok(miss.inspected.length > 0);
  assert.ok(miss.inspected.length <= 8);
});

test("top_k is a real cut-off: a match below it does not count", () => {
  const results = [result({ title: "other" }), result()];
  assert.equal(findSearchEvalMatch(results, [{ title: "feature-builder" }], 1).matched, false);
});

test("a miss over several expectations labels them as alternatives", () => {
  const miss = findSearchEvalMatch([result({ title: "other" })], [{ title: "a" }, { title: "b" }], 5);
  assert.equal(miss.expectation, `${searchEvalExpectationLabel({ title: "a" })} OR ${searchEvalExpectationLabel({ title: "b" })}`);
});

test("a skill is one entity however many of its documents rank", () => {
  assert.equal(searchEvalEntityKey(result()), "skill:feature-builder");
  assert.equal(
    searchEvalEntityKey(result({ path: "03-skills-catalog/sources/custom/feature-builder/SKILL.md" })),
    "skill:feature-builder"
  );
  assert.equal(
    searchEvalEntityKey({ scope: "knowledge", path: "02-knowledge/Note.md", title: "Note" }),
    "path:02-knowledge/note.md"
  );
  assert.equal(searchEvalEntityKey(undefined), "path:");
});

test("duplicates are counted per entity, not per row", () => {
  const duplicates = visibleSearchDuplicates([
    result(),
    result({ path: "03-skills-catalog/sources/custom/feature-builder/SKILL.md" }),
    result({ title: "other", path: "03-skills-catalog/cards/custom/other.md" })
  ]);
  assert.deepEqual(duplicates, [{ entity: "skill:feature-builder", count: 2 }]);
  assert.deepEqual(visibleSearchDuplicates([]), []);
});

test("nDCG rewards earlier matches and is zero when nothing matched", () => {
  assert.equal(searchEvalNdcg([]), 0);
  assert.equal(searchEvalNdcg([{ matched: false }]), 0);
  assert.equal(searchEvalNdcg([{ matched: true, rank: 1 }]), 1);
  const first = searchEvalNdcg([{ matched: true, rank: 1 }, { matched: true, rank: 2 }]);
  const later = searchEvalNdcg([{ matched: true, rank: 3 }, { matched: true, rank: 4 }]);
  assert.ok(first > later);
  assert.ok(later > 0);
});

test("a case with no criteria is skipped, not passed", () => {
  const evaluation = evaluateSearchEvalCase({ query: "x" }, [result()]);
  assert.equal(evaluation.status, "skipped");
  assert.match(evaluation.reason, /No expected, expect_all, expected_any, or expect_any/);
  assert.deepEqual(evaluation.checks, []);
  assert.equal(evaluation.top_results.length, 1);
});

test("a satisfied case passes and reports its rank metrics", () => {
  const evaluation = evaluateSearchEvalCase({ expected: [{ title: "feature-builder" }] }, [result()]);
  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.matched_rank, 1);
  assert.equal(evaluation.reciprocal_rank, 1);
  assert.equal(evaluation.top_1, true);
  assert.equal(evaluation.ndcg, 1);
  assert.equal(evaluation.negative_checks.configured, 0);
});

test("an unmet expectation fails the case", () => {
  const evaluation = evaluateSearchEvalCase({ expected: [{ title: "absent" }] }, [result()]);
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.matched_rank, null);
  assert.equal(evaluation.reciprocal_rank, 0);
  assert.equal(evaluation.top_1, false);
});

test("a must_not hit fails the case even when everything expected matched", () => {
  const evaluation = evaluateSearchEvalCase(
    { expected: [{ title: "feature-builder" }], must_not: [{ title: "brandkit" }] },
    [result(), result({ title: "brandkit", path: "03-skills-catalog/cards/design/brandkit.md" })]
  );
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.negative_checks.configured, 1);
  assert.equal(evaluation.negative_checks.violations.length, 1);
});

test("duplicates over the case's ceiling fail it, and the ceiling can be raised", () => {
  const duplicated = [result(), result({ path: "03-skills-catalog/sources/custom/feature-builder/SKILL.md" })];
  const strict = evaluateSearchEvalCase({ expected: [{ title: "feature-builder" }] }, duplicated);
  assert.equal(strict.status, "fail");
  assert.equal(strict.duplicate_checks.visible_duplicate_count, 1);

  const allowed = evaluateSearchEvalCase(
    { expected: [{ title: "feature-builder" }], max_visible_duplicates: 1 },
    duplicated
  );
  assert.equal(allowed.status, "pass");
  assert.equal(allowed.duplicate_checks.max_visible_duplicates, 1);
});

test("collapsed duplicates are reported from what the index already folded", () => {
  const evaluation = evaluateSearchEvalCase(
    { expected: [{ title: "feature-builder" }] },
    [result({ duplicate_count: 3 })]
  );
  assert.equal(evaluation.duplicate_checks.collapsed_duplicate_count, 3);
});

test("a result summary keeps its rank and identifying fields", () => {
  const summary = summarizeSearchEvalResult(result(), 2);
  assert.equal(summary.rank, 3);
  assert.equal(summary.title, "feature-builder");
  assert.equal(summary.scope, "skills");
});

test("the run status is fail on nothing, fail on failures, degraded on skips", () => {
  assert.equal(searchEvalStatus({ total: 0, failed: 0, skipped: 0 }), "fail");
  assert.equal(searchEvalStatus({ total: 3, failed: 1, skipped: 0 }), "fail");
  assert.equal(searchEvalStatus({ total: 3, failed: 1, skipped: 2 }), "fail");
  assert.equal(searchEvalStatus({ total: 3, failed: 0, skipped: 1 }), "degraded");
  assert.equal(searchEvalStatus({ total: 3, failed: 0, skipped: 0 }), "ok");
});

test("recommendations name each problem, and say so when the run was dense-free", () => {
  const clean = searchEvalRecommendations({ total: 3, failed: 0, metrics: {} }, true);
  assert.deepEqual(clean, ["Golden search cases passed; keep adding cases when new workflows, skills, and project patterns appear."]);

  const noCases = searchEvalRecommendations({ total: 0, failed: 0, metrics: {} }, true);
  assert.match(noCases[0], /Add or unfilter search eval cases/);

  const noisy = searchEvalRecommendations({
    total: 3,
    failed: 2,
    metrics: { negative_violations: 1, visible_duplicate_count: 2 }
  }, false);
  assert.equal(noisy.length, 5);
  assert.match(noisy[0], /explain_search/);
  assert.match(noisy[1], /rebuild_search_index/);
  assert.match(noisy[2], /must_not violations/);
  assert.match(noisy[3], /Canonical result collapsing regressed/);
  assert.match(noisy[4], /include_dense=true/);
});

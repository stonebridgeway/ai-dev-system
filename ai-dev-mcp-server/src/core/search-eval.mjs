/**
 * The golden-case harness for search, minus the searching.
 *
 * A case says what a query should surface: one or more required expectations,
 * an any-of group, results that must NOT appear, and a ceiling on visible
 * duplicates. Everything here judges a result list that has already been
 * fetched — `src/extensions/search.mjs` runs the query and hands the results
 * over — so the ranking metrics can be tested without an index.
 *
 * `pass` means every required expectation matched inside its top-k, no negative
 * expectation matched, and duplicates stayed under the case's ceiling. A case
 * that configures no criteria is `skipped`, not passed: nothing was checked.
 */

export function searchEvalNormalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

export function searchEvalFieldMatches(actual, expected, { exact = false } = {}) {
  if (expected === undefined || expected === null || expected === "") {
    return { checked: false, ok: true };
  }
  const actualText = searchEvalNormalize(actual);
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const ok = expectedValues.some((value) => {
    if (value && typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "equals")) {
        return actualText === searchEvalNormalize(value.equals);
      }
      if (Object.prototype.hasOwnProperty.call(value, "contains")) {
        return actualText.includes(searchEvalNormalize(value.contains));
      }
      if (Object.prototype.hasOwnProperty.call(value, "regex")) {
        try {
          return new RegExp(String(value.regex), "i").test(String(actual ?? ""));
        } catch {
          return false;
        }
      }
    }
    return exact ? actualText === searchEvalNormalize(value) : actualText.includes(searchEvalNormalize(value));
  });
  return { checked: true, ok, actual, expected };
}

export function searchEvalResultText(result) {
  return [
    result.title,
    result.path,
    result.scope,
    result.source,
    result.categories,
    result.preview
  ].map((value) => String(value ?? "")).join("\n");
}

export function searchEvalResultMatches(result, expectation = {}) {
  const checks = [];
  const fieldSpecs = [
    ["title", false],
    ["path", false],
    ["scope", true],
    ["source", false],
    ["categories", false],
    ["preview", false]
  ];

  for (const [field, exact] of fieldSpecs) {
    const check = searchEvalFieldMatches(result[field], expectation[field], { exact });
    if (check.checked) checks.push({ field, ...check });
  }

  const textCheck = searchEvalFieldMatches(searchEvalResultText(result), expectation.text, { exact: false });
  if (textCheck.checked) checks.push({ field: "text", ...textCheck });

  if (!checks.length) {
    return {
      matched: false,
      checks: [{ field: "expectation", ok: false, actual: "", expected: "at least one match criterion" }]
    };
  }

  return {
    matched: checks.every((check) => check.ok),
    checks
  };
}

export function searchEvalExpectationLabel(expectation = {}) {
  const fields = ["title", "path", "scope", "source", "categories", "text"];
  const parts = [];
  for (const field of fields) {
    if (expectation[field] !== undefined && expectation[field] !== null && expectation[field] !== "") {
      parts.push(`${field}=${JSON.stringify(expectation[field])}`);
    }
  }
  return parts.join(", ") || "empty expectation";
}

export function normalizeSearchEvalExpectations(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (value && typeof value === "object") return [value];
  return [];
}

export function searchEvalGroups(testCase) {
  const topKDefault = Math.max(1, Math.min(Number(testCase.top_k || testCase.limit || 5) || 5, 50));
  const groups = [];
  const required = [
    ...normalizeSearchEvalExpectations(testCase.expected),
    ...normalizeSearchEvalExpectations(testCase.expect_all)
  ];

  for (const expectation of required) {
    const alternatives = Array.isArray(expectation.any)
      ? expectation.any.filter((item) => item && typeof item === "object")
      : [expectation];
    groups.push({
      mode: "required",
      top_k: Math.max(1, Math.min(Number(expectation.top_k || topKDefault) || topKDefault, 50)),
      any: alternatives
    });
  }

  const anyExpectations = [
    ...normalizeSearchEvalExpectations(testCase.expected_any),
    ...normalizeSearchEvalExpectations(testCase.expect_any)
  ];
  if (anyExpectations.length) {
    groups.push({
      mode: "one_of",
      top_k: topKDefault,
      any: anyExpectations
    });
  }

  return groups;
}

export function summarizeSearchEvalResult(result, index) {
  return {
    rank: index + 1,
    title: result.title,
    path: result.path,
    scope: result.scope,
    source: result.source,
    categories: result.categories,
    score: result.score,
    original_rank: result.original_rank,
    original_score: result.original_score,
    rerank_adjustment: result.rerank_adjustment,
    rerank_reasons: result.rerank_reasons || [],
    hard_negative: Boolean(result.hard_negative),
    hard_negative_reasons: result.hard_negative_reasons || [],
    keyword_score: result.keyword_score,
    semantic_score: result.semantic_score,
    dense_score: result.dense_score,
    duplicate_count: result.duplicate_count || 0
  };
}

export function findSearchEvalMatch(results, expectations, topK) {
  const candidates = results.slice(0, topK);
  const inspected = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const result = candidates[index];
    for (const expectation of expectations) {
      const match = searchEvalResultMatches(result, expectation);
      if (match.matched) {
        return {
          matched: true,
          rank: index + 1,
          expectation: searchEvalExpectationLabel(expectation),
          result: summarizeSearchEvalResult(result, index),
          checks: match.checks
        };
      }
      inspected.push({
        rank: index + 1,
        expectation: searchEvalExpectationLabel(expectation),
        checks: match.checks
      });
    }
  }
  return {
    matched: false,
    rank: null,
    expectation: expectations.map(searchEvalExpectationLabel).join(" OR "),
    inspected: inspected.slice(0, 8)
  };
}

export function searchEvalEntityKey(result) {
  const resultPath = String(result?.path || "").replaceAll("\\", "/").toLowerCase();
  const title = String(result?.title || "").trim().toLowerCase();
  const isSkillEntity = result?.scope === "skills" && (
    resultPath.startsWith("03-skills-catalog/cards/")
    || (resultPath.includes("/sources/") && resultPath.endsWith("/skill.md"))
  );
  return isSkillEntity ? `skill:${title}` : `path:${resultPath}`;
}

export function visibleSearchDuplicates(results) {
  const counts = new Map();
  for (const result of results) {
    const key = searchEvalEntityKey(result);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entity, count]) => ({ entity, count }));
}

export function searchEvalNdcg(checks) {
  if (!checks.length) return 0;
  const dcg = checks.reduce((sum, check) => (
    check.matched && Number.isFinite(Number(check.rank))
      ? sum + (1 / Math.log2(Number(check.rank) + 1))
      : sum
  ), 0);
  const ideal = checks.reduce((sum, _check, index) => sum + (1 / Math.log2(index + 2)), 0);
  return ideal > 0 ? dcg / ideal : 0;
}

export function evaluateSearchEvalCase(testCase, results) {
  const groups = searchEvalGroups(testCase);
  const topResults = results.slice(0, Math.min(results.length, 5)).map(summarizeSearchEvalResult);
  if (!groups.length) {
    return {
      status: "skipped",
      reason: "No expected, expect_all, expected_any, or expect_any match criteria configured.",
      checks: [],
      top_results: topResults
    };
  }

  const checks = groups.map((group) => ({
    mode: group.mode,
    top_k: group.top_k,
    ...findSearchEvalMatch(results, group.any, group.top_k)
  }));
  const failed = checks.filter((check) => !check.matched);
  const negativeExpectations = normalizeSearchEvalExpectations(testCase.must_not);
  const negativeTopK = Math.max(1, Math.min(Number(testCase.negative_top_k || testCase.top_k || 5) || 5, 50));
  const negativeMatches = negativeExpectations
    .map((expectation) => findSearchEvalMatch(results, [expectation], negativeTopK))
    .filter((item) => item.matched);
  const duplicates = visibleSearchDuplicates(results);
  const maxVisibleDuplicates = Math.max(0, Number(testCase.max_visible_duplicates) || 0);
  const duplicateViolation = duplicates.reduce((sum, item) => sum + item.count - 1, 0) > maxVisibleDuplicates;
  const matchedRank = checks
    .filter((check) => check.matched && Number.isFinite(Number(check.rank)))
    .reduce((best, check) => Math.min(best, Number(check.rank)), Number.POSITIVE_INFINITY);
  const finiteRank = Number.isFinite(matchedRank) ? matchedRank : null;
  return {
    status: failed.length || negativeMatches.length || duplicateViolation ? "fail" : "pass",
    matched_rank: finiteRank,
    reciprocal_rank: finiteRank ? 1 / finiteRank : 0,
    top_1: finiteRank === 1,
    ndcg: searchEvalNdcg(checks),
    checks,
    negative_checks: {
      configured: negativeExpectations.length,
      violations: negativeMatches
    },
    duplicate_checks: {
      visible_duplicates: duplicates,
      visible_duplicate_count: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
      max_visible_duplicates: maxVisibleDuplicates,
      collapsed_duplicate_count: results.reduce((sum, item) => sum + Number(item.duplicate_count || 0), 0)
    },
    top_results: topResults
  };
}

export function searchEvalStatus(summary) {
  if (summary.total <= 0) return "fail";
  if (summary.failed > 0) return "fail";
  if (summary.skipped > 0) return "degraded";
  return "ok";
}

export function searchEvalRecommendations(summary, includeDense) {
  const recommendations = [];
  if (summary.total <= 0) {
    recommendations.push("Add or unfilter search eval cases before trusting search quality.");
  }
  if (summary.failed > 0) {
    recommendations.push("For failed cases, run explain_search with the same query/preset and compare top results against the expected context.");
    recommendations.push("If expected notes are missing from top results, rebuild_search_index and then tune preset weights or case expectations.");
  }
  if (summary.metrics?.negative_violations > 0) {
    recommendations.push("Inspect must_not violations: irrelevant or unsafe sources are ranking above the allowed boundary.");
  }
  if (summary.metrics?.visible_duplicate_count > 0) {
    recommendations.push("Canonical result collapsing regressed; inspect duplicate skill cards and source documents.");
  }
  if (!includeDense) {
    recommendations.push("This run disabled dense BGE-M3 scoring; run again with include_dense=true for the full production path.");
  }
  if (!recommendations.length) {
    recommendations.push("Golden search cases passed; keep adding cases when new workflows, skills, and project patterns appear.");
  }
  return recommendations;
}

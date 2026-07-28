import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUiUxDesignJsonArgs,
  buildUiUxDesignMarkdownArgs,
  buildUiUxKnowledgeArgs,
  expandUiUxQuery,
  normalizeUiUxDesignInput,
  normalizeUiUxKnowledgeInput
} from "./ui-ux-pro-max.mjs";

test("knowledge input accepts Russian text and one valid filter", () => {
  const input = normalizeUiUxKnowledgeInput({
    query: "  доступная форма с видимым фокусом  ",
    domain: "UX",
    max_results: 4
  });
  assert.deepEqual(input, {
    query: "доступная форма с видимым фокусом",
    search_query: "доступная форма с видимым фокусом accessibility focus form",
    domain: "ux",
    stack: "",
    max_results: 4
  });
});

test("knowledge input rejects unknown and conflicting filters", () => {
  assert.throws(
    () => normalizeUiUxKnowledgeInput({ query: "dashboard", domain: "unknown" }),
    /Unsupported domain/
  );
  assert.throws(
    () => normalizeUiUxKnowledgeInput({
      query: "dashboard",
      domain: "ux",
      stack: "react"
    }),
    /either domain or stack/
  );
});

test("query stays one positional argument without shell interpretation", () => {
  const query = "\"; Remove-Item -Recurse C:\\\\important; #";
  const { args } = buildUiUxKnowledgeArgs({ query, stack: "nextjs" });
  assert.deepEqual(args.slice(0, -1), [
    "--json",
    "--max-results",
    "3",
    "--stack",
    "nextjs",
    "--"
  ]);
  assert.equal(args.at(-1), query);
});

test("Russian concepts receive deterministic English search hints", () => {
  assert.equal(
    expandUiUxQuery("премиальный финтех дашборд с высокой плотностью"),
    "премиальный финтех дашборд с высокой плотностью analytics dashboard fintech finance premium luxury dense"
  );
  assert.equal(expandUiUxQuery("accessible fintech dashboard"), "accessible fintech dashboard");
});

test("result count and design dials are bounded", () => {
  assert.equal(
    normalizeUiUxKnowledgeInput({ query: "chart", max_results: 100 }).max_results,
    10
  );
  assert.deepEqual(
    normalizeUiUxDesignInput({
      query: "analytics",
      variance: -5,
      motion: 4.6,
      density: 99
    }),
    {
      query: "analytics",
      search_query: "analytics",
      project_name: "",
      variance: 1,
      motion: 5,
      density: 10
    }
  );
});

test("JSON and Markdown design commands share the validated design inputs", () => {
  const input = {
    query: "B2B analytics dashboard",
    project_name: "Atlas",
    variance: 6,
    motion: 3,
    density: 8
  };
  const json = buildUiUxDesignJsonArgs(input);
  const markdown = buildUiUxDesignMarkdownArgs(input);
  assert.deepEqual(json.normalized, markdown.normalized);
  assert.deepEqual(json.args.slice(0, 2), ["--design-system", "--json"]);
  assert.deepEqual(markdown.args.slice(0, 3), [
    "--design-system",
    "--format",
    "markdown"
  ]);
  assert.equal(json.args.at(-2), "--");
  assert.equal(json.args.at(-1), input.query);
});

test("query and project name enforce explicit length limits", () => {
  assert.throws(
    () => normalizeUiUxKnowledgeInput({ query: "x".repeat(501) }),
    /at most 500/
  );
  assert.throws(
    () => normalizeUiUxDesignInput({
      query: "landing",
      project_name: "x".repeat(121)
    }),
    /at most 120/
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  prioritizeKnowledgeResults,
  routeKnowledgeDocuments
} from "./knowledge-router.mjs";

test("routes Russian project-memory requests to the canonical runbook", () => {
  const route = routeKnowledgeDocuments(
    "Обнови память проекта: краткий бриф, архитектурную карту, карточку Obsidian и индекс"
  );
  assert.equal(route?.id, "refresh-project-memory");
  assert.equal(route?.paths[0], "09-mcp/Project Registry And Map Refresh.md");
});

test("routes exact search-preset tool queries to the control surface", () => {
  const route = routeKnowledgeDocuments(
    "How do preset_search, list_search_presets, and explain_search work?"
  );
  assert.equal(route?.id, "search-presets");
  assert.equal(route?.paths[0], "01-system/AI Dev Control Center.md");
});

test("does not route broad documentation searches", () => {
  assert.equal(routeKnowledgeDocuments("architecture documentation"), null);
});

test("routes Russian product design-system requests to curated UI UX guidance", () => {
  const route = routeKnowledgeDocuments(
    "Создай продуктовую дизайн систему: палитру, типографику и правила доступности"
  );
  assert.equal(route?.id, "ui-ux-design-intelligence");
  assert.equal(route?.paths[0], "09-mcp/UI UX Pro Max Integration.md");
  assert.equal(route?.paths[1], "03-skills-catalog/sources/external/ui-ux-pro-max/SKILL.md");
});

test("promotes routed documents without dropping the remaining ranking", () => {
  const results = [
    { title: "Noise", path: "notes/noise.md", score: 0.9 },
    { title: "Control", path: "01-system/AI Dev Control Center.md", score: 0.4 },
    { title: "README", path: "09-mcp/ai-dev-mcp-server/README.md", score: 0.3 }
  ];
  const ranked = prioritizeKnowledgeResults(
    "preset_search list_search_presets explain_search",
    results
  );
  assert.deepEqual(ranked.map((item) => item.title), ["Control", "README", "Noise"]);
  assert.equal(ranked[0].retrieval_stage, "deterministic-knowledge-router");
  assert.equal(ranked[2].retrieval_stage, undefined);
});

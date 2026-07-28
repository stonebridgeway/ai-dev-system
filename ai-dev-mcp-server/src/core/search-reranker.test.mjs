import assert from "node:assert/strict";
import test from "node:test";
import {
  hardNegativeRulesFromCases,
  isSkillCatalogQuery,
  repairSearchMojibake,
  rerankSearchResults
} from "./search-reranker.mjs";

test("reranker promotes matching frontend workflow over backend lexical noise", () => {
  const ranked = rerankSearchResults("frontend design responsive component", [
    {
      title: "generic-api-builder",
      path: "skills/generic-api-builder/SKILL.md",
      scope: "skills",
      source: "membrane",
      categories: "backend API",
      preview: "Build backend endpoints and database services.",
      score: 0.81
    },
    {
      title: "frontend-product-builder",
      path: "skills/frontend-product-builder/SKILL.md",
      scope: "skills",
      source: "custom",
      categories: "frontend design",
      preview: "Create responsive product UI components.",
      score: 0.70
    }
  ], { scope: "skills", preset: "skills" });
  assert.equal(ranked[0].title, "frontend-product-builder");
  assert.equal(ranked[1].hard_negative, true);
});

test("search normalization repairs Windows-1251 UTF-8 mojibake without changing valid Russian", () => {
  assert.equal(repairSearchMojibake("СЃРѕР·РґР°Р№ РґРёР·Р°Р№РЅ"), "создай дизайн");
  assert.equal(repairSearchMojibake("создай дизайн"), "создай дизайн");
});

test("skill catalog queries do not masquerade as implementation requests", () => {
  assert.equal(isSkillCatalogQuery("skill taxonomy groups and routing"), true);
  assert.equal(
    isSkillCatalogQuery("группы скиллов домены подгруппы маршрутизация и связанные навыки"),
    true
  );
  assert.equal(isSkillCatalogQuery("implement a frontend feature"), false);
});

test("skill catalog queries rank taxonomy notes above individual skills", () => {
  const ranked = rerankSearchResults(
    "группы скиллов домены подгруппы маршрутизация и связанные навыки",
    [{
      title: "data-pipeline-engineer",
      path: "03-skills-catalog/sources/custom/data-pipeline-engineer/SKILL.md",
      scope: "skills",
      source: "custom",
      score: 0.16
    }, {
      title: "Skills Map",
      path: "03-skills-catalog/groups/Skills Map.md",
      scope: "skills",
      source: "vault-note",
      score: 0.12
    }],
    { scope: "skills", preset: "skills" }
  );
  assert.equal(ranked[0].title, "Skills Map");
  assert.match(ranked[0].rerank_reasons.join("\n"), /catalog metadata/);
});

test("golden must-not expectations become reusable hard-negative rules", () => {
  const rules = hardNegativeRulesFromCases([{
    id: "frontend",
    query: "frontend landing design",
    must_not: [{ title: "generic landing" }]
  }]);
  const ranked = rerankSearchResults("frontend landing design", [{
    title: "Generic Landing",
    path: "generic.md",
    scope: "skills",
    source: "membrane",
    score: 1
  }, {
    title: "Landing Conversion Reviewer",
    path: "custom.md",
    scope: "skills",
    source: "custom",
    preview: "Frontend landing design and conversion.",
    score: 0.8
  }], { scope: "skills", hardNegativeRules: rules });
  assert.equal(ranked[0].title, "Landing Conversion Reviewer");
  assert.match(ranked[1].hard_negative_reasons.join("\n"), /golden-case hard negative/);
});

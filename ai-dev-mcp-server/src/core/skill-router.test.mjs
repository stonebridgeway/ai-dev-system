import assert from "node:assert/strict";
import test from "node:test";
import { routeSkills } from "./skill-router.mjs";

test("routes Russian database migration without confusing it with generic data", () => {
  const route = routeSkills({ task: "Добавь миграцию схемы базы данных для пользователей" });
  assert.deepEqual(route.skills.map((item) => item.name), [
    "feature-builder",
    "database-migration-guardian"
  ]);
  assert.equal(route.skills.some((item) => item.name === "data-pipeline-engineer"), false);
});

test("routes frontend bug to workflow, domain, and verification", () => {
  const route = routeSkills({ task: "Исправь баг адаптивной формы на мобильном экране" });
  assert.deepEqual(route.skills.map((item) => item.name), [
    "bugfix-investigator",
    "beta-frontend-maintainer",
    "frontend-quality-gate"
  ]);
});

test("routes product UI work through the single frontend product builder", () => {
  const route = routeSkills({
    task: "Redesign the landing page from an approved visual direction"
  });
  assert.deepEqual(route.skills.map((item) => item.name), [
    "frontend-product-builder",
    "frontend-quality-gate",
    "landing-conversion-reviewer"
  ]);
});

test("routes natural Russian create-interface wording through the product builder", () => {
  const route = routeSkills({
    task: "\u0421\u043e\u0437\u0434\u0430\u0439 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441 \u0431\u0435\u0437 \u0418\u0418 \u0441\u043b\u043e\u043f\u0430",
    projectTypes: ["frontend"]
  });
  assert.deepEqual(route.skills.map((item) => item.name), [
    "frontend-product-builder",
    "frontend-quality-gate",
    "beta-frontend-maintainer"
  ]);
});

test("routes missing-reference generation through the surface-specific factory", () => {
  const web = routeSkills({
    task: "\u0420\u0435\u0444\u0435\u0440\u0435\u043d\u0441\u043e\u0432 \u043d\u0435\u0442, \u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u0443\u0439 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0435\u043d\u044b\u0435 \u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441\u044b \u0434\u043b\u044f \u0441\u0430\u0439\u0442\u0430"
  });
  assert.deepEqual(web.skills.map((item) => item.name), [
    "frontend-product-builder",
    "imagegen-frontend-web",
    "frontend-quality-gate"
  ]);
  assert.equal(web.skills[1].source, "design/taste-skill");

  const mobile = routeSkills({
    task: "Generate visual references for a mobile iOS interface"
  });
  assert.deepEqual(mobile.skills.map((item) => item.name), [
    "frontend-product-builder",
    "imagegen-frontend-mobile",
    "frontend-quality-gate"
  ]);
});

test("never returns more than three skills", () => {
  const route = routeSkills({
    task: "Review security of API database migration, Docker release and frontend form",
    projectTypes: ["frontend", "backend", "api"]
  });
  assert.ok(route.skills.length <= 3);
  assert.equal(new Set(route.skills.map((item) => item.name)).size, route.skills.length);
});

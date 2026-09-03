import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeRoutedRecommendations, routeSkills, taskRequestsDiagram } from "./skill-router.mjs";

test("taskRequestsDiagram matches diagram intent but not schema/contract work", () => {
  for (const yes of [
    "Build an architecture diagram of the payment service",
    "Convert this Mermaid flowchart into a polished diagram",
    "Нарисуй схему взаимодействия сервисов",
    "Визуализируй поток данных ETL"
  ]) {
    assert.equal(taskRequestsDiagram(yes), true, yes);
  }
  for (const no of [
    "Добавь миграцию схемы базы данных для пользователей",
    "Обнови схему API для нового эндпоинта",
    "Fix the responsive form bug on mobile"
  ]) {
    assert.equal(taskRequestsDiagram(no), false, no);
  }
});

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

test("adds archify as a capability without displacing the normal routing triple", () => {
  const route = routeSkills({
    task: "Построй архитектурную карту backend API платёжного сервиса"
  });

  assert.deepEqual(route.skills.map((item) => item.name), [
    "feature-builder",
    "backend-api-engineer",
    "api-contract-reviewer",
    "archify"
  ]);
  assert.deepEqual(route.skills.map((item) => item.role), [
    "workflow",
    "domain",
    "verification",
    "capability"
  ]);
  assert.equal(route.skills.at(-1).source, "external/archify");
  assert.equal(route.skills.at(-1).rule, "diagramming");
});

test("keeps archify when maxSkills limits only conventional routing entries", () => {
  const route = routeSkills({
    task: "Turn this Mermaid sequence diagram into a polished diagram",
    maxSkills: 1
  });

  assert.deepEqual(route.skills.map((item) => item.name), ["feature-builder", "archify"]);
  assert.deepEqual(route.skills.map((item) => item.role), ["workflow", "capability"]);
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

test("keeps deterministic routes first and fills unused recommendation slots", () => {
  const result = prioritizeRoutedRecommendations(
    [
      { name: "feature-builder", source: "custom", score: 220 },
      { name: "devops-release-engineer", source: "custom", score: 219 },
      { name: "archify", source: "external/archify", score: 100 }
    ],
    {
      skills: [
        { name: "feature-builder", role: "workflow", rule: "workflow", reason: "workflow" },
        { name: "devops-release-engineer", role: "domain", rule: "devops", reason: "domain" }
      ]
    },
    3
  );
  assert.deepEqual(result.map((item) => item.name), [
    "feature-builder",
    "devops-release-engineer",
    "archify"
  ]);
});

test("keeps routed capabilities when conventional recommendations reach maxSkills", () => {
  const recommendations = [
    { name: "feature-builder", score: 100 },
    { name: "backend-api-engineer", score: 99 },
    { name: "api-contract-reviewer", score: 98 },
    { name: "archify", score: 97 }
  ];
  const route = routeSkills({
    task: "Построй архитектурную карту backend API платёжного сервиса"
  });

  const prioritized = prioritizeRoutedRecommendations(recommendations, route);
  assert.deepEqual(prioritized.map((item) => item.name), [
    "feature-builder",
    "backend-api-engineer",
    "api-contract-reviewer",
    "archify"
  ]);
  assert.equal(prioritized.at(-1).routing_role, "capability");
});

import assert from "node:assert/strict";
import test from "node:test";
import { INTENT } from "./intent-patterns.mjs";

test("intent patterns match whole Unicode tokens instead of substrings", () => {
  const falsePositives = [
    ["visual", "Improve the reactivity of the vitest suite"],
    ["visual", "Build a platform service"],
    ["frontend", "Improve the reactivity of the vitest suite"],
    ["landing", "Добавь валидацию формы регистрации"],
    ["landing", "Обнови календарь в админке"],
    ["backend", "Обработка ошибок при загрузке"]
  ];
  for (const [intent, value] of falsePositives) {
    assert.equal(INTENT[intent].test(value), false, `${intent}: ${value}`);
  }
});

test("intent patterns retain explicit English and Russian terms", () => {
  assert.equal(INTENT.visual.test("Redesign the website header"), true);
  assert.equal(INTENT.frontend.test("Исправь форму на мобильном экране"), true);
  assert.equal(INTENT.backend.test("Добавь очередь задач"), true);
  assert.equal(INTENT.landing.test("Проверь конверсию лендинга"), true);
});

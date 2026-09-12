import assert from "node:assert/strict";
import test from "node:test";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import {
  SKILL_CARDS_DIR,
  SKILL_CATALOG_DIR,
  SKILL_GROUPS_DIR,
  findSkillItem,
  groupWikiLink,
  isDesignSkill,
  isMembraneSkill,
  isVisualHeavySkill,
  skillCardPath,
  skillGroupNotePath,
  skillKey
} from "./skill-catalog.mjs";

test("generated notes live under the skill catalog folder", () => {
  assert.equal(SKILL_CATALOG_DIR, "03-skills-catalog");
  assert.ok(SKILL_CARDS_DIR.startsWith(`${SKILL_CATALOG_DIR}/`));
  assert.ok(SKILL_GROUPS_DIR.startsWith(`${SKILL_CATALOG_DIR}/`));
  assert.equal(skillGroupNotePath("frontend"), `${SKILL_GROUPS_DIR}/frontend.md`);
});

test("group links carry the taxonomy label unless one is supplied", () => {
  const group = SKILL_GROUPS[0];
  assert.equal(groupWikiLink(group.id), `[[${SKILL_GROUPS_DIR}/${group.id}|${group.label}]]`);
  assert.equal(groupWikiLink(group.id, "Custom"), `[[${SKILL_GROUPS_DIR}/${group.id}|Custom]]`);
  assert.equal(groupWikiLink("not-a-group"), `[[${SKILL_GROUPS_DIR}/not-a-group|not-a-group]]`);
});

test("card paths are slugged per source and skill", () => {
  assert.equal(
    skillCardPath({ source: "design/taste-skill", name: "Image To Code" }),
    `${SKILL_CARDS_DIR}/design-taste-skill/image-to-code.md`
  );
  assert.equal(skillCardPath({ source: "", name: "" }), `${SKILL_CARDS_DIR}/source/skill.md`);
});

test("skill keys are case-insensitive source/name pairs", () => {
  assert.equal(skillKey({ source: "Custom", name: "Feature-Builder" }), "custom:feature-builder");
});

test("findSkillItem matches by name and narrows by source substring", () => {
  const items = [
    { name: "shared", source: "custom" },
    { name: "shared", source: "design/taste-skill" }
  ];
  assert.equal(findSkillItem(items, "SHARED")?.source, "custom");
  assert.equal(findSkillItem(items, "shared", "design")?.source, "design/taste-skill");
  assert.equal(findSkillItem(items, "missing"), undefined);
  assert.equal(findSkillItem(items, "shared", "external"), undefined);
});

test("membrane skills are recognised by source", () => {
  assert.ok(isMembraneSkill({ source: "membrane/app-skills" }));
  assert.ok(!isMembraneSkill({ source: "custom" }));
  assert.ok(!isMembraneSkill({}));
});

test("design skills are recognised by source folder or category", () => {
  assert.ok(isDesignSkill({ source: "design/taste-skill" }));
  assert.ok(isDesignSkill({ source: "external/x", categories: ["Frontend"] }));
  assert.ok(!isDesignSkill({ source: "custom", categories: ["backend"] }));
  assert.ok(!isDesignSkill({ source: "custom" }));
});

test("visual-heavy skills are recognised across name, description and use_when", () => {
  assert.ok(isVisualHeavySkill({ name: "brandkit" }));
  assert.ok(isVisualHeavySkill({ name: "x", description: "logo work" }));
  assert.ok(isVisualHeavySkill({ name: "x", use_when: "image-to-code handoff" }));
  assert.ok(!isVisualHeavySkill({ name: "feature-builder", description: "ship a feature" }));
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import {
  SKILL_CARDS_DIR,
  SKILL_CATALOG_DIR,
  SKILL_GROUPS_DIR,
  MEMBRANE_SOURCE_IDS,
  catalogSourceOfPath,
  findSkillItem,
  groupWikiLink,
  isDesignSkill,
  isMembraneSkill,
  isVisualHeavySkill,
  membraneSourceLayout,
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

test("both places the Membrane catalogue can sit are Membrane by source", () => {
  for (const source of MEMBRANE_SOURCE_IDS) assert.ok(isMembraneSkill({ source }), source);
  assert.equal(catalogSourceOfPath("03-skills-catalog/sources/external/membrane/skills/slack/SKILL.md"), "external/membrane");
  assert.equal(
    catalogSourceOfPath("C:\\vault\\03-skills-catalog\\sources\\membrane\\application-skills\\skills\\x\\SKILL.md"),
    "membrane/application-skills"
  );
  assert.equal(catalogSourceOfPath("03-skills-catalog/sources/external/membrane/README.md"), "external/membrane");
  assert.equal(catalogSourceOfPath("03-skills-catalog/sources/external/archify/SKILL.md"), "external/archify");
  assert.ok(!isMembraneSkill({ source: catalogSourceOfPath("03-skills-catalog/sources/external/archify/SKILL.md") }));
  assert.equal(catalogSourceOfPath("02-knowledge/membrane notes.md"), "", "outside the catalogue a path names no source");
  assert.equal(catalogSourceOfPath("03-skills-catalog/sources/external"), "");
});

test("the Membrane collector reads whichever layout the vault has", () => {
  const sources = path.join("vault", "03-skills-catalog", "sources");
  const seed = path.join(sources, "external", "membrane");
  const vault = path.join(sources, "membrane", "application-skills");
  assert.deepEqual(membraneSourceLayout(sources, (candidate) => candidate === seed), { id: "external/membrane", root: seed });
  assert.deepEqual(membraneSourceLayout(sources, (candidate) => candidate === vault), { id: "membrane/application-skills", root: vault });
  assert.deepEqual(membraneSourceLayout(sources, () => false), { id: "membrane/application-skills", root: vault }, "neither: the vault layout, which reads as empty");
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

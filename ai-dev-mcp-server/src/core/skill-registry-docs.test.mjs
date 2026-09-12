import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_REGISTRY_FILES,
  buildRebuildIndexReport,
  renderCustomSkillsMarkdown,
  renderDesignSkillsMarkdown,
  renderExternalSkillsMarkdown,
  renderMembraneSkillsMarkdown,
  renderSkillNames
} from "./skill-registry-docs.mjs";

const CUSTOM = [{ name: "feature-builder", use_when: "behaviour changes", path: "custom/feature-builder/SKILL.md" }];
const DESIGN = [{ name: "image-to-code", source: "design/taste-skill", type: "taste", use_when: "a reference image exists", path: "design/image-to-code/SKILL.md" }];
const MEMBRANE = [{ name: "gmail", subgroups: ["email", "google"], use_when: "the task names Gmail", path: "membrane/gmail/SKILL.md" }];
const EXTERNAL = [{ name: "archify", source: "external/archify", use_when: "a diagram is the deliverable", path: "external/archify/SKILL.md" }];

test("every generated registry file lives under the catalog registries folder", () => {
  for (const [key, value] of Object.entries(SKILL_REGISTRY_FILES)) {
    assert.ok(value.startsWith("03-skills-catalog/registries/"), `${key} -> ${value}`);
  }
  assert.equal(SKILL_REGISTRY_FILES.combined, "03-skills-catalog/registries/skills.index.json");
  assert.equal(SKILL_REGISTRY_FILES.names, "03-skills-catalog/registries/skills.names.txt");
});

test("the names file is one skill per line and newline-terminated", () => {
  assert.equal(renderSkillNames([{ name: "a" }, { name: "b" }]), "a\nb\n");
  assert.equal(renderSkillNames([]), "\n");
});

test("the custom registry note is a table of name, use_when and file", () => {
  const markdown = renderCustomSkillsMarkdown(CUSTOM);
  assert.match(markdown, /^# Custom Workflow Skills\n/);
  assert.match(markdown, /\| feature-builder \| behaviour changes \| `custom\/feature-builder\/SKILL\.md` \|/);
});

test("the design registry note carries its own heading above the table", () => {
  const markdown = renderDesignSkillsMarkdown(DESIGN);
  assert.match(markdown, /^# Design Skills\n/);
  assert.match(markdown, /# Design Taste Skills/);
  assert.match(markdown, /\| image-to-code \| design\/taste-skill \| taste \| a reference image exists \|/);
});

test("the membrane registry note reports the total and joins subgroups", () => {
  const markdown = renderMembraneSkillsMarkdown(MEMBRANE);
  assert.match(markdown, /Total skills: 1/);
  assert.match(markdown, /\| gmail \| email, google \| the task names Gmail \|/);
  assert.match(renderMembraneSkillsMarkdown([]), /Total skills: 0/);
});

test("the external registry note names the source of each import", () => {
  assert.match(renderExternalSkillsMarkdown(EXTERNAL), /\| archify \| external\/archify \|/);
});

test("the rebuild report counts every source and names every generated file", () => {
  const report = buildRebuildIndexReport({
    custom: CUSTOM,
    design: DESIGN,
    membrane: MEMBRANE,
    external: EXTERNAL,
    combined: [...CUSTOM, ...DESIGN, ...EXTERNAL, ...MEMBRANE],
    taxonomy: {
      schema_version: 3,
      groups: [{ id: "delivery", count: 2, extra: "dropped" }],
      visual_graph: {
        linked_unique_skills: 4, batch_pages: 1, group_hubs: 2, bucket_hubs: 3, page_size: 50,
        root_note: "03-skills-catalog/groups/all-skills/Index.md"
      }
    },
    skillCards: { total: 3, index_path: "cards.json", catalog_path: "SKILL_CARDS.md" },
    paths: {
      skillGroupsIndex: "groups.json",
      skillGraphIndex: "graph.json",
      skillsMap: "Skills Map.md"
    }
  });

  assert.equal(report.total, 4);
  assert.deepEqual(
    { custom: report.custom, design: report.design, external: report.external, membrane: report.membrane },
    { custom: 1, design: 1, external: 1, membrane: 1 }
  );
  assert.equal(report.skill_cards, 3);
  assert.equal(report.taxonomy_schema_version, 3);
  assert.deepEqual(report.skill_groups, [{ id: "delivery", count: 2 }]);
  assert.deepEqual(report.visual_graph, {
    linked_unique_skills: 4, batch_pages: 1, group_hubs: 2, bucket_hubs: 3, page_size: 50
  });
  assert.equal(report.files.combined, SKILL_REGISTRY_FILES.combined);
  assert.equal(report.files.custom, SKILL_REGISTRY_FILES.customMarkdown);
  assert.equal(report.files.skills_map, "Skills Map.md");
  assert.equal(report.files.complete_skill_graph, "03-skills-catalog/groups/all-skills/Index.md");
  assert.equal(report.files.skill_cards_index, "cards.json");
});

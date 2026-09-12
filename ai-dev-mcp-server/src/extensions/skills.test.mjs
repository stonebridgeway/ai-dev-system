import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionTools } from "../tool-extensions.mjs";
import { SKILL_GROUPS } from "../skill-taxonomy.mjs";
import { createSkillOverlayDocument } from "../core/skill-overlays.mjs";
import { SKILL_REGISTRY_FILES } from "../core/skill-registry-docs.mjs";
import { createSkillTools } from "./skills.mjs";

const VAULT_PATHS = {
  skillGroupsIndex: "registries/skill-groups.index.json",
  skillGraphIndex: "registries/skill-graph.index.json",
  skillsMap: "groups/Skills Map.md",
  skillQualityIndex: "registries/skill-quality.index.json",
  skillQualityDashboard: "Skill Quality Dashboard.md",
  skillOverlays: "registries/skill-overlays.json"
};

const SKILL_MARKDOWN = `---
name: feature-builder
description: Implement a behaviour change end to end.
---

# feature-builder

## Use When

The task changes product behaviour.

## Steps

1. Read the project map.
2. Write the test first.
3. Implement the change.

## Verification

Run the quality gate.
`;

function registryItem(overrides = {}) {
  return {
    name: "feature-builder",
    source: "custom",
    type: "workflow",
    path: "custom/feature-builder/SKILL.md",
    primary_group: SKILL_GROUPS[0].id,
    categories: ["workflow"],
    description: "implement a feature end to end",
    use_when: "the task changes product behaviour",
    maturity: "validated",
    trust_level: "trusted-local",
    quality_score: 90,
    quality_status: "pass",
    skill_schema_version: 2,
    ...overrides
  };
}

/**
 * A vault-shaped fixture plus a host that answers every service the skills
 * extension asks for, so the three tools run without the real vault, the
 * collectors, or the embedding backend.
 */
async function createFixture(t, { skills = [registryItem()] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  const catalogRoot = path.join(vaultRoot, "03-skills-catalog");
  const sourcesRoot = path.join(catalogRoot, "sources");
  const safePath = (relative) => path.join(vaultRoot, relative);

  await fs.mkdir(path.join(sourcesRoot, "custom", "feature-builder"), { recursive: true });
  await fs.writeFile(path.join(sourcesRoot, "custom", "feature-builder", "SKILL.md"), SKILL_MARKDOWN, "utf8");
  // Registry paths are relative to the catalog root and must stay inside sources.
  const sourced = skills.map((item) => ({ ...item, path: `sources/${item.path}` }));

  const calls = [];
  const writes = new Map();
  const host = {
    vaultPaths: VAULT_PATHS,
    skillCatalogRoot: catalogRoot,
    skillSourcesRoot: sourcesRoot,
    skillRegistryDir: path.join(catalogRoot, "registries"),
    safePath,
    readSkillIndex: async () => sourced,
    readSkillCardsIndex: async () => [{
      name: "feature-builder", source: "custom", card_path: "03-skills-catalog/cards/custom/feature-builder.md"
    }],
    readSkillOverlayDocument: async () => createSkillOverlayDocument("2026-01-01T00:00:00.000Z"),
    writeJson: (relative, value) => {
      writes.set(relative, value);
    },
    writeText: (relative, value) => {
      writes.set(relative, value);
    },
    markSearchIndexDirty: (reason) => calls.push(["markSearchIndexDirty", reason]),
    skillOutcomeStore: { status: async () => ({ summaries: {} }) },
    collectCustomSkills: async () => {
      calls.push(["collectCustomSkills"]);
      return [registryItem()];
    },
    collectDesignSkills: async () => [registryItem({ name: "image-to-code", source: "design/taste-skill" })],
    collectMembraneSkills: async () => [registryItem({ name: "acme-portal", source: "membrane/app-skills" })],
    collectExternalSkills: async () => [registryItem({ name: "archify", source: "external/archify" })],
    writeSkillTaxonomyArtifacts: async (items) => {
      calls.push(["writeSkillTaxonomyArtifacts", items.length]);
      return {
        schema_version: 3,
        groups: [{ id: SKILL_GROUPS[0].id, count: items.length }],
        visual_graph: {
          linked_unique_skills: items.length, batch_pages: 1, group_hubs: 1, bucket_hubs: 1, page_size: 80,
          root_note: "03-skills-catalog/groups/all-skills/Index.md"
        }
      };
    },
    syncSkillCards: async (options) => {
      calls.push(["syncSkillCards", options]);
      return { total: 3, index_path: "cards.json", catalog_path: "SKILL_CARDS.md" };
    },
    embedTexts: async ({ texts }) => {
      calls.push(["embedTexts", texts.length]);
      return { embeddings: texts.map(() => [1, 0, 0]) };
    },
    projectRecommendationContext: async (args) => {
      calls.push(["projectRecommendationContext", args]);
      return {
        available: false, name: "", project_path: "", stack: [], project_types: [],
        card_path: "", card_text: "", context_text: ""
      };
    }
  };

  return { root, vaultRoot, host, calls, writes, registry: createExtensionTools(host, [createSkillTools]) };
}

test("skill tools expose the three registry contracts and only recommend_skills is read-only", async (t) => {
  const { registry } = await createFixture(t);
  assert.deepEqual(registry.definitions.map((definition) => definition.name), [
    "rebuild_index",
    "validate_skill_library",
    "recommend_skills"
  ]);
  assert.deepEqual(registry.readOnly, ["recommend_skills"]);
  for (const definition of registry.definitions) assert.equal(definition.inputSchema.type, "object");
  assert.deepEqual(
    registry.definitions.find((definition) => definition.name === "recommend_skills").inputSchema.required,
    ["task"]
  );
});

test("rebuild_index writes every registry file and reports what it built", async (t) => {
  const { registry, writes, calls } = await createFixture(t);
  const result = await registry.handlers.get("rebuild_index")({});

  for (const relative of Object.values(SKILL_REGISTRY_FILES)) {
    assert.ok(writes.has(relative), `missing generated file: ${relative}`);
  }
  assert.deepEqual(writes.get(SKILL_REGISTRY_FILES.combined).map((item) => item.name),
    ["feature-builder", "image-to-code", "archify", "acme-portal"]);
  assert.equal(writes.get(SKILL_REGISTRY_FILES.names), "feature-builder\nimage-to-code\narchify\nacme-portal\n");
  assert.match(writes.get(SKILL_REGISTRY_FILES.customMarkdown), /# Custom Workflow Skills/);

  assert.deepEqual(
    { total: result.total, custom: result.custom, design: result.design, external: result.external, membrane: result.membrane },
    { total: 4, custom: 1, design: 1, external: 1, membrane: 1 }
  );
  assert.equal(result.skill_cards, 3);
  assert.equal(result.files.skills_map, VAULT_PATHS.skillsMap);
  assert.deepEqual(calls.at(-2), ["syncSkillCards", { include_membrane: false }]);
  assert.deepEqual(calls.at(-1), ["markSearchIndexDirty", "skill registry rebuilt"]);
});

test("validate_skill_library scores the sources and writes the report and dashboard", async (t) => {
  const { registry, writes, calls } = await createFixture(t);
  const result = await registry.handlers.get("validate_skill_library")({});

  assert.equal(result.action, "validated");
  assert.equal(result.source_read_errors, 0);
  assert.equal(result.summary.total, 1);
  assert.equal(result.report_path, VAULT_PATHS.skillQualityIndex);
  assert.equal(result.dashboard_path, VAULT_PATHS.skillQualityDashboard);
  assert.ok(Array.isArray(result.recommendations) && result.recommendations.length > 0);
  assert.equal("skills" in result, false);

  assert.match(writes.get(VAULT_PATHS.skillQualityDashboard), /# Skill Quality Dashboard/);
  assert.equal(writes.get(VAULT_PATHS.skillQualityIndex).skills.length, 1);
  assert.deepEqual(calls.at(-1), ["markSearchIndexDirty", "skill quality report updated"]);
});

test("validate_skill_library writes nothing when write_report is off", async (t) => {
  const { registry, writes, calls } = await createFixture(t);
  const result = await registry.handlers.get("validate_skill_library")({ write_report: false });

  assert.equal(result.report_path, null);
  assert.equal(result.dashboard_path, null);
  assert.equal(writes.size, 0);
  assert.deepEqual(calls.filter(([name]) => name === "markSearchIndexDirty"), []);
});

test("an unreadable source becomes an issue instead of failing the run", async (t) => {
  const { registry } = await createFixture(t, {
    skills: [registryItem(), registryItem({ name: "ghost", path: "custom/ghost/SKILL.md" })]
  });
  const result = await registry.handlers.get("validate_skill_library")({ write_report: false });

  assert.equal(result.source_read_errors, 1);
  assert.equal(result.issues[0].code, "source-read-failed");
  assert.equal(result.issues[0].skill, "ghost");
  assert.equal(result.summary.total, 1);
});

test("a registry path outside the sources root is refused, not read", async (t) => {
  const { registry } = await createFixture(t, {
    skills: [registryItem({ name: "escape", path: "../../../../etc/passwd" })]
  });
  const result = await registry.handlers.get("validate_skill_library")({ write_report: false });

  assert.equal(result.source_read_errors, 1);
  assert.match(result.issues[0].message, /outside the sources root/);
});

test("filters narrow the validated set and are echoed back", async (t) => {
  const { registry } = await createFixture(t);
  const bySource = await registry.handlers.get("validate_skill_library")({ source: "membrane", write_report: false });
  assert.equal(bySource.summary.total, 0);
  assert.deepEqual(bySource.filters, { source: "membrane", group: "", min_score: 0 });

  const byScore = await registry.handlers.get("validate_skill_library")({ min_score: 200, write_report: false });
  assert.equal(byScore.summary.total, 0);

  const byGroup = await registry.handlers.get("validate_skill_library")({ group: "security", write_report: false });
  assert.equal(byGroup.summary.total, 0);
  assert.equal(byGroup.filters.group, "security");
});

test("refresh_registry rebuilds before validating", async (t) => {
  const { registry, calls } = await createFixture(t);
  await registry.handlers.get("validate_skill_library")({ refresh_registry: true, write_report: false });
  assert.ok(calls.some(([name]) => name === "collectCustomSkills"));
});

test("semantic duplicate refinement is off by default and reaches the embedder when asked", async (t) => {
  const { registry, calls } = await createFixture(t);
  const lexical = await registry.handlers.get("validate_skill_library")({ write_report: false });
  assert.equal(lexical.duplicates.semantic_evaluated, 0);
  assert.deepEqual(calls.filter(([name]) => name === "embedTexts"), []);

  const semantic = await registry.handlers.get("validate_skill_library")({
    include_semantic_duplicates: true, duplicate_threshold: 0.5, write_report: false
  });
  // One skill cannot pair with itself, so there is still nothing to refine.
  assert.equal(semantic.duplicates.semantic_evaluated, 0);
});

test("duplicate analysis can be turned off entirely", async (t) => {
  const { registry } = await createFixture(t);
  const result = await registry.handlers.get("validate_skill_library")({ include_duplicates: false, write_report: false });
  assert.equal(result.duplicates.membrane_policy, "Duplicate analysis disabled.");
  assert.equal(result.duplicates.near_total, 0);
});

test("recommend_skills validates its arguments before touching the vault", async (t) => {
  const { registry, calls } = await createFixture(t);
  const recommend = registry.handlers.get("recommend_skills");

  await assert.rejects(() => recommend({}), /task is required/);
  await assert.rejects(() => recommend({ task: "" }), /task is required/);
  await assert.rejects(() => recommend({ task: 7 }), /task is required/);
  await assert.rejects(() => recommend({ task: "x", membrane_policy: "maybe" }), /membrane_policy must be auto, include, or exclude/);
  assert.deepEqual(calls, []);
});

test("recommend_skills passes the project selector through and attaches card paths", async (t) => {
  const { registry, calls } = await createFixture(t);
  const result = await registry.handlers.get("recommend_skills")({
    task: "implement a feature", project_path: "/repo/demo"
  });

  assert.deepEqual(calls.at(-1), ["projectRecommendationContext", { project: undefined, project_path: "/repo/demo" }]);
  assert.ok(result.length > 0 && result.length <= 3);
  const builder = result.find((item) => item.name === "feature-builder");
  assert.equal(builder?.card_path, "03-skills-catalog/cards/custom/feature-builder.md");
});

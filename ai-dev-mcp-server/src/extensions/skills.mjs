/**
 * Skill registry tools: rebuild it, validate it, and route a task through it.
 *
 * These three own the generated skill catalog end to end. `rebuild_index`
 * collects the SKILL.md sources into the machine registries, the taxonomy notes
 * and the cards; `validate_skill_library` scores those sources and writes the
 * quality report the dashboard renders; `recommend_skills` reads the finished
 * registry and answers "which skills does this task need?".
 *
 * The division of labour matches `src/extensions/system.mjs`: everything that
 * touches the vault, the embedding backend or the project tree is here and
 * reaches it through `host`; every render, verdict and ranking is a pure
 * function in `src/core/skill-*.mjs` with its own test.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalSkillGroup, classifySkill } from "../skill-taxonomy.mjs";
import { analyzeDuplicateSkills, enrichSkillQuality } from "../skill-quality.mjs";
import { isPathInside } from "../core/path-policy.mjs";
import { applySkillOverlays } from "../core/skill-overlays.mjs";
import { applySkillOutcome } from "../core/skill-outcomes.mjs";
import { stripBom } from "../core/text-format.mjs";
import {
  SKILL_REGISTRY_FILES,
  buildRebuildIndexReport,
  renderCustomSkillsMarkdown,
  renderDesignSkillsMarkdown,
  renderExternalSkillsMarkdown,
  renderMembraneSkillsMarkdown,
  renderSkillNames
} from "../core/skill-registry-docs.mjs";
import {
  buildSkillQualityReport,
  renderSkillQualityDashboard,
  skillQualityResponse
} from "../core/skill-quality-report.mjs";
import {
  MEMBRANE_POLICIES,
  recommendSkillsFromRegistry
} from "../core/skill-recommendation.mjs";

/** Embedding pairs cost real time, so only a bounded slice is ever refined. */
const MAX_SEMANTIC_DUPLICATE_PATHS = 32;

/**
 * Rebuild every generated skill registry from the SKILL.md sources in the vault.
 *
 * The collectors, the taxonomy writer and the card sync stay on `host`: they are
 * shared with `rebuild_skill_taxonomy`, `sync_skill_cards` and `import_skill_repo`,
 * which have not been extracted yet.
 */
async function rebuildIndex(host) {
  await fs.mkdir(host.skillRegistryDir, { recursive: true });

  const [outcomeStatus, overlays] = await Promise.all([
    host.skillOutcomeStore.status(),
    host.readSkillOverlayDocument()
  ]);
  const custom = applySkillOverlays((await host.collectCustomSkills())
    .map((item) => applySkillOutcome(item, outcomeStatus.summaries[item.name]))
    .map(classifySkill), overlays);
  const design = applySkillOverlays((await host.collectDesignSkills()).map(classifySkill), overlays);
  const membrane = applySkillOverlays((await host.collectMembraneSkills()).map(classifySkill), overlays);
  const external = applySkillOverlays((await host.collectExternalSkills()).map(classifySkill), overlays);
  const combined = [...custom, ...design, ...external, ...membrane];

  await host.writeJson(SKILL_REGISTRY_FILES.custom, custom);
  await host.writeJson(SKILL_REGISTRY_FILES.design, design);
  await host.writeJson(SKILL_REGISTRY_FILES.membrane, membrane);
  await host.writeJson(SKILL_REGISTRY_FILES.external, external);
  await host.writeJson(SKILL_REGISTRY_FILES.combined, combined);
  await host.writeText(SKILL_REGISTRY_FILES.names, renderSkillNames(combined));
  const taxonomy = await host.writeSkillTaxonomyArtifacts(combined);

  await host.writeText(SKILL_REGISTRY_FILES.customMarkdown, renderCustomSkillsMarkdown(custom));
  await host.writeText(SKILL_REGISTRY_FILES.designMarkdown, renderDesignSkillsMarkdown(design));
  await host.writeText(SKILL_REGISTRY_FILES.membraneMarkdown, renderMembraneSkillsMarkdown(membrane));
  await host.writeText(SKILL_REGISTRY_FILES.externalMarkdown, renderExternalSkillsMarkdown(external));
  const skillCards = await host.syncSkillCards({ include_membrane: false });
  host.markSearchIndexDirty("skill registry rebuilt");

  return buildRebuildIndexReport({
    custom, design, external, membrane, combined, taxonomy, skillCards, paths: host.vaultPaths
  });
}

/**
 * Read one skill's source Markdown, refusing any registry path that points
 * outside the skill sources tree.
 */
async function readSkillMarkdown(host, item) {
  const target = path.resolve(host.skillCatalogRoot, String(item.path || ""));
  const sourceRoot = path.resolve(host.skillSourcesRoot);
  if (!isPathInside(sourceRoot, target, { allowRoot: false })) {
    throw new Error(`Skill path is outside the sources root: ${item.path}`);
  }
  return stripBom(await fs.readFile(target, "utf8"));
}

function dotProduct(left, right) {
  const length = Math.min(left?.length || 0, right?.length || 0);
  let total = 0;
  for (let index = 0; index < length; index += 1) total += Number(left[index] || 0) * Number(right[index] || 0);
  return total;
}

/**
 * Confirm lexically suspicious duplicate pairs with dense embeddings.
 *
 * Only pairs that fit inside one bounded embedding batch are evaluated; the
 * rest keep their lexical verdict.
 */
async function refineDuplicatePairsWithBge(host, pairs, records) {
  if (!pairs.length) return { evaluated: 0, pairs: [] };
  const byPath = new Map(records.map((record) => [record.item.path, record]));
  const selectedPairs = [];
  const selectedPaths = new Set();
  for (const pair of pairs) {
    const additions = [pair.left.path, pair.right.path].filter((value) => !selectedPaths.has(value));
    if (selectedPaths.size + additions.length > MAX_SEMANTIC_DUPLICATE_PATHS) continue;
    selectedPairs.push(pair);
    for (const value of additions) selectedPaths.add(value);
  }
  const paths = [...selectedPaths];
  if (!paths.length) return { evaluated: 0, pairs: [] };
  const embedded = await host.embedTexts({
    texts: paths.map((skillPath) => {
      const record = byPath.get(skillPath);
      return `Skill: ${record?.item?.name || skillPath}\n${String(record?.markdown || "").slice(0, 10000)}`;
    }),
    prefix: "passage: ",
    include_embeddings: true,
    timeout_ms: 600000
  });
  const vectors = new Map(paths.map((skillPath, index) => [skillPath, embedded.embeddings?.[index] || []]));
  return {
    evaluated: selectedPairs.length,
    pairs: selectedPairs.map((pair) => {
      const denseSimilarity = dotProduct(vectors.get(pair.left.path), vectors.get(pair.right.path));
      return {
        ...pair,
        dense_similarity: Number(denseSimilarity.toFixed(4)),
        semantic_confirmed: denseSimilarity >= 0.9
      };
    })
  };
}

/**
 * Score every SKILL.md in scope and, by default, write the quality report and
 * its Obsidian dashboard. A source that cannot be read becomes an issue rather
 * than aborting the run.
 */
async function validateSkillLibrary(host, {
  source = "",
  group = "",
  min_score = 0,
  include_duplicates = true,
  include_semantic_duplicates = false,
  duplicate_threshold = 0.82,
  max_issues = 200,
  write_report = true,
  refresh_registry = false
} = {}) {
  if (refresh_registry) await rebuildIndex(host);
  const paths = host.vaultPaths;
  const current = await host.readSkillIndex();
  const overlays = await host.readSkillOverlayDocument();
  const selectedGroup = group ? canonicalSkillGroup(group) : "";
  const records = [];
  const readErrors = [];
  for (const original of current) {
    if (source && !String(original.source || "").includes(String(source))) continue;
    if (selectedGroup && original.primary_group !== selectedGroup) continue;
    try {
      const markdown = await readSkillMarkdown(host, original);
      const enriched = applySkillOverlays([
        classifySkill(enrichSkillQuality(original, markdown))
      ], overlays)[0];
      if (Number(enriched.quality_score || 0) < Number(min_score || 0)) continue;
      records.push({ item: enriched, markdown });
    } catch (error) {
      readErrors.push({
        severity: "error",
        skill: original.name,
        source: original.source,
        path: original.path,
        code: "source-read-failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const items = records.map((record) => record.item);
  let duplicates = {
    exact: [], near: [], near_total: 0, compared_non_integration_skills: 0,
    membrane_policy: "Duplicate analysis disabled."
  };
  if (include_duplicates) {
    duplicates = analyzeDuplicateSkills(records, {
      threshold: Math.max(0.5, Math.min(Number(duplicate_threshold) || 0.82, 0.99)),
      max_pairs: 100
    });
    if (include_semantic_duplicates && duplicates.near.length) {
      const semantic = await refineDuplicatePairsWithBge(host, duplicates.near, records);
      duplicates.semantic_evaluated = semantic.evaluated;
      duplicates.near = semantic.pairs;
    } else {
      duplicates.semantic_evaluated = 0;
    }
  }
  const report = buildSkillQualityReport({
    items,
    registry: current,
    overlays,
    readErrors,
    duplicates,
    filters: { source, group: selectedGroup, min_score: Number(min_score || 0) },
    maxIssues: max_issues,
    overlaysPath: paths.skillOverlays
  });
  if (write_report) {
    await host.writeJson(paths.skillQualityIndex, report);
    await host.writeText(paths.skillQualityDashboard, renderSkillQualityDashboard(report, {
      reportPath: paths.skillQualityIndex,
      overlaysPath: paths.skillOverlays
    }));
    host.markSearchIndexDirty("skill quality report updated");
  }
  return skillQualityResponse(report, {
    reportPath: write_report ? paths.skillQualityIndex : null,
    dashboardPath: write_report ? paths.skillQualityDashboard : null
  });
}

/**
 * Route one task to a minimal set of skills, aware of the project it runs in.
 *
 * The vault reads are the registry, the card index and the project context;
 * the ranking itself is `recommendSkillsFromRegistry`.
 */
async function recommendSkills(host, {
  task,
  limit = 8,
  project,
  project_path,
  membrane_policy = "auto",
  include_membrane = false,
  preferred_groups = []
} = {}) {
  if (!task || typeof task !== "string") {
    throw new Error("task is required.");
  }
  if (!MEMBRANE_POLICIES.includes(membrane_policy)) {
    throw new Error("membrane_policy must be auto, include, or exclude.");
  }
  const [items, cards, context] = await Promise.all([
    host.readSkillIndex(),
    host.readSkillCardsIndex({ syncIfMissing: false }),
    host.projectRecommendationContext({ project, project_path })
  ]);
  return recommendSkillsFromRegistry({
    task,
    limit,
    items,
    cards,
    context,
    membranePolicy: membrane_policy,
    includeMembrane: include_membrane,
    preferredGroups: preferred_groups
  });
}

/**
 * Skill registry tools.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 */
export function createSkillTools(host) {
  return {
    definitions: [
      {
        name: "rebuild_index",
        description: "Rebuild machine-readable and Markdown skill registries from skills stored in the vault.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "validate_skill_library",
        description: "Validate source SKILL.md files with Schema v2, source-aware quality scoring, relationship checks, and duplicate analysis; optionally write the Obsidian quality dashboard.",
        inputSchema: {
          type: "object",
          properties: {
            source: { type: "string", description: "Optional source substring such as custom or membrane." },
            group: { type: "string", description: "Optional taxonomy group or alias." },
            min_score: { type: "number", default: 0 },
            include_duplicates: { type: "boolean", default: true },
            include_semantic_duplicates: { type: "boolean", default: false, description: "Use BGE-M3 only to refine lexically suspicious non-Membrane pairs." },
            duplicate_threshold: { type: "number", default: 0.82 },
            max_issues: { type: "number", default: 200 },
            write_report: { type: "boolean", default: true },
            refresh_registry: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "recommend_skills",
        description: "Recommend a minimal project-aware set of skills for a development, design, integration, review, or quality task.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string" },
            limit: { type: "number", default: 3, maximum: 3 },
            project: { type: "string" },
            project_path: { type: "string" },
            membrane_policy: { type: "string", default: "auto" },
            include_membrane: { type: "boolean", default: false },
            preferred_groups: {
              type: "array",
              items: { type: "string" },
              default: [],
              description: "Optional preferred taxonomy groups. Automatic task-based group routing is still applied."
            }
          },
          required: ["task"]
        }
      }
    ],
    handlers: {
      rebuild_index: () => rebuildIndex(host),
      validate_skill_library: (args) => validateSkillLibrary(host, args),
      recommend_skills: (args) => recommendSkills(host, args)
    },
    readOnly: ["recommend_skills"]
  };
}

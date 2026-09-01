import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CATALOG_REGISTRY = fileURLToPath(
  new URL("../../../03-skills-catalog/registries/skills.index.json", import.meta.url)
);
const requiresCatalog = existsSync(CATALOG_REGISTRY)
  ? false
  : "requires the full skill catalog (03-skills-catalog/registries/skills.index.json)";

import {
  canonicalSkillGroup,
  classifySkill,
  inferTaskSkillGroups,
  summarizeSkillTaxonomy
} from "./skill-taxonomy.mjs";

function item(name, options = {}) {
  return {
    name,
    source: options.source || "custom",
    type: options.type || "development-workflow",
    categories: options.categories || [],
    description: options.description || "",
    use_when: options.use_when || "",
    requires: [],
    path: `sources/${name}/SKILL.md`
  };
}

async function listMarkdownFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
    }
  }
  await walk(root);
  return files;
}

test("classifies core workflow skills and relationships", () => {
  const frontend = classifySkill(item("frontend-polisher", { description: "Responsive UI accessibility and browser QA." }));
  assert.equal(frontend.primary_group, "frontend-ui");
  assert(frontend.subgroups.includes("accessibility"));
  assert(frontend.related_skills.includes("frontend-quality-gate"));

  const bugfix = classifySkill(item("bugfix-investigator", { description: "Find the root cause of a failing test." }));
  assert.equal(bugfix.primary_group, "testing-quality");
  assert(bugfix.task_types.includes("debug"));
});

test("keeps the curated UI UX intelligence skill in the frontend domain", () => {
  const classified = classifySkill({
    name: "ui-ux-pro-max",
    source: "external/ui-ux-pro-max",
    type: "external-skill",
    description: "UI and UX guidance for web and mobile design systems",
    categories: ["external", "frontend", "design", "ui", "ux"]
  });
  assert.equal(classified.primary_group, "frontend-ui");
  assert.ok(classified.related_skills.includes("frontend-polisher"));
  assert.ok(classified.related_skills.includes("frontend-quality-gate"));
});

test("classifies common integrations into useful subgroups", () => {
  const github = classifySkill(item("github", {
    source: "membrane/application-skills",
    type: "app-integration",
    description: "GitHub integration. Manage repository data."
  }));
  assert.equal(github.primary_group, "integrations-automation");
  assert.deepEqual(github.subgroups, ["developer-tools"]);

  const linear = classifySkill(item("linear", {
    source: "membrane/application-skills",
    type: "app-integration",
    description: "Linear integration. Manage Issues, Projects, Teams."
  }));
  assert.deepEqual(linear.subgroups, ["project-work-management"]);

  const stripe = classifySkill(item("stripe", {
    source: "membrane/application-skills",
    type: "app-integration",
    description: "Stripe integration."
  }));
  assert.deepEqual(stripe.subgroups, ["commerce-payments"]);

  const generic = classifySkill(item("unknown-service", {
    source: "membrane/application-skills",
    type: "app-integration",
    description: "Unknown Service integration. Manage data, records, and automate workflows."
  }));
  const classifiedAgain = classifySkill(generic);
  assert.deepEqual(generic.subgroups, ["general-integration"]);
  assert.deepEqual(classifiedAgain.subgroups, generic.subgroups);
});

test("normalizes aliases and infers groups from Russian and English tasks", () => {
  assert.equal(canonicalSkillGroup("frontend"), "frontend-ui");
  assert.equal(canonicalSkillGroup("backend"), "backend-api");
  assert.equal(canonicalSkillGroup("integrations"), "integrations-automation");

  const frontend = inferTaskSkillGroups("почини адаптив и проверь frontend в браузере");
  assert(frontend.includes("frontend-ui"));
  assert(frontend.includes("testing-quality"));

  const integration = inferTaskSkillGroups("connect GitHub webhook to Slack");
  assert(integration.includes("integrations-automation"));
});

test("assigns every skill in the current registry exactly one known primary group", { skip: requiresCatalog }, async () => {
  const registryUrl = new URL("../../../03-skills-catalog/registries/skills.index.json", import.meta.url);
  const current = JSON.parse(await fs.readFile(registryUrl, "utf8"));
  const classified = current.map(classifySkill);
  assert.equal(classified.length, current.length);
  assert.equal(classified.filter((entry) => !entry.primary_group).length, 0);
  const summary = summarizeSkillTaxonomy(classified);
  assert.equal(summary.reduce((total, group) => total + group.count, 0), current.length);
});

test("keeps every Stage 1 engineering domain populated", { skip: requiresCatalog }, async () => {
  const registryUrl = new URL("../../../03-skills-catalog/registries/skills.index.json", import.meta.url);
  const current = JSON.parse(await fs.readFile(registryUrl, "utf8"));
  const summary = summarizeSkillTaxonomy(current.map(classifySkill));
  for (const groupId of ["backend-api", "data-ai", "devops-infrastructure", "security"]) {
    const group = summary.find((entry) => entry.id === groupId);
    assert(group, `Missing required group: ${groupId}`);
    assert(group.count > 0, `Required group is empty: ${groupId}`);
    assert(group.local_structure_ready_count > 0, `Required group has no structurally ready local skill: ${groupId}`);
  }
});

test("generated visual graph links every registry source exactly once", { skip: requiresCatalog }, async () => {
  const catalogRoot = fileURLToPath(new URL("../../../03-skills-catalog/", import.meta.url));
  const registry = JSON.parse(await fs.readFile(path.join(catalogRoot, "registries", "skills.index.json"), "utf8"));
  const graphRegistry = JSON.parse(await fs.readFile(path.join(catalogRoot, "registries", "skill-graph.index.json"), "utf8"));
  const graphRoot = path.join(catalogRoot, "groups", "all-skills");
  const generatedFiles = await listMarkdownFiles(graphRoot);
  const batchPages = generatedFiles.filter((file) => /^page-\d+\.md$/i.test(path.basename(file)));
  const expected = new Set(registry.map((entry) => `03-skills-catalog/${String(entry.path).replace(/\\/g, "/").replace(/\.md$/i, "")}`));
  const counts = new Map();

  for (const file of batchPages) {
    const markdown = await fs.readFile(file, "utf8");
    for (const match of markdown.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = match[1].trim().replace(/\\/g, "/");
      if (!target.startsWith("03-skills-catalog/sources/")) continue;
      counts.set(target, (counts.get(target) || 0) + 1);
      assert.equal(await fs.stat(path.join(catalogRoot, "..", `${target}.md`)).then(() => true, () => false), true, `Missing source file: ${target}`);
    }
  }

  assert.equal(expected.size, registry.length);
  assert.equal(counts.size, expected.size);
  assert.deepEqual([...counts.keys()].filter((target) => !expected.has(target)), []);
  assert.deepEqual([...expected].filter((target) => !counts.has(target)), []);
  assert.deepEqual([...counts].filter(([, count]) => count !== 1), []);
  assert.equal(graphRegistry.total_skills, registry.length);
  assert.equal(graphRegistry.linked_unique_skills, registry.length);
  assert.equal(batchPages.length, graphRegistry.batch_pages);
  assert.equal(
    generatedFiles.length,
    1 + graphRegistry.group_hubs + graphRegistry.bucket_hubs + graphRegistry.batch_pages
  );
});

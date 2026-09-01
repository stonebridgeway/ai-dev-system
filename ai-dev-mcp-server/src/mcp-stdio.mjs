#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_SUBGROUPS,
  SKILL_GROUPS,
  SKILL_TAXONOMY_SCHEMA_VERSION,
  canonicalSkillGroup,
  classifySkill,
  inferTaskSkillGroups,
  summarizeSkillTaxonomy
} from "./skill-taxonomy.mjs";
import {
  SKILL_SCHEMA_VERSION,
  analyzeDuplicateSkills,
  enrichSkillQuality,
  evaluateSkillQuality,
  summarizeSkillQuality
} from "./skill-quality.mjs";
import {
  atomicAppendFile,
  atomicWriteFile,
  atomicWriteJson
} from "./core/atomic-files.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";
import {
  commandRiskReason,
  parseSafeCommand
} from "./core/command-policy.mjs";
import {
  isPathInside,
  resolveWithinSync
} from "./core/path-policy.mjs";
import { runPolicyCommand } from "./core/process-runner.mjs";
import { analyzeProject } from "./core/project-intelligence.mjs";
import { resolveProjectIdentity } from "./core/project-identity.mjs";
import {
  compileContextPack,
  contextPackFreshness
} from "./core/context-compiler.mjs";
import {
  prioritizeRoutedRecommendations,
  routeSkills,
  taskRequiresFrontendProductWorkflow
} from "./core/skill-router.mjs";
import { prioritizeKnowledgeResults } from "./core/knowledge-router.mjs";
import {
  hardNegativeRulesFromCases,
  isSkillCatalogQuery,
  repairSearchMojibake,
  rerankSearchResults
} from "./core/search-reranker.mjs";
import {
  dashboardFreshness,
  dashboardSourceFingerprint,
  renderSystemDashboard
} from "./core/system-dashboard.mjs";
import {
  createLocalRuntimeProfile,
  renderRuntimeDistribution,
  runtimeDistributionFingerprint,
  validateRuntimeProfile
} from "./core/runtime-distribution.mjs";
import {
  evaluateSkillRoutingSuite,
  readSkillRoutingCases
} from "./core/skill-routing-eval.mjs";
import {
  bindEvidence,
  captureProjectState
} from "./core/evidence.mjs";
import { TaskStore } from "./core/task-lifecycle.mjs";
import {
  applySkillOutcome,
  SkillOutcomeStore
} from "./core/skill-outcomes.mjs";
import {
  PILOT_DIMENSIONS,
  PILOT_TASK_TYPES,
  PilotStore
} from "./core/pilot-evaluation.mjs";
import {
  applySkillOverlay,
  createSkillOverlayDocument,
  skillOverlayKey,
  summarizeSkillOverlays,
  upsertSkillOverlay,
  validateSkillOverlayDocument
} from "./core/skill-overlays.mjs";
import {
  buildUiUxDesignJsonArgs,
  buildUiUxDesignMarkdownArgs,
  buildUiUxKnowledgeArgs,
  UI_UX_PRO_MAX_DOMAINS,
  UI_UX_PRO_MAX_STACKS
} from "./core/ui-ux-pro-max.mjs";
import {
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_MODES,
  FRONTEND_PRODUCT_PATHS,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS,
  approveDesignSystemState,
  approveDirectionState,
  buildFrontendProductFiles,
  createFrontendProductState,
  evaluateFrontendProductGate,
  recordConceptJuryState,
  selectFrontendProductSkills,
  validateFrontendDirections,
  validateFrontendProductContext,
  validateFrontendReferences,
  validateProductDesignScorecard
} from "./core/frontend-product-quality.mjs";
import {
  findNearDuplicateImages,
  pngDifferenceHash
} from "./core/png-perceptual.mjs";
import {
  REFERENCE_FACTORY_GENERATORS,
  REFERENCE_FACTORY_SURFACES,
  buildReferenceFactoryRegistration,
  createReferenceFactoryManifest,
  renderReferenceFactoryPlan,
  updateReferenceFactoryManifest,
  validateReferenceFactoryManifest,
  validateReferenceFactoryOutputs
} from "./core/reference-factory.mjs";
import { buildToolDefinitions } from "./tool-definitions.mjs";
import { autoCommands } from "./auto-commands.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the vault root the server reads content from.
 *
 * Order: an explicit `AI_DEV_VAULT_ROOT`, then the sibling Obsidian vault three
 * levels up (the normal in-vault layout), then the `docker/public-seed` tree
 * bundled in the published repository. The seed fallback lets a standalone
 * checkout — and the test suite running against it — work without a full vault.
 *
 * @returns {string} absolute path to the resolved vault root
 */
function resolveVaultRoot() {
  if (process.env.AI_DEV_VAULT_ROOT) {
    return path.resolve(process.env.AI_DEV_VAULT_ROOT);
  }
  const siblingVault = path.resolve(path.join(serverDir, "..", "..", ".."));
  const looksLikeVault = existsSync(path.join(siblingVault, "03-skills-catalog"))
    || existsSync(path.join(siblingVault, "01-system"));
  if (looksLikeVault) {
    return siblingVault;
  }
  const bundledSeed = path.resolve(path.join(serverDir, "..", "..", "docker", "public-seed"));
  if (existsSync(bundledSeed)) {
    return bundledSeed;
  }
  return siblingVault;
}

const vaultRoot = resolveVaultRoot();

// Home for regenerable runtime data (task state, search cache, models, QA
// artifacts). Agent-neutral: defaults to ~/.ai-dev, overridable per directory
// with the AI_DEV_* env vars, and falls back to a pre-existing ~/.codex/<...>
// layout so installs migrated from the Codex-only runtime keep their history.
const userHome = process.env.AI_DEV_HOME
  || process.env.USERPROFILE
  || process.env.HOME
  || path.dirname(vaultRoot);
function aiDevRuntimePath(envVar, segments, legacySegments = segments) {
  if (process.env[envVar]) return path.resolve(process.env[envVar]);
  const next = path.join(userHome, ".ai-dev", ...segments);
  const legacy = path.join(userHome, ".codex", ...legacySegments);
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
}

const skillIndexPath = path.join(
  vaultRoot,
  "03-skills-catalog",
  "registries",
  "skills.index.json"
);
const skillCatalogRoot = path.join(vaultRoot, "03-skills-catalog");
const sourcesRoot = path.join(skillCatalogRoot, "sources");
const registryDir = path.join(skillCatalogRoot, "registries");
const skillCardsRelativeDir = "03-skills-catalog/cards";
const skillCardsIndexRelativePath = "03-skills-catalog/registries/skill-cards.index.json";
const skillCardsCatalogRelativePath = "03-skills-catalog/registries/SKILL_CARDS.md";
const skillGroupsRelativeDir = "03-skills-catalog/groups";
const skillGroupsIndexRelativePath = "03-skills-catalog/registries/skill-groups.index.json";
const skillsMapRelativePath = `${skillGroupsRelativeDir}/Skills Map.md`;
const skillGraphPagesRelativeDir = `${skillGroupsRelativeDir}/all-skills`;
const skillGraphIndexRelativePath = "03-skills-catalog/registries/skill-graph.index.json";
const skillGraphPageSize = 80;
const skillQualityIndexRelativePath = "03-skills-catalog/registries/skill-quality.index.json";
const skillQualityDashboardRelativePath = "03-skills-catalog/Skill Quality Dashboard.md";
const skillOverlaysRelativePath = "03-skills-catalog/registries/skill-overlays.json";
const systemDashboardRelativePath = "01-system/System Dashboard.md";
const systemDashboardStateRelativePath = "01-system/system-dashboard.json";
const runtimeDistributionRelativePath = "09-mcp/Runtime Distribution.md";
const runtimeDistributionStateRelativePath = "09-mcp/runtime-distribution.json";
const skillRoutingEvalRelativePath = "09-mcp/search-eval/skill_routing_eval_cases.json";
const skillRoutingReportRelativePath = "03-skills-catalog/registries/skill-routing-eval.json";
const projectsRelativeDir = "02-knowledge/Projects";
const projectsDir = path.join(vaultRoot, projectsRelativeDir);
const projectsIndexRelativePath = `${projectsRelativeDir}/Projects Index.md`;
const searchSourceDir = path.join(vaultRoot, "09-mcp", "search-index");
const searchIndexDir = path.resolve(
  aiDevRuntimePath(
    "AI_DEV_SEARCH_INDEX_DIR",
    ["cache", "search-index"],
    ["cache", "ai-dev-system", "search-index"]
  )
);
const searchIndexPath = path.join(searchIndexDir, "ai-dev-search.sqlite");
const searchCliPath = path.join(searchSourceDir, "search_cli.py");
const searchEvalCasesPath = path.join(vaultRoot, "09-mcp", "search-eval", "search_eval_cases.json");
const embeddingsDir = path.join(vaultRoot, "09-mcp", "embeddings");
const frontendQaRunnerPath = path.join(vaultRoot, "09-mcp", "frontend-qa", "frontend_qa_runner.mjs");
const frontendQaPackagePath = path.join(vaultRoot, "09-mcp", "frontend-qa", "package.json");
const uiUxProMaxRoot = path.join(
  vaultRoot,
  "03-skills-catalog",
  "sources",
  "external",
  "ui-ux-pro-max"
);
const uiUxProMaxSearchPath = path.join(uiUxProMaxRoot, "scripts", "search.py");
const uiUxProMaxProvenancePath = path.join(uiUxProMaxRoot, "upstream.json");
const frontendQaArtifactsRoot = path.resolve(
  aiDevRuntimePath("AI_DEV_FRONTEND_QA_ARTIFACT_ROOT", ["artifacts", "frontend-qa"])
);
const taskStateRoot = path.resolve(
  aiDevRuntimePath("AI_DEV_STATE_ROOT", ["state"], ["state", "ai-dev-system"])
);
const taskStore = new TaskStore({ stateRoot: taskStateRoot });
const skillOutcomeStore = new SkillOutcomeStore({ stateRoot: taskStateRoot });
const pilotStore = new PilotStore({ stateRoot: taskStateRoot });
const bgeM3EmbedCliPath = path.join(embeddingsDir, "bge_m3_embed.py");
const bgeM3WorkerCliPath = path.join(embeddingsDir, "bge_m3_worker.py");
const defaultBgeM3ModelDir = path.resolve(
  aiDevRuntimePath("BGE_M3_MODEL_DIR", ["models", "bge-m3"])
);
const searchFreshnessCacheMs = 1000;
let searchIndexRefreshPromise = null;
let searchIndexDirtyReason = "";
let searchIndexLastStatus = null;
let searchIndexLastStatusAt = 0;
let searchHardNegativeCache = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textContent(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function safePath(relativePath) {
  return resolveWithinSync(vaultRoot, relativePath, {
    mode: "write",
    allowAbsolute: true,
    allowRoot: false
  });
}

function safeKnowledgeNotePath(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("path is required.");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("Use a path relative to the AI Dev System root.");
  }
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Knowledge note path must end with .md.");
  }
  if (normalized.includes("..")) {
    throw new Error("Path traversal is not allowed.");
  }
  if (normalized.startsWith("03-skills-catalog/sources/") || normalized.startsWith("03-skills-catalog/registries/")) {
    throw new Error("Use skill-specific tools for sources and registries.");
  }

  const allowedPrefixes = [
    "01-system/",
    "02-knowledge/",
    "03-skills-catalog/",
    "04-agent-workflows/",
    "05-project-templates/",
    "06-prompts/",
    "07-quality-gates/",
    "08-integrations/",
    "09-mcp/",
    "10-inbox/",
    "99-archive/"
  ];
  if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Path must be inside an AI Dev System knowledge folder: ${normalized}`);
  }
  return safePath(normalized);
}

async function readText(relativePath) {
  return fs.readFile(safePath(relativePath), "utf8");
}

async function readSkillIndex() {
  const raw = await fs.readFile(skillIndexPath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function toVaultRelative(absolutePath) {
  return path.relative(vaultRoot, absolutePath).replaceAll("\\", "/");
}

function toSkillCatalogRelative(absolutePath) {
  return path.relative(skillCatalogRoot, absolutePath).replaceAll("\\", "/");
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function parseFrontmatter(text, fallbackName) {
  const frontmatter = text.match(/^---\s*([\s\S]*?)\s*---/);
  const result = { name: fallbackName, description: "" };
  if (!frontmatter) return result;

  const lines = frontmatter[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      result.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    const descBlockMatch = line.match(/^description:\s*\|\s*$/);
    if (descBlockMatch) {
      const descLines = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        if (/^[A-Za-z0-9_-]+:\s*/.test(lines[child])) break;
        descLines.push(lines[child].replace(/^\s{2}/, "").trimEnd());
      }
      result.description = descLines.filter((value) => value.trim()).join(" ").trim();
      continue;
    }

    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch) {
      result.description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return result;
}

function cleanDescription(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function inferUseWhen(description) {
  const cleaned = cleanDescription(description);
  const useMatch = cleaned.match(/Use when\s+(.+)$/i);
  return useMatch ? useMatch[1].replace(/\.$/, "").trim() : cleaned;
}

function shorten(value, max) {
  const cleaned = cleanDescription(value).replaceAll("|", "/");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
}

function inferDesignSkillType(name) {
  if (/^(imagegen|brandkit)/.test(name)) return "image-generation";
  if (name === "full-output-enforcement") return "output-control";
  return "design-workflow";
}

function inferDesignCategories(name) {
  if (/^(imagegen|brandkit)/.test(name)) return ["image-generation", "design", "brand"];
  if (name === "full-output-enforcement") return ["output", "quality", "completion"];
  return ["frontend", "design", "ui", "ux"];
}

async function skillItemFromFile({
  filePath,
  folderName,
  source,
  type,
  categories,
  requires,
  compatibility = "Local Markdown skill",
  homepage = "",
  repository = "",
  commit = "",
  version = "",
  license = ""
}) {
  const text = stripBom(await fs.readFile(filePath, "utf8"));
  const meta = parseFrontmatter(text, folderName);
  const description = cleanDescription(meta.description);
  const item = {
    name: meta.name,
    source,
    type,
    categories,
    description,
    use_when: inferUseWhen(description),
    requires,
    path: toSkillCatalogRelative(filePath),
    compatibility,
    homepage,
    repository
  };
  if (commit) item.commit = commit;
  if (version) item.version = version;
  if (license) item.license = license;
  return enrichSkillQuality(item, text);
}

async function listSkillFilesInSkillsDir(skillsDir) {
  if (!(await pathExists(skillsDir))) return [];
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (await pathExists(skillFile)) {
      files.push({ folderName: entry.name, filePath: skillFile });
    }
  }
  files.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return files;
}

async function getGitCommit(repoPath) {
  try {
    const output = await execFile("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeoutMs: 10000 });
    return output.stdout.trim();
  } catch {
    return "";
  }
}

async function getGitRemote(repoPath) {
  try {
    const output = await execFile("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], { timeoutMs: 10000 });
    return output.stdout.trim();
  } catch {
    return "";
  }
}

async function readExternalProvenance(repoPath) {
  const provenancePath = path.join(repoPath, "upstream.json");
  if (!(await pathExists(provenancePath))) return {};
  try {
    const parsed = JSON.parse(stripBom(await fs.readFile(provenancePath, "utf8")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function collectCustomSkills() {
  const customRoot = path.join(sourcesRoot, "custom");
  const files = await listSkillFilesInSkillsDir(customRoot);
  return Promise.all(files.map(({ folderName, filePath }) => skillItemFromFile({
    filePath,
    folderName,
    source: "custom",
    type: "development-workflow",
    categories: ["development", "workflow"],
    requires: ["repository context"]
  })));
}

async function collectMembraneSkills() {
  const membraneRoot = path.join(sourcesRoot, "membrane", "application-skills");
  const skillsDir = path.join(membraneRoot, "skills");
  const files = await listSkillFilesInSkillsDir(skillsDir);
  const commit = await getGitCommit(membraneRoot);
  const repository = await getGitRemote(membraneRoot) || "https://github.com/membranedev/application-skills";
  return Promise.all(files.map(({ folderName, filePath }) => skillItemFromFile({
    filePath,
    folderName,
    source: "membrane/application-skills",
    type: "app-integration",
    categories: [],
    requires: ["network access", "Membrane account", "app connection"],
    compatibility: "Requires network access and a valid Membrane account (Free tier supported).",
    homepage: "https://getmembrane.com",
    repository,
    commit
  })));
}

async function collectDesignSkills() {
  const designRoot = path.join(sourcesRoot, "design");
  if (!(await pathExists(designRoot))) return [];

  const repos = (await fs.readdir(designRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const result = [];

  for (const repo of repos) {
    const repoPath = path.join(designRoot, repo.name);
    const skillsDir = path.join(repoPath, "skills");
    const files = await listSkillFilesInSkillsDir(skillsDir);
    const commit = await getGitCommit(repoPath);
    const repository = await getGitRemote(repoPath);

    for (const { folderName, filePath } of files) {
      const provisional = parseFrontmatter(stripBom(await fs.readFile(filePath, "utf8")), folderName);
      result.push(await skillItemFromFile({
        filePath,
        folderName,
        source: `design/${repo.name}`,
        type: inferDesignSkillType(provisional.name),
        categories: inferDesignCategories(provisional.name),
        requires: ["frontend/design task"],
        compatibility: "Agent Skills compatible; local Markdown skill",
        homepage: repo.name === "taste-skill" ? "https://tasteskill.dev" : "",
        repository,
        commit
      }));
    }
  }

  return result;
}

async function collectExternalSkills() {
  const externalRoot = path.join(sourcesRoot, "external");
  if (!(await pathExists(externalRoot))) return [];

  const repos = (await fs.readdir(externalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const result = [];

  for (const repo of repos) {
    const repoPath = path.join(externalRoot, repo.name);
    const provenance = await readExternalProvenance(repoPath);
    const commit = cleanDescription(provenance.commit) || await getGitCommit(repoPath);
    const repository = cleanDescription(provenance.repository) || await getGitRemote(repoPath);
    const files = await listSkillFilesInSkillsDir(path.join(repoPath, "skills"));
    const rootSkill = path.join(repoPath, "SKILL.md");
    if (await pathExists(rootSkill)) {
      files.push({ folderName: repo.name, filePath: rootSkill });
    }

    for (const { folderName, filePath } of files) {
      const provisional = parseFrontmatter(stripBom(await fs.readFile(filePath, "utf8")), folderName);
      const isDesignSkill = /\b(ui|ux|design|frontend)\b/i.test(
        `${provisional.name} ${provisional.description}`
      );
      result.push(await skillItemFromFile({
        filePath,
        folderName,
        source: `external/${repo.name}`,
        type: "external-skill",
        categories: isDesignSkill
          ? ["external", "frontend", "design", "ui", "ux"]
          : ["external"],
        requires: isDesignSkill ? ["frontend/design task", "Python 3"] : [],
        compatibility: "Curated, provenance-pinned local Markdown skill",
        repository,
        commit,
        version: cleanDescription(provenance.version),
        license: cleanDescription(provenance.license)
      }));
    }
  }

  return result;
}

async function writeJson(relativePath, value) {
  const target = safePath(relativePath);
  await atomicWriteJson(target, value);
}

async function writeText(relativePath, value) {
  const target = safePath(relativePath);
  await atomicWriteFile(target, value, "utf8");
}

function markSearchIndexDirty(reason = "source changed") {
  searchIndexDirtyReason = String(reason || "source changed");
  searchIndexLastStatus = null;
  searchIndexLastStatusAt = 0;
}

async function writeKnowledgeNote({ path: notePath, content, overwrite = false }) {
  const target = safeKnowledgeNotePath(notePath);
  const exists = await pathExists(target);
  if (exists && !overwrite) {
    throw new Error(`Note already exists: ${toVaultRelative(target)}. Set overwrite=true to replace it.`);
  }
  await atomicWriteFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  markSearchIndexDirty(`knowledge note written: ${toVaultRelative(target)}`);
  return {
    action: exists ? "overwritten" : "created",
    path: toVaultRelative(target),
    bytes: Buffer.byteLength(content, "utf8")
  };
}

async function appendKnowledgeNote({ path: notePath, content, heading }) {
  const target = safeKnowledgeNotePath(notePath);
  const exists = await pathExists(target);
  const parts = [];
  if (!exists) {
    parts.push(`# ${path.basename(notePath, ".md")}\n`);
  }
  if (heading) {
    parts.push(`\n## ${heading}\n\n`);
  } else if (exists) {
    parts.push("\n");
  }
  parts.push(content.endsWith("\n") ? content : `${content}\n`);
  await atomicAppendFile(target, parts.join(""), "utf8");
  markSearchIndexDirty(`knowledge note appended: ${toVaultRelative(target)}`);
  return {
    action: exists ? "appended" : "created",
    path: toVaultRelative(target),
    bytes: Buffer.byteLength(parts.join(""), "utf8")
  };
}

function slugPart(value, fallback = "item") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || fallback).slice(0, 90);
}

function markdownList(values, fallback = "None recorded.") {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return fallback;
  return list.map((value) => `- ${String(value).replace(/\r?\n/g, " ").trim()}`).join("\n");
}

function skillGroupNotePath(groupId) {
  return `${skillGroupsRelativeDir}/${groupId}.md`;
}

function skillWikiLink(item) {
  const target = isMembraneSkill(item)
    ? `03-skills-catalog/${String(item.path || "").replace(/\.md$/i, "")}`
    : skillCardPath(item).replace(/\.md$/i, "");
  return `[[${target}|${item.name}]]`;
}

function groupWikiLink(groupId, label = "") {
  const group = SKILL_GROUPS.find((item) => item.id === groupId);
  return `[[${skillGroupNotePath(groupId).replace(/\.md$/i, "")}|${label || group?.label || groupId}]]`;
}

function skillSourceWikiTarget(item) {
  const relativePath = String(item.path || "").replace(/^\/+/, "").replace(/\.md$/i, "");
  return `03-skills-catalog/${relativePath}`;
}

function skillSourceWikiLink(item) {
  return `[[${skillSourceWikiTarget(item)}|${item.name}]]`;
}

function skillGraphBucketId(item, group) {
  const known = new Set((group.subgroups || []).map((subgroup) => subgroup.id));
  return (item.subgroups || []).find((subgroup) => known.has(subgroup)) || "other";
}

function skillGraphBucketLabel(group, bucketId) {
  if (bucketId === "other") return "Other / General";
  return group.subgroups.find((subgroup) => subgroup.id === bucketId)?.label || bucketId;
}

function skillGraphGroupIndexPath(groupId) {
  return `${skillGraphPagesRelativeDir}/${groupId}/Index.md`;
}

function skillGraphBucketIndexPath(groupId, bucketId) {
  return `${skillGraphPagesRelativeDir}/${groupId}/${bucketId}/Index.md`;
}

function skillGraphPagePath(groupId, bucketId, pageNumber) {
  return `${skillGraphPagesRelativeDir}/${groupId}/${bucketId}/page-${String(pageNumber).padStart(3, "0")}.md`;
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function buildSkillGraphPlan(items, groups) {
  const groupPlans = groups.map((group) => {
    const members = items
      .filter((item) => item.primary_group === group.id)
      .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
    const buckets = new Map();
    for (const item of members) {
      const bucketId = skillGraphBucketId(item, group);
      if (!buckets.has(bucketId)) buckets.set(bucketId, []);
      buckets.get(bucketId).push(item);
    }
    const bucketOrder = new Map((group.subgroups || []).map((subgroup, index) => [subgroup.id, index]));
    const bucketPlans = [...buckets.entries()]
      .sort(([left], [right]) => {
        const leftOrder = left === "other" ? Number.MAX_SAFE_INTEGER : (bucketOrder.get(left) ?? Number.MAX_SAFE_INTEGER - 1);
        const rightOrder = right === "other" ? Number.MAX_SAFE_INTEGER : (bucketOrder.get(right) ?? Number.MAX_SAFE_INTEGER - 1);
        return leftOrder - rightOrder || left.localeCompare(right);
      })
      .map(([bucketId, bucketMembers]) => {
        const pages = chunkItems(bucketMembers, skillGraphPageSize).map((pageItems, index) => ({
          number: index + 1,
          path: skillGraphPagePath(group.id, bucketId, index + 1),
          start: index * skillGraphPageSize + 1,
          end: index * skillGraphPageSize + pageItems.length,
          items: pageItems
        }));
        return {
          id: bucketId,
          label: skillGraphBucketLabel(group, bucketId),
          count: bucketMembers.length,
          index_path: skillGraphBucketIndexPath(group.id, bucketId),
          pages
        };
      });
    return {
      id: group.id,
      label: group.label,
      count: members.length,
      index_path: skillGraphGroupIndexPath(group.id),
      buckets: bucketPlans
    };
  });
  return {
    schema_version: SKILL_TAXONOMY_SCHEMA_VERSION,
    page_size: skillGraphPageSize,
    total_skills: items.length,
    linked_unique_skills: groupPlans.reduce((total, group) => total + group.count, 0),
    batch_pages: groupPlans.reduce(
      (total, group) => total + group.buckets.reduce((subtotal, bucket) => subtotal + bucket.pages.length, 0),
      0
    ),
    group_hubs: groupPlans.filter((group) => group.count > 0).length,
    bucket_hubs: groupPlans.reduce((total, group) => total + group.buckets.length, 0),
    groups: groupPlans
  };
}

function renderSkillGraphRoot(plan) {
  const lines = [
    "---",
    'tags: ["skill-map", "skill-graph", "generated"]',
    `skill_count: ${plan.total_skills}`,
    `batch_page_count: ${plan.batch_pages}`,
    `taxonomy_schema_version: ${plan.schema_version}`,
    "---",
    "",
    "# Complete Skill Graph",
    "",
    "Generated visual navigation for every source `SKILL.md`. Each skill is assigned to one primary domain and bucket so the Obsidian graph forms stable clusters.",
    "",
    `Linked source skills: **${plan.linked_unique_skills}/${plan.total_skills}**.`,
    "",
    "| Domain | Skills | Buckets | Pages |",
    "|---|---:|---:|---:|"
  ];
  for (const group of plan.groups.filter((item) => item.count > 0)) {
    const pages = group.buckets.reduce((total, bucket) => total + bucket.pages.length, 0);
    lines.push(`| [[${group.index_path.replace(/\.md$/i, "")}|${group.label}]] | ${group.count} | ${group.buckets.length} | ${pages} |`);
  }
  lines.push("", "## Back", "", `- [[${skillsMapRelativePath.replace(/\.md$/i, "")}|Skills Map]]`, "");
  return lines.join("\n");
}

function renderSkillGraphGroupIndex(groupPlan) {
  const lines = [
    "---",
    `tags: ["skill-graph", "skill-group/${groupPlan.id}", "generated"]`,
    `skill_group: ${JSON.stringify(groupPlan.id)}`,
    `skill_count: ${groupPlan.count}`,
    "---",
    "",
    `# ${groupPlan.label} - Complete Catalog`,
    "",
    `Source skills: **${groupPlan.count}**.`,
    "",
    "| Bucket | Skills | Pages |",
    "|---|---:|---:|"
  ];
  for (const bucket of groupPlan.buckets) {
    lines.push(`| [[${bucket.index_path.replace(/\.md$/i, "")}|${bucket.label}]] | ${bucket.count} | ${bucket.pages.length} |`);
  }
  lines.push(
    "",
    "## Back",
    "",
    `- ${groupWikiLink(groupPlan.id)}`,
    `- [[${skillGraphPagesRelativeDir}/Index|Complete Skill Graph]]`,
    `- [[${skillsMapRelativePath.replace(/\.md$/i, "")}|Skills Map]]`,
    ""
  );
  return lines.join("\n");
}

function renderSkillGraphBucketIndex(group, groupPlan, bucket) {
  const lines = [
    "---",
    `tags: ["skill-graph", "skill-group/${group.id}", "skill-subgroup/${bucket.id}", "generated"]`,
    `skill_group: ${JSON.stringify(group.id)}`,
    `skill_subgroup: ${JSON.stringify(bucket.id)}`,
    `skill_count: ${bucket.count}`,
    "---",
    "",
    `# ${bucket.label} - Complete Catalog`,
    "",
    `Source skills: **${bucket.count}**. Pages contain at most ${skillGraphPageSize} links.`,
    "",
    "## Pages",
    ""
  ];
  for (const page of bucket.pages) {
    lines.push(`- [[${page.path.replace(/\.md$/i, "")}|Skills ${page.start}-${page.end}]]`);
  }
  lines.push("", "## Back", "");
  if (bucket.id !== "other") {
    lines.push(`- [[${skillGroupsRelativeDir}/${group.id}/${bucket.id}|${bucket.label} taxonomy page]]`);
  }
  lines.push(
    `- [[${groupPlan.index_path.replace(/\.md$/i, "")}|${groupPlan.label} complete catalog]]`,
    `- ${groupWikiLink(group.id)}`,
    `- [[${skillGraphPagesRelativeDir}/Index|Complete Skill Graph]]`,
    ""
  );
  return lines.join("\n");
}

function renderSkillGraphPage(group, groupPlan, bucket, page) {
  const previous = bucket.pages.find((item) => item.number === page.number - 1);
  const next = bucket.pages.find((item) => item.number === page.number + 1);
  const lines = [
    "---",
    `tags: ["skill-batch", "skill-group/${group.id}", "skill-subgroup/${bucket.id}", "generated"]`,
    `skill_group: ${JSON.stringify(group.id)}`,
    `skill_subgroup: ${JSON.stringify(bucket.id)}`,
    `skill_count: ${page.items.length}`,
    `skill_page: ${page.number}`,
    `skill_page_count: ${bucket.pages.length}`,
    "---",
    "",
    `# ${bucket.label} - Skills ${page.start}-${page.end}`,
    "",
    `Domain: ${groupWikiLink(group.id)}. Bucket: [[${bucket.index_path.replace(/\.md$/i, "")}|${bucket.label}]].`,
    "",
    "## Skills",
    ""
  ];
  for (const item of page.items) lines.push(`- ${skillSourceWikiLink(item)}`);
  lines.push("", "## Navigation", "");
  if (previous) lines.push(`- Previous: [[${previous.path.replace(/\.md$/i, "")}|Skills ${previous.start}-${previous.end}]]`);
  if (next) lines.push(`- Next: [[${next.path.replace(/\.md$/i, "")}|Skills ${next.start}-${next.end}]]`);
  lines.push(
    `- [[${bucket.index_path.replace(/\.md$/i, "")}|${bucket.label} complete catalog]]`,
    `- [[${groupPlan.index_path.replace(/\.md$/i, "")}|${groupPlan.label} complete catalog]]`,
    `- [[${skillGraphPagesRelativeDir}/Index|Complete Skill Graph]]`,
    ""
  );
  return lines.join("\n");
}

async function resetSkillGraphPages() {
  const groupsRoot = path.resolve(safePath(skillGroupsRelativeDir));
  const target = path.resolve(safePath(skillGraphPagesRelativeDir));
  if (!isPathInside(groupsRoot, target, { allowRoot: false })) {
    throw new Error(`Refusing to reset generated skill graph outside groups root: ${target}`);
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function writeSkillGraphArtifacts(plan, groups) {
  await resetSkillGraphPages();
  await writeText(`${skillGraphPagesRelativeDir}/Index.md`, renderSkillGraphRoot(plan));
  for (const groupPlan of plan.groups.filter((item) => item.count > 0)) {
    const group = groups.find((item) => item.id === groupPlan.id);
    await writeText(groupPlan.index_path, renderSkillGraphGroupIndex(groupPlan));
    for (const bucket of groupPlan.buckets) {
      await writeText(bucket.index_path, renderSkillGraphBucketIndex(group, groupPlan, bucket));
      for (const page of bucket.pages) {
        await writeText(page.path, renderSkillGraphPage(group, groupPlan, bucket, page));
      }
    }
  }
  const registry = {
    schema_version: plan.schema_version,
    generated_at: new Date().toISOString(),
    page_size: plan.page_size,
    total_skills: plan.total_skills,
    linked_unique_skills: plan.linked_unique_skills,
    batch_pages: plan.batch_pages,
    group_hubs: plan.group_hubs,
    bucket_hubs: plan.bucket_hubs,
    root_note: `${skillGraphPagesRelativeDir}/Index.md`,
    groups: plan.groups.map((group) => ({
      id: group.id,
      label: group.label,
      count: group.count,
      index_path: group.index_path,
      buckets: group.buckets.map((bucket) => ({
        id: bucket.id,
        label: bucket.label,
        count: bucket.count,
        index_path: bucket.index_path,
        pages: bucket.pages.map((page) => ({ path: page.path, start: page.start, end: page.end, count: page.items.length }))
      }))
    }))
  };
  await writeJson(skillGraphIndexRelativePath, registry);
  return registry;
}

function renderSkillsMap(groups, total) {
  const lines = [
    "---",
    'tags: ["skill-map", "skill-taxonomy"]',
    `taxonomy_schema_version: ${SKILL_TAXONOMY_SCHEMA_VERSION}`,
    "---",
    "",
    "# Skills Map",
    "",
    "Главная карта доменов skills. Исходные `SKILL.md` остаются неизменными; эта карта и MCP taxonomy управляют навигацией и поиском.",
    "",
    `Всего классифицировано: **${total}** skills.`,
    "",
    "## Domains",
    "",
    "| Domain | Skills | Core | Catalog | Quality | Structure ready | Empirical | Purpose |",
    "|---|---:|---:|---:|---:|---:|---:|---|"
  ];
  for (const group of groups) {
    lines.push(`| ${groupWikiLink(group.id, group.label)} | ${group.count} | ${group.core_count} | ${group.catalog_count} | ${group.average_quality_score ?? "n/a"} | ${group.structure_ready_count || 0} | ${group.empirical_validated_count || 0} | ${group.description} |`);
  }
  lines.push(
    "",
    "## Complete Visual Graph",
    "",
    `- [[${skillGraphPagesRelativeDir}/Index|Browse all ${total} source skills as linked graph clusters]]`,
    "",
    "## MCP Navigation",
    "",
    "1. `list_skill_groups` - посмотреть домены и размеры.",
    "2. `browse_skill_group` - найти skills внутри выбранного домена или подгруппы.",
    "3. `recommend_skills` - автоматически определить домены по задаче и выполнить group-first ranking.",
    "4. `read_skill_card` -> `read_skill` - прочитать сначала краткую карточку, затем полный skill.",
    "",
    "## Related",
    "",
    "- [[../Skill Routing|Skill Routing]]",
    "- [[../Skill Cards|Skill Cards]]",
    "- [[../Skill Registry Rules|Skill Registry Rules]]",
    ""
  );
  return lines.join("\n");
}

function featuredIntegrationRank(name) {
  const featured = [
    "github", "gitlab", "slack", "linear", "jira", "figma", "sentry", "notion", "google-drive",
    "google-sheets", "gmail", "stripe", "shopify", "salesforce", "hubspot", "discord", "telegram",
    "vercel", "cloudflare", "openai", "anthropic", "dropbox", "zendesk", "calendly", "airtable"
  ];
  const index = featured.indexOf(String(name || "").toLowerCase());
  return index === -1 ? 1000 : index;
}

function renderSkillGroupNote(group, members, graphGroup = null) {
  const qualityScores = members.map((item) => Number(item.quality_score)).filter(Number.isFinite);
  const averageQuality = qualityScores.length
    ? Number((qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length).toFixed(2))
    : null;
  const passing = members.filter((item) => item.quality_status === "pass").length;
  const warning = members.filter((item) => item.quality_status === "warn").length;
  const failing = members.filter((item) => item.quality_status === "fail").length;
  const selected = [...members]
    .sort((a, b) => {
      const priority = (a.taxonomy_priority === "core" ? 0 : 1) - (b.taxonomy_priority === "core" ? 0 : 1);
      if (priority) return priority;
      const featured = featuredIntegrationRank(a.name) - featuredIntegrationRank(b.name);
      return featured || a.name.localeCompare(b.name);
    })
    .slice(0, group.id === "integrations-automation" ? 30 : 80);
  const lines = [
    "---",
    `tags: ["skill-group", "skill-group/${group.id}"]`,
    `skill_group: ${JSON.stringify(group.id)}`,
    `skill_count: ${members.length}`,
    `average_quality_score: ${averageQuality ?? "null"}`,
    `validated_skill_count: ${members.filter((item) => ["validated", "production"].includes(item.maturity)).length}`,
    `taxonomy_schema_version: ${SKILL_TAXONOMY_SCHEMA_VERSION}`,
    "---",
    "",
    `# ${group.label}`,
    "",
    group.description,
    "",
    `Skills: **${members.length}**.`,
    `Quality: **${averageQuality ?? "n/a"}/100** average; pass ${passing}, warn ${warning}, fail ${failing}.`,
    "",
    "## Related Domains",
    "",
    ...(group.related_groups.length ? group.related_groups.map((id) => `- ${groupWikiLink(id)}`) : ["- None."])
  ];

  if (group.subgroups.length) {
    lines.push("", "## Subgroups", "");
    for (const subgroup of group.subgroups) {
      const target = `${skillGroupsRelativeDir}/${group.id}/${subgroup.id}`;
      lines.push(`- [[${target}|${subgroup.label}]] - ${subgroup.count}`);
    }
  }

  if (graphGroup?.count) {
    lines.push(
      "",
      "## Complete Visual Catalog",
      "",
      `- [[${graphGroup.index_path.replace(/\.md$/i, "")}|Browse all ${graphGroup.count} source skills in linked graph pages]]`
    );
  }

  lines.push("", "## Selected Skills", "");
  for (const item of selected) {
    lines.push(`- ${skillWikiLink(item)} - quality ${item.quality_score ?? "n/a"}/100, ${item.maturity || "unrated"} - ${shorten(item.use_when || item.description || "", 180)}`);
  }
  if (!selected.length) lines.push("- No skills assigned.");
  if (members.length > selected.length) {
    lines.push("", `Показано ${selected.length} из ${members.length}. Полный список доступен через \`browse_skill_group\`.`);
  }
  lines.push("", "## Back", "", "- [[Skills Map]]", "");
  return lines.join("\n");
}

function renderSkillSubgroupNote(group, subgroup, members) {
  const qualityScores = members.map((item) => Number(item.quality_score)).filter(Number.isFinite);
  const averageQuality = qualityScores.length
    ? Number((qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length).toFixed(2))
    : null;
  const selected = [...members]
    .sort((a, b) => featuredIntegrationRank(a.name) - featuredIntegrationRank(b.name) || a.name.localeCompare(b.name))
    .slice(0, 40);
  const lines = [
    "---",
    `tags: ["skill-group", "skill-group/${group.id}", "skill-subgroup/${subgroup.id}"]`,
    `skill_group: ${JSON.stringify(group.id)}`,
    `skill_subgroup: ${JSON.stringify(subgroup.id)}`,
    `skill_count: ${members.length}`,
    `average_quality_score: ${averageQuality ?? "null"}`,
    "---",
    "",
    `# ${subgroup.label}`,
    "",
    `Skills in ${group.label}: **${members.length}**.`,
    `Average quality: **${averageQuality ?? "n/a"}/100**.`,
    "",
    "## Selected Skills",
    ""
  ];
  for (const item of selected) lines.push(`- ${skillWikiLink(item)} - quality ${item.quality_score ?? "n/a"}/100, ${item.maturity || "unrated"} - ${shorten(item.use_when || item.description || "", 160)}`);
  if (members.length > selected.length) lines.push("", `Показано ${selected.length} из ${members.length}. Используй \`browse_skill_group\` с параметром \`subgroup\` для полного поиска.`);
  lines.push("", "## Back", "", `- ${groupWikiLink(group.id)}`, `- [[${skillsMapRelativePath.replace(/\.md$/i, "")}|Skills Map]]`, "");
  return lines.join("\n");
}

async function writeSkillTaxonomyArtifacts(items) {
  const groups = summarizeSkillTaxonomy(items);
  const graphPlan = buildSkillGraphPlan(items, groups);
  await writeJson(skillGroupsIndexRelativePath, {
    schema_version: SKILL_TAXONOMY_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    total_skills: items.length,
    groups
  });
  await writeText(skillsMapRelativePath, renderSkillsMap(groups, items.length));

  for (const group of groups) {
    const members = items.filter((item) => item.primary_group === group.id);
    const graphGroup = graphPlan.groups.find((item) => item.id === group.id);
    await writeText(skillGroupNotePath(group.id), renderSkillGroupNote(group, members, graphGroup));
  }

  for (const group of groups) {
    for (const subgroup of group.subgroups) {
      const members = items.filter((item) => item.primary_group === group.id && (item.subgroups || []).includes(subgroup.id));
      if (!members.length) continue;
      await writeText(
        `${skillGroupsRelativeDir}/${group.id}/${subgroup.id}.md`,
        renderSkillSubgroupNote(group, subgroup, members)
      );
    }
  }
  const visualGraph = await writeSkillGraphArtifacts(graphPlan, groups);
  return { schema_version: SKILL_TAXONOMY_SCHEMA_VERSION, total: items.length, groups, visual_graph: visualGraph };
}

function skillCardPath(item) {
  return `${skillCardsRelativeDir}/${slugPart(item.source, "source")}/${slugPart(item.name, "skill")}.md`;
}

function skillCardPolicy(item) {
  if (isMembraneSkill(item)) {
    return {
      role: "External application integration skill.",
      use: "Use only when the task explicitly involves this external app or API.",
      avoid: "Do not use for normal repository coding, architecture work, or generic debugging unless the app is part of the task."
    };
  }
  if (item.source === "custom") {
    return {
      role: "Primary AI development workflow skill.",
      use: "Use as a workflow guide before editing code or updating the knowledge base.",
      avoid: "Do not stack too many workflow skills at once; choose the one that matches the current intent."
    };
  }
  if (String(item.type || "").includes("image-generation")) {
    return {
      role: "Visual reference generation skill.",
      use: "Use when the deliverable needs generated visual references, brand boards, or mockups.",
      avoid: "Do not use when the user only asked for code changes and no visual reference is needed."
    };
  }
  if (String(item.type || "").includes("output-control")) {
    return {
      role: "Completion and output-control support skill.",
      use: "Use when the main risk is incomplete, truncated, or placeholder-heavy output.",
      avoid: "Do not use as a default coding workflow; pair it only with tasks where completeness is the bottleneck."
    };
  }
  if (isDesignSkill(item)) {
    return {
      role: "Frontend/design quality skill.",
      use: "Use for visually important UI, UX, landing pages, redesigns, and design-system work.",
      avoid: "Do not use for backend-only work unless the task has a visible product surface."
    };
  }
  return {
    role: "Skill from the local skill catalog.",
    use: "Use when the task matches the skill description and source.",
    avoid: "Do not use when a narrower custom workflow skill fits better."
  };
}

function renderSkillCard(item) {
  const policy = skillCardPolicy(item);
  const cardPath = skillCardPath(item);
  const generatedAt = new Date().toISOString();
  const categories = Array.isArray(item.categories) ? item.categories : [];
  const requires = Array.isArray(item.requires) ? item.requires : [];
  const tags = [
    "skill-card",
    item.primary_group ? `skill-group/${item.primary_group}` : "",
    item.maturity ? `skill-maturity/${item.maturity}` : "",
    item.quality_status ? `skill-quality/${item.quality_status}` : "",
    item.source,
    item.type,
    ...categories
  ].filter(Boolean).map((value) => String(value).replace(/\s+/g, "-"));

  return `---
card_kind: "skill-card"
name: ${yamlString(item.name)}
source: ${yamlString(item.source)}
type: ${yamlString(item.type)}
primary_group: ${yamlString(item.primary_group || "unclassified")}
subgroups: ${JSON.stringify(item.subgroups || [])}
task_types: ${JSON.stringify(item.task_types || [])}
platforms: ${JSON.stringify(item.platforms || [])}
related_skills: ${JSON.stringify(item.related_skills || [])}
frameworks: ${JSON.stringify(item.frameworks || [])}
languages: ${JSON.stringify(item.languages || [])}
conflicts: ${JSON.stringify(item.conflicts || [])}
maturity: ${yamlString(item.maturity || "draft")}
trust_level: ${yamlString(item.trust_level || "unverified")}
quality_score: ${Number(item.quality_score || 0)}
quality_grade: ${yamlString(item.quality_grade || "F")}
quality_status: ${yamlString(item.quality_status || "fail")}
skill_schema_version: ${Number(item.skill_schema_version || 0)}
skill_path: ${yamlString(`03-skills-catalog/${item.path}`)}
card_path: ${yamlString(cardPath)}
generated_at: ${yamlString(generatedAt)}
categories: ${JSON.stringify(categories)}
tags: ${JSON.stringify(tags)}
---

# ${item.name}

## Purpose

${policy.role}

${cleanDescription(item.description || item.use_when || "No description recorded.")}

## Use When

${cleanDescription(item.use_when || policy.use)}

## Do Not Use When

${policy.avoid}

## Routing

- Source: \`${item.source}\`
- Type: \`${item.type || "unknown"}\`
- Group: ${groupWikiLink(item.primary_group || "unclassified", item.primary_group_label || item.primary_group || "Unclassified")}
- Subgroups: ${(item.subgroups || []).length ? item.subgroups.map((value) => `\`${value}\``).join(", ") : "none"}
- Task types: ${(item.task_types || []).length ? item.task_types.map((value) => `\`${value}\``).join(", ") : "none"}
- Categories: ${categories.length ? categories.map((value) => `\`${value}\``).join(", ") : "none"}
- Requires: ${requires.length ? requires.map((value) => `\`${value}\``).join(", ") : "none"}
- Compatibility: ${item.compatibility || "not recorded"}

## Quality

- Maturity: \`${item.maturity || "draft"}\`
- Trust: \`${item.trust_level || "unverified"}\`
- Score: **${Number(item.quality_score || 0)}/100** (${item.quality_grade || "F"}, \`${item.quality_status || "fail"}\`)
- Profile: \`${item.quality_profile || "unknown"}\`
- Frameworks: ${(item.frameworks || []).length ? item.frameworks.map((value) => `\`${value}\``).join(", ") : "none detected"}
- Languages: ${(item.languages || []).length ? item.languages.map((value) => `\`${value}\``).join(", ") : "none detected"}
- Conflicts: ${(item.conflicts || []).length ? item.conflicts.map((value) => `\`${value}\``).join(", ") : "none recorded"}

Trust records provenance and validation status; it is not an absolute security guarantee.

## Related Skills

${(item.related_skills || []).length ? item.related_skills.map((value) => `- \`${value}\``).join("\n") : "None recorded."}

## Agent Workflow

1. Start with this card when choosing whether the skill fits the task.
2. If it fits, call \`read_skill\` for the full skill instructions.
3. Combine it with project context, AGENTS.md, project-map, and quality-gate before editing code.
4. After important work, update durable project or knowledge notes when useful.

## MCP Commands

\`\`\`json
{
  "tool": "read_skill",
  "arguments": {
    "name": "${item.name}",
    "source": "${item.source}"
  }
}
\`\`\`

## Source

- Skill file: \`03-skills-catalog/${item.path}\`
- Card file: \`${cardPath}\`
- Homepage: ${item.homepage || "not recorded"}
- Repository: ${item.repository || "not recorded"}
`;
}

function skillCardsMarkdownIndex(cards) {
  const bySource = countBy(cards, (card) => card.source);
  const byGroup = countBy(cards, (card) => card.primary_group || "unclassified");
  const output = [
    "# Skill Cards",
    "",
    "Autogenerated index of AI Dev System skill cards.",
    "",
    `Total cards: ${cards.length}`,
    "",
    "## By Source",
    "",
    "| Source | Cards |",
    "|---|---|"
  ];
  for (const [source, count] of Object.entries(bySource).sort((a, b) => a[0].localeCompare(b[0]))) {
    output.push(`| ${source} | ${count} |`);
  }
  output.push("", "## By Group", "", "| Group | Cards |", "|---|---:|");
  for (const [group, count] of Object.entries(byGroup).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    output.push(`| ${groupWikiLink(group)} | ${count} |`);
  }
  output.push(
    "",
    "## Cards",
    "",
    "| Skill | Group | Quality | Maturity | Source | Type | Use when | Card |",
    "|---|---|---:|---|---|---|---|---|"
  );
  for (const card of cards) {
    output.push(`| ${card.name} | ${card.primary_group || "unclassified"} | ${card.quality_score || 0} | ${card.maturity || "draft"} | ${card.source} | ${card.type || ""} | ${shorten(card.use_when || card.description || "", 160)} | \`${card.card_path}\` |`);
  }
  output.push("");
  return output.join("\n");
}

function skillCardPublic(item) {
  return {
    name: item.name,
    source: item.source,
    type: item.type,
    categories: item.categories,
    primary_group: item.primary_group,
    primary_group_label: item.primary_group_label,
    subgroups: item.subgroups || [],
    task_types: item.task_types || [],
    platforms: item.platforms || [],
    related_skills: item.related_skills || [],
    frameworks: item.frameworks || [],
    languages: item.languages || [],
    conflicts: item.conflicts || [],
    maturity: item.maturity,
    trust_level: item.trust_level,
    quality_score: item.quality_score,
    quality_grade: item.quality_grade,
    quality_status: item.quality_status,
    skill_schema_version: item.skill_schema_version,
    use_when: item.use_when,
    skill_path: item.skill_path,
    card_path: item.card_path,
    generated_at: item.generated_at
  };
}

async function readSkillCardsIndex({ syncIfMissing = false } = {}) {
  const target = safePath(skillCardsIndexRelativePath);
  if (!(await pathExists(target))) {
    if (!syncIfMissing) return [];
    const synced = await syncSkillCards({});
    return synced.cards;
  }
  const raw = await fs.readFile(target, "utf8");
  const parsed = JSON.parse(stripBom(raw));
  return Array.isArray(parsed) ? parsed : (parsed.cards || []);
}

async function syncSkillCards({
  sources = [],
  source = "",
  names = [],
  name = "",
  include_membrane = false,
  max_cards = 200
} = {}) {
  const items = await readSkillIndex();
  const selectedSources = new Set([...searchEvalList(sources), ...searchEvalList(source)].map((value) => value.toLowerCase()));
  const selectedNames = new Set([...searchEvalList(names), ...searchEvalList(name)].map((value) => value.toLowerCase()));
  const safeMax = Math.max(1, Math.min(Number(max_cards) || 200, include_membrane ? 5000 : 500));

  const selected = items
    .filter((item) => include_membrane || !isMembraneSkill(item))
    .filter((item) => !selectedSources.size || selectedSources.has(String(item.source || "").toLowerCase()))
    .filter((item) => !selectedNames.size || selectedNames.has(String(item.name || "").toLowerCase()))
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
    .slice(0, safeMax);

  const cards = [];
  for (const item of selected) {
    const cardPath = skillCardPath(item);
    await writeText(cardPath, renderSkillCard(item));
    cards.push({
      name: item.name,
      source: item.source,
      type: item.type,
      categories: item.categories || [],
      primary_group: item.primary_group,
      primary_group_label: item.primary_group_label,
      subgroups: item.subgroups || [],
      task_types: item.task_types || [],
      platforms: item.platforms || [],
      related_skills: item.related_skills || [],
      frameworks: item.frameworks || [],
      languages: item.languages || [],
      conflicts: item.conflicts || [],
      maturity: item.maturity || "draft",
      trust_level: item.trust_level || "unverified",
      quality_profile: item.quality_profile || "unknown",
      quality_score: Number(item.quality_score || 0),
      quality_grade: item.quality_grade || "F",
      quality_status: item.quality_status || "fail",
      quality_breakdown: item.quality_breakdown || {},
      skill_schema_version: Number(item.skill_schema_version || 0),
      description: item.description || "",
      use_when: item.use_when || item.description || "",
      requires: item.requires || [],
      skill_path: `03-skills-catalog/${item.path}`,
      card_path: cardPath,
      homepage: item.homepage || "",
      repository: item.repository || "",
      generated_at: new Date().toISOString()
    });
  }

  await writeJson(skillCardsIndexRelativePath, cards);
  await writeText(skillCardsCatalogRelativePath, skillCardsMarkdownIndex(cards));
  markSearchIndexDirty("skill cards synced");

  return {
    total: cards.length,
    include_membrane,
    by_source: countBy(cards, (card) => card.source),
    index_path: skillCardsIndexRelativePath,
    catalog_path: skillCardsCatalogRelativePath,
    cards: cards.map(skillCardPublic)
  };
}

async function listSkillCards({
  query = "", source = "", categories = "", group = "", subgroup = "",
  maturity = "", trust_level = "", quality_status = "", min_quality = 0, limit = 50
} = {}) {
  const cards = await readSkillCardsIndex({ syncIfMissing: true });
  const selectedCategories = csvValue(categories).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const selectedGroup = group ? canonicalSkillGroup(group) : "";
  const selectedSubgroup = String(subgroup || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return cards
    .filter((card) => !source || String(card.source || "").includes(source))
    .filter((card) => !selectedGroup || card.primary_group === selectedGroup)
    .filter((card) => !selectedSubgroup || (card.subgroups || []).includes(selectedSubgroup))
    .filter((card) => !maturity || card.maturity === maturity)
    .filter((card) => !trust_level || card.trust_level === trust_level)
    .filter((card) => !quality_status || card.quality_status === quality_status)
    .filter((card) => Number(card.quality_score || 0) >= Number(min_quality || 0))
    .filter((card) => !selectedCategories.length || selectedCategories.some((category) => (card.categories || []).map((item) => String(item).toLowerCase()).includes(category)))
    .map((card) => ({
      card,
      score: query ? scoreText(query, [
        card.name,
        card.source,
        card.type,
        card.primary_group,
        (card.subgroups || []).join(" "),
        (card.task_types || []).join(" "),
        (card.frameworks || []).join(" "),
        (card.languages || []).join(" "),
        card.maturity || "",
        card.trust_level || "",
        card.quality_status || "",
        (card.categories || []).join(" "),
        card.description || "",
        card.use_when || ""
      ]) : 1
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.card.source.localeCompare(b.card.source) || a.card.name.localeCompare(b.card.name))
    .slice(0, safeLimit)
    .map(({ card, score }) => ({ ...skillCardPublic(card), score }));
}

async function readSkillCard({ name, source = "" }) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required.");
  }
  const cards = await readSkillCardsIndex({ syncIfMissing: true });
  const item = findSkillItem(cards, name, source);
  if (!item) throw new Error(`Skill card not found: ${name}`);
  return readText(item.card_path);
}

async function searchSkillCards(options = {}) {
  if (!options.query || typeof options.query !== "string") {
    throw new Error("query is required.");
  }
  return listSkillCards(options);
}

function markdownTable(title, rows, columns) {
  const output = [`# ${title}`, ""];
  output.push(`| ${columns.map((column) => column.title).join(" | ")} |`);
  output.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    output.push(`| ${columns.map((column) => column.value(row)).join(" | ")} |`);
  }
  output.push("");
  return output.join("\n");
}

async function readSkillOverlayDocument({ create = true } = {}) {
  const target = safePath(skillOverlaysRelativePath);
  const existing = await readJsonIfExists(target);
  if (existing) return existing;
  const document = createSkillOverlayDocument();
  if (create) await atomicWriteJson(target, document);
  return document;
}

function applySkillOverlays(items, document) {
  return items.map((item) => {
    const overlaid = applySkillOverlay(item, document);
    const group = SKILL_GROUPS.find((candidate) => candidate.id === overlaid.primary_group);
    return group
      ? {
        ...overlaid,
        primary_group_label: group.label,
        related_groups: group.related_groups
      }
      : overlaid;
  });
}

async function rebuildIndex() {
  await fs.mkdir(registryDir, { recursive: true });

  const [outcomeStatus, overlays] = await Promise.all([
    skillOutcomeStore.status(),
    readSkillOverlayDocument()
  ]);
  const custom = applySkillOverlays((await collectCustomSkills())
    .map((item) => applySkillOutcome(item, outcomeStatus.summaries[item.name]))
    .map(classifySkill), overlays);
  const design = applySkillOverlays((await collectDesignSkills()).map(classifySkill), overlays);
  const membrane = applySkillOverlays((await collectMembraneSkills()).map(classifySkill), overlays);
  const external = applySkillOverlays((await collectExternalSkills()).map(classifySkill), overlays);
  const combined = [...custom, ...design, ...external, ...membrane];

  await writeJson("03-skills-catalog/registries/custom.skills.index.json", custom);
  await writeJson("03-skills-catalog/registries/design.skills.index.json", design);
  await writeJson("03-skills-catalog/registries/membrane.skills.index.json", membrane);
  await writeJson("03-skills-catalog/registries/external.skills.index.json", external);
  await writeJson("03-skills-catalog/registries/skills.index.json", combined);
  await writeText("03-skills-catalog/registries/skills.names.txt", `${combined.map((item) => item.name).join("\n")}\n`);
  const taxonomy = await writeSkillTaxonomyArtifacts(combined);

  const customMarkdown = markdownTable("Custom Workflow Skills", custom, [
    { title: "Skill", value: (item) => item.name },
    { title: "Use when", value: (item) => shorten(item.use_when, 220) },
    { title: "File", value: (item) => `\`${item.path}\`` }
  ]);
  await writeText("03-skills-catalog/registries/CUSTOM_WORKFLOW_SKILLS.md", customMarkdown);

  const designMarkdown = [
    "# Design Skills",
    "",
    "Autogenerated index of design-oriented skills.",
    "",
    markdownTable("Design Taste Skills", design, [
      { title: "Skill", value: (item) => item.name },
      { title: "Source", value: (item) => item.source },
      { title: "Type", value: (item) => item.type },
      { title: "Use when", value: (item) => shorten(item.use_when, 220) },
      { title: "File", value: (item) => `\`${item.path}\`` }
    ])
  ].join("\n");
  await writeText("03-skills-catalog/registries/DESIGN_TASTE_SKILLS.md", designMarkdown);

  const membraneMarkdown = [
    "# All Membrane Skills",
    "",
    "Autogenerated index of all Membrane application skills currently stored in this vault.",
    "",
    `Total skills: ${membrane.length}`,
    "",
    markdownTable("Membrane Skills", membrane, [
      { title: "Skill", value: (item) => item.name },
      { title: "Subgroup", value: (item) => (item.subgroups || []).join(", ") },
      { title: "Use when", value: (item) => shorten(item.use_when, 180) },
      { title: "File", value: (item) => `\`${item.path}\`` }
    ])
  ].join("\n");
  await writeText("03-skills-catalog/registries/ALL_MEMBRANE_SKILLS.md", membraneMarkdown);

  const externalMarkdown = markdownTable("External Imported Skills", external, [
    { title: "Skill", value: (item) => item.name },
    { title: "Source", value: (item) => item.source },
    { title: "Use when", value: (item) => shorten(item.use_when, 220) },
    { title: "File", value: (item) => `\`${item.path}\`` }
  ]);
  await writeText("03-skills-catalog/registries/EXTERNAL_SKILLS.md", externalMarkdown);
  const skillCards = await syncSkillCards({ include_membrane: false });
  markSearchIndexDirty("skill registry rebuilt");

  return {
    total: combined.length,
    custom: custom.length,
    design: design.length,
    external: external.length,
    membrane: membrane.length,
    skill_cards: skillCards.total,
    taxonomy_schema_version: taxonomy.schema_version,
    skill_groups: taxonomy.groups.map((group) => ({ id: group.id, count: group.count })),
    visual_graph: {
      linked_unique_skills: taxonomy.visual_graph.linked_unique_skills,
      batch_pages: taxonomy.visual_graph.batch_pages,
      group_hubs: taxonomy.visual_graph.group_hubs,
      bucket_hubs: taxonomy.visual_graph.bucket_hubs,
      page_size: taxonomy.visual_graph.page_size
    },
    files: {
      combined: "03-skills-catalog/registries/skills.index.json",
      names: "03-skills-catalog/registries/skills.names.txt",
      custom: "03-skills-catalog/registries/CUSTOM_WORKFLOW_SKILLS.md",
      design: "03-skills-catalog/registries/DESIGN_TASTE_SKILLS.md",
      external: "03-skills-catalog/registries/EXTERNAL_SKILLS.md",
      membrane: "03-skills-catalog/registries/ALL_MEMBRANE_SKILLS.md",
      skill_groups_index: skillGroupsIndexRelativePath,
      skill_graph_index: skillGraphIndexRelativePath,
      skills_map: skillsMapRelativePath,
      complete_skill_graph: taxonomy.visual_graph.root_note,
      skill_cards_index: skillCards.index_path,
      skill_cards_catalog: skillCards.catalog_path
    }
  };
}

async function rebuildSkillTaxonomy({ sync_cards = true } = {}) {
  const current = await readSkillIndex();
  const overlays = await readSkillOverlayDocument();
  const items = applySkillOverlays(current.map(classifySkill), overlays);
  const bySource = {
    custom: items.filter((item) => item.source === "custom"),
    design: items.filter((item) => String(item.source || "").startsWith("design/")),
    membrane: items.filter(isMembraneSkill),
    external: items.filter((item) => String(item.source || "").startsWith("external/"))
  };

  await writeJson("03-skills-catalog/registries/skills.index.json", items);
  await writeJson("03-skills-catalog/registries/custom.skills.index.json", bySource.custom);
  await writeJson("03-skills-catalog/registries/design.skills.index.json", bySource.design);
  await writeJson("03-skills-catalog/registries/membrane.skills.index.json", bySource.membrane);
  await writeJson("03-skills-catalog/registries/external.skills.index.json", bySource.external);
  const taxonomy = await writeSkillTaxonomyArtifacts(items);
  const cards = sync_cards ? await syncSkillCards({ include_membrane: false }) : null;
  markSearchIndexDirty("skill taxonomy rebuilt");
  return {
    action: "rebuilt",
    total: items.length,
    schema_version: taxonomy.schema_version,
    groups: taxonomy.groups.map((group) => ({
      id: group.id,
      label: group.label,
      count: group.count,
      subgroups: group.subgroups
    })),
    skills_map: skillsMapRelativePath,
    groups_index: skillGroupsIndexRelativePath,
    visual_graph: {
      index_path: skillGraphIndexRelativePath,
      root_note: taxonomy.visual_graph.root_note,
      linked_unique_skills: taxonomy.visual_graph.linked_unique_skills,
      batch_pages: taxonomy.visual_graph.batch_pages,
      group_hubs: taxonomy.visual_graph.group_hubs,
      bucket_hubs: taxonomy.visual_graph.bucket_hubs,
      page_size: taxonomy.visual_graph.page_size
    },
    skill_cards: cards?.total
  };
}

async function readSkillMarkdownForItem(item) {
  const target = path.resolve(skillCatalogRoot, String(item.path || ""));
  const sourceRoot = path.resolve(sourcesRoot);
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

async function refineDuplicatePairsWithBge(pairs, records) {
  if (!pairs.length) return { evaluated: 0, pairs: [] };
  const byPath = new Map(records.map((record) => [record.item.path, record]));
  const selectedPairs = [];
  const selectedPaths = new Set();
  for (const pair of pairs) {
    const additions = [pair.left.path, pair.right.path].filter((value) => !selectedPaths.has(value));
    if (selectedPaths.size + additions.length > 32) continue;
    selectedPairs.push(pair);
    for (const value of additions) selectedPaths.add(value);
  }
  const paths = [...selectedPaths];
  if (!paths.length) return { evaluated: 0, pairs: [] };
  const embedded = await embedTexts({
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

function renderSkillQualityDashboard(report) {
  const summary = report.summary;
  const importantRows = report.important_skills.map((item) =>
    `| ${item.name} | ${item.primary_group} | ${item.maturity} | ${item.validation_status} | ${item.empirical_status} | ${item.trust_level} | ${item.structure_score} | ${item.structure_status} |`
  );
  const issueRows = report.issues.slice(0, 40).map((issue) =>
    `| ${issue.severity} | ${issue.skill} | ${issue.code} | ${String(issue.message || "").replaceAll("|", "/")} |`
  );
  const domainRows = Object.entries(report.by_group)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([group, data]) => `| ${groupWikiLink(group)} | ${data.count} | ${data.average_score} | ${data.pass} | ${data.warn} | ${data.fail} |`);
  const findingRows = Object.entries(summary.finding_counts || {})
    .slice(0, 20)
    .map(([code, count]) => `| ${code} | ${count} |`);
  return `---
tags: ["skill-quality", "skill-dashboard"]
skill_schema_version: ${report.schema_version}
generated_at: ${JSON.stringify(report.generated_at)}
---

# Skill Quality Dashboard

Machine-generated quality view for the complete skill library. Trust describes provenance, not an absolute security guarantee.

## Summary

| Metric | Value |
|---|---:|
| Skills | ${summary.total} |
| Schema v2 | ${summary.schema_current} |
| Average score | ${summary.average_score} |
| Pass | ${summary.by_status.pass || 0} |
| Warn | ${summary.by_status.warn || 0} |
| Fail | ${summary.by_status.fail || 0} |
| Important structurally ready | ${summary.important_structure_ready}/${summary.important_skills} |
| Important empirically validated | ${summary.important_empirical_ready}/${summary.important_skills} |
| Provisional validation | ${summary.by_validation_status.provisional || 0} |
| Issues | ${report.issues_total} |
| Exact duplicate groups | ${report.duplicates.exact.length} |
| Near duplicate candidates | ${report.duplicates.near_total} |
| Overlay source policies | ${report.overlays?.source_policies || 0} |
| Specific skill overlays | ${report.overlays?.specific_overlays || 0} |
| Orphan overlays | ${report.overlays?.orphan_overlays?.length || 0} |

## Finding Counts

| Finding | Skills |
|---|---:|
${findingRows.length ? findingRows.join("\n") : "| none | 0 |"}

## Domains

| Domain | Skills | Average | Pass | Warn | Fail |
|---|---:|---:|---:|---:|---:|
${domainRows.join("\n")}

## Important Skills

| Skill | Group | Maturity | Validation | Empirical | Trust | Structure | Status |
|---|---|---|---|---|---|---:|---|
${importantRows.join("\n")}

## Top Issues

| Severity | Skill | Code | Message |
|---|---|---|---|
${issueRows.length ? issueRows.join("\n") : "| info | - | none | No issues for the selected validation scope. |"}

## Duplicate Policy

${report.duplicates.membrane_policy}

## Files

- Machine report: \`${skillQualityIndexRelativePath}\`
- Normalization overlays: \`${skillOverlaysRelativePath}\`
- Skill taxonomy: [[Skill Taxonomy]]
- Complete graph: [[groups/all-skills/Index|Complete Skill Graph]]
`;
}

async function validateSkillLibrary({
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
  if (refresh_registry) await rebuildIndex();
  const current = await readSkillIndex();
  const overlays = await readSkillOverlayDocument();
  const selectedGroup = group ? canonicalSkillGroup(group) : "";
  const records = [];
  const readErrors = [];
  for (const original of current) {
    if (source && !String(original.source || "").includes(String(source))) continue;
    if (selectedGroup && original.primary_group !== selectedGroup) continue;
    try {
      const markdown = await readSkillMarkdownForItem(original);
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
  const names = new Set(current.map((item) => String(item.name || "").toLowerCase()));
  const relationshipIssues = [];
  for (const item of items) {
    for (const related of item.related_skills || []) {
      if (!names.has(String(related).toLowerCase())) {
        relationshipIssues.push({
          severity: "warn",
          skill: item.name,
          source: item.source,
          path: item.path,
          code: "missing-related-skill",
          message: `Related skill does not exist in the registry: ${related}`
        });
      }
    }
    for (const conflict of item.conflicts || []) {
      if (!String(conflict).startsWith("policy:") && !names.has(String(conflict).toLowerCase())) {
        relationshipIssues.push({
          severity: "error",
          skill: item.name,
          source: item.source,
          path: item.path,
          code: "missing-conflict-target",
          message: `Conflict target does not exist in the registry: ${conflict}`
        });
      }
    }
  }
  const qualityIssues = items.flatMap((item) => (item.quality_findings || []).map((finding) => ({
    ...finding,
    skill: item.name,
    source: item.source,
    path: item.path,
    score: item.quality_score
  })));
  const overlayErrors = validateSkillOverlayDocument(overlays, {
    knownGroups: SKILL_GROUPS.map((item) => item.id),
    knownSkills: current.map((item) => skillOverlayKey(item.source, item.name))
  }).map((message) => ({
    severity: "error",
    skill: "skill-overlays",
    source: "local-overlay",
    path: skillOverlaysRelativePath,
    code: "invalid-skill-overlay",
    message
  }));
  const allIssues = [...readErrors, ...overlayErrors, ...relationshipIssues, ...qualityIssues]
    .sort((a, b) => {
      const priority = { error: 0, warn: 1, info: 2 };
      return (priority[a.severity] ?? 3) - (priority[b.severity] ?? 3)
        || Number(a.score || 0) - Number(b.score || 0)
        || String(a.skill || "").localeCompare(String(b.skill || ""));
    });
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
      const semantic = await refineDuplicatePairsWithBge(duplicates.near, records);
      duplicates.semantic_evaluated = semantic.evaluated;
      duplicates.near = semantic.pairs;
    } else {
      duplicates.semantic_evaluated = 0;
    }
  }
  const summary = summarizeSkillQuality(items);
  const byGroup = {};
  for (const taxonomyGroup of SKILL_GROUPS) {
    const members = items.filter((item) => item.primary_group === taxonomyGroup.id);
    if (!members.length) continue;
    byGroup[taxonomyGroup.id] = {
      count: members.length,
      average_score: Number((members.reduce((total, item) => total + item.quality_score, 0) / members.length).toFixed(2)),
      pass: members.filter((item) => item.quality_status === "pass").length,
      warn: members.filter((item) => item.quality_status === "warn").length,
      fail: members.filter((item) => item.quality_status === "fail").length
    };
  }
  const report = {
    action: "validated",
    generated_at: new Date().toISOString(),
    schema_version: SKILL_SCHEMA_VERSION,
    filters: { source, group: selectedGroup, min_score: Number(min_score || 0) },
    summary,
    source_read_errors: readErrors.length,
    overlays: summarizeSkillOverlays(overlays, current),
    by_group: byGroup,
    important_skills: items.filter((item) => item.source === "custom").map((item) => ({
      name: item.name,
      primary_group: item.primary_group,
      maturity: item.maturity,
      trust_level: item.trust_level,
      structure_score: item.structure_score,
      structure_status: item.structure_status,
      empirical_status: item.empirical_status,
      validation_status: item.validation_status,
      quality_basis: item.quality_basis,
      quality_score: item.quality_score,
      quality_grade: item.quality_grade,
      quality_status: item.quality_status,
      frameworks: item.frameworks || [],
      conflicts: item.conflicts || [],
      path: item.path
    })),
    issues_total: allIssues.length,
    issue_counts: countBy(allIssues, (issue) => issue.severity || "unknown"),
    issues: allIssues.slice(0, Math.max(1, Math.min(Number(max_issues) || 200, 1000))),
    duplicates,
    skills: items.map((item) => ({
      name: item.name,
      source: item.source,
      path: item.path,
      primary_group: item.primary_group,
      maturity: item.maturity,
      trust_level: item.trust_level,
      quality_profile: item.quality_profile,
      structure_score: item.structure_score,
      structure_grade: item.structure_grade,
      structure_status: item.structure_status,
      quality_score: item.quality_score,
      quality_grade: item.quality_grade,
      quality_status: item.quality_status,
      quality_basis: item.quality_basis,
      empirical_score: item.empirical_score,
      empirical_status: item.empirical_status,
      validation_status: item.validation_status,
      validation_evidence: item.validation_evidence,
      quality_breakdown: item.quality_breakdown,
      quality_findings: item.quality_findings,
      frameworks: item.frameworks || [],
      languages: item.languages || [],
      conflicts: item.conflicts || [],
      requires: item.requires || [],
      content_hash: item.content_hash,
      skill_schema_version: item.skill_schema_version
    })),
    recommendations: []
  };
  if (summary.schema_current !== summary.total) report.recommendations.push("Run rebuild_index to persist Schema v2 metadata for every skill.");
  if (summary.important_failures.length) report.recommendations.push(`Fix failing important skills: ${summary.important_failures.join(", ")}.`);
  if (summary.important_empirical_ready < summary.important_skills) {
    report.recommendations.push("Structural quality is not proof of real task success. Run routing benchmarks and collect task verification outcomes before promoting custom skills to validated.");
  }
  if ((report.issue_counts.error || 0) > 0) report.recommendations.push(`Review ${report.issue_counts.error} schema or relationship error(s) listed in the quality report.`);
  if ((summary.finding_counts?.["generic-integration-description"] || 0) > 0) {
    report.recommendations.push(`${summary.finding_counts["generic-integration-description"]} integration skill(s) use generic routing descriptions; prefer specific catalog entries when scores are otherwise close.`);
  }
  if (duplicates.exact.length) report.recommendations.push("Review exact duplicate groups and keep one authoritative source when appropriate.");
  if (duplicates.near_total) report.recommendations.push("Review near-duplicate candidates before deleting or merging any skill.");
  if (!report.recommendations.length) report.recommendations.push("Skill library quality checks passed for the selected scope.");
  if (write_report) {
    await writeJson(skillQualityIndexRelativePath, report);
    await writeText(skillQualityDashboardRelativePath, renderSkillQualityDashboard(report));
    markSearchIndexDirty("skill quality report updated");
  }
  return {
    action: report.action,
    generated_at: report.generated_at,
    schema_version: report.schema_version,
    filters: report.filters,
    summary: report.summary,
    source_read_errors: report.source_read_errors,
    by_group: report.by_group,
    important_skills: report.important_skills,
    issues_total: report.issues_total,
    issue_counts: report.issue_counts,
    issues: report.issues.slice(0, 20),
    duplicates: report.duplicates,
    recommendations: report.recommendations,
    report_path: write_report ? skillQualityIndexRelativePath : null,
    dashboard_path: write_report ? skillQualityDashboardRelativePath : null
  };
}

async function syncSkillOverlays({ rebuild_registry = false } = {}) {
  const defaults = createSkillOverlayDocument();
  const existing = await readSkillOverlayDocument({ create: false });
  const document = {
    ...defaults,
    ...(existing || {}),
    schema_version: defaults.schema_version,
    generated_at: new Date().toISOString(),
    source_policies: {
      ...defaults.source_policies,
      ...(existing?.source_policies || {})
    },
    skills: existing?.skills || {}
  };
  const current = await readSkillIndex();
  const errors = validateSkillOverlayDocument(document, {
    knownGroups: SKILL_GROUPS.map((item) => item.id),
    knownSkills: current.map((item) => skillOverlayKey(item.source, item.name))
  });
  if (errors.length) {
    return {
      action: "rejected",
      path: skillOverlaysRelativePath,
      errors
    };
  }
  await writeJson(skillOverlaysRelativePath, document);
  const rebuild = rebuild_registry ? await rebuildIndex() : null;
  return {
    action: "skill_overlays_synced",
    path: skillOverlaysRelativePath,
    summary: summarizeSkillOverlays(document, current),
    registry_rebuilt: Boolean(rebuild),
    rebuild
  };
}

async function listSkillOverlays({ source = "", name = "" } = {}) {
  const [document, current] = await Promise.all([
    readSkillOverlayDocument(),
    readSkillIndex()
  ]);
  const sourceFilter = String(source || "").toLowerCase();
  const nameFilter = String(name || "").toLowerCase();
  const skills = Object.entries(document.skills || {})
    .filter(([key]) => !sourceFilter || key.split(":")[0].includes(sourceFilter))
    .filter(([key]) => !nameFilter || key.split(":").slice(1).join(":").includes(nameFilter))
    .map(([key, overlay]) => ({ key, ...overlay }));
  return {
    path: skillOverlaysRelativePath,
    summary: summarizeSkillOverlays(document, current),
    source_policies: document.source_policies,
    skills
  };
}

async function upsertSkillOverlayRecord({
  source,
  name,
  overlay,
  reviewer = "",
  rebuild_registry = true
}) {
  const current = await readSkillIndex();
  const target = current.find((item) => (
    String(item.source || "").toLowerCase() === String(source || "").toLowerCase()
    && String(item.name || "").toLowerCase() === String(name || "").toLowerCase()
  ));
  if (!target) throw new Error(`Skill overlay target not found: ${source}:${name}.`);
  const document = upsertSkillOverlay(await readSkillOverlayDocument(), {
    source: target.source,
    name: target.name,
    overlay,
    reviewer
  });
  const errors = validateSkillOverlayDocument(document, {
    knownGroups: SKILL_GROUPS.map((item) => item.id),
    knownSkills: current.map((item) => skillOverlayKey(item.source, item.name))
  });
  if (errors.length) return { action: "rejected", errors };
  await writeJson(skillOverlaysRelativePath, document);
  const rebuild = rebuild_registry ? await rebuildIndex() : null;
  return {
    action: "skill_overlay_upserted",
    key: skillOverlayKey(target.source, target.name),
    overlay: document.skills[skillOverlayKey(target.source, target.name)],
    registry_rebuilt: Boolean(rebuild),
    rebuild
  };
}

function dashboardSkillSource(source) {
  const value = String(source || "");
  if (value === "custom") return "custom";
  if (value.startsWith("membrane/")) return "membrane";
  if (value.startsWith("design/")) return "design";
  if (value.startsWith("external/")) return "external";
  return value || "unknown";
}

async function buildSystemDashboardSnapshot() {
  const [
    skills,
    cards,
    qualityReport,
    projects,
    search,
    outcomes,
    pilots,
    overlays,
    searchCases,
    runtimeSource
  ] = await Promise.all([
    readSkillIndex(),
    readJsonIfExists(safePath(skillCardsIndexRelativePath)),
    readJsonIfExists(safePath(skillQualityIndexRelativePath)),
    projectSummaries({ dedupe: true }),
    searchIndexStatus({ include_external_project_files: true }),
    skillOutcomeStore.status(),
    pilotStore.status(),
    readSkillOverlayDocument(),
    readSearchEvalCases(),
    fs.readFile(path.join(serverDir, "mcp-stdio.mjs"), "utf8")
  ]);
  const bySource = countBy(skills, (item) => dashboardSkillSource(item.source));
  const overlaySummary = summarizeSkillOverlays(overlays, skills);
  const runtimeLines = runtimeSource.split(/\r?\n/).length;
  const snapshot = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    tools: { total: tools.length },
    skills: {
      total: skills.length,
      custom: bySource.custom || 0,
      groups: new Set(skills.map((item) => item.primary_group).filter(Boolean)).size,
      cards: Array.isArray(cards) ? cards.length : Number(cards?.total || cards?.items?.length || 0),
      by_source: bySource
    },
    quality: {
      important_structure_ready: Number(qualityReport?.summary?.important_structure_ready || 0),
      important_empirical_ready: Number(qualityReport?.summary?.important_empirical_ready || 0),
      important_skills: Number(qualityReport?.summary?.important_skills || bySource.custom || 0),
      issues: Number(qualityReport?.issues_total || 0),
      generated_at: qualityReport?.generated_at || ""
    },
    projects: {
      total: projects.length,
      items: projects.map((project) => ({
        id: project.project_id || project.id || "",
        name: project.name,
        stack: project.stack || [],
        updated_at: project.updated_at || project.last_synced || ""
      }))
    },
    search: {
      documents: Number(search.indexed_document_count || 0),
      dense_vectors: Number(search.dense_documents || 0),
      pending_dense: Number(search.dense_pending_documents || 0),
      stale: Boolean(search.stale || search.dirty_reason),
      eval_cases: searchCases.cases.length,
      ranking_version: 2,
      source_fingerprint: search.source_fingerprint || ""
    },
    outcomes: {
      terminal: Number(outcomes.terminal_outcomes || outcomes.events || 0),
      attempts: Number(outcomes.verification_attempts || 0)
    },
    pilots: {
      completed: Number(pilots.summary.total || 0) - Number(pilots.summary.active || 0),
      human_confirmed: Number(pilots.summary.human_confirmed || 0)
    },
    overlays: {
      source_policies: overlaySummary.source_policies,
      specific_overlays: overlaySummary.specific_overlays,
      orphan_overlays: overlaySummary.orphan_overlays.length
    },
    runtime: {
      server_ready: true,
      modular: runtimeLines <= 10_500,
      main_lines: runtimeLines,
      line_ceiling: 10_500,
      coverage_thresholds: "85% lines / 60% branches / 85% functions"
    }
  };
  snapshot.source_fingerprint = dashboardSourceFingerprint(snapshot);
  return snapshot;
}

async function rebuildSystemDashboard({ rebuild_search = false } = {}) {
  const snapshot = await buildSystemDashboardSnapshot();
  await Promise.all([
    writeJson(systemDashboardStateRelativePath, snapshot),
    writeText(systemDashboardRelativePath, renderSystemDashboard(snapshot))
  ]);
  markSearchIndexDirty("generated system dashboard updated");
  const searchRebuild = rebuild_search
    ? await rebuildSearchIndex({
      include_external_project_files: true,
      dense_embeddings: false,
      preserve_dense: true
    })
    : null;
  return {
    action: "system_dashboard_rebuilt",
    dashboard_path: systemDashboardRelativePath,
    state_path: systemDashboardStateRelativePath,
    source_fingerprint: snapshot.source_fingerprint,
    snapshot,
    search_rebuilt: Boolean(searchRebuild),
    search: searchRebuild
  };
}

async function systemDashboardStatus() {
  const [saved, current] = await Promise.all([
    readJsonIfExists(safePath(systemDashboardStateRelativePath)),
    buildSystemDashboardSnapshot()
  ]);
  return {
    dashboard_path: systemDashboardRelativePath,
    state_path: systemDashboardStateRelativePath,
    generated: Boolean(saved),
    generated_at: saved?.generated_at || "",
    freshness: dashboardFreshness(saved, current),
    current,
    next_step: saved && dashboardFreshness(saved, current).fresh
      ? "Dashboard is current."
      : "Run rebuild_system_dashboard."
  };
}

async function buildRuntimeDistributionManifest() {
  const serverRoot = path.resolve(serverDir, "..");
  const localConfigPath = path.join(serverRoot, "config", "runtime.local.json");
  const exampleConfigPath = path.join(serverRoot, "config", "runtime.example.json");
  const localProfile = await readJsonIfExists(localConfigPath);
  const profile = localProfile || createLocalRuntimeProfile({
    vaultRoot,
    nodeExecutable: process.execPath
  });
  const validation = validateRuntimeProfile(profile);
  const files = {
    entrypoint: path.join(serverRoot, "src", "server.mjs"),
    local_launcher: path.join(serverRoot, "scripts", "start-local.ps1"),
    cli: path.join(serverRoot, "scripts", "ai-dev.mjs"),
    config_example: exampleConfigPath,
    acceptance: path.join(vaultRoot, "09-mcp", "scripts", "run-acceptance.ps1"),
    backup: path.join(vaultRoot, "09-mcp", "scripts", "backup-ai-dev-system.ps1"),
    restore: path.join(vaultRoot, "09-mcp", "scripts", "restore-ai-dev-system.ps1")
  };
  const fileStatus = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, target]) => [
    key,
    {
      path: target,
      exists: await pathExists(target)
    }
  ])));
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    profile,
    profile_source: localProfile ? "config/runtime.local.json" : "generated local-first defaults",
    profile_validation: validation,
    entrypoint: "src/server.mjs",
    tools: tools.length,
    commands: {
      start: "powershell -File scripts/start-local.ps1",
      doctor: "node scripts/ai-dev.mjs doctor",
      acceptance: "node scripts/ai-dev.mjs acceptance",
      backup: "node scripts/ai-dev.mjs backup <label>"
    },
    files: fileStatus,
    recovery: {
      backup_script: "09-mcp/scripts/backup-ai-dev-system.ps1",
      restore_script: "09-mcp/scripts/restore-ai-dev-system.ps1"
    },
    remote_transport_implemented: false,
    remote_policy: "blocked until official HTTP transport, TLS, environment-bound bearer auth, allowlist, rate limit, audit log, and threat review are implemented"
  };
  manifest.fingerprint = runtimeDistributionFingerprint(manifest);
  return manifest;
}

async function prepareRuntimeDistribution() {
  const manifest = await buildRuntimeDistributionManifest();
  const missing = Object.entries(manifest.files)
    .filter(([, value]) => !value.exists)
    .map(([key, value]) => `${key}: ${value.path}`);
  if (!manifest.profile_validation.ok || missing.length) {
    return {
      action: "rejected",
      profile_errors: manifest.profile_validation.errors,
      profile_warnings: manifest.profile_validation.warnings,
      missing_files: missing
    };
  }
  await Promise.all([
    writeJson(runtimeDistributionStateRelativePath, manifest),
    writeText(runtimeDistributionRelativePath, renderRuntimeDistribution(manifest))
  ]);
  markSearchIndexDirty("runtime distribution documentation updated");
  return {
    action: "runtime_distribution_prepared",
    path: runtimeDistributionRelativePath,
    state_path: runtimeDistributionStateRelativePath,
    fingerprint: manifest.fingerprint,
    mode: manifest.profile.mode,
    transport: manifest.profile.transport,
    remote_transport_implemented: false,
    next_step: "Keep stdio local. Run the documented threat review before implementing or enabling remote HTTP transport."
  };
}

async function runtimeDistributionStatus() {
  const [saved, current] = await Promise.all([
    readJsonIfExists(safePath(runtimeDistributionStateRelativePath)),
    buildRuntimeDistributionManifest()
  ]);
  const missing = Object.entries(current.files)
    .filter(([, value]) => !value.exists)
    .map(([key, value]) => ({ key, path: value.path }));
  const fresh = Boolean(saved?.fingerprint && saved.fingerprint === current.fingerprint);
  return {
    prepared: Boolean(saved),
    ready_local: current.profile_validation.ok && missing.length === 0,
    mode: current.profile.mode,
    transport: current.profile.transport,
    profile_source: current.profile_source,
    profile_validation: current.profile_validation,
    missing_files: missing,
    remote_transport_implemented: false,
    remote_enabled: current.profile.transport.remote_enabled === true,
    freshness: {
      fresh,
      saved_fingerprint: saved?.fingerprint || "",
      current_fingerprint: current.fingerprint
    },
    commands: current.commands,
    recovery: current.recovery,
    next_step: !saved
      ? "Run prepare_runtime_distribution."
      : fresh
        ? "Local distribution is current."
        : "Run prepare_runtime_distribution after runtime changes."
  };
}

async function runSkillRoutingEval({
  cases_path = "",
  case_ids = [],
  write_report = true
} = {}) {
  const target = cases_path ? safePath(cases_path) : safePath(skillRoutingEvalRelativePath);
  const source = await readSkillRoutingCases(target);
  const selectedIds = new Set(searchEvalList(case_ids));
  const cases = selectedIds.size
    ? source.cases.filter((testCase) => selectedIds.has(String(testCase.id || "")))
    : source.cases;
  if (!cases.length) {
    throw new Error("No skill routing benchmark cases matched the requested filters.");
  }
  const evaluation = evaluateSkillRoutingSuite(cases);
  const report = {
    ...evaluation,
    schema_version: source.schema_version,
    description: source.description,
    cases_path: toVaultRelative(source.path),
    filters: { case_ids: [...selectedIds] },
    limitations: [
      "This benchmark validates deterministic intent routing only.",
      "It does not prove implementation quality or production task success."
    ],
    recommendations: evaluation.status === "pass"
      ? ["Routing contract passed. Continue collecting verification-bound task outcomes for empirical skill validation."]
      : ["Fix failed routing cases before changing skill maturity or using the router as an autonomous selector."]
  };
  if (write_report) {
    await writeJson(skillRoutingReportRelativePath, report);
    markSearchIndexDirty("skill routing benchmark updated");
  }
  return {
    ...report,
    report_path: write_report ? skillRoutingReportRelativePath : null
  };
}

async function readSkillGroupsIndex({ rebuildIfMissing = false } = {}) {
  const target = safePath(skillGroupsIndexRelativePath);
  if (!(await pathExists(target))) {
    if (!rebuildIfMissing) return null;
    await rebuildSkillTaxonomy({ sync_cards: false });
  }
  return JSON.parse(stripBom(await fs.readFile(target, "utf8")));
}

async function listSkillGroups({ query = "", include_empty = false } = {}) {
  const registry = await readSkillGroupsIndex({ rebuildIfMissing: true });
  const normalizedQuery = String(query || "").trim();
  return {
    schema_version: registry.schema_version,
    total_skills: registry.total_skills,
    skills_map: skillsMapRelativePath,
    groups: registry.groups
      .filter((group) => include_empty || group.count > 0)
      .map((group) => ({
        ...group,
        score: normalizedQuery ? scoreText(normalizedQuery, [group.id, group.label, group.description, ...group.subgroups.flatMap((item) => [item.id, item.label])]) : 1,
        note_path: skillGroupNotePath(group.id)
      }))
      .filter((group) => !normalizedQuery || group.score > 0)
      .sort((a, b) => b.score - a.score || b.count - a.count || a.id.localeCompare(b.id))
  };
}

async function browseSkillGroup({
  group, subgroup = "", query = "", source = "", maturity = "", trust_level = "",
  quality_status = "", min_quality = 0, limit = 30
} = {}) {
  const groupId = canonicalSkillGroup(group);
  if (!groupId) throw new Error(`Unknown skill group: ${group}. Use list_skill_groups for valid ids.`);
  const subgroupId = String(subgroup || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const allItems = (await readSkillIndex()).map((item) => item.primary_group ? item : classifySkill(item));
  const members = allItems
    .filter((item) => item.primary_group === groupId)
    .filter((item) => !subgroupId || (item.subgroups || []).includes(subgroupId))
    .filter((item) => !source || String(item.source || "").toLowerCase().includes(String(source).toLowerCase()))
    .filter((item) => !maturity || item.maturity === maturity)
    .filter((item) => !trust_level || item.trust_level === trust_level)
    .filter((item) => !quality_status || item.quality_status === quality_status)
    .filter((item) => Number(item.quality_score || 0) >= Number(min_quality || 0));
  const ranked = members
    .map((item) => {
      const matchScore = query ? scoreText(query, [
        item.name,
        item.description || "",
        item.use_when || "",
        item.primary_group,
        item.primary_group_label,
        ...(item.subgroups || []),
        ...(item.task_types || []),
        ...(item.platforms || []),
        ...(item.frameworks || []),
        ...(item.languages || [])
      ]) : (item.taxonomy_priority === "core" ? 10 : 1);
      return { item, match_score: matchScore, score: matchScore + Number(item.quality_score || 0) / 25 };
    })
    .filter((entry) => !query || entry.match_score > 0)
    .sort((a, b) => b.score - a.score || featuredIntegrationRank(a.item.name) - featuredIntegrationRank(b.item.name) || a.item.name.localeCompare(b.item.name))
    .slice(0, safeLimit)
    .map(({ item, score }) => ({
      name: item.name,
      source: item.source,
      type: item.type,
      primary_group: item.primary_group,
      subgroups: item.subgroups || [],
      task_types: item.task_types || [],
      platforms: item.platforms || [],
      related_skills: item.related_skills || [],
      frameworks: item.frameworks || [],
      languages: item.languages || [],
      maturity: item.maturity,
      trust_level: item.trust_level,
      quality_score: item.quality_score,
      quality_grade: item.quality_grade,
      quality_status: item.quality_status,
      use_when: item.use_when || item.description || "",
      path: item.path,
      card_path: isMembraneSkill(item) ? undefined : skillCardPath(item),
      score
    }));
  const definition = SKILL_GROUPS.find((item) => item.id === groupId);
  return {
    group: { ...definition, note_path: skillGroupNotePath(groupId) },
    subgroup: subgroupId || undefined,
    total_matches: members.length,
    returned: ranked.length,
    query: query || "",
    results: ranked
  };
}

function execFile(command, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `Command failed with exit code ${code}`));
      }
    });
  });
}

function execFileWithInput(command, args, input, { cwd, timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = stderr || stdout || `Command failed with exit code ${code}`;
        reject(new Error(message));
      }
    });
    child.stdin.end(input);
  });
}

function truncateOutput(value, max = 6000) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function pythonCommand() {
  if (process.env.AI_DEV_PYTHON) return process.env.AI_DEV_PYTHON;
  const dependenciesRoot = path.resolve(path.dirname(process.execPath), "..", "..");
  const bundled = process.platform === "win32"
    ? path.join(dependenciesRoot, "python", "python.exe")
    : path.join(dependenciesRoot, "python", "bin", "python");
  return existsSync(bundled) ? bundled : "python";
}

function embeddingPythonCommand() {
  if (process.env.BGE_M3_PYTHON) return process.env.BGE_M3_PYTHON;
  if (process.env.AI_DEV_EMBEDDINGS_PYTHON) return process.env.AI_DEV_EMBEDDINGS_PYTHON;
  return process.platform === "win32"
    ? path.join(embeddingsDir, ".venv", "Scripts", "python.exe")
    : path.join(embeddingsDir, ".venv", "bin", "python");
}

async function runSearchCli(args, { timeoutMs = 600000, command = pythonCommand() } = {}) {
  if (!(await pathExists(searchCliPath))) {
    throw new Error(`Search helper not found: ${searchCliPath}`);
  }

  const output = await execFile(command, [searchCliPath, ...args], { timeoutMs });
  try {
    return JSON.parse(stripBom(output.stdout));
  } catch (err) {
    throw new Error(`Search helper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${output.stdout}`);
  }
}

async function runUiUxProMax(args, { json = false } = {}) {
  if (!(await pathExists(uiUxProMaxSearchPath))) {
    throw new Error(`UI UX Pro Max helper not found: ${uiUxProMaxSearchPath}`);
  }
  const scriptPath = resolveWithinSync(uiUxProMaxRoot, "scripts/search.py", {
    mode: "read",
    allowAbsolute: false,
    allowRoot: false
  });
  const output = await execFile(
    pythonCommand(),
    [scriptPath, ...args],
    { cwd: uiUxProMaxRoot, timeoutMs: 120000 }
  );
  if (!json) return output.stdout.trim();
  try {
    return JSON.parse(stripBom(output.stdout));
  } catch (err) {
    throw new Error(
      `UI UX Pro Max returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n`
      + truncateOutput(output.stdout, 2000)
    );
  }
}

async function uiUxProMaxSource() {
  if (!(await pathExists(uiUxProMaxProvenancePath))) {
    throw new Error(`UI UX Pro Max provenance not found: ${uiUxProMaxProvenancePath}`);
  }
  const provenance = await readExternalProvenance(uiUxProMaxRoot);
  const source = {
    skill: "ui-ux-pro-max",
    path: toVaultRelative(uiUxProMaxRoot),
    repository: cleanDescription(provenance.repository),
    commit: cleanDescription(provenance.commit),
    version: cleanDescription(provenance.version),
    license: cleanDescription(provenance.license)
  };
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(source.repository)) {
    throw new Error("UI UX Pro Max provenance has an invalid repository URL.");
  }
  if (!/^[a-f0-9]{40}$/i.test(source.commit)) {
    throw new Error("UI UX Pro Max provenance must pin a full Git commit.");
  }
  if (!source.version || !source.license) {
    throw new Error("UI UX Pro Max provenance must include version and license.");
  }
  return source;
}

async function queryUiUxKnowledge(input = {}) {
  const command = buildUiUxKnowledgeArgs(input);
  const result = await runUiUxProMax(command.args, { json: true });
  return {
    action: "queried",
    source: await uiUxProMaxSource(),
    request: command.normalized,
    result,
    guardrail: "Use these records as design evidence; repository conventions and observed UI remain authoritative."
  };
}

async function generateUiUxDesignSystem({
  query,
  project_name = "",
  variance,
  motion,
  density,
  project_path = "",
  persist = false,
  overwrite = false
} = {}) {
  let projectRoot = null;
  let target = null;
  let existed = false;
  const request = { query, project_name, variance, motion, density };

  if (persist) {
    projectRoot = await safeProjectRoot(project_path);
    if (!request.project_name) request.project_name = path.basename(projectRoot);
    target = safeProjectFile(projectRoot, ".ai-dev/frontend/design-system.md");
    existed = await pathExists(target);
    if (existed && !overwrite) {
      throw new Error(
        "Design system already exists. Set overwrite=true to replace "
        + ".ai-dev/frontend/design-system.md."
      );
    }
  }

  const jsonCommand = buildUiUxDesignJsonArgs(request);
  const markdownCommand = buildUiUxDesignMarkdownArgs(request);
  const [result, markdown] = await Promise.all([
    runUiUxProMax(jsonCommand.args, { json: true }),
    runUiUxProMax(markdownCommand.args)
  ]);
  const source = await uiUxProMaxSource();
  let persistence = null;

  if (persist) {
    const document = [
      "# UI UX Design System Draft",
      "",
      "> Generated from a curated local dataset. This is a recommendation, not visual approval.",
      "> Reconcile it with the product, approved brand, repository conventions, and observed UI.",
      "",
      "## Provenance",
      "",
      `- Source: ${source.repository}`,
      `- Commit: \`${source.commit}\``,
      `- Version: \`${source.version}\``,
      `- Generated: ${new Date().toISOString()}`,
      "",
      "## Request",
      "",
      "```json",
      JSON.stringify(jsonCommand.normalized, null, 2),
      "```",
      "",
      markdown.trim(),
      "",
      "## Approval State",
      "",
      "- [ ] Product constraints reviewed",
      "- [ ] Brand and existing design tokens reconciled",
      "- [ ] Contrast and interaction states verified in the rendered UI",
      "- [ ] Desktop and mobile screenshots inspected",
      ""
    ].join("\n");
    await atomicWriteFile(target, document, "utf8");
    markSearchIndexDirty(`project design system written: ${target}`);
    persistence = {
      action: existed ? "overwritten" : "created",
      project_path: projectRoot,
      path: ".ai-dev/frontend/design-system.md",
      bytes: Buffer.byteLength(document, "utf8")
    };
  }

  return {
    action: "generated",
    source,
    request: jsonCommand.normalized,
    design_system: result.design_system ?? result,
    markdown: truncateOutput(markdown, 20000),
    persistence,
    guardrail: "Implementation and browser-based visual QA are still required."
  };
}

function csvValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(",");
  return String(value ?? "");
}

async function searchIndexStatus({ include_external_project_files = true } = {}) {
  const args = [
    "status",
    "--vault-root",
    vaultRoot,
    "--index-path",
    searchIndexPath
  ];
  if (include_external_project_files) args.push("--include-external-project-files");
  const status = await runSearchCli(args, { timeoutMs: 120000, command: pythonCommand() });
  status.dirty_reason = searchIndexDirtyReason;
  return status;
}

async function rebuildSearchIndex({
  include_external_project_files = true,
  dense_embeddings = false,
  dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultBgeM3ModelDir,
  dense_device = process.env.BGE_M3_DEVICE || "cpu",
  dense_batch_size = 8,
  dense_text_limit = 1200,
  dense_include_membrane = false,
  dense_incremental = true,
  preserve_dense = true
} = {}) {
  await fs.mkdir(searchIndexDir, { recursive: true });
  const args = [
    "rebuild",
    "--vault-root",
    vaultRoot,
    "--index-path",
    searchIndexPath
  ];
  if (include_external_project_files) args.push("--include-external-project-files");
  if (!dense_embeddings && preserve_dense) args.push("--preserve-dense");
  if (dense_embeddings) {
    args.push(
      "--dense-embeddings",
      "--dense-model-dir",
      path.resolve(String(dense_model_dir || defaultBgeM3ModelDir)),
      "--dense-device",
      String(dense_device || "cpu"),
      "--dense-batch-size",
      String(Math.max(1, Math.min(Number(dense_batch_size) || 8, 32))),
      "--dense-text-limit",
      String(Math.max(300, Math.min(Number(dense_text_limit) || 1200, 12000)))
    );
    if (dense_include_membrane) args.push("--dense-include-membrane");
    if (dense_incremental === false) args.push("--no-dense-incremental");
  }
  const rebuilt = await runSearchCli(args, {
    timeoutMs: dense_embeddings ? 3600000 : 600000,
    command: dense_embeddings ? embeddingPythonCommand() : pythonCommand()
  });
  searchIndexDirtyReason = "";
  searchIndexLastStatus = null;
  searchIndexLastStatusAt = 0;
  return rebuilt;
}

const bgeWorkerStates = new Map();
let bgeWorkerRequestSeq = 0;

function workerKey(modelDir, device) {
  return `${path.resolve(String(modelDir || defaultBgeM3ModelDir))}\x1f${String(device || "cpu")}`;
}

function rejectWorkerPending(state, message) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  state.pending.clear();
}

async function getBgeWorker({ model_dir = process.env.BGE_M3_MODEL_DIR || defaultBgeM3ModelDir, device = process.env.BGE_M3_DEVICE || "cpu" } = {}) {
  if (!(await pathExists(bgeM3WorkerCliPath))) {
    throw new Error(`BGE-M3 worker not found: ${bgeM3WorkerCliPath}`);
  }
  const python = embeddingPythonCommand();
  if (!(await pathExists(python))) {
    throw new Error(`BGE-M3 Python runtime not found: ${python}`);
  }

  const resolvedModelDir = path.resolve(String(model_dir || defaultBgeM3ModelDir));
  const selectedDevice = String(device || "cpu");
  const key = workerKey(resolvedModelDir, selectedDevice);
  const existing = bgeWorkerStates.get(key);
  if (existing && !existing.exited) return existing;

  const child = spawn(python, [
    bgeM3WorkerCliPath,
    "--model-dir",
    resolvedModelDir,
    "--device",
    selectedDevice
  ], { windowsHide: true });

  const state = {
    key,
    child,
    pending: new Map(),
    buffer: "",
    stderr: "",
    ready: false,
    exited: false,
    model_dir: resolvedModelDir,
    device: selectedDevice
  };
  bgeWorkerStates.set(key, state);

  child.stdout.on("data", (chunk) => {
    state.buffer += chunk.toString();
    let index;
    while ((index = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "ready") {
        state.ready = Boolean(message.ok);
        state.ready_message = message;
        continue;
      }
      const id = message.id;
      if (id === undefined || id === null || !state.pending.has(id)) continue;
      const pending = state.pending.get(id);
      state.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.ok === false) {
        pending.reject(new Error(message.error || "BGE-M3 worker request failed."));
      } else {
        pending.resolve(message);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    state.stderr = `${state.stderr}${chunk.toString()}`.slice(-8000);
  });
  child.on("error", (err) => {
    state.exited = true;
    rejectWorkerPending(state, err.message);
    bgeWorkerStates.delete(key);
  });
  child.on("close", (code) => {
    state.exited = true;
    rejectWorkerPending(state, `BGE-M3 worker exited with code ${code}. ${state.stderr}`.trim());
    bgeWorkerStates.delete(key);
  });

  return state;
}

async function requestBgeWorker(payload, { timeoutMs = 180000 } = {}) {
  const state = await getBgeWorker({
    model_dir: payload.model_dir,
    device: payload.device
  });
  if (!state.child.stdin.writable) {
    throw new Error("BGE-M3 worker stdin is closed.");
  }
  const id = ++bgeWorkerRequestSeq;
  const request = {
    id,
    method: payload.method || "embed",
    texts: payload.texts,
    text: payload.text,
    prefix: payload.prefix || "",
    normalize: payload.normalize !== false,
    batch_size: Math.max(1, Math.min(Number(payload.batch_size) || 8, 64)),
    precision: Math.max(2, Math.min(Number(payload.precision) || 6, 10)),
    include_embeddings: payload.include_embeddings !== false
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`BGE-M3 worker request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    state.child.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (err) => {
      if (err) {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function shutdownBgeWorkers() {
  for (const state of bgeWorkerStates.values()) {
    try {
      if (!state.exited && state.child.stdin.writable) {
        state.child.stdin.write(`${JSON.stringify({ id: ++bgeWorkerRequestSeq, method: "shutdown" })}\n`);
      }
      state.child.kill();
    } catch {
      // best effort on process shutdown
    }
  }
  bgeWorkerStates.clear();
}


async function fileStatus(target) {
  try {
    const stat = await fs.stat(target);
    return {
      exists: true,
      path: target,
      size_bytes: stat.size,
      mtime: stat.mtime.toISOString(),
      is_directory: stat.isDirectory()
    };
  } catch {
    return {
      exists: false,
      path: target
    };
  }
}

async function embeddingStatus({
  model_dir = process.env.BGE_M3_MODEL_DIR || defaultBgeM3ModelDir,
  device = process.env.BGE_M3_DEVICE || "cpu"
} = {}) {
  const resolvedModelDir = path.resolve(String(model_dir || defaultBgeM3ModelDir));
  const python = embeddingPythonCommand();
  const workerStates = [...bgeWorkerStates.values()].map((state) => ({
    key: state.key,
    pid: state.child.pid,
    ready: Boolean(state.ready),
    exited: Boolean(state.exited),
    pending_requests: state.pending.size,
    model_dir: state.model_dir,
    device: state.device,
    stderr_tail: state.stderr || ""
  }));
  return {
    backend: "bge-m3-local",
    dense_model: "BAAI/bge-m3",
    dense_dimensions: 1024,
    configured_device: String(device || "cpu"),
    paths: {
      vault_root: vaultRoot,
      search_index: searchIndexPath,
      embeddings_python: python,
      embed_helper: bgeM3EmbedCliPath,
      worker_helper: bgeM3WorkerCliPath,
      model_dir: resolvedModelDir
    },
    availability: {
      search_index: await fileStatus(searchIndexPath),
      embeddings_python: await fileStatus(python),
      embed_helper: await fileStatus(bgeM3EmbedCliPath),
      worker_helper: await fileStatus(bgeM3WorkerCliPath),
      model_dir: await fileStatus(resolvedModelDir),
      model_file: await fileStatus(path.join(resolvedModelDir, "pytorch_model.bin")),
      modules_file: await fileStatus(path.join(resolvedModelDir, "modules.json"))
    },
    workers: {
      count: workerStates.length,
      states: workerStates
    }
  };
}

function healthSummary(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) {
    if (Object.hasOwn(summary, check.status)) summary[check.status] += 1;
  }
  return summary;
}

function overallHealthStatus(checks) {
  if (checks.some((check) => check.status === "fail" && check.critical !== false)) return "fail";
  if (checks.some((check) => check.status === "fail" || check.status === "warn")) return "degraded";
  return "ok";
}

function healthErrorDetails(err) {
  return {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : "Error"
  };
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function frontendQaEnvironmentStatus() {
  if (!(await pathExists(frontendQaRunnerPath))) {
    return { status: "unavailable", playwright_available: false, chromium_available: false, browser_launch_ok: false };
  }
  const output = await execFileWithInput(
    process.execPath,
    [frontendQaRunnerPath],
    JSON.stringify({ action: "status", project_path: vaultRoot }),
    {
      cwd: path.dirname(frontendQaRunnerPath),
      timeoutMs: 60000,
      env: { AI_DEV_FRONTEND_QA_ARTIFACT_ROOT: frontendQaArtifactsRoot }
    }
  );
  return JSON.parse(output.stdout);
}

async function systemHealthCheck({
  include_search_smoke = true,
  include_dense_smoke = false,
  include_embedding_status = true,
  include_registry = true,
  include_skill_cards = true,
  include_projects = true,
  include_auto_commands = true,
  include_presets = true,
  include_search_eval = false,
  smoke_limit = 2
} = {}) {
  const startedAt = new Date();
  const checks = [];
  const safeSmokeLimit = Math.max(1, Math.min(Number(smoke_limit) || 2, 5));

  const addCheck = ({ name, status, summary, details = {}, critical = true, duration_ms = 0 }) => {
    checks.push({
      name,
      status,
      critical,
      summary,
      duration_ms,
      details
    });
  };

  const runCheck = async (name, critical, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      addCheck({
        name,
        critical,
        duration_ms: Date.now() - start,
        ...result
      });
    } catch (err) {
      addCheck({
        name,
        critical,
        status: "fail",
        summary: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
        details: healthErrorDetails(err)
      });
    }
  };

  await runCheck("vault_root", true, async () => {
    const status = await fileStatus(vaultRoot);
    if (!status.exists) return { status: "fail", summary: "Vault root is missing.", details: status };
    if (!status.is_directory) return { status: "fail", summary: "Vault root is not a directory.", details: status };
    return { status: "ok", summary: "Vault root exists.", details: status };
  });

  await runCheck("required_notes", false, async () => {
    const required = [
      "00-start-here.md",
      "01-system/AI Dev Control Center.md",
      "09-mcp/README.md",
      "09-mcp/ai-dev-mcp-server/README.md",
      "09-mcp/ai-dev-mcp-server/docs/ARCHITECTURE.md",
      "03-skills-catalog/Skill Cards.md"
    ];
    const files = [];
    for (const relative of required) {
      const status = await fileStatus(safePath(relative));
      files.push({ relative_path: relative, exists: status.exists, size_bytes: status.size_bytes || 0 });
    }
    const missing = files.filter((file) => !file.exists);
    return {
      status: missing.length ? "warn" : "ok",
      summary: missing.length ? `${missing.length} required notes are missing.` : "Core system notes exist.",
      details: { files, missing }
    };
  });

  await runCheck("search_index_file", true, async () => {
    const status = await fileStatus(searchIndexPath);
    if (!status.exists) return { status: "fail", summary: "SQLite search index is missing.", details: status };
    if (!status.size_bytes) return { status: "fail", summary: "SQLite search index is empty.", details: status };
    return { status: "ok", summary: "SQLite search index file exists.", details: status };
  });

  await runCheck("search_index_freshness", false, async () => {
    const status = await searchIndexStatus({ include_external_project_files: true });
    return {
      status: status.stale ? "warn" : "ok",
      summary: status.stale
        ? `Search index is stale: ${status.added_count} added, ${status.changed_count} changed, ${status.deleted_count} deleted.`
        : `Search index is current with ${status.current_document_count} document(s).`,
      details: status
    };
  });

  await runCheck("frontend_qa_runner", false, async () => {
    const status = await fileStatus(frontendQaRunnerPath);
    const packageStatus = await fileStatus(frontendQaPackagePath);
    if (!status.exists) return { status: "warn", summary: "Frontend QA runner is missing.", details: status };
    if (!status.size_bytes) return { status: "warn", summary: "Frontend QA runner is empty.", details: status };
    return {
      status: packageStatus.exists ? "ok" : "warn",
      summary: packageStatus.exists ? "Frontend QA runner and package manifest exist." : "Frontend QA runner exists, but package manifest is missing.",
      details: { runner: status, package: packageStatus, artifacts_root: frontendQaArtifactsRoot }
    };
  });

  await runCheck("frontend_qa_environment", false, async () => {
    const status = await frontendQaEnvironmentStatus();
    const ready = status.playwright_available && status.chromium_available && status.browser_launch_ok;
    return {
      status: ready ? "ok" : "warn",
      summary: ready
        ? `Playwright Chromium is ready from ${status.playwright_source || "runner"}.`
        : "Playwright Chromium is not fully ready.",
      details: status
    };
  });

  if (include_embedding_status) {
    await runCheck("embedding_backend", true, async () => {
      const status = await embeddingStatus({});
      const required = ["search_index", "embeddings_python", "embed_helper", "worker_helper", "model_dir", "model_file", "modules_file"];
      const missing = required.filter((key) => !status.availability?.[key]?.exists);
      if (missing.length) {
        return {
          status: "fail",
          summary: `Embedding backend is missing required files: ${missing.join(", ")}.`,
          details: { missing, availability: status.availability, workers: status.workers }
        };
      }
      return {
        status: "ok",
        summary: status.workers.count > 0
          ? `Embedding backend files exist; ${status.workers.count} worker(s) currently tracked.`
          : "Embedding backend files exist; worker is not started yet.",
        details: {
          backend: status.backend,
          dense_model: status.dense_model,
          dense_dimensions: status.dense_dimensions,
          configured_device: status.configured_device,
          workers: status.workers,
          paths: status.paths
        }
      };
    });
  } else {
    addCheck({ name: "embedding_backend", status: "skipped", critical: true, summary: "Embedding status check skipped." });
  }

  if (include_registry) {
    await runCheck("skill_registry", true, async () => {
      const items = await readSkillIndex();
      if (!Array.isArray(items)) return { status: "fail", summary: "Skill registry is not a JSON array.", details: { type: typeof items } };
      if (!items.length) return { status: "fail", summary: "Skill registry is empty.", details: { count: 0 } };
      const sources = countBy(items, (item) => item.source);
      const categories = countBy(items.flatMap((item) => item.categories || []), (item) => item);
      return {
        status: "ok",
        summary: `Skill registry loaded with ${items.length} skills.`,
        details: { count: items.length, sources, category_count: Object.keys(categories).length }
      };
    });
    await runCheck("skill_taxonomy", true, async () => {
      const registry = await readSkillGroupsIndex({ rebuildIfMissing: false });
      if (!registry) return { status: "fail", summary: "Skill taxonomy registry is missing.", details: { path: skillGroupsIndexRelativePath } };
      const items = await readSkillIndex();
      const missing = items.filter((item) => !item.primary_group).length;
      const knownGroups = new Set(SKILL_GROUPS.map((group) => group.id));
      const invalid = items.filter((item) => item.primary_group && !knownGroups.has(item.primary_group)).length;
      const assigned = items.length - missing - invalid;
      const status = missing || invalid ? "fail" : "ok";
      return {
        status,
        summary: status === "ok" ? `Skill taxonomy assigned ${assigned}/${items.length} skills across ${registry.groups.length} group(s).` : `Skill taxonomy has ${missing} missing and ${invalid} invalid assignments.`,
        details: {
          schema_version: registry.schema_version,
          total: items.length,
          assigned,
          missing,
          invalid,
          groups: registry.groups.map((group) => ({ id: group.id, count: group.count })),
          index_path: skillGroupsIndexRelativePath,
          skills_map: skillsMapRelativePath
        }
      };
    });
    await runCheck("skill_visual_graph", true, async () => {
      const registryPath = safePath(skillGraphIndexRelativePath);
      if (!(await pathExists(registryPath))) {
        return { status: "fail", summary: "Skill visual graph registry is missing.", details: { path: skillGraphIndexRelativePath } };
      }
      const registry = JSON.parse(stripBom(await fs.readFile(registryPath, "utf8")));
      const files = await listMarkdownFiles(safePath(skillGraphPagesRelativeDir));
      const expectedFiles = 1 + Number(registry.group_hubs || 0) + Number(registry.bucket_hubs || 0) + Number(registry.batch_pages || 0);
      const complete = registry.total_skills === registry.linked_unique_skills;
      const filesComplete = files.length === expectedFiles;
      const status = complete && filesComplete ? "ok" : "fail";
      return {
        status,
        summary: status === "ok"
          ? `Skill visual graph links ${registry.linked_unique_skills}/${registry.total_skills} skills through ${registry.batch_pages} batch page(s).`
          : `Skill visual graph coverage or generated file count is incomplete.`,
        details: {
          total_skills: registry.total_skills,
          linked_unique_skills: registry.linked_unique_skills,
          page_size: registry.page_size,
          batch_pages: registry.batch_pages,
          group_hubs: registry.group_hubs,
          bucket_hubs: registry.bucket_hubs,
          markdown_files: files.length,
          expected_markdown_files: expectedFiles,
          index_path: skillGraphIndexRelativePath,
          root_note: registry.root_note
        }
      };
    });
    await runCheck("skill_quality", true, async () => {
      const items = await readSkillIndex();
      const summary = summarizeSkillQuality(items);
      const reportExists = await pathExists(safePath(skillQualityIndexRelativePath));
      const schemaComplete = summary.schema_current === summary.total;
      const importantComplete = summary.important_structure_ready === summary.important_skills && !summary.important_failures.length;
      const status = schemaComplete && importantComplete && reportExists ? "ok" : (schemaComplete && importantComplete ? "warn" : "fail");
      return {
        status,
        summary: status === "ok"
          ? `Skill Schema v${summary.schema_version} covers ${summary.schema_current}/${summary.total}; important structurally ready skills ${summary.important_structure_ready}/${summary.important_skills}.`
          : `Skill quality is incomplete: schema ${summary.schema_current}/${summary.total}, important structurally ready ${summary.important_structure_ready}/${summary.important_skills}, report ${reportExists ? "present" : "missing"}.`,
        details: {
          ...summary,
          empirical_validation_note: "Structural readiness is tracked separately from verification-bound real task outcomes.",
          report_exists: reportExists,
          report_path: skillQualityIndexRelativePath,
          dashboard_path: skillQualityDashboardRelativePath
        }
      };
    });
    await runCheck("skill_routing_benchmark", true, async () => {
      const reportPath = safePath(skillRoutingReportRelativePath);
      const casesPath = safePath(skillRoutingEvalRelativePath);
      const routerPath = path.join(serverDir, "core", "skill-router.mjs");
      const reportStatus = await fileStatus(reportPath);
      if (!reportStatus.exists) {
        return {
          status: "fail",
          summary: "Skill routing benchmark report is missing.",
          details: {
            report_path: skillRoutingReportRelativePath,
            cases_path: skillRoutingEvalRelativePath
          }
        };
      }
      const [casesStatus, routerStatus] = await Promise.all([
        fileStatus(casesPath),
        fileStatus(routerPath)
      ]);
      const report = JSON.parse(stripBom(await fs.readFile(reportPath, "utf8")));
      const reportTime = Date.parse(reportStatus.mtime || "") || 0;
      const newestInput = Math.max(
        Date.parse(casesStatus.mtime || "") || 0,
        Date.parse(routerStatus.mtime || "") || 0
      );
      const fresh = reportTime >= newestInput;
      const passed = report.status === "pass" && Number(report.summary?.failed || 0) === 0;
      return {
        status: passed && fresh ? "ok" : "fail",
        summary: passed && fresh
          ? `Skill routing passed ${report.summary.passed}/${report.summary.total} golden case(s).`
          : `Skill routing benchmark is ${passed ? "stale" : "failing"}; rerun run_skill_routing_eval.`,
        details: {
          ...report.summary,
          benchmark_status: report.status,
          fresh,
          generated_at: report.generated_at,
          report_path: skillRoutingReportRelativePath,
          cases_path: skillRoutingEvalRelativePath
        }
      };
    });
    await runCheck("skill_outcomes", false, async () => {
      const outcomes = await skillOutcomeStore.status();
      const items = await readSkillIndex();
      const registryValidated = items.filter((item) => item.source === "custom" && item.empirical_status === "pass").length;
      const synchronized = registryValidated === outcomes.empirically_validated;
      return {
        status: synchronized ? "ok" : "warn",
        summary: outcomes.events
          ? `Recorded ${outcomes.events} verification-bound outcome(s) across ${outcomes.skills_observed} skill(s); ${outcomes.empirically_validated} empirically validated.`
          : "No verification-bound skill outcomes have been recorded yet; custom skills remain provisional.",
        details: {
          ...outcomes,
          registry_empirically_validated: registryValidated,
          registry_synchronized: synchronized,
          state_path: path.join(taskStateRoot, "skill-outcomes.json")
        }
      };
    });
  } else {
    addCheck({ name: "skill_registry", status: "skipped", critical: true, summary: "Skill registry check skipped." });
    addCheck({ name: "skill_taxonomy", status: "skipped", critical: true, summary: "Skill taxonomy check skipped." });
    addCheck({ name: "skill_visual_graph", status: "skipped", critical: true, summary: "Skill visual graph check skipped." });
    addCheck({ name: "skill_quality", status: "skipped", critical: true, summary: "Skill quality check skipped." });
    addCheck({ name: "skill_routing_benchmark", status: "skipped", critical: true, summary: "Skill routing benchmark check skipped." });
    addCheck({ name: "skill_outcomes", status: "skipped", critical: false, summary: "Skill outcome check skipped." });
  }

  if (include_skill_cards) {
    await runCheck("skill_cards", false, async () => {
      const cards = await readSkillCardsIndex({ syncIfMissing: false });
      const bySource = countBy(cards, (card) => card.source || "unknown");
      return {
        status: cards.length ? "ok" : "warn",
        summary: cards.length ? `Skill cards loaded with ${cards.length} card(s).` : "Skill cards index is missing or empty.",
        details: {
          count: cards.length,
          by_source: bySource,
          index_path: skillCardsIndexRelativePath,
          catalog_path: skillCardsCatalogRelativePath
        }
      };
    });
  } else {
    addCheck({ name: "skill_cards", status: "skipped", critical: false, summary: "Skill cards check skipped." });
  }

  if (include_projects) {
    await runCheck("project_registry", false, async () => {
      const projects = await listProjects();
      return {
        status: projects.length ? "ok" : "warn",
        summary: projects.length ? `Project registry has ${projects.length} project card(s).` : "Project registry has no project cards yet.",
        details: {
          count: projects.length,
          projects: projects.slice(0, 10).map((project) => ({
            name: project.name,
            project_path: project.project_path,
            card_path: project.card_path,
            status: project.status,
            quality_gate_status: project.quality_gate_status
          }))
        }
      };
    });
  } else {
    addCheck({ name: "project_registry", status: "skipped", critical: false, summary: "Project registry check skipped." });
  }

  if (include_auto_commands) {
    await runCheck("auto_commands", true, async () => {
      const commands = listAutoCommands();
      return {
        status: commands.length ? "ok" : "fail",
        summary: commands.length ? `Auto-command registry has ${commands.length} workflows.` : "Auto-command registry is empty.",
        details: { count: commands.length, names: commands.map((command) => command.name) }
      };
    });
  } else {
    addCheck({ name: "auto_commands", status: "skipped", critical: true, summary: "Auto-command check skipped." });
  }

  if (include_presets) {
    await runCheck("search_presets", true, async () => {
      const presets = listSearchPresets();
      const required = ["balanced", "code", "docs", "skills", "projects", "debug", "frontend", "quality"];
      const names = presets.map((preset) => preset.name);
      const missing = required.filter((name) => !names.includes(name));
      return {
        status: missing.length ? "fail" : "ok",
        summary: missing.length ? `Missing search presets: ${missing.join(", ")}.` : `Search presets loaded: ${names.join(", ")}.`,
        details: { count: presets.length, names, missing }
      };
    });
  } else {
    addCheck({ name: "search_presets", status: "skipped", critical: true, summary: "Search preset check skipped." });
  }

  if (include_search_smoke) {
    await runCheck("search_smoke", true, async () => {
      const results = await searchIndex({
        query: "Project Bootstrap AGENTS quality gate",
        scope: "all",
        limit: safeSmokeLimit,
        ensure_fresh: false
      });
      return {
        status: results.length ? "ok" : "fail",
        summary: results.length ? `FTS search returned ${results.length} result(s).` : "FTS search returned no results.",
        details: { results: results.map((item) => ({ title: item.title, path: item.path, scope: item.scope, score: item.score })) }
      };
    });

    await runCheck("hybrid_smoke_no_dense", true, async () => {
      const results = await hybridSearchIndex({
        query: "frontend design skill",
        scope: "all",
        limit: safeSmokeLimit,
        dense_weight: 0,
        ensure_fresh: false
      });
      return {
        status: results.length ? "ok" : "fail",
        summary: results.length ? `Hybrid search without dense returned ${results.length} result(s).` : "Hybrid search without dense returned no results.",
        details: { results: results.map((item) => ({ title: item.title, path: item.path, scope: item.scope, score: item.score, dense_score: item.dense_score })) }
      };
    });
  } else {
    addCheck({ name: "search_smoke", status: "skipped", critical: true, summary: "Search smoke checks skipped." });
  }

  if (include_dense_smoke) {
    await runCheck("dense_smoke", true, async () => {
      const results = await hybridSearchIndex({
        query: "\u0441\u043e\u0437\u0434\u0430\u0439 \u043a\u0430\u0447\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441 \u0431\u0435\u0437 \u0418\u0418 \u0441\u043b\u043e\u043f\u0430 \u043f\u043e \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043d\u044b\u043c \u0440\u0435\u0444\u0435\u0440\u0435\u043d\u0441\u0430\u043c",
        scope: "knowledge",
        limit: safeSmokeLimit,
        keyword_weight: 0.25,
        semantic_weight: 0.25,
        dense_weight: 0.50,
        ensure_fresh: false
      });
      const hasDense = results.some((item) => Number(item.dense_score) > 0);
      return {
        status: results.length && hasDense ? "ok" : "fail",
        summary: results.length && hasDense
          ? `Dense hybrid search returned ${results.length} result(s) with dense scores.`
          : "Dense hybrid search did not return dense-scored results.",
        details: { results: results.map((item) => ({ title: item.title, path: item.path, score: item.score, dense_score: item.dense_score })) }
      };
    });
  } else {
    addCheck({ name: "dense_smoke", status: "skipped", critical: false, summary: "Dense smoke skipped. Set include_dense_smoke=true to test BGE-M3 end-to-end." });
  }

  if (include_search_eval) {
    await runCheck("search_eval", true, async () => {
      const evalResult = await runSearchEval({ include_dense: false, max_cases: 10 });
      const failed = evalResult.summary.failed;
      const passed = evalResult.summary.passed;
      const skipped = evalResult.summary.skipped;
      const status = evalResult.status === "ok" ? "ok" : (evalResult.status === "degraded" ? "warn" : "fail");
      return {
        status,
        summary: `Search eval: ${passed} passed, ${failed} failed, ${skipped} skipped.`,
        details: {
          include_dense: evalResult.include_dense,
          cases_path: evalResult.cases_path,
          summary: evalResult.summary,
          failed_cases: evalResult.cases
            .filter((item) => item.status === "fail")
            .map((item) => ({ id: item.id, query: item.query, preset: item.preset, error: item.error || "" }))
        }
      };
    });
  } else {
    addCheck({ name: "search_eval", status: "skipped", critical: false, summary: "Search eval skipped. Set include_search_eval=true to run golden cases without dense scoring." });
  }

  const finishedAt = new Date();
  const summary = healthSummary(checks);
  const status = overallHealthStatus(checks);
  const recommendations = [];
  if (checks.some((check) => check.name === "dense_smoke" && check.status === "skipped")) {
    recommendations.push("Run system_health_check with include_dense_smoke=true after MCP restarts or embedding changes.");
  }
  for (const check of checks) {
    if (check.status === "fail") recommendations.push(`Fix failed check: ${check.name} - ${check.summary}`);
    if (check.status === "warn") recommendations.push(`Review warning: ${check.name} - ${check.summary}`);
  }

  return {
    status,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    summary,
    checks,
    recommendations
  };
}

async function embedTexts({
  texts,
  text,
  prefix = "",
  normalize = true,
  batch_size = 8,
  precision = 6,
  include_embeddings = true,
  model_dir = process.env.BGE_M3_MODEL_DIR || defaultBgeM3ModelDir,
  device = process.env.BGE_M3_DEVICE || "cpu",
  timeout_ms = 180000,
  use_worker = true
} = {}) {
  if (!(await pathExists(bgeM3EmbedCliPath))) {
    throw new Error(`BGE-M3 helper not found: ${bgeM3EmbedCliPath}`);
  }

  const python = embeddingPythonCommand();
  if (!(await pathExists(python))) {
    throw new Error(`BGE-M3 Python runtime not found: ${python}`);
  }

  const inputTexts = Array.isArray(texts)
    ? texts
    : (typeof text === "string" && text ? [text] : []);
  const cleanTexts = inputTexts.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!cleanTexts.length) {
    throw new Error("texts or text is required.");
  }
  if (cleanTexts.length > 32) {
    throw new Error("embed_texts accepts at most 32 texts per call.");
  }
  for (const value of cleanTexts) {
    if (value.length > 12000) {
      throw new Error("Each text must be 12000 characters or less.");
    }
  }

  const request = {
    texts: cleanTexts,
    prefix: String(prefix ?? ""),
    normalize: Boolean(normalize),
    batch_size: Math.max(1, Math.min(Number(batch_size) || 8, 32)),
    precision: Math.max(2, Math.min(Number(precision) || 6, 10)),
    include_embeddings: Boolean(include_embeddings),
    model_dir,
    device
  };

  if (use_worker) {
    return requestBgeWorker(request, {
      timeoutMs: Math.max(30000, Math.min(Number(timeout_ms) || 180000, 600000))
    });
  }

  const requestPath = path.join(searchIndexDir, `.bge-m3-request-${process.pid}-${Date.now()}.json`);
  await fs.mkdir(searchIndexDir, { recursive: true });
  await atomicWriteJson(requestPath, request, { spaces: 0 });
  try {
    const output = await execFile(python, [
      bgeM3EmbedCliPath,
      "--model-dir",
      path.resolve(String(model_dir || defaultBgeM3ModelDir)),
      "--device",
      String(device || "cpu"),
      "embed",
      "--input-json",
      requestPath,
      "--precision",
      String(Math.max(2, Math.min(Number(precision) || 6, 10)))
    ], {
      timeoutMs: Math.max(30000, Math.min(Number(timeout_ms) || 180000, 600000))
    });
    const parsed = JSON.parse(stripBom(output.stdout));
    if (!include_embeddings && parsed.embeddings) {
      parsed.embedding_preview = parsed.embeddings.map((row) => row.slice(0, 8));
      delete parsed.embeddings;
    }
    parsed.backend = "bge-m3-local";
    return parsed;
  } finally {
    await fs.rm(requestPath, { force: true }).catch(() => {});
  }
}

async function ensureSearchIndex({ force_check = false } = {}) {
  if (searchIndexRefreshPromise) return searchIndexRefreshPromise;

  const now = Date.now();
  if (
    !force_check &&
    !searchIndexDirtyReason &&
    searchIndexLastStatus &&
    now - searchIndexLastStatusAt < searchFreshnessCacheMs
  ) {
    return { action: "current", status: searchIndexLastStatus };
  }

  const status = await searchIndexStatus({ include_external_project_files: true });
  searchIndexLastStatus = status;
  searchIndexLastStatusAt = Date.now();
  if (!status.stale && !searchIndexDirtyReason) {
    return { action: "current", status };
  }

  searchIndexRefreshPromise = (async () => {
    const rebuild = await rebuildSearchIndex({
      include_external_project_files: true,
      dense_embeddings: false,
      preserve_dense: true
    });
    const refreshed = await searchIndexStatus({ include_external_project_files: true });
    searchIndexLastStatus = refreshed;
    searchIndexLastStatusAt = Date.now();
    searchIndexDirtyReason = "";
    return { action: "rebuilt", previous_status: status, rebuild, status: refreshed };
  })();

  try {
    return await searchIndexRefreshPromise;
  } finally {
    searchIndexRefreshPromise = null;
  }
}

async function searchIndex({
  query,
  scope = "all",
  limit = 10,
  project = "",
  source = "",
  categories = "",
  folders = "",
  ensure_fresh = true
}) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required.");
  }
  if (ensure_fresh) await ensureSearchIndex();
  return runSearchCli([
    "search",
    "--index-path",
    searchIndexPath,
    "--query",
    query,
    "--scope",
    scope || "all",
    "--limit",
    String(Math.max(1, Math.min(Number(limit) || 10, 50))),
    "--project",
    project || "",
    "--source",
    csvValue(source),
    "--categories",
    csvValue(categories),
    "--folders",
    csvValue(folders)
  ], { timeoutMs: 120000 });
}

async function activeSearchHardNegativeRules() {
  const stats = await fs.stat(searchEvalCasesPath).catch(() => null);
  const modified = stats?.mtimeMs || 0;
  if (searchHardNegativeCache?.modified === modified) return searchHardNegativeCache.rules;
  const parsed = await readSearchEvalCases().catch(() => ({ cases: [] }));
  const rules = hardNegativeRulesFromCases(parsed.cases);
  searchHardNegativeCache = { modified, rules };
  return rules;
}

async function hybridSearchIndex({
  query,
  scope = "all",
  limit = 10,
  project = "",
  source = "",
  categories = "",
  folders = "",
  semantic_weight = 0.20,
  keyword_weight = 0.45,
  dense_weight = 0.35,
  dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultBgeM3ModelDir,
  dense_device = process.env.BGE_M3_DEVICE || "cpu",
  intent_routing = false,
  rerank = true,
  preset_name = "",
  ensure_fresh = true
}) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required.");
  }
  const normalizedQuery = repairSearchMojibake(query);
  const requestedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const selectedDenseWeight = Number.isFinite(Number(dense_weight)) ? Number(dense_weight) : 0.35;
  if (ensure_fresh) await ensureSearchIndex();

  let denseQueryVectorPath = "";
  if (selectedDenseWeight > 0) {
    const denseQuery = await requestBgeWorker({
      texts: [normalizedQuery],
      prefix: "query: ",
      normalize: true,
      batch_size: 1,
      precision: 8,
      include_embeddings: true,
      model_dir: dense_model_dir,
      device: dense_device
    }, { timeoutMs: 300000 });
    const vector = denseQuery.embeddings?.[0];
    if (Array.isArray(vector) && vector.length) {
      await fs.mkdir(searchIndexDir, { recursive: true });
      denseQueryVectorPath = path.join(searchIndexDir, `.dense-query-${process.pid}-${Date.now()}.json`);
      await atomicWriteJson(denseQueryVectorPath, vector, { spaces: 0 });
    }
  }

  const args = [
    "hybrid",
    "--index-path",
    searchIndexPath,
    "--query",
    normalizedQuery,
    "--scope",
    scope || "all",
    "--limit",
    "50",
    "--project",
    project || "",
    "--source",
    csvValue(source),
    "--categories",
    csvValue(categories),
    "--folders",
    csvValue(folders),
    "--semantic-weight",
    String(Number.isFinite(Number(semantic_weight)) ? Number(semantic_weight) : 0.20),
    "--keyword-weight",
    String(Number.isFinite(Number(keyword_weight)) ? Number(keyword_weight) : 0.45),
    "--dense-weight",
    String(selectedDenseWeight),
    "--dense-model-dir",
    path.resolve(String(dense_model_dir || defaultBgeM3ModelDir)),
    "--dense-device",
    String(dense_device || "cpu")
  ];
  if (denseQueryVectorPath) {
    args.push("--dense-query-vector-path", denseQueryVectorPath);
  }

  try {
    const results = await runSearchCli(args, {
      timeoutMs: selectedDenseWeight > 0 ? 300000 : 120000,
      command: pythonCommand()
    });
    let ranked = results;
    if (
      intent_routing
      && ["all", "knowledge"].includes(String(scope || "all"))
      && !project
      && !csvValue(folders)
      && !csvValue(source)
    ) {
      ranked = prioritizeKnowledgeResults(normalizedQuery, ranked);
    }
    if (rerank) {
      ranked = rerankSearchResults(normalizedQuery, ranked, {
        scope,
        preset: preset_name,
        hardNegativeRules: await activeSearchHardNegativeRules()
      });
    }
    if (!intent_routing || !["all", "skills"].includes(String(scope || "all"))) {
      return ranked.slice(0, requestedLimit);
    }
    if (project || csvValue(folders)) return ranked.slice(0, requestedLimit);
    if (isSkillCatalogQuery(normalizedQuery)) return ranked.slice(0, requestedLimit);
    const selectedSources = new Set(csvValue(source).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
    if (selectedSources.size && !selectedSources.has("custom")) return ranked.slice(0, requestedLimit);

    const route = routeSkills({ task: normalizedQuery, maxSkills: 3 });
    const registry = await readSkillIndex();
    const customByName = new Map(
      registry
        .filter((item) => item.source === "custom")
        .map((item) => [String(item.name || "").toLowerCase(), item])
    );
    const routed = route.skills
      .map((selection, index) => {
        const item = customByName.get(String(selection.name || "").toLowerCase());
        if (!item) return null;
        return {
          scope: "skills",
          title: item.name,
          path: item.path,
          source: item.source,
          categories: Array.isArray(item.categories) ? item.categories.join(", ") : String(item.categories || ""),
          score: Number((2 - index * 0.01).toFixed(6)),
          keyword_score: 0,
          semantic_score: 0,
          dense_score: 0,
          mode: "routed-hybrid",
          preview: item.description || item.use_when || "",
          routing_role: selection.role,
          routing_reason: selection.reason,
          routing_rule: selection.rule,
          retrieval_stage: "deterministic-intent-router"
        };
      })
      .filter(Boolean);
    const routedNames = new Set(routed.map((item) => item.title.toLowerCase()));
    return [...routed, ...ranked.filter((item) => !routedNames.has(String(item.title || "").toLowerCase()))]
      .slice(0, requestedLimit);
  } finally {
    if (denseQueryVectorPath) {
      await fs.rm(denseQueryVectorPath, { force: true }).catch(() => {});
    }
  }
}

function sanitizeRepoName(repositoryUrl, requestedName) {
  const raw = requestedName || repositoryUrl.split("/").pop()?.replace(/\.git$/, "") || "imported-skill-repo";
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("Could not derive a safe repository name.");
  return sanitized.slice(0, 80);
}

function validateGitHubUrl(repositoryUrl) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(repositoryUrl)) {
    throw new Error("Only simple https://github.com/owner/repo URLs are supported.");
  }
}

async function importSkillRepo({ repository_url, source_group = "external", name, update_if_exists = false }) {
  validateGitHubUrl(repository_url);
  if (!["external", "design", "custom"].includes(source_group)) {
    throw new Error("source_group must be one of: external, design, custom.");
  }

  const repoName = sanitizeRepoName(repository_url, name);
  const targetParent = path.join(sourcesRoot, source_group);
  const target = path.join(targetParent, repoName);
  if (!target.toLowerCase().startsWith(vaultRoot.toLowerCase())) {
    throw new Error("Import target escapes vault root.");
  }

  await fs.mkdir(targetParent, { recursive: true });
  const exists = await pathExists(target);
  if (exists && !update_if_exists) {
    throw new Error(`Repository already exists at ${toVaultRelative(target)}. Set update_if_exists=true to pull updates.`);
  }

  if (exists) {
    await execFile("git", ["-C", target, "pull", "--ff-only"], { timeoutMs: 120000 });
  } else {
    await execFile("git", ["clone", repository_url, target], { timeoutMs: 120000 });
  }

  const rebuild = await rebuildIndex();
  return {
    action: exists ? "updated" : "cloned",
    repository_url,
    source_group,
    name: repoName,
    path: toVaultRelative(target),
    rebuild
  };
}

async function safeProjectRoot(projectPath) {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("project_path is required.");
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error("project_path must be an absolute path.");
  }

  const resolved = path.resolve(projectPath);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }
  return resolved;
}

async function resolveTaskProjectRoot(projectPath) {
  return (await resolveProjectIdentity(projectPath)).project_root;
}

function safeProjectFile(projectRoot, relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    throw new Error("relative project file path is required.");
  }

  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.includes("..")) {
    throw new Error(`Unsafe project file path: ${relativePath}`);
  }
  if (segments.includes(".git")) {
    throw new Error("Writing inside .git is not allowed.");
  }

  return resolveWithinSync(projectRoot, normalized, {
    mode: "write",
    allowAbsolute: false,
    allowRoot: false
  });
}

async function safeProjectSubdir(projectRoot, relativePath = "") {
  if (!relativePath) return projectRoot;
  const target = safeProjectFile(projectRoot, relativePath);
  const stats = await fs.stat(target).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Project subdirectory does not exist: ${relativePath}`);
  }
  return target;
}

async function readJsonIfExists(target) {
  if (!(await pathExists(target))) return null;
  try {
    return JSON.parse(stripBom(await fs.readFile(target, "utf8")));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mdCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function asBulletList(items, fallback = "Not detected.") {
  if (!items.length) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function inferPackageManager(projectRoot, packageJson) {
  const candidates = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"]
  ];
  return Promise.all(candidates.map(([file]) => pathExists(path.join(projectRoot, file))))
    .then((matches) => {
      const matchIndex = matches.findIndex(Boolean);
      if (matchIndex >= 0) return candidates[matchIndex][1];
      return packageJson ? "npm" : "";
    });
}

function packageRunCommand(packageManager, scriptName) {
  if (!scriptName) return "";
  if (packageManager === "pnpm") return `pnpm ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function firstScript(scripts, names) {
  return names.find((name) => Object.hasOwn(scripts, name)) ?? "";
}

function commandRow(label, command, source = "") {
  return { label, command: command || "Not detected", source: source || (command ? "detected" : "missing") };
}

async function readProjectTextIfExists(projectRoot, relativePath) {
  const target = safeProjectFile(projectRoot, relativePath);
  if (!(await pathExists(target))) return "";
  return stripBom(await fs.readFile(target, "utf8").catch(() => ""));
}


async function detectProject(projectRoot, requestedName) {
  const exists = (relativePath) => pathExists(path.join(projectRoot, relativePath));
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = await readJsonIfExists(packageJsonPath);
  const scripts = isPlainObject(packageJson?.scripts) ? packageJson.scripts : {};
  const dependencies = {
    ...(isPlainObject(packageJson?.dependencies) ? packageJson.dependencies : {}),
    ...(isPlainObject(packageJson?.devDependencies) ? packageJson.devDependencies : {})
  };
  const packageManager = await inferPackageManager(projectRoot, packageJson);
  const pyprojectText = await readProjectTextIfExists(projectRoot, "pyproject.toml");
  const requirementsText = await readProjectTextIfExists(projectRoot, "requirements.txt");
  const pythonMetadataText = `${pyprojectText}\n${requirementsText}`.toLowerCase();
  const dependencyText = `${Object.keys(dependencies).join(" ")}\n${pythonMetadataText}`.toLowerCase();

  const stack = [];
  const markers = [];
  const addStack = (name) => {
    if (!stack.includes(name)) stack.push(name);
  };
  const addMarker = async (file, label = file) => {
    if (await exists(file)) markers.push(label);
  };

  if (packageJson) addStack("Node.js");
  if (dependencies.typescript || await exists("tsconfig.json")) addStack("TypeScript");
  if (dependencies.next) addStack("Next.js");
  if (dependencies.react) addStack("React");
  if (dependencies.vue) addStack("Vue");
  if (dependencies.svelte) addStack("Svelte");
  if (dependencies.vite) addStack("Vite");
  if (dependencies.tailwindcss || await exists("tailwind.config.js") || await exists("tailwind.config.ts")) addStack("Tailwind CSS");
  if (dependencies["react-native"] || dependencies.expo || await exists("app.json") || await exists("eas.json")) addStack("React Native/Expo");
  if (dependencies["@capacitor/core"] || dependencies.ionic) addStack("Capacitor/Ionic");
  if (await exists("pyproject.toml") || await exists("requirements.txt") || await exists("Pipfile") || await exists("poetry.lock") || await exists("uv.lock")) addStack("Python");
  if (/fastapi/.test(pythonMetadataText)) addStack("FastAPI");
  if (/flask/.test(pythonMetadataText)) addStack("Flask");
  if (/django/.test(pythonMetadataText)) addStack("Django");
  if (/sqlalchemy/.test(pythonMetadataText)) addStack("SQLAlchemy");
  if (/alembic/.test(pythonMetadataText)) addStack("Alembic");
  if (/postgres|psycopg|asyncpg/.test(pythonMetadataText)) addStack("PostgreSQL");
  if (/redis/.test(pythonMetadataText)) addStack("Redis");
  if (/celery/.test(pythonMetadataText)) addStack("Celery");
  if (/aiogram/.test(pythonMetadataText)) addStack("aiogram");
  if (/python-telegram-bot|pytelegrambotapi|telebot|discord.py/.test(pythonMetadataText)) addStack("Bot framework");
  if (/openai/.test(pythonMetadataText)) addStack("OpenAI-compatible LLM");
  if (/pytest/.test(pythonMetadataText)) addStack("pytest");
  if (/\b(express|koa|fastify|hapi|nestjs|@nestjs\/core)\b/.test(dependencyText)) addStack("Node API");
  if (/\b(telegraf|grammy|node-telegram-bot-api|discord.js|slack-bolt)\b/.test(dependencyText)) addStack("Bot framework");
  if (await exists("pubspec.yaml")) addStack("Flutter/Dart");
  if (await exists("go.mod")) addStack("Go");
  if (await exists("Cargo.toml")) addStack("Rust");
  if (await exists("composer.json")) addStack("PHP");
  if (await exists("pom.xml") || await exists("build.gradle") || await exists("build.gradle.kts")) addStack("Java/JVM");
  if (await exists("Dockerfile") || await exists("docker-compose.yml") || await exists("compose.yml")) addStack("Docker");
  if (await exists("docker-compose.yml") || await exists("compose.yml")) addStack("Docker Compose");
  if (await exists(".github/workflows")) addStack("GitHub Actions");

  await addMarker("README.md");
  await addMarker("docs", "docs/");
  await addMarker("CONTRIBUTING.md");
  await addMarker("CHANGELOG.md");
  await addMarker(".env.example");
  await addMarker("package.json");
  await addMarker("tsconfig.json");
  await addMarker("vite.config.ts");
  await addMarker("vite.config.js");
  await addMarker("next.config.js");
  await addMarker("next.config.mjs");
  await addMarker("tailwind.config.ts");
  await addMarker("tailwind.config.js");
  await addMarker("pyproject.toml");
  await addMarker("requirements.txt");
  await addMarker("pubspec.yaml");
  await addMarker("app.json");
  await addMarker("eas.json");
  await addMarker("android", "android/");
  await addMarker("ios", "ios/");
  await addMarker("go.mod");
  await addMarker("Cargo.toml");
  await addMarker("Dockerfile");
  await addMarker(".github/workflows", "GitHub Actions");
  await addMarker("src", "src/");
  await addMarker("app", "app/");
  await addMarker("pages", "pages/");
  await addMarker("components", "components/");
  await addMarker("tests", "tests/");

  const installCommand = packageJson
    ? `${packageManager || "npm"} install`
    : (await exists("uv.lock") ? "uv sync" : await exists("requirements.txt") ? "python -m pip install -r requirements.txt" : "");
  const devScript = firstScript(scripts, ["dev", "start", "serve"]);
  const testScript = firstScript(scripts, ["test", "test:unit", "test:e2e"]);
  const lintScript = firstScript(scripts, ["lint", "lint:fix"]);
  const typecheckScript = firstScript(scripts, ["typecheck", "type-check", "check-types", "tsc"]);
  const buildScript = firstScript(scripts, ["build", "compile"]);
  const pythonCheckCommand = await exists("scripts/check.py")
    ? (await exists(".venv/Scripts/python.exe") ? ".\\.venv\\Scripts\\python.exe scripts\\check.py" : "python scripts/check.py")
    : "";
  const pythonTestFallback = pythonCheckCommand || (await exists("pyproject.toml") || await exists("requirements.txt") ? "pytest" : "");

  const commands = [
    commandRow("Install", installCommand, installCommand ? "project files" : "missing"),
    commandRow("Dev", packageRunCommand(packageManager, devScript), devScript ? `package script: ${devScript}` : "missing"),
    commandRow("Test", packageRunCommand(packageManager, testScript) || pythonTestFallback || (await exists("Cargo.toml") ? "cargo test" : ""), testScript ? `package script: ${testScript}` : pythonCheckCommand ? "scripts/check.py" : "fallback/missing"),
    commandRow("Lint", packageRunCommand(packageManager, lintScript), lintScript ? `package script: ${lintScript}` : "missing"),
    commandRow("Typecheck", packageRunCommand(packageManager, typecheckScript), typecheckScript ? `package script: ${typecheckScript}` : "missing"),
    commandRow("Build", packageRunCommand(packageManager, buildScript) || (await exists("go.mod") ? "go build ./..." : await exists("Cargo.toml") ? "cargo build" : ""), buildScript ? `package script: ${buildScript}` : "fallback/missing")
  ];

  const frontendNames = new Set(["Next.js", "React", "Vue", "Svelte", "Vite", "Tailwind CSS"]);
  const backendNames = new Set(["FastAPI", "Flask", "Django", "SQLAlchemy", "Alembic", "PostgreSQL", "Redis", "Celery", "Node API", "Go", "Rust", "Java/JVM", "PHP"]);
  const mobileNames = new Set(["React Native/Expo", "Capacitor/Ionic", "Flutter/Dart"]);
  const botNames = new Set(["aiogram", "Bot framework"]);
  const apiNames = new Set(["FastAPI", "Flask", "Django", "Node API"]);
  const isFrontend = stack.some((item) => frontendNames.has(item));
  const isBackend = stack.some((item) => backendNames.has(item));
  const isMobile = stack.some((item) => mobileNames.has(item));
  const isBot = stack.some((item) => botNames.has(item));
  const isApi = stack.some((item) => apiNames.has(item)) || await exists("api") || await exists("routes") || await exists("controllers");
  const projectTypes = [
    isFrontend ? "frontend" : "",
    isBackend ? "backend" : "",
    isMobile ? "mobile" : "",
    isBot ? "bot" : "",
    isApi ? "api" : ""
  ].filter(Boolean);
  const documentation = await projectDocumentationSnapshot(projectRoot);
  const environment = await projectEnvironmentSnapshot(projectRoot);
  const dangerousScripts = projectDangerousScripts(scripts);
  const projectName = requestedName || packageJson?.name || path.basename(projectRoot);
  const intelligence = await analyzeProject(projectRoot, { projectName, maxDepth: 4 });
  for (const value of intelligence.stack) {
    if (!stack.includes(value)) stack.push(value);
  }
  const deepTypes = intelligence.project_types.filter((item) => item !== "unknown");
  for (const value of deepTypes) {
    if (!projectTypes.includes(value)) projectTypes.push(value);
  }
  const mergedCommands = intelligence.commands.length
    ? intelligence.commands
    : commands;
  const detected = {
    project_name: projectName,
    project_path: projectRoot,
    package_manager: packageManager || "Not detected",
    stack,
    project_types: projectTypes.length ? projectTypes : ["unknown"],
    scripts,
    commands: mergedCommands,
    markers: [...new Set([...markers, ...intelligence.components.map((item) => item.manifest)])],
    documentation,
    environment,
    dangerous_scripts: dangerousScripts,
    has_git: await exists(".git"),
    is_frontend: isFrontend || intelligence.is_frontend,
    is_backend: isBackend || intelligence.is_backend,
    is_mobile: isMobile || intelligence.is_mobile,
    is_bot: isBot || intelligence.is_bot,
    is_api: isApi || intelligence.is_api,
    components: intelligence.components,
    architecture: intelligence.architecture,
    workspace: intelligence.workspace,
    component_quality: intelligence.quality
  };
  detected.quality_gaps = projectQualityGaps(detected);
  detected.risk_signals = projectRiskSignals(detected);
  detected.recommended_next_commands = projectRecommendedNextCommands(detected);
  return {
    ...detected
  };
}

async function projectDocumentationSnapshot(projectRoot) {
  const candidates = [
    ["README.md", "README"],
    ["docs", "docs/"],
    ["CONTRIBUTING.md", "CONTRIBUTING"],
    ["CHANGELOG.md", "CHANGELOG"],
    [".github", ".github/"],
    [".github/workflows", "GitHub Actions"]
  ];
  const files = [];
  for (const [relativePath, label] of candidates) {
    const target = safeProjectFile(projectRoot, relativePath);
    const stats = await fs.stat(target).catch(() => null);
    files.push({
      path: relativePath,
      label,
      exists: Boolean(stats),
      type: stats?.isDirectory() ? "directory" : stats?.isFile() ? "file" : "missing"
    });
  }
  return {
    files,
    has_readme: files.some((item) => item.path.toLowerCase() === "readme.md" && item.exists),
    has_docs: files.some((item) => item.path.toLowerCase() === "docs" && item.exists),
    missing: files.filter((item) => !item.exists).map((item) => item.path)
  };
}

async function projectEnvironmentSnapshot(projectRoot) {
  const candidates = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.example",
    ".env.sample",
    "env.example",
    "example.env"
  ];
  const files = [];
  for (const relativePath of candidates) {
    const target = safeProjectFile(projectRoot, relativePath);
    const stats = await fs.stat(target).catch(() => null);
    if (!stats?.isFile()) continue;
    const isExample = /example|sample/i.test(relativePath);
    files.push({
      path: relativePath,
      type: isExample ? "example" : "local",
      risk: isExample ? "low" : "high"
    });
  }
  return {
    files,
    has_example: files.some((item) => item.type === "example"),
    local_secret_files: files.filter((item) => item.type === "local").map((item) => item.path)
  };
}

function projectDangerousScripts(scripts) {
  return Object.entries(scripts || {})
    .map(([name, command]) => {
      const reason = projectCommandRiskReason(command, name);
      return reason ? { name, command: String(command), reason } : null;
    })
    .filter(Boolean);
}

function projectCommandRiskReason(command, name = "") {
  const baseReason = commandRiskReason(command);
  if (baseReason) return baseReason;
  const combined = `${name} ${command}`.toLowerCase();
  const risky = [
    { pattern: /\bdeploy|publish|release\b/, reason: "deployment or release script" },
    { pattern: /\bmigrate|migration|rollback|seed\b/, reason: "database mutation script" },
    { pattern: /\bstripe|payment|charge|invoice\b/, reason: "payment side effects" },
    { pattern: /\btelegram|discord|slack|mail|email|send\b/, reason: "external notification side effects" },
    { pattern: /\bopenai|anthropic|llm|vision|api[_-]?call\b/, reason: "external API or paid model side effects" },
    { pattern: /\bprod|production\b/, reason: "production environment script" }
  ];
  return risky.find((item) => item.pattern.test(combined))?.reason || "";
}

function projectQualityGaps(detected) {
  const missing = commandsByStatus(detected.commands).missing
    .filter((item) => ["Test", "Lint", "Typecheck", "Build"].includes(item.label))
    .map((item) => `${item.label} command is not detected.`);
  if (detected.is_frontend && !commandsByStatus(detected.commands).detected.some((item) => item.label === "Build")) {
    missing.push("Frontend project has no detected build command.");
  }
  if (!detected.documentation?.has_readme) missing.push("README.md is not detected.");
  if (!detected.environment?.has_example && detected.environment?.local_secret_files?.length) {
    missing.push("Local env files exist but no env example file was detected.");
  }
  return [...new Set(missing)];
}

function projectRiskSignals(detected) {
  const risks = [];
  if (!detected.has_git) risks.push("Git repository was not detected at this root.");
  for (const item of detected.dangerous_scripts || []) {
    risks.push(`Script \`${item.name}\` may be unsafe for automatic runs: ${item.reason}.`);
  }
  for (const file of detected.environment?.local_secret_files || []) {
    risks.push(`Local env file \`${file}\` exists; never copy secrets into Obsidian or chat.`);
  }
  if ((detected.is_bot || detected.is_api) && detected.environment?.local_secret_files?.length) {
    risks.push("Bot/API project likely depends on external credentials; smoke checks may call real services.");
  }
  if (!detected.quality_gaps?.length && !risks.length) return [];
  return [...new Set(risks)];
}

function projectRecommendedNextCommands(detected) {
  const commands = [
    "начни новую фичу: <описание>",
    "найди баг: <симптом или ошибка>",
    "сделай ревью",
    "обнови память проекта"
  ];
  if (detected.is_frontend) commands.splice(2, 0, "улучши frontend/design: <экран или компонент>");
  if (detected.quality_gaps?.length || detected.risk_signals?.length) commands.push("обнови базу знаний");
  if (detected.is_frontend) {
    commands.splice(
      2,
      0,
      "поддержи frontend/beta: <экран или компонент>",
      "проверь frontend quality gate",
      "проверь лендинг/конверсию: <страница>"
    );
  }
  return [...new Set(commands)];
}

async function projectTree(projectRoot, { maxDepth = 2, maxEntries = 160 } = {}) {
  const skip = new Set([
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "__pycache__"
  ]);
  const lines = [];

  async function walk(dir, depth) {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries = entries
      .filter((entry) => !skip.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      if (lines.length >= maxEntries) break;
      const full = path.join(dir, entry.name);
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- ${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(projectRoot, 0);
  if (lines.length >= maxEntries) lines.push("- ...truncated");
  return lines.join("\n") || "- Empty project directory";
}

function commandsTable(commands) {
  return [
    "| Task | Component | CWD | Command | Source |",
    "| --- | --- | --- | --- | --- |",
    ...commands.map((item) => `| ${mdCell(item.label)} | ${mdCell(item.component || "")} | ${mdCell(item.cwd || ".")} | ${mdCell(item.command)} | ${mdCell(item.source)} |`)
  ].join("\n");
}

function componentsTable(components = []) {
  if (!components.length) return "No project components detected.";
  return [
    "| Component | Path | Ecosystem | Types | Stack |",
    "| --- | --- | --- | --- | --- |",
    ...components.map((item) => `| ${mdCell(item.name)} | ${mdCell(item.path)} | ${mdCell(item.ecosystem)} | ${mdCell((item.project_types || []).join(", "))} | ${mdCell((item.stack || []).join(", "))} |`)
  ].join("\n");
}

function architectureMarkdown(architecture = {}) {
  const row = (label, values) => `- ${label}: ${(values || []).length ? values.map((item) => `\`${item}\``).join(", ") : "not detected"}`;
  return [
    row("Source roots", architecture.source_roots),
    row("Test roots", architecture.test_roots),
    row("Entrypoints", architecture.entrypoints),
    row("API surfaces", architecture.api_surfaces),
    row("Data and migrations", architecture.data_paths),
    row("CI workflows", architecture.ci)
  ].join("\n");
}

function scriptsTable(scripts) {
  const entries = Object.entries(scripts);
  if (!entries.length) return "No package scripts detected.";
  return [
    "| Script | Command |",
    "| --- | --- |",
    ...entries.map(([name, command]) => `| ${mdCell(name)} | ${mdCell(command)} |`)
  ].join("\n");
}

function autoCommandTable() {
  return [
    "| Phrase | Command | Primary skills |",
    "| --- | --- | --- |",
    ...autoCommands.map((command) => `| ${mdCell(command.display_name)} | \`${command.name}\` | ${mdCell(command.skills.join(", "))} |`)
  ].join("\n");
}

function agentStandardsMarkdown() {
  return `## Agent Standards

### Scope Control

- Keep changes scoped to the requested behavior.
- Prefer existing architecture, naming, components, utilities, and test style.
- Do not do unrelated refactors, formatting churn, dependency swaps, or file moves.
- Preserve user changes and never reset unrelated work.
- Do not introduce dependencies unless the benefit is clear and the project pattern supports it.

### Code Quality

- Read nearby code before editing.
- Keep changes small, reviewable, and reversible.
- Add or update tests for bug fixes, shared logic, data transformations, and user-visible behavior.
- Do not leave TODO placeholders or partial implementations in final work.
- Do not commit secrets, tokens, API keys, private credentials, or local-only config.

### Quality Gate

- Read \`.ai-dev/quality-gate.md\` before final verification.
- Run the narrowest relevant check first, then broader checks when shared behavior or build config is touched.
- If checks cannot run, report the exact reason.
- Do not mark work complete while relevant checks are failing.

### Frontend Quality Gate

- Verify responsive layout on desktop and mobile when UI changes are visible.
- Check loading, empty, error, hover, focus, and disabled states when touched.
- Ensure text does not overflow buttons, tables, cards, or navigation.
- Reuse the existing design system before adding one-off UI.
- For meaningful visual work, inspect the app in a browser or screenshot and report that verification.
`;
}

function autoCommandsMarkdown() {
  return `## Auto Commands

These phrases are shortcuts for repeatable agent workflows. When the user writes one of them, resolve it through the AI Dev System MCP auto-command tools.

${autoCommandTable()}

### Command Rule

- Match the user's phrase with \`match_auto_command\`.
- Read the selected runbook with \`read_auto_command\`.
- Use the listed skills and tools before editing.
- Follow the command guardrails and the project quality gate.
`;
}

function buildAgentsMd(detected) {
  return `# AGENTS.md

Generated by the AI Dev System project bootstrap command.

## Project

- Name: ${detected.project_name}
- Root: \`${detected.project_path}\`
- AI Dev System: \`${vaultRoot}\`
- Project brief: \`.ai-dev/project-brief.md\`
- Project map: \`.ai-dev/project-map.md\`
- Quality gate: \`.ai-dev/quality-gate.md\`

## Agent Startup

1. Read this file before changing code.
2. Read \`.ai-dev/project-brief.md\` for the short handoff memory.
3. Read \`.ai-dev/project-map.md\` for structure and known commands.
4. Read \`.ai-dev/quality-gate.md\` before final verification.
5. Inspect nearby code and existing patterns before editing.
6. For substantive work, call \`begin_task\`. It resolves canonical project identity and compiles a bounded task-specific context pack under \`.ai-dev/context/\`.
7. Inspect the returned context pack, keep acceptance criteria current with \`checkpoint_task\`, then use \`verify_task\` and \`complete_task\`.
8. Use the AI Dev System MCP tools for durable knowledge and skill routing:
   - \`project_identity\`
   - \`compile_project_context\`
   - \`project_context_status\`
   - \`match_auto_command\`
   - \`read_auto_command\`
   - \`search_knowledge\`
   - \`recommend_skills\`
   - \`search_skills\`
   - \`read_skill\`
9. For frontend product or visual work, call \`frontend_product_builder\` and pass the implementation gate before changing product UI code.

## Detected Stack

${asBulletList(detected.stack)}

Package manager: \`${detected.package_manager}\`

Project types: ${detected.project_types.map((item) => `\`${item}\``).join(", ")}

## Components

${componentsTable(detected.components)}

## Commands

${commandsTable(detected.commands)}

${agentStandardsMarkdown()}

${autoCommandsMarkdown()}

## Skill Routing

- New feature: use \`feature-builder\`.
- Bug or failing behavior: use \`bugfix-investigator\`.
- Code review or risk check: use \`code-reviewer\`.
- Frontend product/design: use \`frontend-product-builder\`, its one selected specialist, and \`frontend-quality-gate\`; never mix more than three skills.
- Knowledge updates: use \`knowledge-curator\`.

## Notes For Future Agents

- Update \`.ai-dev/project-map.md\` when the architecture or command surface changes.
- Update \`.ai-dev/quality-gate.md\` when scripts, frameworks, or release checks change.
`;
}

async function buildProjectMapMd(detected) {
  const tree = await projectTree(detected.project_path);
  return `# Project Map

Generated: ${new Date().toISOString()}

## Identity

- Name: ${detected.project_name}
- Root: \`${detected.project_path}\`
- Git repository detected: ${detected.has_git ? "yes" : "no"}
- Project types: ${detected.project_types.map((item) => `\`${item}\``).join(", ")}

## Stack

${asBulletList(detected.stack)}

Package manager: \`${detected.package_manager}\`

## Components

${componentsTable(detected.components)}

Workspace/monorepo detected: ${detected.workspace?.is_monorepo ? "yes" : "no"} (${detected.workspace?.component_count || 0} components).

## Architecture Inventory

${architectureMarkdown(detected.architecture)}

## Important Files And Folders

${asBulletList(detected.markers)}

## Documentation

${documentationMarkdown(detected)}

## Environment And Secrets Risk

${environmentMarkdown(detected)}

## Commands

${commandsTable(detected.commands)}

## Package Scripts

${scriptsTable(detected.scripts)}

## Quality Gaps

${detected.quality_gaps.length ? asBulletList(detected.quality_gaps) : "- No automatic quality gaps detected."}

## Risk Signals

${detected.risk_signals.length ? asBulletList(detected.risk_signals) : "- No automatic risk signals detected."}

## Recommended Next Commands

${asBulletList(detected.recommended_next_commands)}

## Top-Level Tree

\`\`\`text
${tree}
\`\`\`
`;
}

function documentationMarkdown(detected) {
  const files = detected.documentation?.files || [];
  if (!files.length) return "- Documentation scan not available.";
  return [
    "| Item | Status | Type |",
    "| --- | --- | --- |",
    ...files.map((item) => `| ${mdCell(item.path)} | ${item.exists ? "present" : "missing"} | ${mdCell(item.type)} |`)
  ].join("\n");
}

function environmentMarkdown(detected) {
  const env = detected.environment || { files: [], local_secret_files: [] };
  const lines = [];
  if (!env.files.length) {
    lines.push("- No `.env*` files detected by the lightweight scan.");
  } else {
    for (const file of env.files) {
      lines.push(`- \`${file.path}\`: ${file.type === "example" ? "example/template file" : "local secret-bearing file, do not copy contents into chat or Obsidian"}`);
    }
  }
  if (env.local_secret_files?.length && !env.has_example) {
    lines.push("- Local env files exist but no `.env.example`/sample file was detected.");
  }
  return lines.join("\n");
}

function dangerousScriptsMarkdown(detected) {
  const scripts = detected.dangerous_scripts || [];
  if (!scripts.length) return "- No package scripts were automatically flagged as side-effectful.";
  return scripts.map((item) => `- \`${item.name}\`: ${item.reason}. Command: \`${item.command}\``).join("\n");
}

function buildProjectBriefMd(detected) {
  return `# Project Brief

Generated: ${new Date().toISOString()}

This is the short handoff cache for Codex, Claude, and other agents. Read it before loading the larger project map.

## Identity

- Name: ${detected.project_name}
- Root: \`${detected.project_path}\`
- Git repository detected: ${detected.has_git ? "yes" : "no"}
- Project types: ${detected.project_types.map((item) => `\`${item}\``).join(", ")}
- Package manager: \`${detected.package_manager}\`

## Stack

${asBulletList(detected.stack)}

## Components

${componentsTable(detected.components)}

## Architecture Inventory

${architectureMarkdown(detected.architecture)}

## Important Files And Folders

${asBulletList(detected.markers)}

## Command Map

${commandsTable(detected.commands)}

## Quality Gaps

${detected.quality_gaps.length ? asBulletList(detected.quality_gaps) : "- No automatic quality gaps detected."}

## Risk Signals

${detected.risk_signals.length ? asBulletList(detected.risk_signals) : "- No automatic risk signals detected."}

## Dangerous Or Side-Effectful Scripts

${dangerousScriptsMarkdown(detected)}

## Documentation

${documentationMarkdown(detected)}

## Environment And Secrets

${environmentMarkdown(detected)}

## Recommended Skills

${recommendedSkillsMarkdown(detected)}

## Recommended Next Commands

${asBulletList(detected.recommended_next_commands)}

## Agent Handoff Rule

- Do not load the whole repository into chat context.
- Use this file for quick orientation, then \`.ai-dev/project-map.md\` for structure and \`.ai-dev/quality-gate.md\` for verification.
- Use MCP search for specific files, commands, risks, and skills.
- Do not run side-effectful scripts without explicit user approval.
`;
}

function buildQualityGateMd(detected) {
  const verificationCommands = detected.commands
    .filter((item) => ["Lint", "Typecheck", "Test", "Build"].includes(item.label))
    .filter((item) => item.command !== "Not detected");
  const commandList = verificationCommands.length
    ? verificationCommands.map((item) => `- ${item.label}${item.cwd && item.cwd !== "." ? ` [cwd=${item.cwd}]` : ""}: \`${item.command}\``).join("\n")
    : "- No verification commands were detected. Inspect project scripts and choose the closest available checks.";

  const frontendChecklist = detected.is_frontend
    ? `
## Frontend QA

- Check desktop and mobile layouts.
- Check loading, empty, and error states when touched by the task.
- Verify text does not overflow buttons, cards, tables, or navigation.
- Verify interactive controls have clear hover/focus/disabled states.
- For visual changes, run or open the app and inspect the changed screens.
- When Playwright is available, run MCP \`run_frontend_qa\` for desktop/mobile screenshots, console errors, overflow, and basic accessibility.
- For product/design work, ordinary \`run_frontend_qa\` is not sufficient: require an approved direction and design system, then use \`run_visual_reference_qa\`, independent \`record_visual_review\`, and \`frontend_product_gate\` with \`gate=handoff\`.
- Check hierarchy, composition, typography, density, action clarity, content quality, asset authenticity, mobile UX, state coverage, and brand coherence separately. Do not use one overall design score.
- For handoff or beta release, use the \`frontend-quality-gate\` skill and report Gate: pass, warn, or block.
`
    : "";

  return `# Quality Gate

Generated: ${new Date().toISOString()}

## Default Verification

${commandList}

## Missing Checks

${detected.quality_gaps.length ? asBulletList(detected.quality_gaps) : "- No missing checks were automatically detected."}

## Unsafe Or Manual Commands

${dangerousScriptsMarkdown(detected)}

## Minimum Standard

- Run the narrowest fast check that proves the change.
- Run broader checks when touching shared utilities, build config, routing, auth, data models, or UI foundations.
- If a check is unavailable or cannot run locally, record the reason in the final response.
- Do not mark the task complete while known relevant checks are failing.
${frontendChecklist}
## Final Response Checklist

- Mention changed files.
- Mention checks run and results.
- Mention any skipped checks or residual risk.
`;
}

function buildAiDevReadmeMd(detected) {
  return `# .ai-dev

This folder is managed by the AI Dev System.

- \`project-brief.md\` is the short handoff cache for Codex, Claude, and other agents.
- \`project-map.md\` keeps the agent-facing map of this repository.
- \`quality-gate.md\` defines the verification standard for local changes.
- \`frontend/\` contains Frontend Product Quality v2 context, approvals, references, and visual evidence when this is a frontend project.
- Root \`AGENTS.md\` is the first file agents should read in this project.

Project: ${detected.project_name}
`;
}

async function writeProjectFile(projectRoot, relativePath, content, overwrite) {
  const target = safeProjectFile(projectRoot, relativePath);
  const exists = await pathExists(target);
  if (exists && !overwrite) {
    return { action: "skipped", path: relativePath, reason: "already exists" };
  }

  await atomicWriteFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  markSearchIndexDirty(`project file written: ${target}`);
  return { action: exists ? "overwritten" : "created", path: relativePath };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashProjectFile(projectRoot, relativePath) {
  const target = safeProjectFile(projectRoot, relativePath);
  return sha256(await fs.readFile(target));
}

async function frontendProductDocumentHashes(projectRoot) {
  return {
    design_brief: await hashProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.designBrief),
    design_system: await hashProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.designSystem),
    ui_inventory: await hashProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.uiInventory),
    visual_acceptance: await hashProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.visualAcceptance)
  };
}

async function readFrontendProductDocuments(projectRoot) {
  return {
    designSystem: await fs.readFile(
      safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.designSystem),
      "utf8"
    ),
    uiInventory: await fs.readFile(
      safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.uiInventory),
      "utf8"
    ),
    visualAcceptance: await fs.readFile(
      safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.visualAcceptance),
      "utf8"
    )
  };
}

async function readFrontendProductState(projectRoot, { required = true } = {}) {
  const target = safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.state);
  const state = await readJsonIfExists(target);
  if (!state && required) {
    throw new Error(
      `Frontend Product Quality is not prepared. Run prepare_frontend_product first: ${FRONTEND_PRODUCT_PATHS.state}`
    );
  }
  return state;
}

async function writeFrontendProductState(projectRoot, state) {
  const target = safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.state);
  const next = {
    ...state,
    updated_at: new Date().toISOString()
  };
  await atomicWriteJson(target, next);
  markSearchIndexDirty(`frontend product state written: ${target}`);
  return next;
}

function isFrontendManagedProjectPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
  return normalized === FRONTEND_PRODUCT_PATHS.root ||
    normalized.startsWith(`${FRONTEND_PRODUCT_PATHS.root}/`);
}

async function frontendApplicationBaseline(projectRoot) {
  const projectState = await captureProjectState(projectRoot);
  const applicationDirtyFiles = (projectState.dirty_files || [])
    .map((value) => String(value).replaceAll("\\", "/"))
    .filter((value) => !isFrontendManagedProjectPath(value))
    .sort();
  const dirtyFileHashes = {};
  for (const relativePath of applicationDirtyFiles) {
    try {
      const target = safeProjectFile(projectRoot, relativePath);
      dirtyFileHashes[relativePath] = sha256(await fs.readFile(target));
    } catch {
      dirtyFileHashes[relativePath] = "missing-or-non-file";
    }
  }
  return {
    ...projectState,
    application_dirty_files: applicationDirtyFiles,
    application_dirty_hashes: dirtyFileHashes
  };
}

function frontendPreApprovalChanges(preparationBaseline, currentBaseline) {
  if (!preparationBaseline) {
    return currentBaseline.application_dirty_files || [];
  }
  const changes = [];
  if (
    preparationBaseline.git &&
    currentBaseline.git &&
    preparationBaseline.head !== currentBaseline.head
  ) {
    changes.push(`git HEAD changed from ${preparationBaseline.head || "unknown"} to ${currentBaseline.head || "unknown"}`);
  } else if (Boolean(preparationBaseline.git) !== Boolean(currentBaseline.git)) {
    changes.push("repository Git state changed after frontend preparation");
  }

  const beforeHashes = preparationBaseline.application_dirty_hashes || {};
  const afterHashes = currentBaseline.application_dirty_hashes || {};
  for (const relativePath of new Set([
    ...Object.keys(beforeHashes),
    ...Object.keys(afterHashes)
  ])) {
    if (beforeHashes[relativePath] !== afterHashes[relativePath]) {
      changes.push(relativePath);
    }
  }
  return [...new Set(changes)];
}

function normalizeFrontendProductReference(reference) {
  const generation = isPlainObject(reference?.generation)
    ? {
      factory_schema_version: Number(reference.generation.factory_schema_version || 0),
      manifest_id: String(reference.generation.manifest_id || "").trim(),
      artifact_id: String(reference.generation.artifact_id || "").trim(),
      prompt_sha256: String(reference.generation.prompt_sha256 || "").trim(),
      file_sha256: String(reference.generation.file_sha256 || "").trim(),
      width: Number(reference.generation.width || 0),
      height: Number(reference.generation.height || 0),
      inspection_method: String(reference.generation.inspection_method || "").trim(),
      inspection_observations: String(reference.generation.inspection_observations || "").trim()
    }
    : undefined;
  return {
    id: String(reference?.id || "").trim(),
    label: String(reference?.label || "").trim(),
    kind: String(reference?.kind || "").trim(),
    role: String(reference?.role || "baseline").trim(),
    direction_id: String(reference?.direction_id || "").trim(),
    value: String(reference?.value || "").trim(),
    purpose: String(reference?.purpose || "").trim(),
    routes: searchEvalList(reference?.routes),
    viewports: searchEvalList(reference?.viewports),
    states: searchEvalList(reference?.states),
    ...(generation ? { generation } : {})
  };
}

function normalizeFrontendDirection(direction) {
  return {
    id: String(direction?.id || "").trim(),
    name: String(direction?.name || "").trim(),
    rationale: String(direction?.rationale || "").trim(),
    reference_ids: searchEvalList(direction?.reference_ids),
    artifacts: searchEvalList(direction?.artifacts),
    tradeoffs: searchEvalList(direction?.tradeoffs)
  };
}

async function validateFrontendReferenceFiles(projectRoot, references, directions = []) {
  const errors = [];
  for (const reference of references || []) {
    if (reference.kind !== "local-image") continue;
    let target;
    try {
      target = safeProjectFile(projectRoot, reference.value);
    } catch (error) {
      errors.push(`Reference "${reference.id}" has an unsafe path: ${error.message}`);
      continue;
    }
    const relative = path.relative(
      safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.references),
      target
    );
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push(`Reference "${reference.id}" must be inside ${FRONTEND_PRODUCT_PATHS.references}.`);
    } else if (!(await pathExists(target))) {
      errors.push(`Reference "${reference.id}" file does not exist: ${reference.value}.`);
    }
  }

  for (const direction of directions || []) {
    for (const artifact of direction.artifacts || []) {
      if (/^https?:\/\//i.test(artifact)) continue;
      let target;
      try {
        target = safeProjectFile(projectRoot, artifact);
      } catch (error) {
        errors.push(`Direction "${direction.id}" has an unsafe artifact path: ${error.message}`);
        continue;
      }
      const relative = path.relative(
        safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.references),
        target
      );
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        errors.push(`Direction "${direction.id}" artifact must be inside ${FRONTEND_PRODUCT_PATHS.references}.`);
      } else if (!(await pathExists(target))) {
        errors.push(`Direction "${direction.id}" artifact does not exist: ${artifact}.`);
      }
    }
  }
  return errors;
}

function frontendArtifactPart(value, fallback = "default") {
  return String(value || fallback)
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function referencesForApprovedDirection(state) {
  const approvedDirectionId = state.approvals?.direction?.direction_id || "";
  const selectedReferenceIds = new Set(
    (state.directions || [])
      .find((item) => item.id === approvedDirectionId)
      ?.reference_ids || []
  );
  const hasGeneratedBaselines = (state.references || []).some((reference) => (
    (reference.role || "baseline") === "baseline" &&
    reference.direction_id === approvedDirectionId
  ));
  return (state.references || []).filter((reference) => {
    const role = reference.role || "baseline";
    if (role === "inspiration") return false;
    if (role === "candidate") {
      return !hasGeneratedBaselines && selectedReferenceIds.has(reference.id);
    }
    if (reference.direction_id && reference.direction_id !== approvedDirectionId) return false;
    return true;
  });
}

function referenceFactoryCoverageErrors(state) {
  const factory = state.reference_factory;
  if (!factory?.concepts || factory.concepts.status !== "registered") return [];
  if (!state.approvals?.direction?.direction_id) return [];
  if (factory.coverage?.status !== "registered") {
    return [
      "Reference Factory concept directions are registered, but approved-direction baseline coverage is missing. " +
      "Run plan_frontend_references with stage=coverage and register_frontend_references before design-system approval."
    ];
  }
  if (factory.coverage.approved_direction_id !== state.approvals.direction.direction_id) {
    return ["Reference Factory baseline coverage belongs to a different approved direction."];
  }
  return [];
}

async function materializeApprovedVisualBaselines(projectRoot, references) {
  const approvedRoot = safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.approvedReferences);
  await fs.mkdir(approvedRoot, { recursive: true });
  const copied = [];
  for (const reference of references || []) {
    if (reference.kind !== "local-image" || path.extname(reference.value).toLowerCase() !== ".png") {
      continue;
    }
    const source = safeProjectFile(projectRoot, reference.value);
    const routes = reference.routes?.length ? reference.routes : ["/"];
    const viewports = reference.viewports?.length ? reference.viewports : [];
    const states = reference.states?.length ? reference.states : ["default"];
    for (const route of routes) {
      for (const viewport of viewports) {
        for (const state of states) {
          const fileName = [
            frontendArtifactPart(route, "root"),
            frontendArtifactPart(viewport, "viewport"),
            frontendArtifactPart(state)
          ].join("__") + ".png";
          const target = path.join(approvedRoot, fileName);
          await fs.copyFile(source, target);
          copied.push({
            reference_id: reference.id,
            route,
            viewport,
            state,
            path: path.relative(projectRoot, target).replaceAll("\\", "/"),
            sha256: await hashProjectFile(
              projectRoot,
              path.relative(projectRoot, target).replaceAll("\\", "/")
            )
          });
        }
      }
    }
  }
  return copied;
}

function referenceFactoryManifestRelativePath(manifestId) {
  if (!/^rf-\d{14}-[a-f0-9]{10}$/.test(String(manifestId || ""))) {
    throw new Error("Invalid Reference Factory manifest id.");
  }
  return `${FRONTEND_PRODUCT_PATHS.referenceFactoryManifests}/${manifestId}.json`;
}

function referenceFactoryPlanRelativePath(manifestId) {
  if (!/^rf-\d{14}-[a-f0-9]{10}$/.test(String(manifestId || ""))) {
    throw new Error("Invalid Reference Factory manifest id.");
  }
  return `${FRONTEND_PRODUCT_PATHS.referenceFactoryPlans}/${manifestId}.md`;
}

async function readReferenceFactoryManifest(projectRoot, manifestId) {
  const relativePath = referenceFactoryManifestRelativePath(manifestId);
  const manifest = await readJsonIfExists(safeProjectFile(projectRoot, relativePath));
  if (!manifest) throw new Error(`Reference Factory manifest not found: ${manifestId}.`);
  return { manifest, relativePath };
}

function inspectPngStructure(buffer) {
  const errors = [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    return { width: 0, height: 0, errors: ["File is not a PNG image."] };
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasIdat = false;
  let hasIend = false;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (next > buffer.length) {
      errors.push("PNG chunk exceeds file length.");
      break;
    }
    const type = buffer.toString("ascii", typeStart, typeStart + 4);
    if (chunkIndex === 0 && type !== "IHDR") errors.push("PNG must start with IHDR.");
    if (type === "IHDR") {
      if (length !== 13) errors.push("PNG IHDR has an invalid length.");
      if (length >= 8) {
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
      }
    }
    if (type === "IDAT") hasIdat = true;
    if (type === "IEND") {
      hasIend = true;
      break;
    }
    offset = next;
    chunkIndex += 1;
  }
  if (!width || !height) errors.push("PNG dimensions are missing or invalid.");
  if (!hasIdat) errors.push("PNG has no image-data chunk.");
  if (!hasIend) errors.push("PNG has no end chunk.");
  return { width, height, errors };
}

async function inspectReferenceFactoryPng(projectRoot, artifact) {
  const target = safeProjectFile(projectRoot, artifact.output_path);
  const generatedRoot = safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.generatedReferences);
  if (!isPathInside(generatedRoot, target)) {
    return { errors: [`Artifact "${artifact.id}" is outside the generated-reference directory.`] };
  }
  if (!(await pathExists(target))) {
    return { errors: [`Generated PNG does not exist: ${artifact.output_path}.`] };
  }
  const buffer = await fs.readFile(target);
  const structure = inspectPngStructure(buffer);
  const errors = structure.errors.map((item) => `Artifact "${artifact.id}": ${item}`);
  if (buffer.length < 256) {
    errors.push(`Artifact "${artifact.id}" is implausibly small for an inspectable reference.`);
  }
  const portrait = structure.height > structure.width;
  if (artifact.orientation === "portrait" && !portrait) {
    errors.push(`Artifact "${artifact.id}" must be portrait.`);
  }
  if (artifact.orientation === "landscape" && portrait) {
    errors.push(`Artifact "${artifact.id}" must be landscape.`);
  }
  const minimumWidth = artifact.orientation === "portrait" ? 320 : 800;
  const minimumHeight = artifact.orientation === "portrait" ? 568 : 450;
  if (structure.width < minimumWidth || structure.height < minimumHeight) {
    errors.push(
      `Artifact "${artifact.id}" is too small: ${structure.width}x${structure.height}; ` +
      `minimum ${minimumWidth}x${minimumHeight}.`
    );
  }
  return {
    path: artifact.output_path,
    width: structure.width,
    height: structure.height,
    size_bytes: buffer.length,
    sha256: sha256(buffer),
    perceptual_hash: (() => {
      try {
        return pngDifferenceHash(buffer);
      } catch (error) {
        errors.push(`Artifact "${artifact.id}": ${String(error.message || error)}`);
        return "";
      }
    })(),
    errors
  };
}

function referenceFactoryEntry(manifest, manifestPath, planPath, status = "planned") {
  return {
    manifest_id: manifest.id,
    manifest_path: manifestPath,
    plan_path: planPath,
    manifest_fingerprint: manifest.manifest_fingerprint,
    context_fingerprint: manifest.context_fingerprint,
    approved_direction_id: manifest.approved_direction_id,
    surface: manifest.surface,
    generator: manifest.generator,
    artifact_count: manifest.artifacts.length,
    status,
    updated_at: new Date().toISOString()
  };
}

async function planFrontendReferences({
  project_path,
  task = "",
  stage = "auto",
  surface = "",
  generator = "imagegen",
  direction_count = 3,
  artifact_budget = 32
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  let conceptManifest = null;
  if ((stage === "coverage" || (stage === "auto" && state.approvals?.direction))) {
    const conceptManifestId = state.reference_factory?.concepts?.manifest_id;
    if (conceptManifestId) {
      conceptManifest = (await readReferenceFactoryManifest(projectRoot, conceptManifestId)).manifest;
    }
  }

  let manifest;
  try {
    manifest = createReferenceFactoryManifest({
      state,
      task,
      stage,
      surface,
      generator,
      directionCount: Number(direction_count),
      artifactBudget: Number(artifact_budget),
      conceptManifest
    });
  } catch (error) {
    return {
      action: "rejected",
      project_path: projectRoot,
      errors: String(error.message || error).split("\n").filter(Boolean)
    };
  }
  const manifestErrors = validateReferenceFactoryManifest(manifest, { state });
  if (manifestErrors.length) {
    return { action: "rejected", project_path: projectRoot, errors: manifestErrors };
  }

  const manifestPath = referenceFactoryManifestRelativePath(manifest.id);
  const planPath = referenceFactoryPlanRelativePath(manifest.id);
  await fs.mkdir(
    safeProjectFile(projectRoot, `${FRONTEND_PRODUCT_PATHS.generatedReferences}/${manifest.id}`),
    { recursive: true }
  );
  await atomicWriteJson(safeProjectFile(projectRoot, manifestPath), manifest);
  await atomicWriteFile(
    safeProjectFile(projectRoot, planPath),
    renderReferenceFactoryPlan(manifest),
    "utf8"
  );

  const factory = {
    schema_version: 1,
    ...(state.reference_factory || {}),
    surface: manifest.surface,
    selected_skills: manifest.selected_skills,
    [manifest.stage]: referenceFactoryEntry(manifest, manifestPath, planPath)
  };
  const resetForConcepts = manifest.stage === "concepts"
    ? {
      phase: "brief",
      directions: [],
      references: (state.references || []).filter((reference) => (
        reference.generation?.factory_schema_version !== 1
      )),
      approvals: { direction: null, design_system: null },
      concept_jury: null,
      latest_visual_run: null,
      visual_reviews: []
    }
    : {
      phase: "direction-approved",
      approvals: {
        ...(state.approvals || {}),
        design_system: null
      },
      latest_visual_run: null,
      visual_reviews: []
    };
  const saved = await writeFrontendProductState(projectRoot, {
    ...state,
    ...resetForConcepts,
    selected_skills: manifest.selected_skills,
    reference_factory: factory
  });
  markSearchIndexDirty(`reference factory planned: ${manifestPath}`);
  return {
    action: "frontend_references_planned",
    project_path: projectRoot,
    phase: saved.phase,
    stage: manifest.stage,
    manifest_id: manifest.id,
    manifest_path: manifestPath,
    plan_path: planPath,
    surface: manifest.surface,
    generator: manifest.generator,
    selected_skills: manifest.selected_skills,
    artifact_count: manifest.artifacts.length,
    artifact_jobs: manifest.artifacts.map((artifact) => ({
      artifact_id: artifact.id,
      direction_id: artifact.direction_id,
      output_path: artifact.output_path,
      width: artifact.width,
      height: artifact.height,
      prompt: artifact.prompt,
      prompt_sha256: artifact.prompt_sha256,
      negative_prompt: artifact.negative_prompt
    })),
    tool_handoff: manifest.generator === "figma"
      ? "Create each frame in Figma, export every planned artifact as PNG, inspect it, then call register_frontend_references."
      : "Call ImageGen for every artifact job, save each PNG at output_path, inspect it with view_image, then call register_frontend_references.",
    next_step: "Generate every planned artifact and register only visually inspected outputs."
  };
}

async function registerFrontendReferences({
  project_path,
  manifest_id,
  outputs = []
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const { manifest, relativePath: manifestPath } = await readReferenceFactoryManifest(
    projectRoot,
    manifest_id
  );
  const errors = [
    ...validateReferenceFactoryManifest(manifest, { state }),
    ...validateReferenceFactoryOutputs(manifest, outputs)
  ];
  if (state.reference_factory?.[manifest.stage]?.manifest_id !== manifest.id) {
    errors.push("Reference Factory manifest is not the active plan for this stage.");
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      manifest_id,
      errors: [...new Set(errors)]
    };
  }
  const fileMetadata = {};
  const seenHashes = new Map();
  for (const artifact of manifest.artifacts || []) {
    const metadata = await inspectReferenceFactoryPng(projectRoot, artifact);
    fileMetadata[artifact.id] = metadata;
    errors.push(...(metadata.errors || []));
    if (metadata.sha256) {
      const previous = seenHashes.get(metadata.sha256);
      if (previous) {
        errors.push(
          `Artifacts "${previous}" and "${artifact.id}" are byte-identical; distinct jobs require distinct inspected images.`
        );
      } else {
        seenHashes.set(metadata.sha256, artifact.id);
      }
    }
  }
  if (manifest.stage === "concepts") {
    const artifactsById = new Map((manifest.artifacts || []).map((artifact) => [artifact.id, artifact]));
    const nearDuplicates = findNearDuplicateImages(
      Object.entries(fileMetadata).map(([id, metadata]) => ({
        id,
        direction_id: artifactsById.get(id)?.direction_id,
        comparison_group: [
          artifactsById.get(id)?.scope,
          artifactsById.get(id)?.viewport,
          artifactsById.get(id)?.state,
          artifactsById.get(id)?.orientation
        ].join("|"),
        perceptual_hash: metadata.perceptual_hash
      })),
      {
        maximumDistance: 6,
        comparable: (left, right) => (
          left.direction_id !== right.direction_id &&
          left.comparison_group === right.comparison_group
        )
      }
    );
    for (const duplicate of nearDuplicates) {
      errors.push(
        `Artifacts "${duplicate.left_id}" and "${duplicate.right_id}" are perceptually near-identical ` +
        `(distance ${duplicate.distance}/${128}); visual directions must differ in composition, not only styling.`
      );
    }
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      manifest_id,
      errors: [...new Set(errors)]
    };
  }

  const registration = buildReferenceFactoryRegistration(manifest, outputs, fileMetadata);
  let saved;
  if (manifest.stage === "concepts") {
    const retained = (state.references || []).filter((reference) => (
      reference.generation?.factory_schema_version !== 1
    ));
    const brief = await updateFrontendProductBrief({
      project_path: projectRoot,
      context: state.context,
      references: [...retained, ...registration.references],
      anti_slop_exceptions: state.anti_slop_exceptions || []
    });
    if (brief.blockers.length) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: brief.blockers
      };
    }
    const directions = await recordFrontendDirections({
      project_path: projectRoot,
      directions: registration.directions
    });
    if (directions.action === "rejected") return directions;
    saved = await readFrontendProductState(projectRoot);
  } else {
    if (manifest.approved_direction_id !== state.approvals?.direction?.direction_id) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: ["Coverage manifest no longer matches the approved direction."]
      };
    }
    const retained = (state.references || []).filter((reference) => !(
      reference.role === "baseline" &&
      reference.direction_id === manifest.approved_direction_id &&
      reference.generation?.factory_schema_version === 1
    ));
    const references = [...retained, ...registration.references].map(normalizeFrontendProductReference);
    const referenceErrors = [
      ...validateFrontendReferences(references),
      ...await validateFrontendReferenceFiles(projectRoot, references, state.directions)
    ];
    if (referenceErrors.length) {
      return {
        action: "rejected",
        project_path: projectRoot,
        manifest_id,
        errors: referenceErrors
      };
    }
    saved = await writeFrontendProductState(projectRoot, {
      ...state,
      phase: "direction-approved",
      references,
      approvals: {
        ...(state.approvals || {}),
        design_system: null
      },
      latest_visual_run: null,
      visual_reviews: []
    });
  }

  const registeredAt = new Date().toISOString();
  const registeredManifest = updateReferenceFactoryManifest(manifest, {
    status: "registered",
    registered_at: registeredAt,
    updated_at: registeredAt,
    outputs: manifest.artifacts.map((artifact) => ({
      artifact_id: artifact.id,
      path: artifact.output_path,
      prompt_sha256: artifact.prompt_sha256,
      file_sha256: fileMetadata[artifact.id].sha256,
      perceptual_hash: fileMetadata[artifact.id].perceptual_hash,
      width: fileMetadata[artifact.id].width,
      height: fileMetadata[artifact.id].height,
      inspection: outputs.find((item) => item.artifact_id === artifact.id)?.inspection
    }))
  });
  await atomicWriteJson(safeProjectFile(projectRoot, manifestPath), registeredManifest);
  const planPath = referenceFactoryPlanRelativePath(manifest.id);
  const factory = {
    schema_version: 1,
    ...(saved.reference_factory || {}),
    surface: manifest.surface,
    generator: manifest.generator,
    selected_skills: manifest.selected_skills,
    [manifest.stage]: {
      ...referenceFactoryEntry(
        registeredManifest,
        manifestPath,
        planPath,
        "registered"
      ),
      registered_at: registeredAt
    }
  };
  saved = await writeFrontendProductState(projectRoot, {
    ...saved,
    reference_factory: factory
  });
  markSearchIndexDirty(`reference factory registered: ${manifestPath}`);
  return {
    action: manifest.stage === "concepts"
      ? "frontend_reference_concepts_registered"
      : "frontend_reference_coverage_registered",
    project_path: projectRoot,
    manifest_id,
    stage: manifest.stage,
    phase: saved.phase,
    references_registered: registration.references.map((item) => item.id),
    directions_registered: registration.directions.map((item) => item.id),
    file_evidence: Object.fromEntries(Object.entries(fileMetadata).map(([id, metadata]) => [
      id,
      {
        path: metadata.path,
        width: metadata.width,
        height: metadata.height,
        size_bytes: metadata.size_bytes,
        sha256: metadata.sha256,
        perceptual_hash: metadata.perceptual_hash
      }
    ])),
    next_step: manifest.stage === "concepts"
      ? "Run an independent Concept Jury, approve its recommended direction, then plan stage=coverage."
      : "Complete the design system, UI inventory, and visual acceptance documents, then approve the design system."
  };
}

async function referenceFactoryStatus({ project_path }) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot, { required: false });
  if (!state) {
    return {
      project_path: projectRoot,
      prepared: false,
      next_step: "Run prepare_frontend_product before Reference Factory."
    };
  }
  const factory = state.reference_factory || null;
  let nextStep = "Run plan_frontend_references with stage=concepts.";
  if (factory?.concepts?.status === "planned") {
    nextStep = "Generate, inspect, and register every concept artifact.";
  } else if (factory?.concepts?.status === "registered" && !state.concept_jury) {
    nextStep = "Run record_frontend_concept_jury with an independent reviewer.";
  } else if (factory?.concepts?.status === "registered" && !state.approvals?.direction) {
    nextStep = "Approve the direction recommended by Concept Jury.";
  } else if (factory?.coverage?.status === "planned") {
    nextStep = "Generate, inspect, and register every approved-direction baseline.";
  } else if (state.approvals?.direction && factory?.coverage?.status !== "registered") {
    nextStep = "Run plan_frontend_references with stage=coverage.";
  } else if (factory?.coverage?.status === "registered" && !state.approvals?.design_system) {
    nextStep = "Complete and approve the project design system.";
  } else if (state.approvals?.design_system) {
    nextStep = "Implementation may proceed while frontend_product_gate remains green.";
  }
  return {
    project_path: projectRoot,
    prepared: true,
    phase: state.phase,
    selected_skills: state.selected_skills,
    reference_factory: factory,
    concept_jury: state.concept_jury || null,
    approved_direction: state.approvals?.direction || null,
    design_system_approved: Boolean(state.approvals?.design_system),
    coverage_blockers: referenceFactoryCoverageErrors(state),
    next_step: nextStep
  };
}

async function prepareFrontendProduct({
  project_path,
  project_name = "",
  mode = "new",
  implementer = "",
  context = {},
  overwrite = false
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const detected = await detectProject(projectRoot, project_name);
  const stateTarget = safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.state);
  const existing = await readJsonIfExists(stateTarget);
  const preparationBaseline = !existing || overwrite
    ? await frontendApplicationBaseline(projectRoot)
    : existing.preparation_baseline;
  const state = existing && !overwrite
    ? existing
    : {
      ...createFrontendProductState({
        projectName: project_name || detected.project_name,
        mode,
        implementer,
        context
      }),
      preparation_baseline: preparationBaseline
    };
  const results = [];
  for (const [relativePath, content] of buildFrontendProductFiles(state)) {
    results.push(await writeProjectFile(projectRoot, relativePath, content, overwrite));
  }
  await fs.mkdir(
    safeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.approvedReferences),
    { recursive: true }
  );
  if (!existing || overwrite) {
    await atomicWriteJson(stateTarget, state);
    results.push({
      action: existing ? "overwritten" : "created",
      path: FRONTEND_PRODUCT_PATHS.state
    });
  } else {
    results.push({
      action: "skipped",
      path: FRONTEND_PRODUCT_PATHS.state,
      reason: "already exists"
    });
  }
  markSearchIndexDirty(`frontend product prepared: ${projectRoot}`);
  return {
    action: "frontend_product_prepared",
    project_name: state.project_name,
    project_path: projectRoot,
    mode: state.mode,
    phase: state.phase,
    selected_skills: state.selected_skills,
    preparation_baseline: state.preparation_baseline,
    created: results.filter((item) => item.action === "created").map((item) => item.path),
    overwritten: results.filter((item) => item.action === "overwritten").map((item) => item.path),
    skipped: results.filter((item) => item.action === "skipped"),
    blockers: [
      ...validateFrontendProductContext(state.context),
      ...validateFrontendReferences(state.references),
      ...validateFrontendDirections(state.directions, state.references)
    ],
    next_step: "Complete the product context and references, then record two or three visual directions."
  };
}

async function frontendProductBuilder({
  project_path,
  mode = "",
  task = ""
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot, { required: false });
  const selectedMode = mode || state?.mode || (
    taskLooksLandingConversion(task) ? "landing"
      : taskLooksBetaFrontend(task) ? "maintenance"
        : /redesign|upgrade.*ui/i.test(task) ? "redesign"
          : "new"
  );
  let gate = null;
  if (state) {
    const hashes = state.approvals?.design_system
      ? await frontendProductDocumentHashes(projectRoot).catch(() => ({}))
      : {};
    gate = evaluateFrontendProductGate(state, {
      gate: "implementation",
      currentDocumentHashes: hashes
    });
  }
  return {
    project_path: projectRoot,
    prepared: Boolean(state),
    mode: selectedMode,
    phase: state?.phase || "not-prepared",
    selected_skills: state?.selected_skills || selectFrontendProductSkills({ mode: selectedMode }),
    max_skills: 3,
    implementation_gate: gate,
    workflow: [
      "prepare_frontend_product",
      "update_frontend_product_brief",
      "when references do not exist: plan_frontend_references -> generate and inspect artifacts -> register_frontend_references",
      "record_frontend_directions (automatic after Reference Factory concept registration, manual for external references)",
      "approve_frontend_direction",
      "after Reference Factory direction approval: plan_frontend_references stage=coverage -> register_frontend_references",
      "approve_frontend_design_system",
      "frontend_product_gate",
      "implement only after the implementation gate passes",
      "run_visual_reference_qa",
      "record_visual_review",
      "frontend_product_gate with gate=handoff"
    ]
  };
}

async function updateFrontendProductBrief({
  project_path,
  context = {},
  references = [],
  anti_slop_exceptions = []
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const next = {
    ...state,
    phase: "brief",
    context: {
      ...(state.context || {}),
      ...Object.fromEntries(Object.entries(context || {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? searchEvalList(value) : String(value ?? "").trim()
      ]))
    },
    references: references.map(normalizeFrontendProductReference),
    anti_slop_exceptions: anti_slop_exceptions.map((item) => ({
      rule_id: String(item?.rule_id || "").trim(),
      rationale: String(item?.rationale || "").trim(),
      approver: String(item?.approver || "").trim()
    })),
    reference_factory: null,
    concept_jury: null,
    approvals: { direction: null, design_system: null },
    latest_visual_run: null,
    visual_reviews: []
  };
  const saved = await writeFrontendProductState(projectRoot, next);
  const brief = buildFrontendProductFiles(saved).get(FRONTEND_PRODUCT_PATHS.designBrief);
  await writeProjectFile(projectRoot, FRONTEND_PRODUCT_PATHS.designBrief, brief, true);
  return {
    action: "frontend_product_brief_updated",
    project_path: projectRoot,
    phase: saved.phase,
    blockers: [
      ...validateFrontendProductContext(saved.context),
      ...validateFrontendReferences(saved.references),
      ...await validateFrontendReferenceFiles(projectRoot, saved.references)
    ],
    invalidated: ["direction approval", "design-system approval", "visual QA and review"]
  };
}

async function recordFrontendDirections({
  project_path,
  directions
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const normalized = directions.map(normalizeFrontendDirection);
  const errors = [
    ...validateFrontendProductContext(state.context),
    ...validateFrontendReferences(state.references),
    ...validateFrontendDirections(normalized, state.references),
    ...await validateFrontendReferenceFiles(projectRoot, state.references, normalized)
  ];
  if (errors.length) {
    return { action: "rejected", project_path: projectRoot, errors };
  }
  const saved = await writeFrontendProductState(projectRoot, {
    ...state,
    phase: "directions-ready",
    directions: normalized,
    concept_jury: null,
    approvals: { direction: null, design_system: null },
    latest_visual_run: null,
    visual_reviews: []
  });
  return {
    action: "frontend_directions_recorded",
    project_path: projectRoot,
    phase: saved.phase,
    direction_ids: saved.directions.map((item) => item.id),
    next_step: state.reference_factory?.concepts?.status === "registered"
      ? "Run an independent Concept Jury before direction approval."
      : "Approve exactly one direction before completing the project design system."
  };
}

async function recordFrontendConceptJury({
  project_path,
  reviewer,
  independent_from_implementer = false,
  comparison,
  direction_reviews
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const fileErrors = await validateFrontendReferenceFiles(
    projectRoot,
    state.references,
    state.directions
  );
  if (fileErrors.length) return { action: "rejected", project_path: projectRoot, errors: fileErrors };
  const result = recordConceptJuryState(state, {
    reviewer,
    independentFromImplementer: independent_from_implementer,
    comparison,
    directionReviews: direction_reviews
  });
  if (!result.ok) return { action: "rejected", project_path: projectRoot, errors: result.errors };
  const saved = await writeFrontendProductState(projectRoot, result.state);
  return {
    action: "frontend_concept_jury_recorded",
    project_path: projectRoot,
    phase: saved.phase,
    concept_jury: saved.concept_jury,
    next_step: `Approve direction "${saved.concept_jury.recommended_direction_id}".`
  };
}

async function approveFrontendDirection({
  project_path,
  direction_id,
  approver,
  evidence
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const fileErrors = await validateFrontendReferenceFiles(
    projectRoot,
    state.references,
    state.directions
  );
  if (fileErrors.length) return { action: "rejected", project_path: projectRoot, errors: fileErrors };
  const approval = approveDirectionState(state, {
    directionId: direction_id,
    approver,
    evidence
  });
  if (!approval.ok) return { action: "rejected", project_path: projectRoot, errors: approval.errors };
  const saved = await writeFrontendProductState(projectRoot, approval.state);
  return {
    action: "frontend_direction_approved",
    project_path: projectRoot,
    phase: saved.phase,
    approval: saved.approvals.direction,
    next_step: `Complete ${FRONTEND_PRODUCT_PATHS.designSystem}, ${FRONTEND_PRODUCT_PATHS.uiInventory}, and ${FRONTEND_PRODUCT_PATHS.visualAcceptance}.`
  };
}

async function approveFrontendDesignSystem({
  project_path,
  approver,
  evidence
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const coverageErrors = referenceFactoryCoverageErrors(state);
  if (coverageErrors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      errors: coverageErrors
    };
  }
  const [documents, hashes, projectState] = await Promise.all([
    readFrontendProductDocuments(projectRoot),
    frontendProductDocumentHashes(projectRoot),
    frontendApplicationBaseline(projectRoot)
  ]);
  const preApprovalChanges = frontendPreApprovalChanges(
    state.preparation_baseline,
    projectState
  );
  const approval = approveDesignSystemState(state, {
    approver,
    evidence,
    documentHashes: hashes,
    baseline: projectState,
    dirtyFiles: preApprovalChanges,
    documents
  });
  if (!approval.ok) {
    return {
      action: "rejected",
      project_path: projectRoot,
      errors: approval.errors,
      pre_approval_application_changes: preApprovalChanges
    };
  }
  const saved = await writeFrontendProductState(projectRoot, approval.state);
  const baselines = await materializeApprovedVisualBaselines(
    projectRoot,
    referencesForApprovedDirection(saved)
  );
  if (baselines.length) {
    saved.approvals.design_system.approved_visual_baselines = baselines;
    await writeFrontendProductState(projectRoot, saved);
  }
  return {
    action: "frontend_design_system_approved",
    project_path: projectRoot,
    phase: saved.phase,
    approval: saved.approvals.design_system,
    preparation_baseline_strength: state.preparation_baseline?.strength || "unknown",
    approved_visual_baselines: baselines,
    implementation_gate: evaluateFrontendProductGate(saved, {
      gate: "implementation",
      currentDocumentHashes: hashes
    }),
    next_step: "Implementation may begin only while frontend_product_gate remains green."
  };
}

async function frontendProductGate({
  project_path,
  gate = "implementation"
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const hashes = await frontendProductDocumentHashes(projectRoot).catch(() => ({}));
  const artifactStatus = gate === "handoff"
    ? await frontendReviewArtifactsCurrent(projectRoot, state)
    : null;
  return {
    project_path: projectRoot,
    ...evaluateFrontendProductGate(state, {
      gate,
      currentDocumentHashes: hashes,
      reviewArtifactsCurrent: artifactStatus?.current ?? null
    }),
    reviewed_artifacts: artifactStatus
  };
}

async function bootstrapProject({
  project_path,
  project_name,
  overwrite = false,
  include_project_map = true,
  include_quality_gate = true,
  include_project_brief = true,
  include_frontend_product = true
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const detected = await detectProject(projectRoot, project_name);
  const plannedFiles = [
    ["AGENTS.md", buildAgentsMd(detected)],
    [".ai-dev/README.md", buildAiDevReadmeMd(detected)]
  ];
  if (include_project_brief) plannedFiles.push([".ai-dev/project-brief.md", buildProjectBriefMd(detected)]);
  if (include_project_map) plannedFiles.push([".ai-dev/project-map.md", await buildProjectMapMd(detected)]);
  if (include_quality_gate) plannedFiles.push([".ai-dev/quality-gate.md", buildQualityGateMd(detected)]);

  const results = [];
  for (const [relativePath, content] of plannedFiles) {
    results.push(await writeProjectFile(projectRoot, relativePath, content, overwrite));
  }
  let frontendProduct = null;
  if (include_frontend_product && detected.project_types.includes("frontend")) {
    frontendProduct = await prepareFrontendProduct({
      project_path: projectRoot,
      project_name: detected.project_name,
      mode: "new",
      overwrite: false
    });
  }

  return {
    project_path: projectRoot,
    project_name: detected.project_name,
    detected_stack: detected.stack,
    project_types: detected.project_types,
    package_manager: detected.package_manager,
    created: results.filter((item) => item.action === "created").map((item) => item.path),
    overwritten: results.filter((item) => item.action === "overwritten").map((item) => item.path),
    skipped: results.filter((item) => item.action === "skipped"),
    commands: detected.commands,
    quality_gaps: detected.quality_gaps,
    risk_signals: detected.risk_signals,
    recommended_next_commands: detected.recommended_next_commands,
    frontend_product: frontendProduct,
    next_step: "Restart Codex or open a new thread if this tool was added during the current session."
  };
}

async function prepareProject({
  project_path,
  project_name = "",
  description = "",
  overwrite = false,
  include_project_map = true,
  include_quality_gate = true,
  include_project_brief = true,
  include_frontend_product = true,
  sync_registry = true,
  rebuild_search = true
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const bootstrap = await bootstrapProject({
    project_path: projectRoot,
    project_name,
    overwrite,
    include_project_map,
    include_quality_gate,
    include_project_brief,
    include_frontend_product
  });

  let registry = null;
  if (sync_registry) {
    registry = await syncProjectCard({
      project_path: projectRoot,
      project_name: bootstrap.project_name,
      description,
      create_if_missing: true,
      update_index: true
    });
  }

  let search_index = null;
  if (rebuild_search) {
    search_index = await rebuildSearchIndex({ include_external_project_files: true });
  }

  return {
    action: "prepared",
    project_name: bootstrap.project_name,
    project_path: projectRoot,
    overwrite,
    bootstrap,
    registry,
    search_index,
    next_steps: [
      "Read AGENTS.md.",
      "Read .ai-dev/project-brief.md.",
      "Read .ai-dev/project-map.md.",
      "Read .ai-dev/quality-gate.md.",
      "Call recommend_skills with this project before implementation work.",
      "Run run_quality_gate before finishing code changes.",
      "For frontend product work, pass frontend_product_gate before implementation.",
      "Run run_visual_reference_qa and record_visual_review before frontend handoff."
    ]
  };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function projectSlug(value) {
  const raw = String(value ?? "").trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug.slice(0, 80);

  let hash = 0;
  for (const char of raw) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return `project-${Math.abs(hash)}`;
}

function projectCardRelativePath(name) {
  return `${projectsRelativeDir}/${projectSlug(name)}.md`;
}

function parseSimpleFrontmatterFields(text) {
  const match = text.match(/^---\s*([\s\S]*?)\s*---/);
  if (!match) return {};

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const rawValue = fieldMatch[2].trim();
    if (/^".*"$/.test(rawValue)) {
      try {
        fields[fieldMatch[1]] = JSON.parse(rawValue);
        continue;
      } catch {
        // Fall through to simple stripping for non-JSON YAML-ish values.
      }
    }
    fields[fieldMatch[1]] = rawValue.replace(/^["']|["']$/g, "");
  }
  return fields;
}

function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function extractMarkdownSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function bulletValues(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .map((value) => value.replace(/^`|`$/g, ""));
}

function projectSummaryFromText(relativePath, text) {
  const fields = parseSimpleFrontmatterFields(text);
  const heading = fields.project_name || firstHeading(text) || path.basename(relativePath, ".md");
  const projectPath =
    fields.project_path ||
    text.match(/-\s+Real git root:\s*`([^`]+)`/i)?.[1] ||
    text.match(/-\s+Repository path:\s*`([^`]+)`/i)?.[1] ||
    text.match(/-\s+Root:\s*`([^`]+)`/i)?.[1] ||
    "";

  return {
    name: heading,
    slug: projectSlug(heading),
    card_path: relativePath,
    project_id: fields.project_id || "",
    repository_id: fields.repository_id || "",
    canonical_path: fields.canonical_path || projectPath,
    project_aliases: (() => {
      try {
        const parsed = JSON.parse(fields.project_aliases || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    project_path: projectPath,
    status: fields.status || text.match(/^Status:\s*(.+)$/m)?.[1]?.trim() || "",
    updated: fields.updated || "",
    description: fields.description || "",
    stack: bulletValues(extractMarkdownSection(text, "Stack")),
    quality_gate_status: fields.quality_gate_status || text.match(/Last run status:\s*`?([^`\r\n]+)`?/i)?.[1]?.trim() || "",
    frontend_product_phase: fields.frontend_product_phase || "",
    last_project_map_refresh: fields.last_project_map_refresh || text.match(/Last refreshed:\s*`?([^`\r\n]+)`?/i)?.[1]?.trim() || "",
    active_tasks: bulletValues(extractMarkdownSection(text, "Active Tasks"))
      .filter((item) => !/^no active tasks recorded\.?$/i.test(item))
  };
}

const projectCardKnownSections = [
  "Registry Snapshot",
  "Repository",
  "Project Profile",
  "Stack",
  "Documentation",
  "Environment And Secrets Risk",
  "Commands",
  "Package Scripts",
  "Project Brief",
  "Project Map",
  "Quality Gate",
  "Quality Gate Status",
  "Frontend Product Quality",
  "Quality Gaps",
  "Risk Signals",
  "Dangerous Or Side-Effectful Scripts",
  "Recommended Skills",
  "Skill Routing",
  "Skill Routing Policy",
  "Architecture Summary",
  "Active Tasks",
  "Risks And Weak Spots",
  "Known Weak Spots",
  "Next Practical Improvements",
  "Recommended Next Commands",
  "Last Project Map Refresh",
  "Last Quality Gate Run",
  "Notes",
  "Agent Rule"
];

function extractProjectCardSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";

  const nextSectionNames = sectionName.toLowerCase() === "last quality gate run"
    ? ["Notes", "Agent Rule"]
    : projectCardKnownSections.filter((name) => name.toLowerCase() !== sectionName.toLowerCase());
  if (!nextSectionNames.length) {
    return lines.slice(start + 1).join("\n").trim();
  }
  const nextKnownPattern = new RegExp(
    `^##\\s+(${nextSectionNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
    "i"
  );
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (nextKnownPattern.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

async function projectFileSnapshot(projectRoot, relativePath) {
  const target = safeProjectFile(projectRoot, relativePath);
  const stats = await fs.stat(target).catch(() => null);
  if (!stats || !stats.isFile()) {
    return { relative_path: relativePath, exists: false, modified: "" };
  }
  return {
    relative_path: relativePath,
    exists: true,
    modified: stats.mtime.toISOString()
  };
}

function commandsByStatus(commands) {
  return {
    detected: commands.filter((item) => item.command && item.command !== "Not detected"),
    missing: commands.filter((item) => !item.command || item.command === "Not detected")
  };
}

function qualityStatusFromCard(text, fallbackText = "") {
  const combined = `${text || ""}\n${fallbackText || ""}`;
  if (!combined.trim()) return { status: "not run", updated: "" };
  const status = (combined.match(/Status:\s*([^\r\n]+)/i)?.[1]?.trim() || "").replaceAll("`", "");
  const updated = (combined.match(/Updated:\s*([^\r\n]+)/i)?.[1]?.trim() || "").replaceAll("`", "");
  const inferredStatus = /all checks passed|checks passed|passed/i.test(combined)
    ? "passed (reported manually)"
    : "not run";
  return {
    status: status || inferredStatus,
    updated
  };
}

function recommendedSkillsForProject(detected) {
  const skills = [
    ["repo-onboarding", "Repository setup, AGENTS.md, project map, quality gate."],
    ["feature-builder", "Feature implementation with repo patterns and tests."],
    ["bugfix-investigator", "Bug, regression, failing test, or CI investigation."],
    ["code-reviewer", "Risk review, missing tests, security/data/behavior checks."],
    ["knowledge-curator", "Durable project notes and lessons."]
  ];
  if (detected.is_frontend) {
    skills.splice(4, 0, ["frontend-product-builder", "Single design-first orchestrator for product context, references, approvals, implementation, and visual handoff."]);
    skills.splice(5, 0, ["frontend-polisher", "Frontend/UI quality, states, responsiveness."]);
    skills.splice(6, 0, ["beta-frontend-maintainer", "Existing beta frontend support with minimal safe diffs."]);
    skills.splice(7, 0, ["frontend-quality-gate", "Technical UI QA plus strict visual-reference evidence."]);
    skills.splice(8, 0, ["landing-conversion-reviewer", "Landing page clarity, trust, CTA, and conversion review."]);
    skills.splice(9, 0, ["design-taste-frontend", "Visually important frontend/design work."]);
  }
  return skills;
}

function recommendedSkillsMarkdown(detected) {
  return [
    "| Skill | Use when |",
    "| --- | --- |",
    ...recommendedSkillsForProject(detected).map(([skill, reason]) => `| \`${skill}\` | ${mdCell(reason)} |`)
  ].join("\n");
}

function generatedProjectRisks(detected, files) {
  const risks = [];
  const { missing } = commandsByStatus(detected.commands);
  for (const item of missing) {
    if (["Lint", "Typecheck", "Test", "Build"].includes(item.label)) {
      risks.push(`${item.label} command is not detected.`);
    }
  }
  if (!files.agents.exists) risks.push("Root `AGENTS.md` is missing.");
  if (!files.project_brief?.exists) risks.push("`.ai-dev/project-brief.md` is missing.");
  if (!files.project_map.exists) risks.push("`.ai-dev/project-map.md` is missing.");
  if (!files.quality_gate.exists) risks.push("`.ai-dev/quality-gate.md` is missing.");
  if (detected.is_frontend && !files.frontend_product?.exists) {
    risks.push("Frontend Product Quality v2 state is missing.");
  }
  if (!detected.markers.includes("README.md")) risks.push("Repository README is not detected.");
  if (!detected.has_git) risks.push("Git repository was not detected at this root.");
  for (const item of detected.risk_signals || []) risks.push(item);
  return risks.length ? asBulletList(risks) : "- No automatically detected registry risks.";
}

function generatedProjectImprovements(detected, files) {
  const improvements = [];
  if (!files.agents.exists || !files.project_brief?.exists || !files.project_map.exists || !files.quality_gate.exists) {
    improvements.push("Run `bootstrap_project` to create missing agent-facing files.");
  }
  if (detected.is_frontend && !files.frontend_product?.exists) {
    improvements.push("Run `prepare_frontend_product` before product UI or visual work.");
  }
  if (files.project_brief?.exists) {
    improvements.push("Run `refresh_project_memory` after meaningful structure, command, risk, or documentation changes.");
  }
  if (files.project_map.exists) {
    improvements.push("Run `refresh_project_map` after meaningful structure or command changes.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Test")) {
    improvements.push("Add or document a reliable test/check command.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Lint")) {
    improvements.push("Add or document a lint command when the project is ready.");
  }
  if (!commandsByStatus(detected.commands).detected.some((item) => item.label === "Typecheck")) {
    improvements.push("Add or document a typecheck command when useful for this stack.");
  }
  if (!detected.documentation?.has_readme) {
    improvements.push("Add a README.md with setup, run, test, and deployment notes.");
  }
  if (detected.environment?.local_secret_files?.length && !detected.environment?.has_example) {
    improvements.push("Add an `.env.example` with safe placeholder values.");
  }
  return improvements.length ? improvements.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No automatic improvements suggested.";
}

function registrySnapshotTable({
  detected,
  identity,
  description,
  status,
  files,
  qualityStatus,
  frontendProductStatus,
  activeTaskCount = 0
}) {
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| Status | ${mdCell(status)} |`,
    `| Description | ${mdCell(description || "Not recorded.")} |`,
    `| Project ID | \`${mdCell(identity.project_id)}\` |`,
    `| Repository | \`${mdCell(detected.project_path)}\` |`,
    `| Stack | ${mdCell(detected.stack.join(", ") || "Not detected")} |`,
    `| Package manager | ${mdCell(detected.package_manager)} |`,
    `| Project types | ${mdCell((detected.project_types || []).join(", ") || "unknown")} |`,
    `| Project brief | ${files.project_brief.exists ? `present, modified ${files.project_brief.modified}` : "missing"} |`,
    `| Project map | ${files.project_map.exists ? `present, modified ${files.project_map.modified}` : "missing"} |`,
    `| Quality gate | ${files.quality_gate.exists ? `present, modified ${files.quality_gate.modified}` : "missing"} |`,
    `| Last quality status | ${mdCell(qualityStatus.status)} |`,
    `| Frontend product phase | ${mdCell(frontendProductStatus?.phase || (detected.is_frontend ? "not prepared" : "not applicable"))} |`,
    `| Frontend handoff gate | ${mdCell(frontendProductStatus?.handoff?.ok ? "pass" : (frontendProductStatus?.handoff ? "block" : "not run"))} |`,
    `| Active tasks | ${activeTaskCount} |`,
    `| Updated | ${new Date().toISOString()} |`
  ].join("\n");
}

function fencedCodeBlocks(markdown) {
  const blocks = [];
  const pattern = /```[A-Za-z0-9_-]*\s*([\s\S]*?)```/g;
  let match = null;
  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[1].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

function qualityGateFileSummaryMarkdown(markdown) {
  if (!markdown.trim()) return "";
  const commands = fencedCodeBlocks(extractMarkdownSection(markdown, "Default Verification"))
    .flatMap((block) => block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .slice(0, 6);
  const missingChecks = bulletValues(extractMarkdownSection(markdown, "Missing Checks"));
  const lines = ["### Repo Quality Gate Summary", ""];
  if (commands.length) {
    lines.push("Default command candidates:", "");
    for (const command of commands) lines.push(`- \`${command}\``);
    lines.push("");
  }
  if (missingChecks.length) {
    lines.push("Missing checks:", "");
    for (const item of missingChecks) lines.push(`- ${item}`);
  }
  return lines.join("\n").trim();
}

async function buildRichProjectCardMd(detected, {
  description = "",
  status = "registered",
  notes = "",
  existing_text = "",
  project_identity = null
} = {}) {
  const now = new Date().toISOString();
  const identity = project_identity || await resolveProjectIdentity(detected.project_path);
  const files = {
    agents: await projectFileSnapshot(detected.project_path, "AGENTS.md"),
    readme: await projectFileSnapshot(detected.project_path, ".ai-dev/README.md"),
    project_brief: await projectFileSnapshot(detected.project_path, ".ai-dev/project-brief.md"),
    project_map: await projectFileSnapshot(detected.project_path, ".ai-dev/project-map.md"),
    quality_gate: await projectFileSnapshot(detected.project_path, ".ai-dev/quality-gate.md"),
    frontend_product: await projectFileSnapshot(detected.project_path, FRONTEND_PRODUCT_PATHS.state)
  };
  const frontendProductState = files.frontend_product.exists
    ? await readFrontendProductState(detected.project_path, { required: false })
    : null;
  let frontendProductStatus = null;
  if (frontendProductState) {
    const hashes = await frontendProductDocumentHashes(detected.project_path).catch(() => ({}));
    const artifactStatus = await frontendReviewArtifactsCurrent(
      detected.project_path,
      frontendProductState
    );
    frontendProductStatus = {
      phase: frontendProductState.phase,
      implementation: evaluateFrontendProductGate(frontendProductState, {
        gate: "implementation",
        currentDocumentHashes: hashes
      }),
      handoff: evaluateFrontendProductGate(frontendProductState, {
        gate: "handoff",
        currentDocumentHashes: hashes,
        reviewArtifactsCurrent: artifactStatus.current
      }),
      reviewed_artifacts: artifactStatus
    };
  }
  const lastQualityGateRun = extractProjectCardSection(existing_text, "Last Quality Gate Run");
  const lastFrontendQaRun = extractProjectCardSection(existing_text, "Last Frontend QA Run");
  const preservedQualityGateStatus = extractProjectCardSection(existing_text, "Quality Gate Status");
  const preservedQualityGate = extractProjectCardSection(existing_text, "Quality Gate");
  const qualityGateFileText = files.quality_gate.exists ? await readProjectTextIfExists(detected.project_path, ".ai-dev/quality-gate.md") : "";
  const qualityStatus = qualityStatusFromCard(lastQualityGateRun, `${preservedQualityGate}\n${preservedQualityGateStatus}`);
  const preservedArchitecture = extractProjectCardSection(existing_text, "Architecture Summary");
  const preservedActiveTasks = extractProjectCardSection(existing_text, "Active Tasks");
  const activeTasksMarkdown = preservedActiveTasks || "- No active tasks recorded.";
  const activeTaskCount = bulletValues(activeTasksMarkdown)
    .filter((item) => !/^no active tasks recorded\.?$/i.test(item))
    .length;
  const preservedRisks =
    extractProjectCardSection(existing_text, "Risks And Weak Spots") ||
    extractProjectCardSection(existing_text, "Known Weak Spots");
  const preservedImprovements = extractProjectCardSection(existing_text, "Next Practical Improvements");
  const preservedNotes = extractProjectCardSection(existing_text, "Notes");
  const frontendProductPhase = frontendProductStatus?.phase ||
    (detected.is_frontend ? "not prepared" : "not applicable");

  const frontmatter = [
    "---",
    `project_name: ${yamlString(detected.project_name)}`,
    `project_path: ${yamlString(detected.project_path)}`,
    `project_id: ${yamlString(identity.project_id)}`,
    `repository_id: ${yamlString(identity.repository_id || "")}`,
    `canonical_path: ${yamlString(identity.canonical_path)}`,
    `project_aliases: ${yamlString(JSON.stringify(identity.aliases))}`,
    `status: ${yamlString(status)}`,
    `description: ${yamlString(description)}`,
    `updated: ${yamlString(now)}`,
    `stack: ${yamlString(detected.stack.join(", "))}`,
    `project_types: ${yamlString((detected.project_types || []).join(", "))}`,
    `last_project_map_refresh: ${yamlString(files.project_map.modified || "")}`,
    `quality_gate_status: ${yamlString(qualityStatus.status)}`,
    `frontend_product_phase: ${yamlString(frontendProductPhase)}`,
    "---"
  ].join("\n");

  return `${frontmatter}
# ${detected.project_name}

Status: ${status}

## Registry Snapshot

${registrySnapshotTable({ detected, identity, description, status, files, qualityStatus, frontendProductStatus, activeTaskCount })}

## Repository

- Project ID: \`${identity.project_id}\`
- Canonical path: \`${identity.canonical_path}\`
- Repository path: \`${detected.project_path}\`
- Known aliases: ${identity.aliases.map((item) => `\`${item}\``).join(", ")}
- Git repository detected: ${detected.has_git ? "yes" : "no"}
- Agent files:
  - \`AGENTS.md\`: ${files.agents.exists ? `present, modified ${files.agents.modified}` : "missing"}
  - \`.ai-dev/README.md\`: ${files.readme.exists ? `present, modified ${files.readme.modified}` : "missing"}
  - \`.ai-dev/project-brief.md\`: ${files.project_brief.exists ? `present, modified ${files.project_brief.modified}` : "missing"}
  - \`.ai-dev/project-map.md\`: ${files.project_map.exists ? `present, modified ${files.project_map.modified}` : "missing"}
  - \`.ai-dev/quality-gate.md\`: ${files.quality_gate.exists ? `present, modified ${files.quality_gate.modified}` : "missing"}
  - \`${FRONTEND_PRODUCT_PATHS.state}\`: ${files.frontend_product.exists ? `present, modified ${files.frontend_product.modified}` : "missing"}

## Project Profile

- Types: ${detected.project_types.map((item) => `\`${item}\``).join(", ")}
- Frontend: ${detected.is_frontend ? "yes" : "no"}
- Backend: ${detected.is_backend ? "yes" : "no"}
- Mobile: ${detected.is_mobile ? "yes" : "no"}
- Bot: ${detected.is_bot ? "yes" : "no"}
- API: ${detected.is_api ? "yes" : "no"}

## Stack

${asBulletList(detected.stack)}

Package manager: \`${detected.package_manager}\`

## Documentation

${documentationMarkdown(detected)}

## Environment And Secrets Risk

${environmentMarkdown(detected)}

## Commands

${commandsTable(detected.commands)}

## Package Scripts

${scriptsTable(detected.scripts)}

## Project Brief

- Path: \`${path.join(detected.project_path, ".ai-dev", "project-brief.md")}\`
- Exists: ${files.project_brief.exists ? "yes" : "no"}
- Last refreshed: \`${files.project_brief.modified || "not recorded"}\`
- Refresh command: \`refresh_project_memory\`

## Project Map

- Path: \`${path.join(detected.project_path, ".ai-dev", "project-map.md")}\`
- Exists: ${files.project_map.exists ? "yes" : "no"}
- Last refreshed: \`${files.project_map.modified || "not recorded"}\`
- Refresh command: \`refresh_project_map\`

## Quality Gate Status

- Path: \`${path.join(detected.project_path, ".ai-dev", "quality-gate.md")}\`
- Exists: ${files.quality_gate.exists ? "yes" : "no"}
- Last run status: \`${qualityStatus.status}\`
- Last run updated: \`${qualityStatus.updated || "not recorded"}\`
- Runner: \`run_quality_gate\`
${preservedQualityGate ? `
### Existing Quality Notes

${preservedQualityGate}
` : ""}
${qualityGateFileSummaryMarkdown(qualityGateFileText)}

## Frontend Product Quality

- Prepared: ${frontendProductState ? "yes" : "no"}
- Phase: \`${frontendProductPhase}\`
- Implementation gate: \`${frontendProductStatus ? (frontendProductStatus.implementation?.ok ? "pass" : "block") : (detected.is_frontend ? "not prepared" : "not applicable")}\`
- Handoff gate: \`${frontendProductStatus ? (frontendProductStatus.handoff?.ok ? "pass" : "block") : (detected.is_frontend ? "not prepared" : "not applicable")}\`
- State: \`${path.join(detected.project_path, FRONTEND_PRODUCT_PATHS.state)}\`
- Builder: \`frontend_product_builder\`
- Strict QA: \`run_visual_reference_qa\`

## Quality Gaps

${detected.quality_gaps.length ? asBulletList(detected.quality_gaps) : "- No automatic quality gaps detected."}

## Risk Signals

${detected.risk_signals.length ? asBulletList(detected.risk_signals) : "- No automatic risk signals detected."}

## Dangerous Or Side-Effectful Scripts

${dangerousScriptsMarkdown(detected)}

## Recommended Skills

${recommendedSkillsMarkdown(detected)}

## Skill Routing Policy

- Use \`recommend_skills\` with this project name or path before implementation work.
- Use \`membrane_policy: "auto"\` for normal work.
- Use \`membrane_policy: "exclude"\` when app skills are noisy.
- Use \`membrane_policy: "include"\` only for explicit external app integrations.

## Architecture Summary

${preservedArchitecture || "Not recorded yet."}

## Active Tasks

${activeTasksMarkdown}

## Risks And Weak Spots

${preservedRisks || generatedProjectRisks(detected, files)}

## Next Practical Improvements

${preservedImprovements || generatedProjectImprovements(detected, files)}

## Recommended Next Commands

${asBulletList(detected.recommended_next_commands)}

${lastQualityGateRun ? `## Last Quality Gate Run

${lastQualityGateRun}

` : ""}${lastFrontendQaRun ? `## Last Frontend QA Run

${lastFrontendQaRun}

` : ""}## Notes

${preservedNotes || notes || "No durable notes recorded yet."}

## Agent Rule

When working on this project, read repo-local \`AGENTS.md\` first, then \`.ai-dev/project-map.md\`, then \`.ai-dev/quality-gate.md\`. Use \`recommend_skills\` and the project quality gate before finalizing development work.
`;
}

async function projectSummaries({ dedupe = true } = {}) {
  await fs.mkdir(projectsDir, { recursive: true });
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  const cards = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    if (entry.name.toLowerCase() === "projects index.md") continue;

    const filePath = path.join(projectsDir, entry.name);
    const relativePath = toVaultRelative(filePath);
    const text = stripBom(await fs.readFile(filePath, "utf8"));
    const summary = projectSummaryFromText(relativePath, text);
    if (summary.project_path) {
      try {
        const identity = await resolveProjectIdentity(summary.project_path);
        summary.project_id = identity.project_id;
        summary.repository_id = identity.repository_id || summary.repository_id;
        summary.canonical_path = identity.canonical_path;
        summary.project_aliases = [...new Set([
          ...summary.project_aliases,
          ...identity.aliases
        ])];
      } catch {
        // Missing or offline repositories remain readable from their durable card metadata.
      }
    }
    cards.push(summary);
  }
  if (!dedupe) return cards.sort((a, b) => a.name.localeCompare(b.name));

  const unique = new Map();
  for (const card of cards) {
    const key = card.project_id || (
      card.canonical_path
        ? `path:${path.resolve(card.canonical_path).toLowerCase()}`
        : `card:${card.card_path.toLowerCase()}`
    );
    const existing = unique.get(key);
    if (!existing || String(card.updated || "") > String(existing.updated || "")) {
      unique.set(key, {
        ...card,
        duplicate_cards: existing
          ? [...(existing.duplicate_cards || []), existing.card_path]
          : card.duplicate_cards || []
      });
    } else {
      existing.duplicate_cards = [...(existing.duplicate_cards || []), card.card_path];
    }
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderProjectsIndex(projects) {
  return `# Projects Index

This folder stores durable project cards for repositories connected to the AI Dev System.

## Active Projects

${projects.length ? [
  "| Project | Status | Stack | Quality | Frontend product | Project map | Active tasks | Path |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...projects.map((project) => `| [[${path.basename(project.card_path, ".md")}]] | ${mdCell(project.status || "registered")} | ${mdCell((project.stack || []).slice(0, 6).join(", ") || "Not detected")} | ${mdCell(project.quality_gate_status || "not run")} | ${mdCell(project.frontend_product_phase || "not prepared")} | ${mdCell(project.last_project_map_refresh || "not recorded")} | ${mdCell((project.active_tasks || []).length)} | ${mdCell(project.project_path || "")} |`)
].join("\n") : "- No projects registered yet."}

## Project Card Rule

Each project card should record:

- repository path;
- stack and architecture summary;
- available quality gate;
- quality gate status;
- last project-map refresh;
- recommended skills;
- active tasks;
- risks and known weak spots;
- next practical improvements.

## MCP Tools

- \`list_projects\`
- \`read_project\`
- \`register_project\`
- \`sync_project_card\`
- \`update_project_card\`
- \`refresh_project_map\`
- \`refresh_project_memory\`
- \`run_quality_gate\`
- \`run_frontend_qa\`
- \`frontend_product_builder\`
- \`prepare_frontend_product\`
- \`frontend_product_gate\`
- \`run_visual_reference_qa\`
- \`record_visual_review\`
`;
}

async function updateProjectsIndex() {
  const projects = await projectSummaries();
  await writeText(projectsIndexRelativePath, renderProjectsIndex(projects));
  return { path: projectsIndexRelativePath, total: projects.length };
}

async function findProjectCard(identifier) {
  if (!identifier || typeof identifier !== "string") {
    throw new Error("project name/path is required.");
  }

  const normalized = identifier.trim();
  const normalizedSlug = projectSlug(normalized);
  const normalizedPath = path.isAbsolute(normalized) ? path.resolve(normalized).toLowerCase() : "";
  let requestedIdentity = null;
  if (normalizedPath) {
    requestedIdentity = await resolveProjectIdentity(normalized).catch(() => null);
  }
  const projects = await projectSummaries({ dedupe: false });
  const match = projects.find((project) => {
    const cardName = path.basename(project.card_path, ".md");
    return (
      project.slug === normalizedSlug ||
      cardName.toLowerCase() === normalized.toLowerCase() ||
      project.name.toLowerCase() === normalized.toLowerCase() ||
      (requestedIdentity && project.project_id === requestedIdentity.project_id) ||
      (normalizedPath && project.project_path && path.resolve(project.project_path).toLowerCase() === normalizedPath)
    );
  });

  if (!match) throw new Error(`Project card not found: ${identifier}`);
  return {
    ...match,
    absolute_path: safePath(match.card_path)
  };
}

async function listProjects() {
  return projectSummaries();
}

async function projectIdentity({ project_path }) {
  return resolveProjectIdentity(project_path);
}

async function readProject({ name }) {
  const card = await findProjectCard(name);
  return fs.readFile(card.absolute_path, "utf8");
}

function buildProjectCardMd(detected, { description = "", status = "registered", notes = "" } = {}) {
  const now = new Date().toISOString();
  return `---
project_name: ${yamlString(detected.project_name)}
project_path: ${yamlString(detected.project_path)}
status: ${yamlString(status)}
description: ${yamlString(description)}
updated: ${yamlString(now)}
---
# ${detected.project_name}

Status: ${status}

## Repository

- Repository path: \`${detected.project_path}\`
- Project map: \`${path.join(detected.project_path, ".ai-dev", "project-map.md")}\`
- Quality gate: \`${path.join(detected.project_path, ".ai-dev", "quality-gate.md")}\`

## Stack

${asBulletList(detected.stack)}

Package manager: \`${detected.package_manager}\`

## Commands

${commandsTable(detected.commands)}

## Architecture Summary

Not recorded yet.

## Quality Gate

Read repo-local \`.ai-dev/quality-gate.md\` before running checks.

## Recommended Skills

- \`repo-onboarding\`
- \`feature-builder\`
- \`bugfix-investigator\`
- \`code-reviewer\`
- \`knowledge-curator\`

## Known Weak Spots

Not recorded yet.

## Next Practical Improvements

Not recorded yet.

## Notes

${notes || "No durable notes recorded yet."}
`;
}

async function registerProject({
  project_path,
  project_name,
  description = "",
  status = "registered",
  notes = "",
  overwrite = false,
  update_index = true
}) {
  const identity = await resolveProjectIdentity(project_path);
  const projectRoot = identity.project_root;
  const detected = await detectProject(projectRoot, project_name);
  const existingIdentityCard = (await projectSummaries({ dedupe: false }))
    .find((project) => project.project_id === identity.project_id);
  const relativePath = existingIdentityCard?.card_path
    || projectCardRelativePath(detected.project_name);
  const target = safeKnowledgeNotePath(relativePath);
  const exists = await pathExists(target);
  if (exists && !overwrite) {
    if (update_index) await updateProjectsIndex();
    return {
      action: "skipped",
      reason: "project card already exists",
      project_id: identity.project_id,
      project_name: detected.project_name,
      project_path: detected.project_path,
      card_path: relativePath
    };
  }

  const existingText = exists ? stripBom(await fs.readFile(target, "utf8")) : "";
  await atomicWriteFile(target, await buildRichProjectCardMd(detected, {
    description,
    status,
    notes,
    existing_text: existingText,
    project_identity: identity
  }), "utf8");
  markSearchIndexDirty(`project card written: ${relativePath}`);
  const index = update_index ? await updateProjectsIndex() : null;
  return {
    action: exists ? "overwritten" : "created",
    project_id: identity.project_id,
    project_name: detected.project_name,
    project_path: detected.project_path,
    card_path: relativePath,
    detected_stack: detected.stack,
    index
  };
}

async function syncProjectCard({
  name = "",
  project_path = "",
  project_name = "",
  description = "",
  status = "",
  create_if_missing = true,
  update_index = true
}) {
  let projectRoot = "";
  let identity = null;
  let existingCard = null;
  let existingText = "";

  if (project_path) {
    identity = await resolveProjectIdentity(project_path);
    projectRoot = identity.project_root;
    try {
      existingCard = await findProjectCard(projectRoot);
    } catch {
      existingCard = null;
    }
  } else if (name) {
    existingCard = await findProjectCard(name);
    existingText = stripBom(await fs.readFile(existingCard.absolute_path, "utf8"));
    if (!existingCard.project_path) {
      throw new Error(`Project card has no project_path: ${existingCard.card_path}`);
    }
    identity = await resolveProjectIdentity(existingCard.project_path);
    projectRoot = identity.project_root;
  } else {
    throw new Error("name or project_path is required.");
  }

  const detected = await detectProject(projectRoot, project_name || existingCard?.name || "");
  const relativePath = existingCard?.card_path || projectCardRelativePath(detected.project_name);
  const target = safeKnowledgeNotePath(relativePath);
  const exists = await pathExists(target);
  if (!exists && !create_if_missing) {
    return {
      action: "skipped",
      reason: "project card does not exist",
      project_name: detected.project_name,
      project_path: detected.project_path,
      card_path: relativePath
    };
  }

  if (!existingText && exists) {
    existingText = stripBom(await fs.readFile(target, "utf8"));
  }
  const fields = parseSimpleFrontmatterFields(existingText);
  const nextDescription = description || fields.description || existingCard?.description || "";
  const nextStatus = status || fields.status || existingCard?.status || "active";

  await atomicWriteFile(target, await buildRichProjectCardMd(detected, {
    description: nextDescription,
    status: nextStatus,
    existing_text: existingText,
    project_identity: identity
  }), "utf8");
  markSearchIndexDirty(`project card synced: ${relativePath}`);

  const index = update_index ? await updateProjectsIndex() : null;
  return {
    action: exists ? "synced" : "created",
    project_id: identity.project_id,
    project_name: detected.project_name,
    project_path: detected.project_path,
    card_path: relativePath,
    detected_stack: detected.stack,
    commands: detected.commands,
    index
  };
}

function replaceOrAppendSection(text, sectionName, content, mode) {
  const normalizedContent = content.endsWith("\n") ? content.trimEnd() : content;
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));

  if (start < 0) {
    return `${text.trimEnd()}\n\n## ${sectionName}\n\n${normalizedContent}\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const before = lines.slice(0, start).join("\n").trimEnd();
  const currentBody = lines.slice(start + 1, end).join("\n").trim();
  const after = lines.slice(end).join("\n").trimStart();
  const nextBody = mode === "replace"
    ? normalizedContent
    : [currentBody, normalizedContent].filter(Boolean).join("\n\n");
  return `${before}\n\n## ${sectionName}\n\n${nextBody}\n\n${after}`.trimEnd() + "\n";
}

async function updateProjectCard({
  name,
  section = "Notes",
  content,
  mode = "append",
  update_index = true
}) {
  if (!content || typeof content !== "string") {
    throw new Error("content is required.");
  }
  if (!["append", "replace"].includes(mode)) {
    throw new Error("mode must be append or replace.");
  }

  const card = await findProjectCard(name);
  const text = stripBom(await fs.readFile(card.absolute_path, "utf8"));
  const updated = replaceOrAppendSection(text, section, content, mode);
  await atomicWriteFile(card.absolute_path, updated, "utf8");
  markSearchIndexDirty(`project card updated: ${card.card_path}`);
  const index = update_index ? await updateProjectsIndex() : null;
  return {
    action: mode === "replace" ? "section_replaced" : "section_appended",
    project_name: card.name,
    card_path: card.card_path,
    section,
    index
  };
}

async function refreshProjectMap({
  project_path,
  project_name,
  overwrite = true,
  update_registry = true,
  register_if_missing = false
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const detected = await detectProject(projectRoot, project_name);
  const mapContent = await buildProjectMapMd(detected);
  const mapResult = await writeProjectFile(projectRoot, ".ai-dev/project-map.md", mapContent, overwrite);

  let registry = null;
  if (update_registry) {
    try {
      registry = await syncProjectCard({
        project_path: detected.project_path,
        project_name: detected.project_name,
        create_if_missing: register_if_missing,
        update_index: true
      });
    } catch (err) {
      if (!register_if_missing) {
        registry = { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
      } else {
        registry = await registerProject({
          project_path: detected.project_path,
          project_name: detected.project_name,
          status: "registered via refresh_project_map",
          description: "Registered automatically while refreshing project map.",
          notes: `Project map refreshed at ${new Date().toISOString()}.`,
          overwrite: false
        });
      }
    }
  }

  return {
    project_name: detected.project_name,
    project_path: detected.project_path,
    project_map: mapResult,
    detected_stack: detected.stack,
    commands: detected.commands,
    registry
  };
}

async function refreshProjectMemory({
  project_path,
  project_name,
  overwrite = true,
  update_registry = true,
  register_if_missing = true,
  rebuild_search = true
}) {
  const projectRoot = await resolveTaskProjectRoot(project_path);
  const detected = await detectProject(projectRoot, project_name);
  const briefResult = await writeProjectFile(projectRoot, ".ai-dev/project-brief.md", buildProjectBriefMd(detected), overwrite);
  const mapResult = await writeProjectFile(projectRoot, ".ai-dev/project-map.md", await buildProjectMapMd(detected), overwrite);

  let registry = null;
  if (update_registry) {
    try {
      registry = await syncProjectCard({
        project_path: detected.project_path,
        project_name: detected.project_name,
        create_if_missing: register_if_missing,
        update_index: true
      });
    } catch (err) {
      if (!register_if_missing) {
        registry = { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
      } else {
        registry = await registerProject({
          project_path: detected.project_path,
          project_name: detected.project_name,
          status: "registered via refresh_project_memory",
          description: "Registered automatically while refreshing project memory.",
          notes: `Project memory refreshed at ${new Date().toISOString()}.`,
          overwrite: false
        });
      }
    }
  }

  let search_index = null;
  if (rebuild_search) {
    search_index = await rebuildSearchIndex({ include_external_project_files: true });
  }

  return {
    action: "memory_refreshed",
    project_name: detected.project_name,
    project_path: detected.project_path,
    project_types: detected.project_types,
    project_brief: briefResult,
    project_map: mapResult,
    detected_stack: detected.stack,
    commands: detected.commands,
    quality_gaps: detected.quality_gaps,
    risk_signals: detected.risk_signals,
    dangerous_scripts: detected.dangerous_scripts,
    recommended_next_commands: detected.recommended_next_commands,
    registry,
    search_index
  };
}

function normalizeQualityLabel(label) {
  return String(label ?? "")
    .replace(/\s*\[cwd=[^\]]+\]\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "");
}

function cleanQualityCommand(command) {
  return String(command ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
}

function parseQualityGateCommands(text) {
  const commands = [];
  const seen = new Set();
  const add = (label, command, source, explicitCwd = "") => {
    const cleaned = cleanQualityCommand(command);
    if (!cleaned || /^not detected$/i.test(cleaned)) return;
    const rawLabel = String(label || "Command").trim();
    const cwdMatch = rawLabel.match(/\s*\[cwd=([^\]]+)\]\s*$/i);
    const cwd = String(explicitCwd || cwdMatch?.[1] || "").trim().replaceAll("\\", "/");
    const cleanLabel = rawLabel.replace(/\s*\[cwd=[^\]]+\]\s*$/i, "").trim();
    const key = `${normalizeQualityLabel(cleanLabel)}:${cwd}:${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    commands.push({
      label: cleanLabel,
      command: cleaned,
      cwd,
      source
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const bulletMatch = line.match(/^\s*[-*]\s+([^:`]+):\s*`([^`]+)`/);
    if (bulletMatch) {
      add(bulletMatch[1], bulletMatch[2], "markdown bullet");
      continue;
    }

    const bareBulletMatch = line.match(/^\s*[-*]\s+`([^`]+)`/);
    if (bareBulletMatch) {
      add("Command", bareBulletMatch[1], "markdown bullet");
      continue;
    }

    if (/^\s*\|/.test(line) && !/^\s*\|\s*-+/.test(line)) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length >= 2 && !/^task$/i.test(cells[0]) && !/^command$/i.test(cells[1])) {
        add(cells[0], cells[1].replace(/^`|`$/g, ""), "markdown table", cells[2] || "");
      }
    }
  }

  return commands;
}

function shouldSkipQualityLabel(label) {
  return /^(install|dev|serve|start|watch|preview|deploy|publish|release|migrate|migration|seed|smoke|manual|integration)$/i.test(String(label ?? "").trim());
}

function qualityCommandBlockReason(command) {
  try {
    parseSafeCommand(String(command ?? ""), { purpose: "quality" });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function selectQualityCommands(commands, labels, maxCommands) {
  const normalizedLabels = Array.isArray(labels)
    ? labels.map(normalizeQualityLabel).filter(Boolean)
    : [];
  const selected = [];
  const skipped = [];

  for (const item of commands) {
    if (normalizedLabels.length && !normalizedLabels.includes(normalizeQualityLabel(item.label))) {
      skipped.push({ ...item, reason: "label not selected" });
      continue;
    }
    if (!normalizedLabels.length && shouldSkipQualityLabel(item.label)) {
      skipped.push({ ...item, reason: "label skipped by default" });
      continue;
    }
    if (selected.length >= maxCommands) {
      skipped.push({ ...item, reason: "max_commands limit reached" });
      continue;
    }
    selected.push(item);
  }
  return { selected, skipped };
}

function qualityGateReportMarkdown(result) {
  const lines = [
    `Updated: ${result.finished_at}`,
    "",
    `Status: ${result.status}`,
    "",
    `Project path: \`${result.project_path}\``,
    "",
    "## Commands",
    "",
    "| Label | CWD | Command | Status | Exit |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const item of result.results) {
    lines.push(`| ${mdCell(item.label)} | ${mdCell(item.cwd || ".")} | ${mdCell(item.command)} | ${mdCell(item.status)} | ${mdCell(item.exit_code ?? "")} |`);
  }
  if (!result.results.length) {
    lines.push("| None | . |  | no commands run |  |");
  }

  if (result.blocked.length) {
    lines.push("", "## Blocked Commands", "");
    for (const item of result.blocked) {
      lines.push(`- ${item.label}: \`${item.command}\` (${item.reason})`);
    }
  }

  if (result.skipped.length) {
    lines.push("", "## Skipped Commands", "");
    for (const item of result.skipped) {
      lines.push(`- ${item.label}: \`${item.command}\` (${item.reason})`);
    }
  }

  return lines.join("\n");
}

async function runQualityGate({
  project_path,
  labels = [],
  dry_run = false,
  timeout_ms = 120000,
  max_commands = 6,
  continue_on_failure = true,
  allow_unsafe_commands = false,
  update_registry = true,
  register_if_missing = false
}) {
  const projectRoot = await safeProjectRoot(project_path);
  const gatePath = safeProjectFile(projectRoot, ".ai-dev/quality-gate.md");
  if (!(await pathExists(gatePath))) {
    throw new Error(`Quality gate file not found: ${path.join(projectRoot, ".ai-dev", "quality-gate.md")}`);
  }

  const startedAt = new Date().toISOString();
  const gateText = stripBom(await fs.readFile(gatePath, "utf8"));
  const parsed = parseQualityGateCommands(gateText);
  const { selected, skipped } = selectQualityCommands(parsed, labels, Math.max(1, Math.min(Number(max_commands) || 6, 20)));
  const results = [];
  const blocked = [];

  for (const item of selected) {
    const blockReason = qualityCommandBlockReason(item.command);
    if (blockReason) {
      blocked.push({ ...item, reason: blockReason });
      continue;
    }

    if (dry_run) {
      results.push({
        label: item.label,
        command: item.command,
        cwd: item.cwd || ".",
        status: "dry_run",
        exit_code: null,
        stdout: "",
        stderr: "",
        timed_out: false
      });
      continue;
    }

    const commandRoot = await safeProjectSubdir(projectRoot, item.cwd || "");
    const output = await runPolicyCommand({
      command: item.command,
      projectRoot: commandRoot,
      purpose: "quality",
      timeoutMs: Math.max(1000, Math.min(Number(timeout_ms) || 120000, 30 * 60 * 1000))
    });
    const status = output.timedOut ? "timed_out" : output.exitCode === 0 ? "passed" : "failed";
    results.push({
      label: item.label,
      command: item.command,
      cwd: item.cwd || ".",
      command_adapter: output.command.adapter || output.command.kind,
      execution_adapter: output.invocation?.adapter || "direct",
      status,
      exit_code: output.exitCode,
      stdout: truncateOutput(output.stdout),
      stderr: truncateOutput(output.stderr),
      timed_out: output.timedOut,
      output_truncated: output.truncated,
      duration_ms: output.durationMs
    });
    if (!continue_on_failure && status !== "passed") break;
  }

  let status = "passed";
  if (dry_run) status = "dry_run";
  else if (!parsed.length) status = "no_commands";
  else if (blocked.length && !results.length) status = "blocked";
  else if (results.some((item) => item.status === "failed" || item.status === "timed_out")) status = "failed";
  else if (blocked.length) status = "passed_with_blocked";
  else if (!results.length) status = "no_commands_run";

  const result = {
    project_path: projectRoot,
    quality_gate_path: path.relative(projectRoot, gatePath).replaceAll("\\", "/"),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    parsed_commands: parsed,
    selected_commands: selected,
    results,
    blocked,
    skipped,
    safety: {
      execution: "argv",
      shell: false,
      unsafe_bypass_honored: false,
      legacy_allow_unsafe_requested: Boolean(allow_unsafe_commands)
    }
  };

  if (update_registry) {
    try {
      const card = await findProjectCard(projectRoot);
      const report = await updateProjectCard({
        name: card.name,
        section: "Last Quality Gate Run",
        mode: "replace",
        content: qualityGateReportMarkdown(result),
        update_index: false
      });
      const synced = await syncProjectCard({
        project_path: projectRoot,
        create_if_missing: false,
        update_index: true
      });
      result.registry = { report, synced };
    } catch (err) {
      if (!register_if_missing) {
        result.registry = { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
      } else {
        result.registry = await registerProject({
          project_path: projectRoot,
          status: "registered via run_quality_gate",
          description: "Registered automatically while running quality gate.",
          notes: qualityGateReportMarkdown(result),
          overwrite: false
        });
      }
    }
  }

  return result;
}

function frontendQaDevCommand(detected, explicitCommand) {
  const explicit = String(explicitCommand ?? "").trim();
  if (explicit) return explicit;
  const dev = detected.commands?.find((item) => item.label === "Dev" && item.command && item.command !== "Not detected");
  return dev?.command || "";
}

function frontendQaReportMarkdown(result) {
  if (result.markdown && typeof result.markdown === "string") return result.markdown;
  const lines = [
    "# Frontend QA Report",
    "",
    `Generated: ${result.started_at || new Date().toISOString()}`,
    `Gate: ${result.gate || "warn"}`,
    `Status: ${result.status || "unknown"}`,
    `Project path: \`${result.project_path || ""}\``,
    result.base_url ? `Base URL: ${result.base_url}` : "",
    result.dev_command ? `Dev command: \`${result.dev_command}\`` : ""
  ].filter(Boolean);

  if (result.setup_warnings?.length) {
    lines.push("", "## Setup Warnings", "");
    for (const item of result.setup_warnings) lines.push(`- ${item}`);
  }
  if (result.results?.length) {
    lines.push("", "## Results", "", "| Route | Viewport | Status | Screenshot |", "| --- | --- | --- | --- |");
    for (const item of result.results) {
      lines.push(`| ${mdCell(item.route)} | ${mdCell(item.viewport?.name || "")} | ${mdCell(item.status)} | ${mdCell(item.screenshot || "")} |`);
    }
  }
  if (!result.results?.length) {
    lines.push("", "## Results", "", "- No browser checks were run.");
  }
  return lines.join("\n");
}

async function runFrontendQa(rawOptions = {}) {
  const projectRoot = await safeProjectRoot(rawOptions.project_path);
  const requestedConfigPath = String(rawOptions.config_path || ".ai-dev/frontend-qa.json");
  let projectConfig = {};
  let loadedConfigPath = "";
  if (rawOptions.load_project_config !== false) {
    const candidate = safeProjectFile(projectRoot, requestedConfigPath);
    if (await pathExists(candidate)) {
      projectConfig = JSON.parse(stripBom(await fs.readFile(candidate, "utf8")));
      if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
        throw new Error(`Frontend QA config must be a JSON object: ${candidate}`);
      }
      loadedConfigPath = candidate;
    }
  }
  const options = { ...projectConfig, ...rawOptions };
  const {
    project_name,
    app_subdir = "",
    url = "",
    dev_command = "",
    start_dev_server = true,
    routes = ["/"],
    viewports = [],
    scenarios = [],
    check_console = true,
    check_overflow = true,
    check_accessibility_basic = true,
    check_accessibility_axe = true,
    check_anti_slop = false,
    anti_slop_exceptions = [],
    required_states = [],
    check_visual_regression = true,
    visual_baseline_dir = "",
    update_visual_baselines = false,
    max_pixel_diff_ratio = 0.01,
    scenario_timeout_ms = 10000,
    take_screenshots = true,
    screenshot_dir = "",
    artifact_location = "system",
    allowed_http_errors = [],
    write_report = true,
    update_registry = true,
    register_if_missing = false,
    server_ready_timeout_ms = 60000,
    navigation_timeout_ms = 30000,
    timeout_ms = 300000
  } = options;
  if (!(await pathExists(frontendQaRunnerPath))) {
    throw new Error(`Frontend QA runner not found: ${frontendQaRunnerPath}`);
  }

  if (!["system", "project"].includes(artifact_location)) {
    throw new Error("artifact_location must be system or project.");
  }
  const workingDirectory = await safeProjectSubdir(projectRoot, app_subdir);
  let registeredCard = null;
  try {
    registeredCard = await findProjectCard(projectRoot);
  } catch {
    registeredCard = null;
  }
  const resolvedProjectName = project_name || registeredCard?.name || path.basename(projectRoot);
  const detected = await detectProject(workingDirectory, resolvedProjectName);
  const resolvedDevCommand = frontendQaDevCommand(detected, dev_command);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const systemArtifactDir = path.join(frontendQaArtifactsRoot, slugPart(resolvedProjectName, "project"), runId);
  const input = {
    project_path: projectRoot,
    app_subdir,
    url,
    dev_command: resolvedDevCommand,
    start_dev_server,
    routes,
    viewports,
    scenarios,
    check_console,
    check_overflow,
    check_accessibility_basic,
    check_accessibility_axe,
    check_anti_slop,
    anti_slop_exceptions,
    required_states,
    check_visual_regression,
    visual_baseline_dir,
    update_visual_baselines,
    max_pixel_diff_ratio,
    scenario_timeout_ms,
    load_project_config: false,
    config_path: requestedConfigPath,
    loaded_config_path: loadedConfigPath,
    take_screenshots,
    screenshot_dir: artifact_location === "project" ? screenshot_dir : "",
    artifact_dir: artifact_location === "system" ? systemArtifactDir : "",
    allowed_http_errors,
    server_ready_timeout_ms,
    navigation_timeout_ms
  };

  let result = null;
  try {
    const output = await execFileWithInput(
      process.execPath,
      [frontendQaRunnerPath],
      JSON.stringify(input),
      {
        cwd: projectRoot,
        timeoutMs: Math.max(10000, Math.min(Number(timeout_ms) || 300000, 20 * 60 * 1000)),
        env: { AI_DEV_FRONTEND_QA_ARTIFACT_ROOT: frontendQaArtifactsRoot }
      }
    );
    result = JSON.parse(output.stdout);
    if (output.stderr?.trim()) {
      result.setup_warnings = [
        ...(result.setup_warnings || []),
        `Runner stderr: ${truncateOutput(output.stderr, 1200)}`
      ];
      if (result.gate === "pass") result.gate = "warn";
    }
  } catch (err) {
    result = {
      gate: "block",
      status: "runner_failed",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      project_path: projectRoot,
      base_url: url,
      dev_command: resolvedDevCommand,
      routes,
      viewports,
      screenshots: [],
      setup_warnings: [err instanceof Error ? err.message : String(err)],
      results: []
    };
  }

  result.project_name = resolvedProjectName;
  result.detected_stack = detected.stack;
  result.app_subdir = app_subdir;
  result.artifact_location = artifact_location;
  result.dev_command = result.dev_command || resolvedDevCommand;
  result.markdown = frontendQaReportMarkdown(result);

  if (write_report) {
    if (artifact_location === "system") {
      const reportPath = path.join(systemArtifactDir, "frontend-qa-report.md");
      await atomicWriteFile(
        reportPath,
        result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`,
        "utf8"
      );
      result.report_file = reportPath;
    } else {
      result.report_file = await writeProjectFile(projectRoot, ".ai-dev/frontend-qa-report.md", result.markdown, true);
    }
  }

  if (update_registry) {
    try {
      const card = registeredCard || await findProjectCard(projectRoot);
      const report = await updateProjectCard({
        name: card.name,
        section: "Last Frontend QA Run",
        mode: "replace",
        content: result.markdown,
        update_index: false
      });
      const synced = await syncProjectCard({
        project_path: projectRoot,
        create_if_missing: false,
        update_index: true
      });
      result.registry = { report, synced };
    } catch (err) {
      if (!register_if_missing) {
        result.registry = { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
      } else {
        result.registry = await registerProject({
          project_path: projectRoot,
          status: "registered via run_frontend_qa",
          description: "Registered automatically while running frontend QA.",
          notes: result.markdown,
          overwrite: false
        });
      }
    }
  }

  return result;
}

function frontendQaVisualArtifacts(result) {
  const artifacts = [];
  const add = (artifactPath, type, context = {}) => {
    const value = String(artifactPath || "").trim();
    if (!value) return;
    artifacts.push({ path: value, type, ...context });
  };
  for (const item of result.results || []) {
    const context = {
      route: item.route,
      viewport: item.viewport?.name || "",
      state: "default"
    };
    add(item.screenshot, "screenshot", context);
    add(item.visual?.baseline, "baseline", context);
    add(item.visual?.diff, "diff", context);
    for (const scenario of item.scenarios || []) {
      const scenarioContext = {
        route: item.route,
        viewport: item.viewport?.name || "",
        state: scenario.state || scenario.name || ""
      };
      add(scenario.screenshot, "screenshot", scenarioContext);
      add(scenario.visual?.baseline, "baseline", scenarioContext);
      add(scenario.visual?.diff, "diff", scenarioContext);
    }
  }
  const seen = new Set();
  return artifacts.filter((artifact) => {
    const key = `${artifact.type}:${artifact.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function frontendQaHasDesktopAndMobile(result) {
  const viewports = result.viewports || [];
  const names = viewports.map((item) => String(item.name || "").toLowerCase());
  return (
    (names.some((name) => name.includes("desktop")) && names.some((name) => name.includes("mobile"))) ||
    (viewports.some((item) => Number(item.width) >= 768) && viewports.some((item) => Number(item.width) < 768))
  );
}

async function runVisualReferenceQa(rawOptions = {}) {
  const projectRoot = await safeProjectRoot(rawOptions.project_path);
  const state = await readFrontendProductState(projectRoot);
  const documentHashes = await frontendProductDocumentHashes(projectRoot).catch(() => ({}));
  const implementationGate = evaluateFrontendProductGate(state, {
    gate: "implementation",
    currentDocumentHashes: documentHashes
  });
  if (!implementationGate.ok) {
    return {
      action: "rejected",
      project_path: projectRoot,
      reason: "implementation_gate_failed",
      implementation_gate: implementationGate
    };
  }

  const requiredStates = state.context?.required_states || [];
  const result = await runFrontendQa({
    ...rawOptions,
    project_path: projectRoot,
    check_console: true,
    check_overflow: true,
    check_accessibility_basic: true,
    check_accessibility_axe: true,
    check_anti_slop: true,
    anti_slop_exceptions: state.anti_slop_exceptions || [],
    required_states: requiredStates,
    check_visual_regression: true,
    visual_baseline_dir: FRONTEND_PRODUCT_PATHS.approvedReferences,
    update_visual_baselines: false,
    take_screenshots: true,
    update_registry: false,
    register_if_missing: false
  });
  const runId = `visual-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const artifacts = frontendQaVisualArtifacts(result);
  const desktopAndMobile = frontendQaHasDesktopAndMobile(result);
  const requiredStatesCovered = result.state_coverage?.complete === true;
  const baselinesComplete = result.visual_baselines_complete === true;
  const technicalPassed = result.gate === "pass" &&
    desktopAndMobile &&
    requiredStatesCovered &&
    baselinesComplete &&
    Number(result.unwaived_anti_slop_findings || 0) === 0;
  const visualRun = {
    run_id: runId,
    status: technicalPassed ? "awaiting_review" : "failed",
    technical_status: technicalPassed ? "passed" : "failed",
    strict: true,
    desktop_and_mobile: desktopAndMobile,
    required_states_covered: requiredStatesCovered,
    baselines_complete: baselinesComplete,
    unwaived_anti_slop_findings: Number(result.unwaived_anti_slop_findings || 0),
    required_states: requiredStates,
    state_coverage: result.state_coverage || null,
    artifacts,
    report_file: result.report_file || "",
    artifact_dir: result.artifact_dir || "",
    qa_started_at: result.started_at,
    qa_finished_at: result.finished_at,
    recorded_at: new Date().toISOString()
  };
  const saved = await writeFrontendProductState(projectRoot, {
    ...state,
    phase: technicalPassed ? "visual-review" : "visual-qa-failed",
    latest_visual_run: visualRun,
    visual_reviews: []
  });
  return {
    action: technicalPassed ? "awaiting_visual_review" : "visual_qa_failed",
    project_path: projectRoot,
    run_id: runId,
    phase: saved.phase,
    technical_passed: technicalPassed,
    strict_checks: {
      desktop_and_mobile: desktopAndMobile,
      required_states_covered: requiredStatesCovered,
      baselines_complete: baselinesComplete,
      unwaived_anti_slop_findings: visualRun.unwaived_anti_slop_findings
    },
    required_review_artifacts: artifacts,
    qa: result,
    next_step: technicalPassed
      ? "Inspect every listed artifact and call record_visual_review with the ten-dimension scorecard."
      : "Fix the blocking evidence, preserve approved baselines, and rerun strict visual QA."
  };
}

function resolveFrontendReviewArtifact(projectRoot, artifactPath) {
  const value = String(artifactPath || "").trim();
  if (!value) throw new Error("Visual review artifact path is required.");
  if (!path.isAbsolute(value)) return safeProjectFile(projectRoot, value);
  const resolved = path.resolve(value);
  if (
    !isPathInside(projectRoot, resolved) &&
    !isPathInside(frontendQaArtifactsRoot, resolved)
  ) {
    throw new Error(`Visual review artifact is outside approved roots: ${value}`);
  }
  return resolved;
}

async function frontendReviewArtifactsCurrent(projectRoot, state) {
  const review = (state?.visual_reviews || []).at(-1);
  if (!review) {
    return {
      available: false,
      current: false,
      checked: 0,
      changed: []
    };
  }
  const changed = [];
  for (const artifact of review.artifacts || []) {
    try {
      const absolute = resolveFrontendReviewArtifact(projectRoot, artifact.path);
      const currentHash = sha256(await fs.readFile(absolute));
      if (!artifact.sha256 || currentHash !== artifact.sha256) {
        changed.push({
          path: artifact.path,
          reason: "hash_changed"
        });
      }
    } catch (error) {
      changed.push({
        path: artifact.path,
        reason: "missing_or_unreadable",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (!(review.artifacts || []).length) {
    changed.push({
      path: "",
      reason: "no_reviewed_artifacts"
    });
  }
  return {
    available: true,
    current: changed.length === 0,
    checked: (review.artifacts || []).length,
    changed
  };
}

async function recordVisualReview({
  project_path,
  reviewer,
  reviewer_role = "",
  inspections = [],
  scorecard
}) {
  const projectRoot = await resolveTaskProjectRoot(project_path);
  const state = await readFrontendProductState(projectRoot);
  const run = state.latest_visual_run;
  const errors = [];
  if (!run) errors.push("No strict Visual Reference QA run exists.");
  else if (run.status !== "awaiting_review") {
    errors.push(`Latest Visual Reference QA status is ${run.status}; expected awaiting_review.`);
  }
  const reviewerName = String(reviewer || "").trim();
  if (!String(state.implementer || "").trim()) {
    errors.push("Frontend product state must name the implementer before independent review.");
  }
  if (!reviewerName) errors.push("Visual review requires a reviewer.");
  if (
    reviewerName &&
    String(state.implementer || "").trim() &&
    reviewerName.toLowerCase() === String(state.implementer).trim().toLowerCase()
  ) {
    errors.push("Visual reviewer must be independent from the implementer.");
  }
  errors.push(...validateProductDesignScorecard(scorecard));

  const inspectionMap = new Map((inspections || []).map((inspection) => [
    String(inspection?.path || "").replaceAll("\\", "/").toLowerCase(),
    inspection
  ]));
  const reviewedArtifacts = [];
  for (const artifact of run?.artifacts || []) {
    const key = String(artifact.path).replaceAll("\\", "/").toLowerCase();
    const inspection = inspectionMap.get(key);
    if (!inspection) {
      errors.push(`Missing visual inspection for artifact: ${artifact.path}.`);
      continue;
    }
    if (!["browser", "view_image", "human"].includes(String(inspection.inspection_method || ""))) {
      errors.push(`Unsupported inspection method for ${artifact.path}.`);
    }
    if (String(inspection.observations || "").trim().length < 10) {
      errors.push(`Visual inspection needs concrete observations for ${artifact.path}.`);
    }
    try {
      const absolute = resolveFrontendReviewArtifact(projectRoot, artifact.path);
      const content = await fs.readFile(absolute);
      reviewedArtifacts.push({
        ...artifact,
        absolute_path: absolute,
        sha256: sha256(content),
        inspection_method: String(inspection.inspection_method || ""),
        observations: String(inspection.observations || "").trim()
      });
    } catch (error) {
      errors.push(`Could not hash reviewed artifact ${artifact.path}: ${error.message}`);
    }
  }
  if (errors.length) {
    return {
      action: "rejected",
      project_path: projectRoot,
      run_id: run?.run_id || "",
      errors
    };
  }

  const review = {
    review_id: `visual-review-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    run_id: run.run_id,
    reviewer: reviewerName,
    reviewer_role: String(reviewer_role || "").trim(),
    independent: true,
    artifact_hashes_current: true,
    artifacts: reviewedArtifacts,
    scorecard,
    reviewed_at: new Date().toISOString()
  };
  const saved = await writeFrontendProductState(projectRoot, {
    ...state,
    phase: "handoff-ready",
    latest_visual_run: {
      ...run,
      status: "passed",
      reviewed_at: review.reviewed_at,
      review_id: review.review_id
    },
    visual_reviews: [...(state.visual_reviews || []), review]
  });
  const documentHashes = await frontendProductDocumentHashes(projectRoot);
  return {
    action: "visual_review_recorded",
    project_path: projectRoot,
    phase: saved.phase,
    review,
    handoff_gate: evaluateFrontendProductGate(saved, {
      gate: "handoff",
      currentDocumentHashes: documentHashes
    })
  };
}

async function listMarkdownFiles(root) {
  const results = [];
  const skip = new Set([".git", ".obsidian", "node_modules", "dist"]);

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(vaultRoot, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (rel.includes("03-skills-catalog/sources/membrane/application-skills/.git")) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(rel);
      }
    }
  }

  await walk(root);
  return results;
}

function scoreText(query, fields) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const terms = q.split(/\s+/).filter(Boolean);
  const text = fields.join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
  }
  if (fields.some((field) => field.toLowerCase().includes(q))) score += 3;
  return score;
}

function autoCommandPublic(command) {
  return {
    name: command.name,
    display_name: command.display_name,
    aliases: command.aliases,
    purpose: command.purpose,
    tools: command.tools,
    skills: command.skills,
    required_context: command.required_context,
    steps: command.steps,
    guardrails: command.guardrails,
    completion_report: command.completion_report ?? []
  };
}

function listAutoCommands() {
  return autoCommands.map(autoCommandPublic);
}

function scoreAutoCommand(request, command) {
  const normalized = (request ?? "").toLowerCase().trim();
  const fields = [
    command.name,
    command.display_name,
    command.purpose,
    command.aliases.join(" "),
    command.tools.join(" "),
    command.skills.join(" "),
    command.required_context.join(" "),
    command.steps.join(" "),
    command.guardrails.join(" "),
    (command.completion_report ?? []).join(" ")
  ];
  let score = scoreText(normalized, fields);
  for (const alias of command.aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (normalized === normalizedAlias) score += 20;
    else if (normalized.includes(normalizedAlias)) score += 10;
  }
  if (normalized.includes(command.name)) score += 12;
  return score;
}

function matchAutoCommand({ request, limit = 3 }) {
  if (!request || typeof request !== "string") {
    throw new Error("request is required.");
  }
  return autoCommands
    .map((command) => ({
      score: scoreAutoCommand(request, command),
      ...autoCommandPublic(command)
    }))
    .filter((command) => command.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function readAutoCommand({ name }) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required.");
  }
  const normalized = name.toLowerCase().trim();
  const command = autoCommands.find((item) => (
    item.name.toLowerCase() === normalized ||
    item.display_name.toLowerCase() === normalized ||
    item.aliases.some((alias) => alias.toLowerCase() === normalized)
  ));
  if (!command) throw new Error(`Auto command not found: ${name}`);
  return autoCommandPublic(command);
}

async function analyzeProjectTool({ project_path, project_name = "", max_depth = 4 }) {
  const projectRoot = await safeProjectRoot(project_path);
  return analyzeProject(projectRoot, {
    projectName: project_name,
    maxDepth: Math.max(1, Math.min(Number(max_depth) || 4, 6))
  });
}

async function buildProjectContextPack({
  projectRoot,
  task,
  projectName = "",
  acceptanceCriteria = [],
  maxSourceFiles = 12,
  maxChars = 24_000
}) {
  const identity = await resolveProjectIdentity(projectRoot);
  const detected = {
    ...await detectProject(identity.project_root, projectName),
    project_id: identity.project_id,
    repository_id: identity.repository_id,
    canonical_project_path: identity.canonical_path,
    project_aliases: identity.aliases
  };
  const [skills, projectState, agents, brief, projectMap, qualityGate] = await Promise.all([
    recommendSkillsProjectAware({
      task,
      project_path: identity.project_root,
      limit: 3,
      membrane_policy: "exclude"
    }),
    captureProjectState(identity.project_root),
    readProjectTextIfExists(identity.project_root, "AGENTS.md"),
    readProjectTextIfExists(identity.project_root, ".ai-dev/project-brief.md"),
    readProjectTextIfExists(identity.project_root, ".ai-dev/project-map.md"),
    readProjectTextIfExists(identity.project_root, ".ai-dev/quality-gate.md")
  ]);
  const pack = await compileContextPack({
    projectRoot: identity.project_root,
    task,
    project: detected,
    identity,
    acceptanceCriteria,
    skills,
    projectState,
    agentRules: agents,
    projectBrief: brief,
    projectMap,
    qualityGate,
    maxSourceFiles,
    maxChars
  });
  return { pack, identity, detected, skills, projectState };
}

async function compileProjectContext({
  project_path,
  task,
  project_name = "",
  acceptance_criteria = [],
  max_source_files = 12,
  max_chars = 24_000,
  persist = true
}) {
  const built = await buildProjectContextPack({
    projectRoot: project_path,
    task,
    projectName: project_name,
    acceptanceCriteria: acceptance_criteria,
    maxSourceFiles: Math.max(1, Math.min(Number(max_source_files) || 12, 30)),
    maxChars: Math.max(8_000, Math.min(Number(max_chars) || 24_000, 60_000))
  });
  let paths = null;
  if (persist) {
    const contextRoot = ".ai-dev/context";
    const packRoot = `${contextRoot}/packs`;
    const markdownPath = `${packRoot}/${built.pack.id}.md`;
    const jsonPath = `${packRoot}/${built.pack.id}.json`;
    const latestMarkdownPath = `${contextRoot}/latest.md`;
    const latestJsonPath = `${contextRoot}/latest.json`;
    const { markdown, ...jsonPack } = built.pack;
    await Promise.all([
      writeProjectFile(built.identity.project_root, markdownPath, markdown, true),
      writeProjectFile(built.identity.project_root, jsonPath, `${JSON.stringify(jsonPack, null, 2)}\n`, true),
      writeProjectFile(built.identity.project_root, latestMarkdownPath, markdown, true),
      writeProjectFile(built.identity.project_root, latestJsonPath, `${JSON.stringify(jsonPack, null, 2)}\n`, true)
    ]);
    paths = {
      markdown: markdownPath,
      json: jsonPath,
      latest_markdown: latestMarkdownPath,
      latest_json: latestJsonPath
    };
  }
  return {
    action: "project_context_compiled",
    project_path: built.identity.project_root,
    project_id: built.identity.project_id,
    persisted: Boolean(persist),
    paths,
    context_pack: built.pack,
    next_step: "Use this bounded context pack, then inspect only the selected files and their direct dependencies."
  };
}

async function projectContextStatus({ project_path }) {
  const identity = await resolveProjectIdentity(project_path);
  const relativePath = ".ai-dev/context/latest.json";
  const latest = await readJsonIfExists(safeProjectFile(identity.project_root, relativePath));
  if (!latest) {
    return {
      project_path: identity.project_root,
      project_id: identity.project_id,
      compiled: false,
      next_step: "Run compile_project_context for the current task."
    };
  }
  const state = await captureProjectState(identity.project_root);
  return {
    project_path: identity.project_root,
    project_id: identity.project_id,
    compiled: true,
    path: relativePath,
    context_pack_id: latest.id,
    task: latest.task,
    generated_at: latest.generated_at,
    selected_files: (latest.selected_files ?? []).map((file) => file.path),
    freshness: contextPackFreshness(latest, state),
    next_step: contextPackFreshness(latest, state).fresh
      ? "Use the current context pack."
      : "Recompile project context before substantive work."
  };
}

async function beginTask({
  project_path,
  task,
  project_name = "",
  acceptance_criteria = []
}) {
  const identity = await resolveProjectIdentity(project_path);
  const projectRoot = identity.project_root;
  const detected = {
    ...await detectProject(projectRoot, project_name),
    project_id: identity.project_id,
    repository_id: identity.repository_id,
    canonical_project_path: identity.canonical_path,
    project_aliases: identity.aliases
  };
  const [skills, baseline, agents, brief, projectMap, qualityGate] = await Promise.all([
    recommendSkillsProjectAware({
      task,
      project_path: projectRoot,
      limit: 3,
      membrane_policy: "exclude"
    }),
    captureProjectState(projectRoot),
    readProjectTextIfExists(projectRoot, "AGENTS.md"),
    readProjectTextIfExists(projectRoot, ".ai-dev/project-brief.md"),
    readProjectTextIfExists(projectRoot, ".ai-dev/project-map.md"),
    readProjectTextIfExists(projectRoot, ".ai-dev/quality-gate.md")
  ]);
  const contextPack = await compileContextPack({
    projectRoot,
    task,
    project: detected,
    identity,
    acceptanceCriteria: acceptance_criteria,
    skills,
    projectState: baseline,
    agentRules: agents,
    projectBrief: brief,
    projectMap,
    qualityGate,
    maxSourceFiles: 12,
    maxChars: 20_000
  });
  const record = await taskStore.begin({
    task,
    project: detected,
    skills,
    acceptanceCriteria: acceptance_criteria,
    baseline,
    context: {
      bounded: true,
      context_pack_id: contextPack.id,
      compiled_context: contextPack.markdown,
      selected_files: contextPack.selected_files.map((file) => ({
        path: file.path,
        score: file.score,
        reasons: file.reasons,
        sha256: file.sha256
      })),
      context_unknowns: contextPack.unknowns,
      project_brief_path: ".ai-dev/project-brief.md",
      project_map_path: ".ai-dev/project-map.md",
      quality_gate_path: ".ai-dev/quality-gate.md",
      components: detected.components ?? [],
      architecture: detected.architecture ?? {},
      project_identity: identity
    }
  });
  return {
    ...record,
    next_actions: [
      "Confirm or refine acceptance criteria with checkpoint_task before broad implementation.",
      "Use the compiled context pack, then read only routed skills and direct dependencies of selected files.",
      "After edits, checkpoint changed files, then run verify_task.",
      "Call complete_task only after every acceptance criterion is met or explicitly waived."
    ]
  };
}

async function getTask({ task_id }) {
  return taskStore.read(task_id);
}

async function listTasks({ project_path = "", status = "", limit = 20 }) {
  return taskStore.list({ projectPath: project_path, status, limit });
}

async function skillOutcomeStatus() {
  return skillOutcomeStore.status();
}

async function rebuildSkillOutcomes() {
  const tasks = await taskStore.list({ limit: 5000 });
  const entries = [];
  const skipped = [];
  for (const task of tasks) {
    if (task.status !== "complete" || !task.completion) {
      skipped.push({ task_id: task.id, reason: `status=${task.status}` });
      continue;
    }
    const verificationIds = new Set(task.completion.verification_ids || []);
    const verification = [...(task.verifications || [])]
      .reverse()
      .find((item) => verificationIds.has(item.id) && item.passed);
    if (!verification) {
      skipped.push({ task_id: task.id, reason: "no completion-bound passing verification" });
      continue;
    }
    const projectIdentity = await resolveProjectIdentity(task.project.path);
    entries.push({
      task,
      verification,
      projectState: task.completion.project_state,
      projectIdentity
    });
  }
  const status = await skillOutcomeStore.rebuildFromCompletedTasks(entries);
  return {
    status: "rebuilt",
    completed_tasks: entries.length,
    skipped,
    outcome_status: status
  };
}

async function startProjectPilot({
  project_path,
  title,
  task_type = "other",
  task_id = "",
  baseline,
  implementer = ""
}) {
  const identity = await resolveProjectIdentity(project_path);
  if (task_id) {
    const task = await taskStore.read(task_id);
    const taskIdentity = await resolveProjectIdentity(task.project.path);
    if (taskIdentity.project_id !== identity.project_id) {
      throw new Error("Pilot project does not match the linked task project.");
    }
  }
  const pilot = await pilotStore.start({
    projectIdentity: identity,
    title,
    taskType: task_type,
    taskId: task_id,
    baseline,
    implementer
  });
  return {
    pilot,
    required_dimensions: PILOT_DIMENSIONS,
    next_step: task_id
      ? "Complete and verify the linked task, then record an independent pilot review."
      : "Link a lifecycle task when available, then record an independent pilot review."
  };
}

async function recordProjectPilotReview({
  pilot_id,
  verdict,
  reviewer,
  revision_count,
  duration_minutes,
  dimensions,
  notes = ""
}) {
  const current = await pilotStore.status({ id: pilot_id });
  const pilot = current.pilots[0];
  if (!pilot) throw new Error(`Pilot not found: ${pilot_id}`);
  if (pilot.task_id) {
    const task = await taskStore.read(pilot.task_id);
    if (task.status !== "complete") {
      throw new Error("Linked task must be complete before pilot review is recorded.");
    }
  }
  const updated = await pilotStore.review(pilot_id, {
    verdict,
    reviewer,
    revision_count,
    duration_minutes,
    dimensions,
    notes
  });
  const outcome = updated.task_id
    ? await skillOutcomeStore.applyPilotReview(updated.task_id, updated.review)
    : { updated: false, reason: "pilot is not linked to a lifecycle task" };
  return {
    pilot: updated,
    skill_outcomes: outcome
  };
}

async function projectPilotStatus({ pilot_id = "", project_path = "" } = {}) {
  const projectId = project_path
    ? (await resolveProjectIdentity(project_path)).project_id
    : "";
  return pilotStore.status({ id: pilot_id, projectId });
}

async function checkpointTask({
  task_id,
  summary,
  changed_files = [],
  criteria = [],
  notes = ""
}) {
  return taskStore.checkpoint(task_id, {
    summary,
    changedFiles: changed_files,
    criteria,
    notes
  });
}

function verificationPassed(checks) {
  if (!checks.length) return false;
  return checks.every((item) => {
    if (item.type === "quality_gate") return item.result?.status === "passed";
    if (item.type === "frontend_qa") return item.result?.gate === "pass";
    if (item.type === "frontend_product") return item.result?.ok === true;
    return false;
  });
}

async function verifyTask({
  task_id,
  run_quality = true,
  quality_labels = [],
  run_frontend = false,
  frontend_options = {}
}) {
  const record = await taskStore.read(task_id);
  if (record.status === "complete") throw new Error("Completed task cannot be verified again.");
  const projectIdentity = await resolveProjectIdentity(record.project.path);
  const projectRoot = projectIdentity.project_root;
  const checks = [];

  if (run_quality) {
    try {
      checks.push({
        type: "quality_gate",
        result: await runQualityGate({
          project_path: projectRoot,
          labels: quality_labels,
          dry_run: false,
          update_registry: false,
          register_if_missing: false
        })
      });
    } catch (error) {
      checks.push({
        type: "quality_gate",
        result: {
          status: "unavailable",
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  if (run_frontend) {
    if (!record.project.types.includes("frontend")) {
      checks.push({
        type: "frontend_qa",
        result: {
          gate: "block",
          status: "not_frontend",
          error: "Task project is not detected as frontend."
        }
      });
    } else {
      try {
        checks.push({
          type: "frontend_qa",
          result: await runFrontendQa({
            ...frontend_options,
            project_path: projectRoot,
            project_name: record.project.name,
            update_registry: false,
            register_if_missing: false
          })
        });
      } catch (error) {
        checks.push({
          type: "frontend_qa",
          result: {
            gate: "block",
            status: "unavailable",
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  if (record.project.types.includes("frontend")) {
    const productState = await readFrontendProductState(projectRoot, { required: false });
    const frontendProductTask = taskLooksFrontendProduct(record.task);
    if (frontendProductTask) {
      if (!productState) {
        checks.push({
          type: "frontend_product",
          result: {
            ok: false,
            gate: "handoff",
            blockers: ["Frontend Product Quality v2 is not prepared for this visual task."]
          }
        });
      } else {
        const hashes = await frontendProductDocumentHashes(projectRoot).catch(() => ({}));
        const artifactStatus = await frontendReviewArtifactsCurrent(projectRoot, productState);
        checks.push({
          type: "frontend_product",
          result: {
            ...evaluateFrontendProductGate(productState, {
              gate: "handoff",
              currentDocumentHashes: hashes,
              reviewArtifactsCurrent: artifactStatus.current
            }),
            reviewed_artifacts: artifactStatus
          }
        });
      }
    }
  }

  const projectState = await captureProjectState(projectRoot);
  const passed = verificationPassed(checks);
  const verification = {
    id: `verification-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
    passed,
    checks,
    evidence: bindEvidence({
      type: "task-verification",
      result: { status: passed ? "passed" : "failed" },
      projectState,
      details: {
        checks: checks.map((item) => ({
          type: item.type,
          status: item.result?.status || item.result?.gate || "unknown"
        }))
      }
    })
  };
  let updated = await taskStore.addVerification(task_id, verification);
  const skillOutcomes = await skillOutcomeStore.recordVerification({
    task: updated,
    verification,
    projectState,
    projectIdentity
  });

  if (passed) {
    const criteria = [];
    for (const item of updated.acceptance_criteria) {
      if (/automated checks pass/i.test(item.text)) {
        criteria.push({ id: item.id, status: "met", evidence: [verification.id] });
      }
      if (run_frontend && /changed ui is checked/i.test(item.text)) {
        criteria.push({ id: item.id, status: "met", evidence: [verification.id] });
      }
      if (/design-first implementation gate|strict visual reference qa/i.test(item.text)) {
        criteria.push({ id: item.id, status: "met", evidence: [verification.id] });
      }
    }
    if (criteria.length) {
      updated = await taskStore.checkpoint(task_id, {
        summary: "Automated verification passed.",
        criteria,
        notes: `Evidence: ${verification.id}`
      });
    }
  }
  return {
    task: updated,
    verification,
    skill_outcomes: skillOutcomes,
    current_project_state: projectState
  };
}

function taskCompletionMarkdown(record) {
  const lines = [
    "---",
    `task_id: ${record.id}`,
    `project: ${JSON.stringify(record.project.name)}`,
    `status: ${record.status}`,
    `completed_at: ${record.completion?.at || ""}`,
    "---",
    "",
    `# ${record.task}`,
    "",
    `Project: \`${record.project.path}\``,
    "",
    `Risk: ${record.risk}`,
    "",
    "## Completion",
    "",
    record.completion?.summary || "",
    "",
    "## Acceptance Criteria",
    ""
  ];
  for (const item of record.acceptance_criteria) {
    lines.push(`- [${item.status === "met" ? "x" : " "}] ${item.id}: ${item.text}${item.note ? ` (${item.note})` : ""}`);
  }
  lines.push("", "## Skills", "");
  for (const item of record.skills) lines.push(`- ${item.name} (${item.routing_role || item.role || "routed"})`);
  lines.push("", "## Verification", "");
  for (const item of record.verifications) {
    lines.push(`- ${item.id}: ${item.passed ? "passed" : "failed"} at ${item.at}`);
  }
  return `${lines.join("\n")}\n`;
}

async function completeTask({
  task_id,
  summary,
  allow_waived = false,
  write_report = true
}) {
  const existing = await taskStore.read(task_id);
  const projectIdentity = await resolveProjectIdentity(existing.project.path);
  const projectRoot = projectIdentity.project_root;
  const projectState = await captureProjectState(projectRoot);
  const record = await taskStore.complete(task_id, {
    summary,
    projectState,
    allowWaived: allow_waived
  });
  const completionVerificationIds = new Set(record.completion?.verification_ids || []);
  const finalVerification = [...record.verifications]
    .reverse()
    .find((item) => completionVerificationIds.has(item.id) && item.passed);
  const skillOutcomes = await skillOutcomeStore.recordCompletion({
    task: record,
    verification: finalVerification,
    projectState,
    projectIdentity
  });
  let report = null;
  if (write_report) {
    report = await writeKnowledgeNote({
      path: `02-knowledge/Task Runs/${record.id}.md`,
      content: taskCompletionMarkdown(record),
      overwrite: true
    });
  }
  return { task: record, report, skill_outcomes: skillOutcomes };
}

const tools = buildToolDefinitions({
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_MODES,
  PILOT_DIMENSIONS,
  PILOT_TASK_TYPES,
  PRODUCT_DESIGN_SCORECARD_DIMENSIONS,
  REFERENCE_FACTORY_GENERATORS,
  REFERENCE_FACTORY_SURFACES,
  UI_UX_PRO_MAX_DOMAINS,
  UI_UX_PRO_MAX_STACKS
});

async function searchKnowledge({ query, limit = 10 }) {
  const files = await listMarkdownFiles(vaultRoot);
  const matches = [];
  for (const file of files) {
    if (file.includes("03-skills-catalog/sources/membrane/application-skills/skills/")) continue;
    const text = await readText(file);
    const score = scoreText(query, [file, text.slice(0, 8000)]);
    if (score > 0) {
      matches.push({
        path: file,
        score,
        preview: text.replace(/\s+/g, " ").slice(0, 240)
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

async function searchAll({
  query,
  scope = "all",
  limit = 10,
  project = "",
  source = "",
  categories = "",
  folders = ""
}) {
  return searchIndex({ query, scope, limit, project, source, categories, folders });
}

const SEARCH_PRESETS = Object.freeze({
  balanced: {
    description: "Default hybrid search for mixed knowledge, project, and skill lookup.",
    use_when: "General AI Dev System lookup when the target source is not obvious.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.45,
    semantic_weight: 0.20,
    dense_weight: 0.35
  },
  code: {
    description: "Code and repository lookup biased toward exact names, paths, commands, symbols, and project files.",
    use_when: "Finding AGENTS.md, project maps, commands, filenames, stack notes, or repo-local AI-dev files.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.65,
    semantic_weight: 0.15,
    dense_weight: 0.20,
    intent_routing: true
  },
  docs: {
    description: "Knowledge-base lookup biased toward meaning and explanatory notes.",
    use_when: "Finding architecture notes, runbooks, system docs, decisions, or conceptual explanations.",
    scope: "knowledge",
    limit: 8,
    keyword_weight: 0.25,
    semantic_weight: 0.25,
    dense_weight: 0.50,
    intent_routing: true
  },
  skills: {
    description: "Skill registry lookup for choosing or reading task-specific skills.",
    use_when: "Finding relevant custom, design, Membrane, or integration skills.",
    scope: "skills",
    limit: 10,
    keyword_weight: 0.35,
    semantic_weight: 0.25,
    dense_weight: 0.40,
    intent_routing: true
  },
  projects: {
    description: "Project registry lookup biased toward registered project cards and project context.",
    use_when: "Finding a project, its stack, quality status, risks, active tasks, or recommended skills.",
    scope: "projects",
    limit: 8,
    keyword_weight: 0.50,
    semantic_weight: 0.20,
    dense_weight: 0.30
  },
  debug: {
    description: "Bug/debug lookup biased toward exact errors, commands, failing checks, and known investigation workflows.",
    use_when: "Investigating failures, stack traces, regressions, CI issues, or quality gate problems.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.60,
    semantic_weight: 0.20,
    dense_weight: 0.20,
    intent_routing: true
  },
  frontend: {
    description: "Frontend/design lookup biased toward visual intent and design workflow meaning.",
    use_when: "Finding UI, UX, redesign, landing page, responsive, browser-check, or design-taste guidance.",
    scope: "all",
    limit: 10,
    keyword_weight: 0.25,
    semantic_weight: 0.25,
    dense_weight: 0.50,
    intent_routing: true
  },
  quality: {
    description: "Quality-gate lookup for verification, tests, review standards, and safety checks.",
    use_when: "Finding checks, quality gates, review rules, test strategy, or verification commands.",
    scope: "quality",
    limit: 8,
    keyword_weight: 0.45,
    semantic_weight: 0.25,
    dense_weight: 0.30
  }
});

const SEARCH_PRESET_ALIASES = Object.freeze({
  default: "balanced",
  all: "balanced",
  general: "balanced",
  repo: "code",
  repository: "code",
  command: "code",
  commands: "code",
  symbol: "code",
  symbols: "code",
  knowledge: "docs",
  doc: "docs",
  document: "docs",
  documentation: "docs",
  note: "docs",
  notes: "docs",
  skill: "skills",
  project: "projects",
  registry: "projects",
  bug: "debug",
  bugs: "debug",
  error: "debug",
  failure: "debug",
  ci: "debug",
  design: "frontend",
  ui: "frontend",
  ux: "frontend",
  front: "frontend",
  review: "quality",
  tests: "quality",
  test: "quality",
  gate: "quality"
});

function searchPresetName(value = "balanced") {
  const normalized = String(value || "balanced").toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return SEARCH_PRESET_ALIASES[normalized] || normalized || "balanced";
}

function getSearchPreset(value = "balanced") {
  const name = searchPresetName(value);
  const preset = SEARCH_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown search preset: ${value}. Use list_search_presets to see valid presets.`);
  }
  return { name, ...preset };
}

function listSearchPresets() {
  const aliasesByPreset = new Map();
  for (const [alias, name] of Object.entries(SEARCH_PRESET_ALIASES)) {
    if (!aliasesByPreset.has(name)) aliasesByPreset.set(name, []);
    aliasesByPreset.get(name).push(alias);
  }
  return Object.entries(SEARCH_PRESETS).map(([name, preset]) => ({
    name,
    aliases: aliasesByPreset.get(name) || [],
    ...preset,
    weights: {
      keyword: preset.keyword_weight,
      semantic: preset.semantic_weight,
      dense: preset.dense_weight
    }
  }));
}

function optionProvided(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined && options[key] !== null && options[key] !== "";
}

function presetOption(options, key, fallback) {
  return optionProvided(options, key) ? options[key] : fallback;
}

function resolveSearchPresetArgs(options = {}, { defaultLimit = 10 } = {}) {
  const preset = getSearchPreset(options.preset || "balanced");
  const limitFallback = preset.limit || defaultLimit;
  const limit = Math.max(1, Math.min(Number(presetOption(options, "limit", limitFallback)) || limitFallback, 50));
  return {
    preset,
    search: {
      query: options.query,
      scope: presetOption(options, "scope", preset.scope || "all"),
      limit,
      project: presetOption(options, "project", ""),
      source: presetOption(options, "source", ""),
      categories: presetOption(options, "categories", ""),
      folders: presetOption(options, "folders", ""),
      semantic_weight: Number(presetOption(options, "semantic_weight", preset.semantic_weight ?? 0.20)),
      keyword_weight: Number(presetOption(options, "keyword_weight", preset.keyword_weight ?? 0.45)),
      dense_weight: Number(presetOption(options, "dense_weight", preset.dense_weight ?? 0.35)),
      dense_model_dir: presetOption(options, "dense_model_dir", undefined),
      dense_device: presetOption(options, "dense_device", "cpu"),
      intent_routing: Boolean(presetOption(options, "intent_routing", preset.intent_routing ?? false)),
      rerank: Boolean(presetOption(options, "rerank", true)),
      preset_name: preset.name
    }
  };
}

function appliedSearchPresetSummary(resolved) {
  const weights = normalizedSearchWeights(resolved.search);
  return {
    preset: {
      name: resolved.preset.name,
      description: resolved.preset.description,
      use_when: resolved.preset.use_when
    },
    scope: resolved.search.scope,
    limit: resolved.search.limit,
    filters: {
      project: resolved.search.project || "",
      source: resolved.search.source || "",
      categories: csvValue(resolved.search.categories),
      folders: csvValue(resolved.search.folders)
    },
    weights: {
      requested: {
        keyword: clampSearchWeight(resolved.search.keyword_weight, 0.45),
        semantic: clampSearchWeight(resolved.search.semantic_weight, 0.20),
        dense: clampSearchWeight(resolved.search.dense_weight, 0.35)
      },
      normalized: {
        keyword: roundSearchNumber(weights.keyword),
        semantic: roundSearchNumber(weights.semantic),
        dense: roundSearchNumber(weights.dense)
      }
    },
    reranker: {
      enabled: resolved.search.rerank !== false,
      version: 2,
      hard_negative_rules: "golden cases plus domain conflicts"
    }
  };
}

async function hybridSearch(options = {}) {
  const resolved = resolveSearchPresetArgs(options, { defaultLimit: 10 });
  return hybridSearchIndex(resolved.search);
}

function clampSearchWeight(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(number, 1));
}

function normalizedSearchWeights({ keyword_weight = 0.45, semantic_weight = 0.20, dense_weight = 0.35 } = {}) {
  let keyword = clampSearchWeight(keyword_weight, 0.45);
  let semantic = clampSearchWeight(semantic_weight, 0.20);
  let dense = clampSearchWeight(dense_weight, 0.35);
  let total = keyword + semantic + dense;
  if (total <= 0) {
    keyword = 0.45;
    semantic = 0.20;
    dense = 0.35;
    total = keyword + semantic + dense;
  }
  return {
    keyword: keyword / total,
    semantic: semantic / total,
    dense: dense / total
  };
}

function roundSearchNumber(value, digits = 6) {
  const number = Number(value) || 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function explainSearchProfile(result) {
  const parts = [
    { name: "keyword", score: Number(result.keyword_score) || 0 },
    { name: "semantic", score: Number(result.semantic_score) || 0 },
    { name: "dense", score: Number(result.dense_score) || 0 }
  ].sort((a, b) => b.score - a.score);
  const top = parts[0];
  if (!top || top.score <= 0) return "weak match; result is mostly from boosts or fallback scoring";
  if (top.name === "keyword") return "keyword/FTS match is the strongest signal";
  if (top.name === "dense") return "dense BGE-M3 meaning match is the strongest signal";
  return "local sparse semantic match is the strongest signal";
}

function explainScoreAdjustment(value) {
  if (value >= 0.03) return "positive adjustment from lexical boost or vault-note preference";
  if (value <= -0.03) return "negative adjustment from source penalty or other ranking guardrail";
  return "close to pure weighted score";
}

function explainSearchResult(result, index, weights) {
  const keywordRaw = Number(result.keyword_score) || 0;
  const semanticRaw = Number(result.semantic_score) || 0;
  const denseRaw = Number(result.dense_score) || 0;
  const keywordContribution = keywordRaw * weights.keyword;
  const semanticContribution = semanticRaw * weights.semantic;
  const denseContribution = denseRaw * weights.dense;
  const weightedScore = keywordContribution + semanticContribution + denseContribution;
  const adjustment = (Number(result.score) || 0) - weightedScore;
  return {
    rank: index + 1,
    title: result.title,
    path: result.path,
    scope: result.scope,
    source: result.source,
    score: result.score,
    original_rank: result.original_rank,
    original_score: result.original_score,
    rerank_adjustment: result.rerank_adjustment,
    rerank_reasons: result.rerank_reasons || [],
    hard_negative: Boolean(result.hard_negative),
    hard_negative_reasons: result.hard_negative_reasons || [],
    weighted_score_before_adjustments: roundSearchNumber(weightedScore),
    score_adjustment: roundSearchNumber(adjustment),
    score_parts: {
      keyword: {
        raw: roundSearchNumber(keywordRaw),
        weight: roundSearchNumber(weights.keyword),
        contribution: roundSearchNumber(keywordContribution)
      },
      semantic: {
        raw: roundSearchNumber(semanticRaw),
        weight: roundSearchNumber(weights.semantic),
        contribution: roundSearchNumber(semanticContribution)
      },
      dense: {
        raw: roundSearchNumber(denseRaw),
        weight: roundSearchNumber(weights.dense),
        contribution: roundSearchNumber(denseContribution)
      }
    },
    likely_reason: explainSearchProfile(result),
    adjustment_note: explainScoreAdjustment(adjustment),
    preview: result.preview
  };
}

function explainSearchTuningNotes(results, weights) {
  const notes = [];
  const hasDense = results.some((item) => Number(item.dense_score) > 0);
  const hasKeyword = results.some((item) => Number(item.keyword_score) > 0);
  if (!hasDense && weights.dense > 0) {
    notes.push("Dense weight is enabled, but returned results have no dense score. Rebuild the index with dense_embeddings=true or check the dense backend.");
  }
  if (!hasKeyword) {
    notes.push("Keyword score is zero for these results; the query is being answered mostly by semantic meaning rather than exact terms.");
  }
  if (results.length >= 2 && Number(results[0].score) - Number(results[1].score) < 0.03) {
    notes.push("Top results are close; read the first few before choosing context.");
  }
  if (!notes.length) {
    notes.push("Ranking signals look healthy: at least one exact, sparse, or dense signal is contributing to the returned results.");
  }
  return notes;
}

async function presetSearch(options = {}) {
  const explain = Boolean(options.explain);
  const resolved = resolveSearchPresetArgs(options, { defaultLimit: 10 });
  const results = await hybridSearchIndex(resolved.search);
  const weights = normalizedSearchWeights(resolved.search);
  return {
    query: resolved.search.query,
    result_count: results.length,
    applied: appliedSearchPresetSummary(resolved),
    tuning_notes: explain ? explainSearchTuningNotes(results, weights) : undefined,
    results: explain
      ? results.map((item, index) => explainSearchResult(item, index, weights))
      : results
  };
}

function resolveSearchEvalCasesPath(casesPath = "") {
  if (!casesPath) return searchEvalCasesPath;
  const resolved = path.resolve(path.isAbsolute(casesPath) ? casesPath : safePath(casesPath));
  const normalizedRoot = path.resolve(vaultRoot).toLowerCase();
  const normalizedTarget = resolved.toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Search eval cases path escapes vault root: ${casesPath}`);
  }
  return resolved;
}

async function readSearchEvalCases(casesPath = "") {
  const resolved = resolveSearchEvalCasesPath(casesPath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(stripBom(raw));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) {
    throw new Error("Search eval cases file must be an array or an object with a cases array.");
  }
  return {
    path: path.relative(vaultRoot, resolved).replaceAll("\\", "/"),
    schema_version: Array.isArray(parsed) ? 1 : (parsed.schema_version ?? 1),
    description: Array.isArray(parsed) ? "" : (parsed.description || ""),
    cases
  };
}

function searchEvalList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function searchEvalNormalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

function searchEvalFieldMatches(actual, expected, { exact = false } = {}) {
  if (expected === undefined || expected === null || expected === "") {
    return { checked: false, ok: true };
  }
  const actualText = searchEvalNormalize(actual);
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const ok = expectedValues.some((value) => {
    if (value && typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "equals")) {
        return actualText === searchEvalNormalize(value.equals);
      }
      if (Object.prototype.hasOwnProperty.call(value, "contains")) {
        return actualText.includes(searchEvalNormalize(value.contains));
      }
      if (Object.prototype.hasOwnProperty.call(value, "regex")) {
        try {
          return new RegExp(String(value.regex), "i").test(String(actual ?? ""));
        } catch {
          return false;
        }
      }
    }
    return exact ? actualText === searchEvalNormalize(value) : actualText.includes(searchEvalNormalize(value));
  });
  return { checked: true, ok, actual, expected };
}

function searchEvalResultText(result) {
  return [
    result.title,
    result.path,
    result.scope,
    result.source,
    result.categories,
    result.preview
  ].map((value) => String(value ?? "")).join("\n");
}

function searchEvalResultMatches(result, expectation = {}) {
  const checks = [];
  const fieldSpecs = [
    ["title", false],
    ["path", false],
    ["scope", true],
    ["source", false],
    ["categories", false],
    ["preview", false]
  ];

  for (const [field, exact] of fieldSpecs) {
    const check = searchEvalFieldMatches(result[field], expectation[field], { exact });
    if (check.checked) checks.push({ field, ...check });
  }

  const textCheck = searchEvalFieldMatches(searchEvalResultText(result), expectation.text, { exact: false });
  if (textCheck.checked) checks.push({ field: "text", ...textCheck });

  if (!checks.length) {
    return {
      matched: false,
      checks: [{ field: "expectation", ok: false, actual: "", expected: "at least one match criterion" }]
    };
  }

  return {
    matched: checks.every((check) => check.ok),
    checks
  };
}

function searchEvalExpectationLabel(expectation = {}) {
  const fields = ["title", "path", "scope", "source", "categories", "text"];
  const parts = [];
  for (const field of fields) {
    if (expectation[field] !== undefined && expectation[field] !== null && expectation[field] !== "") {
      parts.push(`${field}=${JSON.stringify(expectation[field])}`);
    }
  }
  return parts.join(", ") || "empty expectation";
}

function normalizeSearchEvalExpectations(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  if (value && typeof value === "object") return [value];
  return [];
}

function searchEvalGroups(testCase) {
  const topKDefault = Math.max(1, Math.min(Number(testCase.top_k || testCase.limit || 5) || 5, 50));
  const groups = [];
  const required = [
    ...normalizeSearchEvalExpectations(testCase.expected),
    ...normalizeSearchEvalExpectations(testCase.expect_all)
  ];

  for (const expectation of required) {
    const alternatives = Array.isArray(expectation.any)
      ? expectation.any.filter((item) => item && typeof item === "object")
      : [expectation];
    groups.push({
      mode: "required",
      top_k: Math.max(1, Math.min(Number(expectation.top_k || topKDefault) || topKDefault, 50)),
      any: alternatives
    });
  }

  const anyExpectations = [
    ...normalizeSearchEvalExpectations(testCase.expected_any),
    ...normalizeSearchEvalExpectations(testCase.expect_any)
  ];
  if (anyExpectations.length) {
    groups.push({
      mode: "one_of",
      top_k: topKDefault,
      any: anyExpectations
    });
  }

  return groups;
}

function summarizeSearchEvalResult(result, index) {
  return {
    rank: index + 1,
    title: result.title,
    path: result.path,
    scope: result.scope,
    source: result.source,
    categories: result.categories,
    score: result.score,
    original_rank: result.original_rank,
    original_score: result.original_score,
    rerank_adjustment: result.rerank_adjustment,
    rerank_reasons: result.rerank_reasons || [],
    hard_negative: Boolean(result.hard_negative),
    hard_negative_reasons: result.hard_negative_reasons || [],
    keyword_score: result.keyword_score,
    semantic_score: result.semantic_score,
    dense_score: result.dense_score,
    duplicate_count: result.duplicate_count || 0
  };
}

function findSearchEvalMatch(results, expectations, topK) {
  const candidates = results.slice(0, topK);
  const inspected = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const result = candidates[index];
    for (const expectation of expectations) {
      const match = searchEvalResultMatches(result, expectation);
      if (match.matched) {
        return {
          matched: true,
          rank: index + 1,
          expectation: searchEvalExpectationLabel(expectation),
          result: summarizeSearchEvalResult(result, index),
          checks: match.checks
        };
      }
      inspected.push({
        rank: index + 1,
        expectation: searchEvalExpectationLabel(expectation),
        checks: match.checks
      });
    }
  }
  return {
    matched: false,
    rank: null,
    expectation: expectations.map(searchEvalExpectationLabel).join(" OR "),
    inspected: inspected.slice(0, 8)
  };
}

function searchEvalEntityKey(result) {
  const resultPath = String(result?.path || "").replaceAll("\\", "/").toLowerCase();
  const title = String(result?.title || "").trim().toLowerCase();
  const isSkillEntity = result?.scope === "skills" && (
    resultPath.startsWith("03-skills-catalog/cards/")
    || (resultPath.includes("/sources/") && resultPath.endsWith("/skill.md"))
  );
  return isSkillEntity ? `skill:${title}` : `path:${resultPath}`;
}

function visibleSearchDuplicates(results) {
  const counts = new Map();
  for (const result of results) {
    const key = searchEvalEntityKey(result);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entity, count]) => ({ entity, count }));
}

function searchEvalNdcg(checks) {
  if (!checks.length) return 0;
  const dcg = checks.reduce((sum, check) => (
    check.matched && Number.isFinite(Number(check.rank))
      ? sum + (1 / Math.log2(Number(check.rank) + 1))
      : sum
  ), 0);
  const ideal = checks.reduce((sum, _check, index) => sum + (1 / Math.log2(index + 2)), 0);
  return ideal > 0 ? dcg / ideal : 0;
}

function evaluateSearchEvalCase(testCase, results) {
  const groups = searchEvalGroups(testCase);
  const topResults = results.slice(0, Math.min(results.length, 5)).map(summarizeSearchEvalResult);
  if (!groups.length) {
    return {
      status: "skipped",
      reason: "No expected, expect_all, expected_any, or expect_any match criteria configured.",
      checks: [],
      top_results: topResults
    };
  }

  const checks = groups.map((group) => ({
    mode: group.mode,
    top_k: group.top_k,
    ...findSearchEvalMatch(results, group.any, group.top_k)
  }));
  const failed = checks.filter((check) => !check.matched);
  const negativeExpectations = normalizeSearchEvalExpectations(testCase.must_not);
  const negativeTopK = Math.max(1, Math.min(Number(testCase.negative_top_k || testCase.top_k || 5) || 5, 50));
  const negativeMatches = negativeExpectations
    .map((expectation) => findSearchEvalMatch(results, [expectation], negativeTopK))
    .filter((item) => item.matched);
  const duplicates = visibleSearchDuplicates(results);
  const maxVisibleDuplicates = Math.max(0, Number(testCase.max_visible_duplicates) || 0);
  const duplicateViolation = duplicates.reduce((sum, item) => sum + item.count - 1, 0) > maxVisibleDuplicates;
  const matchedRank = checks
    .filter((check) => check.matched && Number.isFinite(Number(check.rank)))
    .reduce((best, check) => Math.min(best, Number(check.rank)), Number.POSITIVE_INFINITY);
  const finiteRank = Number.isFinite(matchedRank) ? matchedRank : null;
  return {
    status: failed.length || negativeMatches.length || duplicateViolation ? "fail" : "pass",
    matched_rank: finiteRank,
    reciprocal_rank: finiteRank ? 1 / finiteRank : 0,
    top_1: finiteRank === 1,
    ndcg: searchEvalNdcg(checks),
    checks,
    negative_checks: {
      configured: negativeExpectations.length,
      violations: negativeMatches
    },
    duplicate_checks: {
      visible_duplicates: duplicates,
      visible_duplicate_count: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
      max_visible_duplicates: maxVisibleDuplicates,
      collapsed_duplicate_count: results.reduce((sum, item) => sum + Number(item.duplicate_count || 0), 0)
    },
    top_results: topResults
  };
}

function searchEvalStatus(summary) {
  if (summary.total <= 0) return "fail";
  if (summary.failed > 0) return "fail";
  if (summary.skipped > 0) return "degraded";
  return "ok";
}

function searchEvalRecommendations(summary, includeDense) {
  const recommendations = [];
  if (summary.total <= 0) {
    recommendations.push("Add or unfilter search eval cases before trusting search quality.");
  }
  if (summary.failed > 0) {
    recommendations.push("For failed cases, run explain_search with the same query/preset and compare top results against the expected context.");
    recommendations.push("If expected notes are missing from top results, rebuild_search_index and then tune preset weights or case expectations.");
  }
  if (summary.metrics?.negative_violations > 0) {
    recommendations.push("Inspect must_not violations: irrelevant or unsafe sources are ranking above the allowed boundary.");
  }
  if (summary.metrics?.visible_duplicate_count > 0) {
    recommendations.push("Canonical result collapsing regressed; inspect duplicate skill cards and source documents.");
  }
  if (!includeDense) {
    recommendations.push("This run disabled dense BGE-M3 scoring; run again with include_dense=true for the full production path.");
  }
  if (!recommendations.length) {
    recommendations.push("Golden search cases passed; keep adding cases when new workflows, skills, and project patterns appear.");
  }
  return recommendations;
}

async function runSearchEval(options = {}) {
  const includeDense = options.include_dense !== false;
  const casesFile = await readSearchEvalCases(options.cases_path || "");
  const selectedIds = new Set(searchEvalList(options.case_ids));
  const selectedPresets = new Set(searchEvalList(options.presets).map(searchPresetName));
  const maxCases = Math.max(1, Math.min(Number(options.max_cases) || 50, 200));
  let cases = casesFile.cases;
  if (selectedIds.size) {
    cases = cases.filter((testCase) => selectedIds.has(String(testCase.id || "")));
  }
  if (selectedPresets.size) {
    cases = cases.filter((testCase) => selectedPresets.has(searchPresetName(testCase.preset || "balanced")));
  }
  cases = cases.slice(0, maxCases);

  const caseResults = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const id = String(testCase.id || testCase.query || "unnamed-case");
    try {
      if (!testCase.query || typeof testCase.query !== "string") {
        caseResults.push({
          id,
          status: "fail",
          error: "Case query is required.",
          duration_ms: Date.now() - startedAt
        });
        if (options.fail_fast) break;
        continue;
      }

      const resolved = resolveSearchPresetArgs({
        ...testCase,
        rerank: optionProvided(options, "rerank") ? options.rerank : testCase.rerank,
        dense_model_dir: optionProvided(options, "dense_model_dir") ? options.dense_model_dir : testCase.dense_model_dir,
        dense_device: optionProvided(options, "dense_device") ? options.dense_device : testCase.dense_device
      }, { defaultLimit: 10 });
      if (!includeDense && !optionProvided(testCase, "dense_weight")) {
        resolved.search.dense_weight = 0;
      }

      const results = await hybridSearchIndex(resolved.search);
      const evaluation = evaluateSearchEvalCase(testCase, results);
      caseResults.push({
        id,
        status: evaluation.status,
        query: resolved.search.query,
        preset: resolved.preset.name,
        applied: appliedSearchPresetSummary(resolved),
        result_count: results.length,
        duration_ms: Date.now() - startedAt,
        ...evaluation
      });
      if (options.fail_fast && evaluation.status === "fail") break;
    } catch (err) {
      caseResults.push({
        id,
        status: "fail",
        query: testCase.query || "",
        preset: searchPresetName(testCase.preset || "balanced"),
        error: err.message,
        duration_ms: Date.now() - startedAt
      });
      if (options.fail_fast) break;
    }
  }

  const summary = {
    total: caseResults.length,
    passed: caseResults.filter((item) => item.status === "pass").length,
    failed: caseResults.filter((item) => item.status === "fail").length,
    skipped: caseResults.filter((item) => item.status === "skipped").length
  };
  const scoredCases = caseResults.filter((item) => item.status !== "skipped");
  summary.metrics = {
    mean_reciprocal_rank: scoredCases.length
      ? scoredCases.reduce((sum, item) => sum + Number(item.reciprocal_rank || 0), 0) / scoredCases.length
      : 0,
    top_1_accuracy: scoredCases.length
      ? scoredCases.filter((item) => item.top_1).length / scoredCases.length
      : 0,
    mean_ndcg: scoredCases.length
      ? scoredCases.reduce((sum, item) => sum + Number(item.ndcg || 0), 0) / scoredCases.length
      : 0,
    negative_violations: scoredCases.reduce((sum, item) => sum + Number(item.negative_checks?.violations?.length || 0), 0),
    visible_duplicate_count: scoredCases.reduce((sum, item) => sum + Number(item.duplicate_checks?.visible_duplicate_count || 0), 0),
    collapsed_duplicate_count: scoredCases.reduce((sum, item) => sum + Number(item.duplicate_checks?.collapsed_duplicate_count || 0), 0)
  };

  return {
    status: searchEvalStatus(summary),
    cases_path: casesFile.path,
    schema_version: casesFile.schema_version,
    description: casesFile.description,
    include_dense: includeDense,
    reranker_enabled: options.rerank !== false,
    filters: {
      case_ids: [...selectedIds],
      presets: [...selectedPresets],
      max_cases: maxCases
    },
    summary,
    recommendations: searchEvalRecommendations(summary, includeDense),
    cases: caseResults
  };
}

async function explainSearch(options = {}) {
  const resolved = resolveSearchPresetArgs(options, { defaultLimit: 5 });
  resolved.search.limit = Math.max(1, Math.min(Number(resolved.search.limit) || 5, 20));
  const results = await hybridSearchIndex(resolved.search);
  const weights = normalizedSearchWeights(resolved.search);
  return {
    query: resolved.search.query,
    scope: resolved.search.scope,
    result_count: results.length,
    applied: appliedSearchPresetSummary(resolved),
    weights: appliedSearchPresetSummary(resolved).weights,
    notes: [
      "weighted_score_before_adjustments is computed from returned component scores and normalized weights.",
      "score_adjustment captures lexical boosts, vault-note preference, and source penalties applied inside the search helper."
    ],
    tuning_notes: explainSearchTuningNotes(results, weights),
    results: results.map((item, index) => explainSearchResult(item, index, weights))
  };
}

async function searchProjects({ query, project = "", limit = 10 }) {
  return searchIndex({ query, scope: "projects", project, limit });
}

async function searchNotes({ query, folders = "", limit = 10, scope = "knowledge" }) {
  const selectedFolders = csvValue(folders);
  return searchIndex({
    query,
    scope: selectedFolders ? "all" : scope,
    folders: selectedFolders,
    limit
  });
}

async function searchSkillRegistry({
  query,
  source = "",
  categories = "",
  limit = 10
}) {
  return searchIndex({
    query,
    scope: "skills",
    source,
    categories,
    limit
  });
}

function skillKey(item) {
  return `${item.source}:${item.name}`.toLowerCase();
}

function findSkillItem(items, name, source = "") {
  const normalized = String(name ?? "").toLowerCase().trim();
  const normalizedSource = String(source ?? "").toLowerCase().trim();
  return items.find((item) => {
    const nameMatches = item.name.toLowerCase() === normalized;
    const sourceMatches = !normalizedSource || item.source.toLowerCase().includes(normalizedSource);
    return nameMatches && sourceMatches;
  });
}

function isMembraneSkill(item) {
  return String(item.source ?? "").toLowerCase().includes("membrane");
}

function isDesignSkill(item) {
  return String(item.source ?? "").toLowerCase().includes("design/") || (item.categories ?? []).some((category) => /design|frontend|ui|ux/i.test(category));
}

function isVisualHeavySkill(item) {
  return /imagegen|image-to-code|brandkit|logo|identity/i.test(`${item.name} ${item.description ?? ""} ${item.use_when ?? ""}`);
}

function taskLooksVisual(task) {
  return /(ui|ux|frontend|design|figma|responsive|landing|website|portfolio|mockup|image|visual|brand|logo|redesign|сайт|дизайн|интерфейс|лендинг|бренд|логотип|мокап)/i.test(task);
}

function taskLooksMembraneIntegration(task) {
  return /(membrane|app skill|application skill|connector|oauth|webhook|crm|gmail|google sheets|google drive|notion|slack|discord|linear|jira|hubspot|salesforce|shopify|stripe|интеграц|вебхук|коннектор)/i.test(task);
}

function taskLooksBackend(task) {
  return /(api|backend|database|queue|worker|celery|fastapi|sqlalchemy|postgres|redis|bot|telegram|llm|vision|server|бэкенд|сервер|бот|очеред|база данных)/i.test(task);
}

function taskLooksQuality(task) {
  return /(test|lint|typecheck|quality|gate|ci|coverage|security scan|ruff|pytest|провер|тест|качество|линт|тайпчек|безопасн)/i.test(task);
}

function taskLooksFrontendProduct(task) {
  return taskRequiresFrontendProductWorkflow(task);
}

function taskLooksBetaFrontend(task) {
  const frontendSignal = /(frontend|front-end|ui|ux|react|next\.js|vue|svelte|vite|tailwind|layout|component|screen|css|button|form|modal|интерфейс|фронт|верстк|экран|компонент|кнопк|форм|модал)/i.test(task);
  const supportSignal = /(beta|staging|support|maintain|maintenance|existing app|admin panel|dashboard|responsive bug|layout bug|ui bug|frontend bug|small fix|polish ticket|бета|стейдж|поддерж|саппорт|админ|панел|дашборд|адаптив|поправ|почин|баг)/i.test(task);
  return frontendSignal && supportSignal;
}

function taskLooksFrontendGate(task) {
  const frontendSignal = /(frontend|front-end|ui|ux|browser|visual|responsive|accessibility|a11y|wcag|web vitals|layout|form|screen|component|интерфейс|фронт|верстк|дизайн|адаптив|доступн|браузер|форм|экран|компонент)/i.test(task);
  const gateSignal = /(quality gate|qa|check|verify|verification|review|test|lint|build|handoff|release|ship|провер|качество|гейт|тест|релиз|сдач|ревью)/i.test(task);
  return frontendSignal && gateSignal;
}

function taskLooksLandingConversion(task) {
  return /(landing|landing page|conversion|cro|cta|hero|pricing|marketing page|sales page|lead[- ]?gen|waitlist|signup|offer|funnel|copywriting|лендинг|ленд|конверс|оффер|продающ|заявк|герой|хиро|тариф|прайс|лид|вейтлист|подпис|регистрац)/i.test(task);
}

function projectLooksFrontend(context) {
  return /(react|next\.js|vue|svelte|vite|tailwind|frontend|ui|ux)/i.test(context.context_text);
}

function projectStackLooksFrontend(context) {
  return /(react|next\.js|vue|svelte|vite|tailwind|frontend|ui|ux)/i.test((context.stack ?? []).join(" "));
}

function projectLooksBackend(context) {
  return /(python|fastapi|sqlalchemy|alembic|postgres|redis|celery|aiogram|docker|backend|api|worker|queue|bot)/i.test(context.context_text);
}

function projectFiltersMembrane(context) {
  return /membrane\/app skills.*noisy|filter.*membrane|membrane.*noisy/i.test(context.card_text);
}

async function projectRecommendationContext({ project, project_path } = {}) {
  const identifier = project_path || project;
  if (!identifier) {
    return {
      available: false,
      name: "",
      project_path: "",
      stack: [],
      project_types: [],
      card_path: "",
      card_text: "",
      context_text: ""
    };
  }

  let card = null;
  let cardText = "";
  let detected = null;
  let projectRoot = "";

  if (project_path) {
    projectRoot = await safeProjectRoot(project_path);
    detected = await detectProject(projectRoot);
    try {
      card = await findProjectCard(projectRoot);
      cardText = stripBom(await fs.readFile(card.absolute_path, "utf8"));
    } catch {
      card = null;
    }
  } else {
    card = await findProjectCard(project);
    cardText = stripBom(await fs.readFile(card.absolute_path, "utf8"));
    if (card.project_path && path.isAbsolute(card.project_path) && await pathExists(card.project_path)) {
      projectRoot = await safeProjectRoot(card.project_path);
      detected = await detectProject(projectRoot, card.name);
    }
  }

  const summary = cardText ? projectSummaryFromText(card?.card_path ?? "", cardText) : null;
  const stack = [
    ...(detected?.stack ?? []),
    ...(summary?.stack ?? [])
  ].filter((value, index, array) => value && array.indexOf(value) === index);
  const recommendedFromCard = bulletValues(extractMarkdownSection(cardText, "Recommended Skills"));
  const knownWeakSpots = extractMarkdownSection(cardText, "Known Weak Spots");
  const qualityGate = extractMarkdownSection(cardText, "Quality Gate");
  const architecture = extractMarkdownSection(cardText, "Architecture Summary");
  const nextImprovements = extractMarkdownSection(cardText, "Next Practical Improvements");
  const contextText = [
    summary?.name ?? detected?.project_name ?? project ?? "",
    projectRoot || summary?.project_path || "",
    stack.join(" "),
    architecture,
    qualityGate,
    knownWeakSpots,
    nextImprovements,
    recommendedFromCard.join(" "),
    cardText.slice(0, 5000)
  ].filter(Boolean).join("\n");

  return {
    available: true,
    name: summary?.name ?? detected?.project_name ?? String(project ?? path.basename(projectRoot || "")),
    project_path: projectRoot || summary?.project_path || "",
    stack,
    project_types: detected?.project_types ?? [],
    card_path: card?.card_path ?? "",
    card_text: cardText,
    context_text: contextText,
    recommended_skills: recommendedFromCard,
    membrane_noisy: projectFiltersMembrane({ card_text: cardText, context_text: contextText })
  };
}

function membraneAllowed({ task, context, membranePolicy, includeMembrane }) {
  if (includeMembrane || membranePolicy === "include") return true;
  if (membranePolicy === "exclude") return false;
  if (context?.membrane_noisy) return false;
  return taskLooksMembraneIntegration(task);
}

function shouldSkipRecommendedSkill(item, { task, context, membranePolicy, includeMembrane }) {
  if (item.routing_priority === "disabled") {
    return "Skill is disabled by the local normalization overlay.";
  }
  if (isMembraneSkill(item) && !membraneAllowed({ task, context, membranePolicy, includeMembrane })) {
    return "Membrane/app skills are filtered unless the task explicitly asks for app integrations or membrane_policy=include.";
  }
  if (item.name === "knowledge-curator" && !/(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task)) {
    return "Knowledge workflow filtered because the task is not a durable-knowledge update.";
  }
  if (item.name === "repo-onboarding" && !/(repo|repository|onboard|bootstrap|prepare|AGENTS|project map|подготов|оформ|проект|агент|ии|репозитор|изучи проект|изучить проект)/i.test(task)) {
    return "Repository onboarding workflow filtered because the task is not repository preparation or discovery.";
  }
  if (item.name === "frontend-polisher" && !taskLooksVisual(task) && !projectStackLooksFrontend(context)) {
    return "Frontend workflow filtered because neither task nor project is frontend/design oriented.";
  }
  if (isVisualHeavySkill(item) && !taskLooksVisual(task)) {
    return "Visual/image-heavy skill filtered because the task is not visual/design related.";
  }
  if (isDesignSkill(item) && !taskLooksVisual(task) && !projectStackLooksFrontend(context)) {
    return "Design/frontend skill filtered because neither task nor project is frontend/design oriented.";
  }
  return "";
}

function projectRecommendedSkillRank(name, task, context) {
  const normalized = String(name ?? "").toLowerCase();
  const featureLike = /(new feature|implement|add|build|feature|созда|добав|реализ|фич)/i.test(task) || taskLooksBackend(task) || projectLooksBackend(context);
  const bugLike = /(bug|error|fail|fix|debug|regression|flaky|retry|слом|ошиб|почин|баг|\bci\b)/i.test(task);
  const reviewLike = /(review|\bpr\b|diff|pull request|patch|audit|проверь|ревью)/i.test(task) || taskLooksQuality(task);
  const repoLike = /(repo|repository|onboard|bootstrap|prepare|AGENTS|project map|подготов|оформ|проект|агент|ии|репозитор)/i.test(task);
  const knowledgeLike = /(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task);

  const betaFrontendLike = taskLooksBetaFrontend(task) || (projectStackLooksFrontend(context) && (featureLike || bugLike));
  const frontendGateLike = taskLooksFrontendGate(task) || (taskLooksQuality(task) && (taskLooksVisual(task) || projectStackLooksFrontend(context)));
  const landingConversionLike = taskLooksLandingConversion(task);
  const frontendProductLike = taskLooksFrontendProduct(task);

  if (normalized === "frontend-product-builder" && frontendProductLike) return 180;
  if (normalized === "feature-builder" && featureLike) return 108;
  if (normalized === "bugfix-investigator" && bugLike) return 108;
  if (normalized === "code-reviewer" && reviewLike) return 108;
  if (normalized === "repo-onboarding" && repoLike) return 108;
  if (normalized === "frontend-polisher" && (taskLooksVisual(task) || projectStackLooksFrontend(context))) return 108;
  if (normalized === "beta-frontend-maintainer" && betaFrontendLike) return 116;
  if (normalized === "frontend-quality-gate" && frontendGateLike) return 116;
  if (normalized === "landing-conversion-reviewer" && landingConversionLike) return 116;
  if (normalized === "knowledge-curator" && knowledgeLike) return 108;
  return 0;
}

async function searchSkills({
  query, limit = 10, source, group = "", subgroup = "", maturity = "", trust_level = "",
  quality_status = "", min_quality = 0
}) {
  const items = await readSkillIndex();
  const selectedGroup = group ? canonicalSkillGroup(group) : "";
  const selectedSubgroup = String(subgroup || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  return items
    .filter((item) => !source || item.source.includes(source))
    .filter((item) => !selectedGroup || item.primary_group === selectedGroup)
    .filter((item) => !selectedSubgroup || (item.subgroups || []).includes(selectedSubgroup))
    .filter((item) => !maturity || item.maturity === maturity)
    .filter((item) => !trust_level || item.trust_level === trust_level)
    .filter((item) => !quality_status || item.quality_status === quality_status)
    .filter((item) => Number(item.quality_score || 0) >= Number(min_quality || 0))
    .map((item) => {
      const matchScore = scoreText(query, [
        item.name,
        item.type,
        item.primary_group || "",
        item.primary_group_label || "",
        (item.subgroups ?? []).join(" "),
        (item.task_types ?? []).join(" "),
        (item.platforms ?? []).join(" "),
        (item.frameworks ?? []).join(" "),
        (item.languages ?? []).join(" "),
        item.maturity || "",
        item.trust_level || "",
        (item.categories ?? []).join(" "),
        item.description ?? "",
        item.use_when ?? ""
      ]);
      return { item, match_score: matchScore, score: matchScore + Number(item.quality_score || 0) / 50 };
    })
    .filter((entry) => entry.match_score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

async function readSkill({ name, source }) {
  const normalized = name.toLowerCase().trim();
  const items = await readSkillIndex();
  const item = items.find((entry) => {
    const nameMatches = entry.name.toLowerCase() === normalized;
    const sourceMatches = !source || entry.source.includes(source);
    return nameMatches && sourceMatches;
  });
  if (!item) throw new Error(`Skill not found: ${name}`);
  return readText(path.join("03-skills-catalog", item.path));
}

async function recommendSkills({ task, limit = 8 }) {
  const recommendations = [];
  const add = (name, source, reason) => recommendations.push({ name, source, reason });

  if (taskLooksFrontendProduct(task)) {
    add("frontend-product-builder", "custom", "task requires the design-first frontend product workflow");
  }
  if (taskLooksBetaFrontend(task)) {
    add("beta-frontend-maintainer", "custom", "task is existing beta/frontend maintenance");
  }
  if (taskLooksFrontendGate(task)) {
    add("frontend-quality-gate", "custom", "task asks to verify frontend quality before handoff");
  }
  if (taskLooksLandingConversion(task)) {
    add("landing-conversion-reviewer", "custom", "task asks for landing page conversion review");
  }

  if (/(new feature|implement|add|build|созда|добав|реализ)/i.test(task)) {
    add("feature-builder", "custom", "task changes product behavior");
  }
  if (/(bug|error|fail|fix|слом|ошиб|почин|\bci\b)/i.test(task)) {
    add("bugfix-investigator", "custom", "task requires root-cause investigation");
  }
  if (/(review|\bpr\b|diff|pull request|ревью)/i.test(task)) {
    add("code-reviewer", "custom", "task asks for review or risk assessment");
  }
  if (/(ui|ux|frontend|figma|responsive|дизайн|интерфейс)/i.test(task)) {
    add("frontend-polisher", "custom", "task touches frontend quality or design");
  }
  if (/(website|landing|portfolio|marketing site|premium site|premium|сайт|ленд|премиаль|портфолио)/i.test(task)) {
    add("design-taste-frontend", "design/taste-skill", "task asks for a visually important website or landing page");
  }
  if (/(image.?to.?code|reference image|generate.*image|visual reference|mockup|референс|мокап)/i.test(task)) {
    add("image-to-code", "design/taste-skill", "task benefits from image-first design analysis before coding");
  }
  if (/(redesign|upgrade.*ui|улучш.*дизайн|редизайн)/i.test(task)) {
    add("redesign-existing-projects", "design/taste-skill", "task is an existing UI redesign");
  }
  if (/(brand|logo|identity|brand kit|бренд|логотип|айдентик)/i.test(task)) {
    add("brandkit", "design/taste-skill", "task asks for brand identity or brand-kit generation");
  }
  if (/(knowledge|obsidian|notes|vault|база знаний|заметк)/i.test(task)) {
    add("knowledge-curator", "custom", "task updates durable knowledge");
  }

  const skillMatches = await searchSkills({ query: task, limit });
  const seen = new Set();
  return [...recommendations, ...skillMatches.map((item) => ({
    name: item.name,
    source: item.source,
    reason: item.use_when || item.description || "registry match"
  }))]
    .filter((item) => {
      const key = `${item.source}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function skillQualityRankAdjustment(item) {
  if (!item || item.skill_schema_version !== SKILL_SCHEMA_VERSION) return 0;
  if (item.maturity === "deprecated") return -100;
  if (item.quality_status === "fail") return -30;
  let adjustment = Math.max(-8, Math.min(8, Math.round((Number(item.quality_score || 0) - 75) / 3)));
  if (["validated", "production"].includes(item.maturity)) adjustment += 4;
  else if (item.maturity === "reviewed") adjustment += 2;
  if (["trusted-local", "pinned-upstream"].includes(item.trust_level)) adjustment += 2;
  if (item.routing_priority === "high") adjustment += 4;
  if (item.routing_priority === "low") adjustment -= 6;
  if (item.routing_priority === "disabled") adjustment -= 100;
  return adjustment;
}

async function recommendSkillsProjectAware({
  task,
  limit = 8,
  project,
  project_path,
  membrane_policy = "auto",
  include_membrane = false,
  preferred_groups = []
}) {
  if (!task || typeof task !== "string") {
    throw new Error("task is required.");
  }
  if (!["auto", "include", "exclude"].includes(membrane_policy)) {
    throw new Error("membrane_policy must be auto, include, or exclude.");
  }

  const items = await readSkillIndex();
  const skillCardsByKey = new Map((await readSkillCardsIndex({ syncIfMissing: false })).map((card) => [skillKey(card), card]));
  const context = await projectRecommendationContext({ project, project_path });
  const inferredGroups = inferTaskSkillGroups(task, context.context_text);
  const requestedGroups = searchEvalList(preferred_groups)
    .map(canonicalSkillGroup)
    .filter(Boolean);
  const routedGroups = [...new Set([...requestedGroups, ...inferredGroups])];
  const routedGroupSet = new Set(routedGroups);
  const deterministicRoute = routeSkills({
    task,
    projectTypes: context.project_types ?? [],
    stack: context.stack ?? [],
    maxSkills: 3
  });
  const recommendations = new Map();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 3, 3));
  const visualTask = taskLooksVisual(task);
  const backendTask = taskLooksBackend(task);
  const qualityTask = taskLooksQuality(task);
  const betaFrontendTask = taskLooksBetaFrontend(task);
  const frontendGateTask = taskLooksFrontendGate(task);
  const landingConversionTask = taskLooksLandingConversion(task);
  const frontendProductTask = taskLooksFrontendProduct(task);
  const frontendProject = projectStackLooksFrontend(context);
  const backendProject = projectLooksBackend(context);

  const upsert = ({ name, source = "", reason, rank = 50, evidence = [], item }) => {
    const skill = item ?? findSkillItem(items, name, source);
    const candidate = skill ?? { name, source, categories: [], description: "", use_when: "" };
    const skipReason = skill ? shouldSkipRecommendedSkill(candidate, {
      task,
      context,
      membranePolicy: membrane_policy,
      includeMembrane: include_membrane
    }) : "";
    if (skipReason) return;
    if (candidate.maturity === "deprecated") return;

    const key = skillKey(candidate);
    const entry = {
      name: candidate.name,
      source: candidate.source,
      type: candidate.type,
      categories: candidate.categories,
      primary_group: candidate.primary_group,
      primary_group_label: candidate.primary_group_label,
      subgroups: candidate.subgroups || [],
      task_types: candidate.task_types || [],
      platforms: candidate.platforms || [],
      related_skills: candidate.related_skills || [],
      frameworks: candidate.frameworks || [],
      languages: candidate.languages || [],
      conflicts: candidate.conflicts || [],
      maturity: candidate.maturity,
      trust_level: candidate.trust_level,
      quality_score: candidate.quality_score,
      quality_grade: candidate.quality_grade,
      quality_status: candidate.quality_status,
      routed_groups: routedGroups,
      reason,
      use_when: candidate.use_when || candidate.description || "",
      path: candidate.path,
      card_path: skillCardsByKey.get(key)?.card_path,
      score: rank + skillQualityRankAdjustment(candidate),
      project: context.available ? context.name : undefined,
      evidence
    };
    const existing = recommendations.get(key);
    if (!existing || existing.score < entry.score) {
      recommendations.set(key, entry);
    }
  };

  const addNamed = (name, source, reason, rank, evidence = []) => upsert({ name, source, reason, rank, evidence });

  deterministicRoute.skills.forEach((item, index) => {
    addNamed(
      item.name,
      item.source,
      item.reason,
      220 - index,
      [`routing:${item.role}`, `rule:${item.rule}`]
    );
  });

  if (frontendProductTask) {
    addNamed(
      "frontend-product-builder",
      "custom",
      "frontend product work must pass the design-first state machine",
      190,
      ["design-first", "visual approval", "independent review"]
    );
  }

  if (/(repo|repository|onboard|bootstrap|prepare|AGENTS|project map|quality gate|подготов|оформ|проект|агент|ии|репозитор)/i.test(task)) {
    addNamed("repo-onboarding", "custom", "task asks to understand or prepare repository context", 145);
  }
  if (/(new feature|implement|add|build|feature|созда|добав|реализ|фич)/i.test(task)) {
    addNamed("feature-builder", "custom", "task changes product or developer behavior", 140);
  }
  if (/(bug|error|fail|fix|debug|regression|flaky|слом|ошиб|почин|баг|\bci\b)/i.test(task)) {
    addNamed("bugfix-investigator", "custom", "task requires root-cause investigation", 150);
  }
  if (/(review|\bpr\b|diff|pull request|patch|audit|проверь|ревью)/i.test(task)) {
    addNamed("code-reviewer", "custom", "task asks for review or risk assessment", 145);
  }
  if (betaFrontendTask || (frontendProject && /(support|maintain|small fix|bug|responsive|layout|component|screen|поддерж|поправ|почин|баг|адаптив|экран|компонент)/i.test(task))) {
    addNamed("beta-frontend-maintainer", "custom", "existing frontend task should use minimal safe diffs and browser-aware verification", 146);
  }
  if (frontendGateTask || (qualityTask && (visualTask || frontendProject))) {
    addNamed("frontend-quality-gate", "custom", "frontend changes need responsive, accessibility, browser, and handoff verification", 148);
  }
  if (landingConversionTask) {
    addNamed("landing-conversion-reviewer", "custom", "landing or marketing page should be checked for clarity, trust, CTA, and conversion flow", 150);
  }
  if (visualTask || frontendProject) {
    addNamed("frontend-polisher", "custom", frontendProject ? "project or task is frontend/UI oriented" : "task touches frontend quality or design", 128);
  }
  if (/(website|landing|portfolio|marketing site|premium site|premium|сайт|лендинг|портфолио)/i.test(task)) {
    addNamed("design-taste-frontend", "design/taste-skill", "task asks for a visually important website or landing page", 132);
  }
  if (/(image.?to.?code|reference image|generate.*image|visual reference|mockup|референс|мокап)/i.test(task)) {
    addNamed("image-to-code", "design/taste-skill", "task benefits from image-first design analysis before coding", 132);
  }
  if (/(redesign|upgrade.*ui|улучш.*дизайн|редизайн)/i.test(task)) {
    addNamed("redesign-existing-projects", "design/taste-skill", "task is an existing UI redesign", 132);
  }
  if (/(brand|logo|identity|brand kit|бренд|логотип|айдентик)/i.test(task)) {
    addNamed("brandkit", "design/taste-skill", "task asks for brand identity or brand-kit generation", 132);
  }
  if (/(knowledge|obsidian|notes|vault|memory|handoff|brief|project-map|база знаний|заметк|памят|контекст)/i.test(task)) {
    addNamed("knowledge-curator", "custom", "task updates durable knowledge", 135);
  }
  if (qualityTask) {
    addNamed("code-reviewer", "custom", "quality-gate or verification work benefits from risk review", 134, ["quality gate"]);
  }
  if ((backendTask || backendProject) && !visualTask) {
    addNamed("backend-api-engineer", "custom", "backend or API work needs contract, data, failure, and operability checks", 146, context.stack);
    addNamed("feature-builder", "custom", "backend/project implementation should follow repository architecture and tests", 118, context.stack);
  }
  if (/(api contract|openapi|graphql|protobuf|webhook|endpoint|response schema|request schema|backward compatib|контракт.*api|эндпоинт|вебхук)/i.test(task)) {
    addNamed("api-contract-reviewer", "custom", "task changes or reviews a consumer-facing API contract", 152);
  }
  if (/(database migration|schema migration|alembic|migration|backfill|schema change|миграц|схем.*баз|бэкфил)/i.test(task)) {
    addNamed("database-migration-guardian", "custom", "schema or data evolution needs compatibility, lock, rollback, and recovery checks", 158);
  }
  if (/(ci\/cd|deployment|deploy|release|rollback|github actions|gitlab ci|pipeline|деплой|релиз|откат)/i.test(task)) {
    addNamed("devops-release-engineer", "custom", "task changes build, release, deployment, or rollback behavior", 152);
  }
  if (/(docker|dockerfile|compose|container|kubernetes|k8s|helm|докер|контейнер|кубер)/i.test(task)) {
    addNamed("container-deployment-reviewer", "custom", "container build or runtime behavior needs reproducibility and safety review", 154);
  }
  if (/(application security|security review|threat model|authorization|authentication|permission|vulnerab|csrf|xss|ssrf|безопасн|авториз|уязвим)/i.test(task)) {
    addNamed("application-security-reviewer", "custom", "task touches an application security boundary or requests threat review", 156);
  }
  if (/(secret|credential|dependency audit|supply chain|lockfile|npm audit|pip-audit|snyk|sbom|секрет|зависимост|утечк.*ключ)/i.test(task)) {
    addNamed("secrets-dependencies-auditor", "custom", "task concerns credential exposure or dependency supply-chain risk", 156);
  }
  if (/(data pipeline|etl|elt|ingestion|streaming|backfill|lineage|data quality|пайплайн.*дан|импорт.*дан|качеств.*дан)/i.test(task)) {
    addNamed("data-pipeline-engineer", "custom", "task changes a data contract, pipeline, lineage, or recovery flow", 154);
  }
  if (/(llm|rag|embedding|vector search|prompt|tool calling|structured output|model provider|openai|anthropic|нейросет|эмбеддинг|промпт)/i.test(task)) {
    addNamed("llm-integration-engineer", "custom", "task integrates probabilistic model behavior and needs evaluation, safety, cost, and fallback controls", 156);
  }

  for (const recommended of context.recommended_skills ?? []) {
    const cleaned = recommended.replaceAll("`", "").split(/\s+-\s+|:/)[0].trim();
    if (!cleaned) continue;
    const rank = projectRecommendedSkillRank(cleaned, task, context);
    if (rank > 0) {
      addNamed(cleaned, "", "project card recommends this skill for this task/project", rank, ["project card"]);
    }
  }

  const rankingQuery = [
    task,
    context.stack?.length ? `Stack: ${context.stack.join(" ")}` : ""
  ].filter(Boolean).join("\n").slice(0, 4000);

  const groupFirstCandidates = routedGroups.length
    ? items.filter((item) => item.source === "custom" || routedGroupSet.has(item.primary_group) || String(task).toLowerCase().includes(String(item.name || "").toLowerCase()))
    : items;

  const automaticMatches = groupFirstCandidates
    .map((item) => {
      const scoringQuery = isMembraneSkill(item) ? task : rankingQuery;
      const membrane = isMembraneSkill(item);
      let score = scoreText(scoringQuery, [
        item.name,
        membrane ? "" : item.source,
        membrane ? "" : item.type,
        (item.subgroups ?? []).join(" "),
        (item.task_types ?? []).join(" "),
        (item.platforms ?? []).join(" "),
        (item.frameworks ?? []).join(" "),
        (item.languages ?? []).join(" "),
        membrane ? "" : (item.categories ?? []).join(" "),
        item.description ?? "",
        item.use_when ?? "",
        membrane ? "" : (item.requires ?? []).join(" ")
      ]);
      const exactName = String(item.name || "").length > 1 && String(task).toLowerCase().includes(String(item.name).toLowerCase());
      if (exactName) score += 24;
      if (item.source === "custom") score += 4;
      if (score > 0 && routedGroupSet.has(item.primary_group)) score += 6;
      score += skillQualityRankAdjustment(item);
      if (membrane && !exactName && score < 12) score = 0;
      if (item.source === "custom" && score < 10) score = 0;
      if (isDesignSkill(item) && (visualTask || frontendProject)) score += 3;
      if (isMembraneSkill(item) && !membraneAllowed({ task, context, membranePolicy: membrane_policy, includeMembrane: include_membrane })) score = 0;
      if (isVisualHeavySkill(item) && !visualTask) score = Math.max(0, score - 5);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, Math.max(safeLimit * 6, 40));

  for (const { item, score } of automaticMatches) {
    upsert({
      item,
      reason: item.use_when || item.description || "registry match with project context",
      rank: 60 + score,
      evidence: context.available ? ["task", "project context"] : ["task"]
    });
  }

  const rankedRecommendations = [...recommendations.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((item) => {
      const cleaned = { ...item };
      if (!cleaned.project) delete cleaned.project;
      if (!cleaned.evidence?.length) delete cleaned.evidence;
      return cleaned;
    });
  return prioritizeRoutedRecommendations(rankedRecommendations, deterministicRoute, safeLimit);
}

async function callTool(name, args) {
  if (name === "search_knowledge") return textContent(await searchKnowledge(args));
  if (name === "read_knowledge") return textContent(await readText(args.path));
  if (name === "search_skills") return textContent(await searchSkills(args));
  if (name === "read_skill") return textContent(await readSkill(args));
  if (name === "recommend_skills") return textContent(await recommendSkillsProjectAware(args));
  if (name === "query_ui_ux_knowledge") return textContent(await queryUiUxKnowledge(args));
  if (name === "generate_ui_ux_design_system") {
    return textContent(await generateUiUxDesignSystem(args));
  }
  if (name === "list_skill_groups") return textContent(await listSkillGroups(args));
  if (name === "browse_skill_group") return textContent(await browseSkillGroup(args));
  if (name === "rebuild_skill_taxonomy") return textContent(await rebuildSkillTaxonomy(args));
  if (name === "validate_skill_library") return textContent(await validateSkillLibrary(args));
  if (name === "sync_skill_overlays") return textContent(await syncSkillOverlays(args));
  if (name === "list_skill_overlays") return textContent(await listSkillOverlays(args));
  if (name === "upsert_skill_overlay") return textContent(await upsertSkillOverlayRecord(args));
  if (name === "run_skill_routing_eval") return textContent(await runSkillRoutingEval(args));
  if (name === "sync_skill_cards") return textContent(await syncSkillCards(args));
  if (name === "list_skill_cards") return textContent(await listSkillCards(args));
  if (name === "search_skill_cards") return textContent(await searchSkillCards(args));
  if (name === "read_skill_card") return textContent(await readSkillCard(args));
  if (name === "search_index_status") return textContent(await searchIndexStatus(args));
  if (name === "rebuild_search_index") return textContent(await rebuildSearchIndex(args));
  if (name === "search_all") return textContent(await searchAll(args));
  if (name === "hybrid_search") return textContent(await hybridSearch(args));
  if (name === "list_search_presets") return textContent(listSearchPresets());
  if (name === "preset_search") return textContent(await presetSearch(args));
  if (name === "explain_search") return textContent(await explainSearch(args));
  if (name === "run_search_eval") return textContent(await runSearchEval(args));
  if (name === "embed_texts") return textContent(await embedTexts(args));
  if (name === "embedding_status") return textContent(await embeddingStatus(args));
  if (name === "system_health_check") return textContent(await systemHealthCheck(args));
  if (name === "rebuild_system_dashboard") return textContent(await rebuildSystemDashboard(args));
  if (name === "system_dashboard_status") return textContent(await systemDashboardStatus(args));
  if (name === "prepare_runtime_distribution") return textContent(await prepareRuntimeDistribution(args));
  if (name === "runtime_distribution_status") return textContent(await runtimeDistributionStatus(args));
  if (name === "search_projects") return textContent(await searchProjects(args));
  if (name === "search_notes") return textContent(await searchNotes(args));
  if (name === "search_skill_registry") return textContent(await searchSkillRegistry(args));
  if (name === "rebuild_index") return textContent(await rebuildIndex(args));
  if (name === "import_skill_repo") return textContent(await importSkillRepo(args));
  if (name === "bootstrap_project") return textContent(await bootstrapProject(args));
  if (name === "prepare_project") return textContent(await prepareProject(args));
  if (name === "frontend_product_builder") return textContent(await frontendProductBuilder(args));
  if (name === "plan_frontend_references") return textContent(await planFrontendReferences(args));
  if (name === "register_frontend_references") return textContent(await registerFrontendReferences(args));
  if (name === "reference_factory_status") return textContent(await referenceFactoryStatus(args));
  if (name === "prepare_frontend_product") return textContent(await prepareFrontendProduct(args));
  if (name === "update_frontend_product_brief") return textContent(await updateFrontendProductBrief(args));
  if (name === "record_frontend_directions") return textContent(await recordFrontendDirections(args));
  if (name === "record_frontend_concept_jury") return textContent(await recordFrontendConceptJury(args));
  if (name === "approve_frontend_direction") return textContent(await approveFrontendDirection(args));
  if (name === "approve_frontend_design_system") return textContent(await approveFrontendDesignSystem(args));
  if (name === "frontend_product_gate") return textContent(await frontendProductGate(args));
  if (name === "run_visual_reference_qa") return textContent(await runVisualReferenceQa(args));
  if (name === "record_visual_review") return textContent(await recordVisualReview(args));
  if (name === "list_auto_commands") return textContent(listAutoCommands());
  if (name === "match_auto_command") return textContent(matchAutoCommand(args));
  if (name === "read_auto_command") return textContent(readAutoCommand(args));
  if (name === "project_identity") return textContent(await projectIdentity(args));
  if (name === "list_projects") return textContent(await listProjects(args));
  if (name === "read_project") return textContent(await readProject(args));
  if (name === "register_project") return textContent(await registerProject(args));
  if (name === "sync_project_card") return textContent(await syncProjectCard(args));
  if (name === "update_project_card") return textContent(await updateProjectCard(args));
  if (name === "refresh_project_map") return textContent(await refreshProjectMap(args));
  if (name === "refresh_project_memory") return textContent(await refreshProjectMemory(args));
  if (name === "run_quality_gate") return textContent(await runQualityGate(args));
  if (name === "run_frontend_qa") return textContent(await runFrontendQa(args));
  if (name === "analyze_project") return textContent(await analyzeProjectTool(args));
  if (name === "compile_project_context") return textContent(await compileProjectContext(args));
  if (name === "project_context_status") return textContent(await projectContextStatus(args));
  if (name === "begin_task") return textContent(await beginTask(args));
  if (name === "get_task") return textContent(await getTask(args));
  if (name === "list_tasks") return textContent(await listTasks(args));
  if (name === "skill_outcome_status") return textContent(await skillOutcomeStatus());
  if (name === "rebuild_skill_outcomes") return textContent(await rebuildSkillOutcomes());
  if (name === "start_project_pilot") return textContent(await startProjectPilot(args));
  if (name === "record_project_pilot_review") return textContent(await recordProjectPilotReview(args));
  if (name === "project_pilot_status") return textContent(await projectPilotStatus(args));
  if (name === "checkpoint_task") return textContent(await checkpointTask(args));
  if (name === "verify_task") return textContent(await verifyTask(args));
  if (name === "complete_task") return textContent(await completeTask(args));
  if (name === "write_knowledge_note") return textContent(await writeKnowledgeNote(args));
  if (name === "append_knowledge_note") return textContent(await appendKnowledgeNote(args));
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-dev-system", version: "0.1.0" }
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") {
      result(id, {});
      return;
    }
    if (method === "tools/list") {
      result(id, { tools });
      return;
    }
    if (method === "tools/call") {
      result(id, await callTool(params?.name, params?.arguments ?? {}));
      return;
    }
    if (method === "resources/list") {
      result(id, { resources: [] });
      return;
    }
    if (method === "prompts/list") {
      result(id, { prompts: [] });
      return;
    }
    if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    error(id, -32000, err instanceof Error ? err.message : String(err));
  }
}

export function startLegacyServer() {
  let buffer = "";
  let messageQueue = Promise.resolve();

  function enqueueLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      error(null, -32700, err instanceof Error ? err.message : String(err));
      return;
    }

    messageQueue = messageQueue
      .then(() => handle(message))
      .catch((err) => {
        error(message?.id ?? null, -32000, err instanceof Error ? err.message : String(err));
      });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      enqueueLine(line);
    }
  });

  process.stdin.on("end", () => {
    messageQueue.finally(() => {
      shutdownBgeWorkers();
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    shutdownBgeWorkers();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    shutdownBgeWorkers();
    process.exit(143);
  });
}

export {
  callTool,
  resolveTaskProjectRoot,
  shutdownBgeWorkers,
  tools,
  vaultRoot
};

if (await isDirectExecution(import.meta.url)) startLegacyServer();

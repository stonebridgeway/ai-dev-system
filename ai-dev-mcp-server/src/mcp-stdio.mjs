#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execFileWithInput } from "./core/input-process-runner.mjs";
import {
  SKILL_GROUPS,
  SKILL_TAXONOMY_SCHEMA_VERSION,
  canonicalSkillGroup,
  classifySkill,
  summarizeSkillTaxonomy
} from "./skill-taxonomy.mjs";
import { enrichSkillQuality } from "./skill-quality.mjs";
import {
  atomicAppendFile,
  atomicWriteFile,
  atomicWriteIfChanged,
  atomicWriteJson
} from "./core/atomic-files.mjs";
import {
  cleanDescription,
  csvValue,
  mdCell,
  scoreText,
  shorten,
  slugPart,
  stripBom,
  toStringList as searchEvalList
} from "./core/text-format.mjs";
import {
  findSkillItem,
  groupWikiLink,
  isDesignSkill,
  isMembraneSkill,
  skillCardPath,
  skillGroupNotePath
} from "./core/skill-catalog.mjs";
import {
  renderSkillCard,
  skillCardPublic,
  skillCardUnchanged,
  skillCardsMarkdownIndex
} from "./core/skill-cards.mjs";
import {
  projectFiltersMembrane,
  taskLooksBetaFrontend,
  taskLooksLandingConversion
} from "./core/skill-recommendation.mjs";
import { listSearchPresets } from "./core/search-runtime.mjs";
import { createSearchIndexRuntime } from "./core/search-index.mjs";
import { createEmbeddingRuntime } from "./core/embedding-workers.mjs";
import { isDirectExecution } from "./core/direct-execution.mjs";
import {
  isPathInside,
  resolveWithinSync
} from "./core/path-policy.mjs";
import { createArchifyTools } from "./core/archify-tools.mjs";
import { analyzeProject } from "./core/project-intelligence.mjs";
import { createProjectDetector } from "./core/project-detection.mjs";
import { renderProjectCardMd } from "./core/project-cards.mjs";
import {
  architectureMarkdown,
  asBulletList,
  bulletValues,
  commandsTable,
  componentsTable,
  dangerousScriptsMarkdown,
  documentationMarkdown,
  environmentMarkdown,
  extractMarkdownSection,
  firstHeading,
  parseSimpleFrontmatterFields,
  projectSlug,
  recommendedSkillsMarkdown,
  scriptsTable
} from "./core/project-markdown.mjs";
import { loadImportGraph, renderImportGraphMarkdown } from "./core/import-graph.mjs";
import { configureRuntimeStateRoot, resolveProjectIdentity } from "./core/project-identity.mjs";
import { resolveRuntimeAssets } from "./core/runtime-assets.mjs";
import { resolveRuntimeHome } from "./core/runtime-home.mjs";
import {
  compileContextPack,
  contextPackFreshness
} from "./core/context-compiler.mjs";
import { loadContextExtras } from "./core/context-extras.mjs";
import { routeSkills } from "./core/skill-router.mjs";
import { prioritizeKnowledgeResults } from "./core/knowledge-router.mjs";
import {
  hardNegativeRulesFromCases,
  isSkillCatalogQuery,
  repairSearchMojibake,
  rerankSearchResults
} from "./core/search-reranker.mjs";
import { countBy } from "./core/system-health.mjs";
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
import { captureProjectState } from "./core/evidence.mjs";
import { TaskStore } from "./core/task-lifecycle.mjs";
import { UsageLedger, usageHintsFromArgs } from "./core/usage-ledger.mjs";
import { SessionStore } from "./core/session-memory.mjs";
import { InstinctStore } from "./core/instincts.mjs";
import { SkillOutcomeStore } from "./core/skill-outcomes.mjs";
import {
  PILOT_DIMENSIONS,
  PILOT_TASK_TYPES,
  PilotStore
} from "./core/pilot-evaluation.mjs";
import {
  applySkillOverlays,
  createSkillOverlayDocument,
  skillOverlayKey,
  summarizeSkillOverlays,
  upsertSkillOverlay,
  validateSkillOverlayDocument
} from "./core/skill-overlays.mjs";
import {
  buildUiUxKnowledgeArgs,
  UI_UX_PRO_MAX_DOMAINS,
  UI_UX_PRO_MAX_STACKS
} from "./core/ui-ux-pro-max.mjs";
import {
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_MODES,
  FRONTEND_PRODUCT_PATHS,
  approveDesignSystemState,
  approveDirectionState,
  buildFrontendProductFiles,
  createFrontendProductState,
  evaluateFrontendProductGate,
  recordConceptJuryState,
  selectFrontendProductSkills,
  validateFrontendDirections,
  validateFrontendProductContext,
  validateFrontendReferences
} from "./core/frontend-product-quality.mjs";
import {
  SKILL_IMPORT_INSTRUCTION_POLICY,
  SKILL_IMPORT_QUALITY_FLOOR,
  SKILL_IMPORT_TRUST_LEVEL,
  parseSkillFrontmatter,
  planSkillImport,
  readSkillImportCandidates,
  stageSelectedSkills
} from "./core/skill-import-policy.mjs";
import { buildToolDefinitions } from "./tool-definitions.mjs";
import { autoCommands } from "./auto-commands.mjs";
import { createExtensionTools } from "./tool-extensions.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = (() => {
  try {
    return JSON.parse(readFileSync(path.join(serverDir, "..", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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
const userHome = resolveRuntimeHome(vaultRoot);
configureRuntimeStateRoot(path.join(userHome, ".ai-dev"));
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
// The helper trees the server runs. A vault keeps them under `09-mcp/`; a plain
// checkout of this repository keeps them in its root and has no `09-mcp` at all,
// so each is resolved in its own right (`src/core/runtime-assets.mjs`).
const runtimeAssets = resolveRuntimeAssets({
  vaultRoot,
  repositoryRoot: path.resolve(serverDir, "..", "..")
});
const searchSourceDir = runtimeAssets.searchIndexDir;
const searchIndexDir = path.resolve(
  aiDevRuntimePath(
    "AI_DEV_SEARCH_INDEX_DIR",
    ["cache", "search-index"],
    ["cache", "ai-dev-system", "search-index"]
  )
);
const searchIndexPath = path.join(searchIndexDir, "ai-dev-search.sqlite");
const searchCliPath = path.join(searchSourceDir, "search_cli.py");
const searchEvalCasesPath = path.join(runtimeAssets.searchEvalDir, "search_eval_cases.json");
// The routing benchmark's golden cases. `skillRoutingEvalRelativePath` above is
// what a report prints; this is where the file actually is, which in a plain
// checkout is outside the seed that stands in for a vault. The health check
// compares the report against this, so editing the cases asks for a rerun
// instead of being invisible.
const skillRoutingEvalCasesPath = path.join(runtimeAssets.searchEvalDir, "skill_routing_eval_cases.json");
const embeddingsDir = runtimeAssets.embeddingsDir;
const frontendQaRunnerPath = path.join(runtimeAssets.frontendQaDir, "frontend_qa_runner.mjs");
const frontendQaPackagePath = path.join(runtimeAssets.frontendQaDir, "package.json");
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
const archifyArtifactsRoot = path.resolve(
  aiDevRuntimePath("AI_DEV_ARCHIFY_ARTIFACT_ROOT", ["artifacts", "archify"])
);
const archifyReceiptsRoot = path.resolve(
  aiDevRuntimePath("AI_DEV_ARCHIFY_RECEIPTS_ROOT", ["state", "archify-receipts"])
);
const taskStateRoot = path.resolve(
  aiDevRuntimePath("AI_DEV_STATE_ROOT", ["state"], ["state", "ai-dev-system"])
);
const taskStore = new TaskStore({ stateRoot: taskStateRoot });
const usageLedger = new UsageLedger({ stateRoot: taskStateRoot });
const sessionStore = new SessionStore({ stateRoot: taskStateRoot });
const instinctStore = new InstinctStore({ stateRoot: taskStateRoot });
const skillOutcomeStore = new SkillOutcomeStore({ stateRoot: taskStateRoot });
const pilotStore = new PilotStore({ stateRoot: taskStateRoot });
const bgeM3EmbedCliPath = path.join(embeddingsDir, "bge_m3_embed.py");
const bgeM3WorkerCliPath = path.join(embeddingsDir, "bge_m3_worker.py");
const defaultBgeM3ModelDir = path.resolve(
  aiDevRuntimePath("BGE_M3_MODEL_DIR", ["models", "bge-m3"])
);
let searchHardNegativeCache = null;

/**
 * The search services, built once and shared.
 *
 * They are services rather than tools: `src/extensions/search.mjs` is their MCP
 * surface, the system extension's health checks read them, and writers all over
 * this module call `markSearchIndexDirty` so the next query rebuilds the index.
 * Both are created here because only this module knows where the vault, the
 * cache directory and the Python runtimes are.
 */
const embeddingRuntime = createEmbeddingRuntime({
  embedCliPath: bgeM3EmbedCliPath,
  workerCliPath: bgeM3WorkerCliPath,
  defaultModelDir: defaultBgeM3ModelDir,
  searchIndexDir,
  searchIndexPath,
  vaultRoot,
  pythonCommand: () => embeddingPythonCommand(),
  pathExists: (target) => pathExists(target),
  fileStatus: (target) => fileStatus(target),
  execFile: (command, args, options) => execFile(command, args, options)
});
const searchRuntime = createSearchIndexRuntime({
  vaultRoot,
  searchCliPath,
  searchIndexDir,
  searchIndexPath,
  defaultModelDir: defaultBgeM3ModelDir,
  pythonCommand: () => pythonCommand(),
  embeddingPythonCommand: () => embeddingPythonCommand(),
  pathExists: (target) => pathExists(target),
  execFile: (command, args, options) => execFile(command, args, options),
  embedQuery: (payload, options) => embeddingRuntime.request(payload, options),
  hardNegativeRules: () => activeSearchHardNegativeRules(),
  readSkillIndex: () => readSkillIndex(),
  ranking: {
    repairSearchMojibake,
    prioritizeKnowledgeResults,
    rerankSearchResults,
    isSkillCatalogQuery,
    routeSkills
  }
});
const shutdownBgeWorkers = () => embeddingRuntime.shutdown();

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

function inferUseWhen(description) {
  const cleaned = cleanDescription(description);
  const useMatch = cleaned.match(/Use when\s+(.+)$/i);
  return useMatch ? useMatch[1].replace(/\.$/, "").trim() : cleaned;
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
  license = "",
  trustLevel = "",
  instructionPolicy = ""
}) {
  const text = stripBom(await fs.readFile(filePath, "utf8"));
  const meta = parseSkillFrontmatter(text, folderName);
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
  if (trustLevel) item.trust_level = trustLevel;
  if (instructionPolicy) item.instruction_policy = instructionPolicy;
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
      const provisional = parseSkillFrontmatter(stripBom(await fs.readFile(filePath, "utf8")), folderName);
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
    const instructionPolicy = cleanDescription(provenance.instruction_policy);
    const files = await listSkillFilesInSkillsDir(path.join(repoPath, "skills"));
    const rootSkill = path.join(repoPath, "SKILL.md");
    if (await pathExists(rootSkill)) {
      files.push({ folderName: repo.name, filePath: rootSkill });
    }

    for (const { folderName, filePath } of files) {
      const provisional = parseSkillFrontmatter(stripBom(await fs.readFile(filePath, "utf8")), folderName);
      const isArchify = folderName === "archify";
      const isDesignSkill = /\b(ui|ux|design|frontend)\b/i.test(
        `${provisional.name} ${provisional.description}`
      );
      result.push(await skillItemFromFile({
        filePath,
        folderName,
        source: `external/${repo.name}`,
        type: "external-skill",
        categories: isArchify
          ? ["external", "diagram", "architecture", "visualization", "documentation"]
          : isDesignSkill
          ? ["external", "frontend", "design", "ui", "ux"]
          : ["external"],
        requires: isArchify
          ? ["Node >=18", "system Chrome/Edge (visual-check only)"]
          : isDesignSkill ? ["frontend/design task", "Python 3"] : [],
        compatibility: isArchify
          ? "Local Node CLI skill; provenance-pinned"
          : instructionPolicy === SKILL_IMPORT_INSTRUCTION_POLICY
          ? "Provenance-pinned local Markdown skill; read as reference until a local review promotes it"
          : "Curated, provenance-pinned local Markdown skill",
        homepage: isArchify ? "https://github.com/tt-a1i/archify" : "",
        repository,
        commit,
        version: cleanDescription(provenance.version),
        license: cleanDescription(provenance.license),
        trustLevel: cleanDescription(provenance.trust),
        instructionPolicy
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

// The golden-case file: read here rather than in the search extension because
// the reranker's hard-negative rules are derived from it on every hybrid query,
// and the system extension reports on it too.
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

async function activeSearchHardNegativeRules() {
  const stats = await fs.stat(searchEvalCasesPath).catch(() => null);
  const modified = stats?.mtimeMs || 0;
  if (searchHardNegativeCache?.modified === modified) return searchHardNegativeCache.rules;
  const parsed = await readSearchEvalCases().catch(() => ({ cases: [] }));
  const rules = hardNegativeRulesFromCases(parsed.cases);
  searchHardNegativeCache = { modified, rules };
  return rules;
}

function markSearchIndexDirty(reason = "source changed") {
  searchRuntime.markDirty(reason);
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

function skillWikiLink(item) {
  const target = isMembraneSkill(item)
    ? `03-skills-catalog/${String(item.path || "").replace(/\.md$/i, "")}`
    : skillCardPath(item).replace(/\.md$/i, "");
  return `[[${target}|${item.name}]]`;
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
    const rendered = renderSkillCard(item);
    // A card that says the same thing keeps its file, and its stamp: see
    // `skillCardUnchanged` for why a moved mtime is not free here.
    const onDisk = await readText(cardPath).catch(() => "");
    if (!skillCardUnchanged(onDisk, rendered)) await writeText(cardPath, rendered);
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

async function readSkillOverlayDocument({ create = true } = {}) {
  const target = safePath(skillOverlaysRelativePath);
  const existing = await readJsonIfExists(target);
  if (existing) return existing;
  const document = createSkillOverlayDocument();
  if (create) await atomicWriteJson(target, document);
  return document;
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
  // A caller's path is checked against the vault; ours is the resolved helper
  // tree, which in a plain checkout sits outside the seed that stands in for a
  // vault (`src/core/runtime-assets.mjs`).
  const target = cases_path ? safePath(cases_path) : skillRoutingEvalCasesPath;
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
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(output.stderr || output.stdout || `Command failed with exit code ${code}`));
      }
    });
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

async function importSkillRepo({
  repository_url,
  source_group = "external",
  name,
  update_if_exists = false,
  select_skills = false,
  min_quality_score = SKILL_IMPORT_QUALITY_FLOOR,
  dry_run = false
}) {
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
  if (exists && !update_if_exists && !(select_skills && dry_run)) {
    throw new Error(`Repository already exists at ${toVaultRelative(target)}. Set update_if_exists=true to pull updates.`);
  }

  if (select_skills) {
    return importSelectedSkills({
      repository_url,
      repoName,
      source_group,
      target,
      exists,
      minQualityScore: min_quality_score,
      dryRun: dry_run
    });
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

// Selective import: clone to a scratch directory, run the import policy over the
// upstream `skills/` tree, and keep only what survives all four gates. Nothing
// is written into the vault until the plan is known, so a rejected catalogue
// never lands half-imported. See src/core/skill-import-policy.mjs.
async function importSelectedSkills({
  repository_url,
  repoName,
  source_group,
  target,
  exists,
  minQualityScore,
  dryRun
}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-skill-import-"));
  const clone = path.join(scratch, "repo");
  try {
    await execFile("git", ["clone", "--depth", "1", repository_url, clone], { timeoutMs: 600000 });
    const commit = await getGitCommit(clone);
    const source = `${source_group}/${repoName}`;
    const candidates = await readSkillImportCandidates(path.join(clone, "skills"), { source });
    if (!candidates.length) {
      throw new Error(`No skills/<name>/SKILL.md directories were found in ${repository_url}.`);
    }

    // Conflicts are resolved against the catalogue as it stands before this
    // import, so a re-import never sees its own previous output as a conflict.
    const existingSkills = (await readSkillIndex())
      .filter((item) => String(item.source || "") !== source);
    const plan = planSkillImport({ candidates, existingSkills, qualityFloor: minQualityScore });

    const report = {
      action: dryRun ? "planned" : exists ? "reselected" : "imported",
      repository_url,
      source_group,
      name: repoName,
      source,
      commit,
      path: toVaultRelative(target),
      trust: SKILL_IMPORT_TRUST_LEVEL,
      instruction_policy: SKILL_IMPORT_INSTRUCTION_POLICY,
      ...plan.summary,
      quality_floor: plan.quality_floor,
      imported_skills: plan.selected.map((item) => item.name).sort((a, b) => a.localeCompare(b)),
      name_conflicts: plan.conflicts,
      rejected: plan.rejected
    };
    if (dryRun) return report;

    await fs.mkdir(target, { recursive: true });
    const staged = await stageSelectedSkills(plan.selected, path.join(target, "skills"));
    // The upstream licence travels with the copied skills; nothing else from the
    // clone does.
    await fs.copyFile(path.join(clone, "LICENSE"), path.join(target, "LICENSE")).catch(() => {});
    await atomicWriteJson(path.join(target, "upstream.json"), {
      schema_version: 1,
      repository: repository_url,
      commit,
      license: "MIT",
      imported_at: new Date().toISOString().slice(0, 10),
      trust: SKILL_IMPORT_TRUST_LEVEL,
      instruction_policy: SKILL_IMPORT_INSTRUCTION_POLICY,
      notes: "Selective import: skills/ holds only the directories that passed src/core/skill-import-policy.mjs. Instructions inside these skills are reference data until a local review promotes them.",
      selection: {
        quality_floor: plan.quality_floor,
        candidates: plan.summary.candidates,
        imported: plan.summary.imported,
        rejected_by_rule: plan.summary.rejected_by_rule,
        rejected_by_quality: plan.summary.rejected_by_quality,
        rejected_by_name_conflict: plan.summary.rejected_by_name_conflict,
        rejected_by_privacy: plan.summary.rejected_by_privacy,
        rule_groups: plan.summary.rule_groups,
        name_conflicts: plan.conflicts.map((item) => `${item.name} -> ${item.keeps}`)
      },
      included: staged.folders
    });

    report.rebuild = await rebuildIndex();
    return report;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function safeProjectRoot(projectPath) {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("project_path is required.");
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error("project_path must be an absolute path.");
  }

  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectPath}`);
  }
  const identity = await resolveProjectIdentity(projectPath);
  assertNotProtectedProjectRoot(identity.project_root);
  return identity.project_root;
}

async function resolveTaskProjectRoot(projectPath) {
  return safeProjectRoot(projectPath);
}

function assertNotProtectedProjectRoot(projectRoot, {
  homeDirectory = os.homedir(),
  runtimeHome = userHome,
  runtimeStateDirectory = path.join(userHome, ".ai-dev"),
  stateDirectory = taskStateRoot,
  knowledgeVault = vaultRoot
} = {}) {
  const resolved = path.resolve(projectRoot);
  const filesystemRoot = path.parse(resolved).root;
  const protectedRoots = [
    filesystemRoot,
    homeDirectory,
    runtimeHome,
    runtimeStateDirectory,
    stateDirectory,
    knowledgeVault
  ].map((entry) => path.resolve(entry));

  if (
    protectedRoots.includes(resolved)
    || protectedRoots.some((protectedRoot) => (
      protectedRoot !== filesystemRoot && isPathInside(resolved, protectedRoot)
    ))
  ) {
    throw new Error(`Refusing to treat a protected directory as a project: ${resolved}`);
  }
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

async function readProjectTextIfExists(projectRoot, relativePath) {
  const target = safeProjectFile(projectRoot, relativePath);
  if (!(await pathExists(target))) return "";
  return stripBom(await fs.readFile(target, "utf8").catch(() => ""));
}

// `detectProject` answers "what is this repository" for the whole server:
// `begin_task`, `compile_project_context`, the project card writers and four
// extensions all call it. The detector itself is in `src/core`, over an
// injected filesystem; this is the one binding to the real one.
const { detectProject } = createProjectDetector({
  pathExists,
  readJsonIfExists,
  readProjectText: readProjectTextIfExists,
  safeProjectFile,
  stat: (target) => fs.stat(target).catch(() => null),
  analyzeProject,
  readDirectory: (target) => fs.readdir(target).catch(() => [])
});

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
  // The graph is re-read only when the source files moved; the fingerprint
  // costs a directory walk, the parse costs the whole tree (PLAN.md 3.8).
  const importGraph = await loadImportGraph(detected.project_path).catch(() => null);
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

## Import graph

${renderImportGraphMarkdown(importGraph)}

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
    search_index = await searchRuntime.rebuild({ include_external_project_files: true });
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

function projectCardRelativePath(name) {
  return `${projectsRelativeDir}/${projectSlug(name)}.md`;
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

/**
 * Gather what a project card states, then render it.
 *
 * Identity, the agent-facing file snapshots, the Frontend Product Quality state
 * and the project's own quality-gate file are all read here; the card itself is
 * rendered by `renderProjectCardMd` in `src/core/project-cards.mjs`, which sees
 * only the gathered facts.
 */
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
  const qualityGateFileText = files.quality_gate.exists
    ? await readProjectTextIfExists(detected.project_path, ".ai-dev/quality-gate.md")
    : "";
  return renderProjectCardMd({
    detected,
    identity,
    files,
    frontendProductPrepared: Boolean(frontendProductState),
    frontendProductStatus,
    qualityGateFileText,
    existingText: existing_text,
    description,
    status,
    notes,
    now,
    updatedAt: new Date().toISOString()
  });
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
    search_index = await searchRuntime.rebuild({ include_external_project_files: true });
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

const {
  archifyProjectPath,
  archifyDoctor,
  archifyGuide,
  archifyValidate,
  archifyRender,
  archifyDeliver,
  archifyVisualCheck,
  archifyCompare,
  archifyMigrate,
  archifyBrands
} = createArchifyTools({
  vaultRoot,
  archifyArtifactsRoot,
  archifyReceiptsRoot,
  safeProjectRoot,
  safeProjectFile,
  slugPart,
  readJsonIfExists
});
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
    extras: await loadContextExtras({ projectRoot: identity.project_root, stateRoot: taskStateRoot, repositoryId: identity.repository_id, projectId: identity.project_id, task, stack: detected.stack }),
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

// Extension tools live in src/extensions/* and receive shared runtime services
// through this host object (see src/tool-extensions.mjs).
const extensions = createExtensionTools({
  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, pilotStore, usageLedger, sessionStore,
  instinctStore, callTool,
  serverRoot: path.resolve(serverDir, ".."),
  resolveProjectIdentity, detectProject, captureProjectState, readProjectTextIfExists,
  writeProjectFile, safeProjectFile, safeProjectRoot, writeKnowledgeNote, appendKnowledgeNote,
  markSearchIndexDirty,
  // Vault layout, generated-state writers and live status sources. The system
  // extension reads all of them from here so no extension has to know where the
  // vault lives or import this module back.
  vaultPaths: {
    skillCardsIndex: skillCardsIndexRelativePath,
    skillCardsCatalog: skillCardsCatalogRelativePath,
    skillGroupsIndex: skillGroupsIndexRelativePath,
    skillsMap: skillsMapRelativePath,
    skillGraphIndex: skillGraphIndexRelativePath,
    skillGraphPages: skillGraphPagesRelativeDir,
    skillQualityIndex: skillQualityIndexRelativePath,
    skillQualityDashboard: skillQualityDashboardRelativePath,
    skillRoutingReport: skillRoutingReportRelativePath,
    skillRoutingEvalCases: skillRoutingEvalRelativePath,
    skillOverlays: skillOverlaysRelativePath,
    systemDashboard: systemDashboardRelativePath,
    systemDashboardState: systemDashboardStateRelativePath
  },
  searchIndexPath, skillRoutingEvalCasesPath,
  frontendQaRunnerPath, frontendQaPackagePath, frontendQaArtifactsRoot,
  // `tools` is assembled from the extension definitions below, so it is read lazily.
  toolCount: () => tools.length,
  safePath, fileStatus, pathExists, readJsonIfExists, writeJson, writeText, listMarkdownFiles,
  readSkillIndex, readSkillGroupsIndex, readSkillCardsIndex, readSkillOverlayDocument,
  readSearchEvalCases, projectSummaries, listProjects, listAutoCommands, listSearchPresets,
  frontendQaEnvironmentStatus,
  // The search services. `search` and `embeddings` are what the search extension
  // drives; the named wrappers below are what the system extension's health
  // checks ask for, and `runSearchEval` is the search extension's own tool
  // reached the same way `prepare_pull_request` is.
  search: searchRuntime, embeddings: embeddingRuntime,
  searchIndexStatus: (args) => searchRuntime.status(args),
  rebuildSearchIndex: (args) => searchRuntime.rebuild(args),
  searchIndex: (args) => searchRuntime.search(args),
  hybridSearchIndex: (args) => searchRuntime.hybridSearch(args),
  embeddingStatus: (args) => embeddingRuntime.status(args),
  runSearchEval: (args) => extensions.handlers.get("run_search_eval")(args),
  // The sibling tools the lifecycle extension drives. Reached through the
  // registry rather than `callTool`, so a composed run records one ledger entry
  // for the tool the client asked for and none for the work it delegated.
  recommendSkills: (args) => extensions.handlers.get("recommend_skills")(args),
  runQualityGate: (args) => extensions.handlers.get("run_quality_gate")(args),
  runSecurityScan: (args) => extensions.handlers.get("run_security_scan")(args),
  runFrontendQa: (args) => extensions.handlers.get("run_frontend_qa")(args),
  preparePullRequest: (args) => extensions.handlers.get("prepare_pull_request")(args),
  // Skill sources and the writers that turn them into the generated catalog.
  // `rebuild_index` owns the catalog but not the collectors: `import_skill_repo`,
  // `rebuild_skill_taxonomy` and `sync_skill_cards` still live here and share them.
  skillCatalogRoot, skillSourcesRoot: sourcesRoot, skillRegistryDir: registryDir,
  collectCustomSkills, collectDesignSkills, collectMembraneSkills, collectExternalSkills,
  writeSkillTaxonomyArtifacts, syncSkillCards, projectRecommendationContext,
  embedTexts: (args) => embeddingRuntime.embedTexts(args),
  // Frontend product state and project-card writers. The state readers stay here
  // because `compile_project_context`, `verify_task` and the product tools that
  // have not been extracted yet all read them; the frontend extensions reach
  // them through this host rather than the other way round.
  readFrontendProductState, writeFrontendProductState, frontendProductDocumentHashes,
  frontendReviewArtifactsCurrent,
  normalizeFrontendProductReference, validateFrontendReferenceFiles,
  updateFrontendProductBrief, recordFrontendDirections, resolveFrontendReviewArtifact,
  findProjectCard, updateProjectCard, syncProjectCard, registerProject,
  safeProjectSubdir, resolveTaskProjectRoot, runUiUxProMax, uiUxProMaxSource,
  // The Archify receipt store, which `verify_task` reads to check that a
  // delivery claim is backed by a receipt the renderer itself wrote.
  archifyProjectPath, archifyReceiptsRoot,
  sha256, truncateOutput
});
// Two extension tools are called by the runtime itself, not only over MCP:
// `import_skill_repo` and the overlay tools rebuild the registry after writing
// to the vault, and `compile_project_context` routes skills for the pack it
// compiles. They reach the extension the same way `prepare_pull_request` is
// reached, so each tool stays the single implementation. The lifecycle tools
// reach their siblings the same way, through the host wrappers above.
const rebuildIndex = (args = {}) => extensions.handlers.get("rebuild_index")(args);
const recommendSkillsProjectAware = (args) => extensions.handlers.get("recommend_skills")(args);
const extensionReadOnlyTools = extensions.readOnly;
const tools = [...buildToolDefinitions({
  CONCEPT_JURY_DIMENSIONS,
  FRONTEND_PRODUCT_MODES,
  PILOT_DIMENSIONS,
  PILOT_TASK_TYPES,
  UI_UX_PRO_MAX_DOMAINS,
  UI_UX_PRO_MAX_STACKS
}), ...extensions.definitions];

async function searchKnowledge({ query, limit = 10 }) {
  if (!query || typeof query !== "string") throw new Error("query is required.");
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

async function searchSkills({
  query, limit = 10, source, group = "", subgroup = "", maturity = "", trust_level = "",
  quality_status = "", min_quality = 0
}) {
  if (!query || typeof query !== "string") throw new Error("query is required.");
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
  if (!name || typeof name !== "string") throw new Error("name is required.");
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

async function dispatchTool(name, args) {
  if (name === "search_knowledge") return textContent(await searchKnowledge(args));
  if (name === "read_knowledge") return textContent(await readText(args.path));
  if (name === "search_skills") return textContent(await searchSkills(args));
  if (name === "read_skill") return textContent(await readSkill(args));
  if (name === "query_ui_ux_knowledge") return textContent(await queryUiUxKnowledge(args));
  if (name === "list_skill_groups") return textContent(await listSkillGroups(args));
  if (name === "browse_skill_group") return textContent(await browseSkillGroup(args));
  if (name === "rebuild_skill_taxonomy") return textContent(await rebuildSkillTaxonomy(args));
  if (name === "sync_skill_overlays") return textContent(await syncSkillOverlays(args));
  if (name === "list_skill_overlays") return textContent(await listSkillOverlays(args));
  if (name === "upsert_skill_overlay") return textContent(await upsertSkillOverlayRecord(args));
  if (name === "run_skill_routing_eval") return textContent(await runSkillRoutingEval(args));
  if (name === "sync_skill_cards") return textContent(await syncSkillCards(args));
  if (name === "list_skill_cards") return textContent(await listSkillCards(args));
  if (name === "search_skill_cards") return textContent(await searchSkillCards(args));
  if (name === "read_skill_card") return textContent(await readSkillCard(args));
  if (name === "prepare_runtime_distribution") return textContent(await prepareRuntimeDistribution(args));
  if (name === "runtime_distribution_status") return textContent(await runtimeDistributionStatus(args));
  if (name === "import_skill_repo") return textContent(await importSkillRepo(args));
  if (name === "bootstrap_project") return textContent(await bootstrapProject(args));
  if (name === "prepare_project") return textContent(await prepareProject(args));
  if (name === "frontend_product_builder") return textContent(await frontendProductBuilder(args));
  if (name === "reference_factory_status") return textContent(await referenceFactoryStatus(args));
  if (name === "prepare_frontend_product") return textContent(await prepareFrontendProduct(args));
  if (name === "update_frontend_product_brief") return textContent(await updateFrontendProductBrief(args));
  if (name === "record_frontend_directions") return textContent(await recordFrontendDirections(args));
  if (name === "record_frontend_concept_jury") return textContent(await recordFrontendConceptJury(args));
  if (name === "approve_frontend_direction") return textContent(await approveFrontendDirection(args));
  if (name === "approve_frontend_design_system") return textContent(await approveFrontendDesignSystem(args));
  if (name === "frontend_product_gate") return textContent(await frontendProductGate(args));
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
  if (name === "archify_doctor") return textContent(await archifyDoctor(args));
  if (name === "archify_guide") return textContent(await archifyGuide(args));
  if (name === "archify_validate") return textContent(await archifyValidate(args));
  if (name === "archify_render") return textContent(await archifyRender(args));
  if (name === "archify_deliver") return textContent(await archifyDeliver(args));
  if (name === "archify_visual_check") return textContent(await archifyVisualCheck(args));
  if (name === "archify_compare") return textContent(await archifyCompare(args));
  if (name === "archify_migrate") return textContent(await archifyMigrate(args));
  if (name === "archify_brands") return textContent(await archifyBrands(args));
  if (name === "analyze_project") return textContent(await analyzeProjectTool(args));
  if (name === "compile_project_context") return textContent(await compileProjectContext(args));
  if (name === "project_context_status") return textContent(await projectContextStatus(args));
  if (name === "get_task") return textContent(await getTask(args));
  if (name === "list_tasks") return textContent(await listTasks(args));
  if (name === "skill_outcome_status") return textContent(await skillOutcomeStatus());
  if (name === "rebuild_skill_outcomes") return textContent(await rebuildSkillOutcomes());
  if (name === "start_project_pilot") return textContent(await startProjectPilot(args));
  if (name === "record_project_pilot_review") return textContent(await recordProjectPilotReview(args));
  if (name === "project_pilot_status") return textContent(await projectPilotStatus(args));
  if (name === "write_knowledge_note") return textContent(await writeKnowledgeNote(args));
  if (name === "append_knowledge_note") return textContent(await appendKnowledgeNote(args));
  const extension = extensions.handlers.get(name);
  if (extension) return textContent(await extension(args));
  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Run one tool and record it in the usage ledger.
 *
 * Every caller goes through here — the MCP server transport (`server.mjs`),
 * the legacy stdio loop below, `scripts/ai-dev.mjs`, the smoke scripts, and
 * tools composed from other tools through the extension host — so
 * `usage_report` counts the work the system actually did instead of only the
 * calls that happened to arrive over MCP. The transport records nothing of its
 * own; it passes its own overhead as `transportMs` and that is all it adds.
 *
 * A composed call (for example `begin_task_in_worktree` calling `begin_task`)
 * is one ledger entry per tool that ran, never the same call twice.
 *
 * The ledger write is deliberately not awaited: it rewrites an append-only
 * JSONL file, and no tool result should wait for it. Nothing calls
 * `process.exit()` around a tool call, so the pending write still lands.
 *
 * @param {string} name - Tool name.
 * @param {object} args - Tool arguments.
 * @param {{ transportMs?: number }} [context] - Transport overhead to add to the recorded duration.
 * @returns {Promise<{ content: Array<{ type: string, text: string }> }>}
 */
async function callTool(name, args, { transportMs = 0 } = {}) {
  const startedAt = Date.now();
  const overhead = Math.max(0, Number(transportMs) || 0);
  const hints = usageHintsFromArgs(args);
  const record = (ok, error = "") => {
    usageLedger
      .recordToolCall({ tool: name, ok, durationMs: Date.now() - startedAt + overhead, error, ...hints })
      .catch(() => undefined);
  };
  try {
    const result = await dispatchTool(name, args);
    record(true);
    return result;
  } catch (error) {
    record(false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-dev-system", version: packageVersion }
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
  assertNotProtectedProjectRoot,
  callTool,
  // Where the runtime keeps the two things a first run builds. Exported so
  // `scripts/first-run.mjs` asks the runtime instead of re-deriving the
  // fallback chain — the mismatch that made a checkout look empty.
  embeddingsDir,
  extensionReadOnlyTools,
  resolveTaskProjectRoot,
  safeProjectRoot,
  searchIndexPath,
  shutdownBgeWorkers,
  skillRoutingEvalCasesPath,
  tools,
  usageLedger,
  vaultRoot
};

if (await isDirectExecution(import.meta.url)) startLegacyServer();

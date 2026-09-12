import fs from "node:fs/promises";
import path from "node:path";

import { evaluateSkillQuality } from "../skill-quality.mjs";
import { auditDistributionTree, copyDistributionTree } from "./public-distribution.mjs";

/**
 * Selection policy for `import_skill_repo` when it imports a large upstream
 * skill catalogue (docs/ecc-upgrades/PLAN.md, item 3.1).
 *
 * A repository like ECC ships hundreds of skills, most of which are not
 * engineering methodology: business operations, regulated domains, media
 * production, ECC's own navigation, and workflows that need Claude Code
 * subagents or external MCP servers. Cloning the tree wholesale would bury the
 * ~100 useful ones and put unreviewed domain instructions into skill routing.
 *
 * Four gates decide, in this order, and each rejection carries the reason it
 * was rejected under so the import report can be audited:
 *
 *   1. `excluded-by-rule`  — the skill is in a taxonomy group we do not import.
 *   2. `name-conflict`     — a skill of that name already exists here; ours wins.
 *   3. `privacy-finding`   — it would fail the public-seed privacy audit.
 *   4. `below-quality-floor` — its structural quality score is under the floor.
 *
 * Everything that survives is copied verbatim. Imported skills are recorded as
 * `trust: known-upstream` with `instruction_policy: data-until-review`: their
 * text is reference material until someone reviews it, never instructions the
 * agent follows on sight.
 */

/** Minimum structural quality score an imported skill must reach. */
export const SKILL_IMPORT_QUALITY_FLOOR = 75;

/** Marker recorded on imported skills that have not had a local review yet. */
export const SKILL_IMPORT_INSTRUCTION_POLICY = "data-until-review";

/** Trust level assigned to skills imported under this policy. */
export const SKILL_IMPORT_TRUST_LEVEL = "known-upstream";

/**
 * Taxonomy groups that never enter the catalogue. Each group cites the row of
 * the ECC review it comes from; `rules` holds exact skill names plus `family-*`
 * prefixes, matched against both the upstream directory name and the name in
 * the skill's frontmatter (ECC's `scientific-*` folders rename themselves).
 *
 * Deliberately *not* excluded: the language, framework and database reference
 * skills, and `coding-standards` / `git-workflow` / `error-handling` /
 * `api-connector-builder` / `hexagonal-architecture`. ECC-GAP-ANALYSIS.md §D
 * lists those as "подключаются через import_skill_repo" — they are in §D
 * because they need no hand-porting, which is exactly what this import does.
 */
export const SKILL_IMPORT_EXCLUSION_GROUPS = Object.freeze([
  Object.freeze({
    id: "domain-business",
    reason: "Business, legal, and marketing operations rather than the development engine.",
    source: "ECC-GAP-ANALYSIS.md §D (доменные/бизнес-скиллы); PLAN.md §4.2",
    rules: Object.freeze([
      "article-writing", "benchmark-methodology", "brand-discovery", "brand-voice",
      "carrier-relationship-management", "competitive-platform-analysis",
      "competitive-report-structure", "connections-optimizer", "content-engine",
      "counterparty-channel-discipline", "crosspost", "customer-billing-ops",
      "customs-trade-compliance", "email-ops", "energy-procurement", "esign-field-placement",
      "finance-billing-ops", "github-ops", "google-workspace-ops", "inventory-demand-planning",
      "investor-*", "jira-integration", "lead-intelligence", "logistics-exception-management",
      "market-research", "marketing-*", "master-agreement-generator", "messages-ops",
      "operator-approval-loop", "production-scheduling", "project-flow-ops",
      "quality-nonconformance", "returns-reverse-logistics", "seo", "social-*",
      "unified-notifications-ops", "x-api"
    ])
  }),
  Object.freeze({
    id: "regulated-and-niche-domains",
    reason: "Healthcare, crypto, science, networking, and homelab domains outside an engineering server.",
    source: "ECC-GAP-ANALYSIS.md §D (healthcare/крипто/наука/сети/homelab); PLAN.md §4.2",
    rules: Object.freeze([
      "agent-payment-x402", "cisco-ios-patterns", "defi-amm-security", "evm-token-decimals",
      "flox-environments", "healthcare-*", "hipaa-compliance", "homelab-*", "ito-*",
      "llm-trading-agent-security", "nasiko-control-plane", "netmiko-ssh-automation",
      "network-*", "nodejs-keccak256", "nutrient-document-processing", "prediction-market-*",
      "scientific-*", "uncloud", "visa-doc-translate"
    ])
  }),
  Object.freeze({
    id: "media-creative",
    reason: "Video, animation, and creative production; several need external media APIs.",
    source: "ECC-GAP-ANALYSIS.md §D (медиа/видео/креатив)",
    rules: Object.freeze([
      "blender-motion-state-inspection", "fal-ai-media", "frontend-slides", "ios-icon-gen",
      "manim-video", "openclaw-persona-forge", "remotion-video-creation", "taste",
      "taste-application", "taste-distillation", "tasteforge-video", "ui-demo",
      "video-editing", "videodb"
    ])
  }),
  Object.freeze({
    id: "external-mcp-dependent",
    reason: "Require Context7, Exa, Firecrawl, or similar remote MCP servers; this server runs offline.",
    source: "ECC-GAP-ANALYSIS.md §D (внешние MCP-зависимые скиллы)",
    rules: Object.freeze([
      "codehealth-mcp", "data-scraper-agent", "deep-research", "documentation-lookup",
      "exa-search", "laravel-plugin-discovery", "mailtrap-email-integration", "repo-scan",
      "research-ops", "search-first"
    ])
  }),
  Object.freeze({
    id: "ecc-self-service",
    reason: "Navigation, configuration, and self-audit of ECC itself, or host shell and terminal control.",
    source: "ECC-GAP-ANALYSIS.md §D (ECC-специфичные скиллы самообслуживания); PLAN.md §4.2",
    rules: Object.freeze([
      "agent-sort", "agentic-os", "automation-audit-ops", "autonomous-agent-harness",
      "claude-devfleet", "configure-ecc", "dev-team", "dmux-workflows", "dynamic-workflow-mode",
      "ecc-guide", "ecc-recipes", "ecc-tools-cost-audit", "enterprise-agent-ops",
      "hermes-imports", "nanoclaw-repl", "plan-orchestrate", "skill-comply", "skill-scout",
      "skill-stocktake", "team-agent-orchestration", "team-builder", "terminal-opener",
      "terminal-ops", "token-budget-advisor", "workspace-surface-audit"
    ])
  }),
  Object.freeze({
    id: "agent-orchestration",
    reason: "Delegate phases to Claude Code subagents; orchestration belongs to the runner, not the MCP server.",
    source: "ECC-GAP-ANALYSIS.md §D (оркестрация субагентов); PLAN.md §4.2",
    rules: Object.freeze([
      "council", "council-multi-model", "gan-*", "opensource-pipeline", "orch-*", "santa-method"
    ])
  }),
  Object.freeze({
    id: "agent-loops",
    reason: "Run-until-done loops and transcript observers; the server never runs background processes.",
    source: "ECC-GAP-ANALYSIS.md §D (циклы и наблюдение за ними); PLAN.md §4.2",
    rules: Object.freeze([
      "autonomous-loops", "continuous-agent-loop", "continuous-learning-v2", "loop-design-check",
      "parallel-execution-optimizer", "ralphinho-rfc-pipeline"
    ])
  }),
  Object.freeze({
    id: "ecc-operator-surfaces",
    reason: "Local browser and desktop UIs; the Obsidian dashboard and Argentum own that role here.",
    source: "ECC-GAP-ANALYSIS.md §D (Plan Canvas, дашборды ECC)",
    rules: Object.freeze(["dashboard-builder", "plan-canvas"])
  }),
  Object.freeze({
    id: "superseded-by-ai-dev-system",
    reason: "Duplicate a module this server already owns (memory, instincts, guard, evals, skill validation).",
    source: "ECC-GAP-ANALYSIS.md §D (прочее); PLAN.md §4.2",
    rules: Object.freeze([
      "agent-architecture-audit", "agent-harness-construction", "agent-introspection-debugging",
      "agent-self-evaluation", "agentic-engineering", "ai-first-engineering",
      "ai-regression-testing", "benchmark-optimization-loop", "blueprint", "ck",
      "content-hash-cache-pattern", "continuous-learning", "eval-harness", "gateguard",
      "iterative-retrieval", "knowledge-ops", "make-interfaces-feel-better",
      "ml-adoption-playbook", "plankton-code-quality", "recsys-pipeline-architect",
      "recursive-decision-ledger", "regex-vs-llm-structured-text", "safety-guard",
      "unified-memory"
    ])
  }),
  Object.freeze({
    id: "oversized-for-seed",
    reason: "Tens of framework reference files; ECC-GAP-ANALYSIS.md §D calls carrying them into the seed pointless.",
    source: "ECC-GAP-ANALYSIS.md §D (реферативные скиллы, строка про Remotion/Angular)",
    rules: Object.freeze(["angular-developer"])
  })
]);

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function ruleMatches(rule, folder, name) {
  if (rule.endsWith("*")) {
    const prefix = rule.slice(0, -1);
    return folder.startsWith(prefix) || (Boolean(name) && name.startsWith(prefix));
  }
  return rule === folder || rule === name;
}

/**
 * The exclusion group a candidate falls into, or `null` when none matches.
 *
 * @param {string} folder - Upstream directory name.
 * @param {string} [name] - Name from the skill's frontmatter.
 * @returns {{ group: string, reason: string, source: string, rule: string } | null}
 */
export function matchSkillImportExclusion(folder, name = "") {
  const folderKey = lower(folder);
  const nameKey = lower(name);
  for (const group of SKILL_IMPORT_EXCLUSION_GROUPS) {
    for (const rule of group.rules) {
      if (ruleMatches(rule, folderKey, nameKey)) {
        return { group: group.id, reason: group.reason, source: group.source, rule };
      }
    }
  }
  return null;
}

/**
 * Parse a skill's YAML frontmatter. Handles `description:` on one line and as a
 * `|` block; every other key is ignored. Shared with the vault collectors so the
 * name an import is planned under is the name the registry ends up using.
 *
 * @param {string} text - Full SKILL.md contents.
 * @param {string} fallbackName - Name to use when frontmatter carries none.
 * @returns {{ name: string, description: string }}
 */
export function parseSkillFrontmatter(text, fallbackName) {
  const frontmatter = String(text ?? "").match(/^---\s*([\s\S]*?)\s*---/);
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

    if (/^description:\s*\|\s*$/.test(line)) {
      const descriptionLines = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        if (/^[A-Za-z0-9_-]+:\s*/.test(lines[child])) break;
        descriptionLines.push(lines[child].replace(/^\s{2}/, "").trimEnd());
      }
      result.description = descriptionLines.filter((value) => value.trim()).join(" ").trim();
      continue;
    }

    const descriptionMatch = line.match(/^description:\s*(.+)$/);
    if (descriptionMatch) {
      result.description = descriptionMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return result;
}

/**
 * Read every `<skillsDirectory>/<folder>/SKILL.md`, score it as it would be
 * scored once in the registry, and audit its directory against the public-seed
 * privacy rules.
 *
 * @param {string} skillsDirectory - Upstream `skills/` directory.
 * @param {{ source?: string }} [options] - `source` is the registry source the
 *   candidates would carry (it selects the quality profile).
 * @returns {Promise<Array<object>>} Candidates in directory order.
 */
export async function readSkillImportCandidates(skillsDirectory, { source = "external" } = {}) {
  const entries = await fs.readdir(skillsDirectory, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(skillsDirectory, entry.name);
    const markdown = await fs.readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => null);
    if (markdown === null) continue;
    const text = markdown.replace(/^﻿/, "");
    const meta = parseSkillFrontmatter(text, entry.name);
    const description = String(meta.description || "").replace(/\s+/g, " ").trim();
    const quality = evaluateSkillQuality({ name: meta.name, source, description }, text);
    const audit = await auditDistributionTree(directory);
    candidates.push({
      folder: entry.name,
      name: meta.name,
      description,
      directory,
      quality_score: quality.score,
      quality_grade: quality.grade,
      quality_status: quality.status,
      privacy_findings: audit.findings.map((finding) => ({
        rule: finding.rule,
        path: `${entry.name}/${finding.path}`
      })),
      files: audit.total_files,
      bytes: audit.total_bytes
    });
  }
  return candidates;
}

function rejection(candidate, reason, detail) {
  return {
    folder: candidate.folder,
    name: candidate.name,
    reason,
    quality_score: candidate.quality_score,
    ...detail
  };
}

/**
 * Apply the four import gates to scored candidates.
 *
 * @param {{ candidates?: Array<object>, existingSkills?: Array<{ name?: string, source?: string, path?: string }>, qualityFloor?: number }} input
 * @returns {{ quality_floor: number, selected: Array<object>, rejected: Array<object>, conflicts: Array<object>, summary: object }}
 */
export function planSkillImport({
  candidates = [],
  existingSkills = [],
  qualityFloor = SKILL_IMPORT_QUALITY_FLOOR
} = {}) {
  const floorValue = Number(qualityFloor);
  const floor = Number.isFinite(floorValue) ? Math.max(0, Math.min(100, floorValue)) : SKILL_IMPORT_QUALITY_FLOOR;

  const existing = new Map();
  for (const item of existingSkills) {
    const key = lower(item?.name);
    if (!key || existing.has(key)) continue;
    existing.set(key, { name: item?.name, source: item?.source || "", path: item?.path || "" });
  }

  const selected = [];
  const rejected = [];
  const conflicts = [];
  const ruleGroups = {};

  for (const candidate of candidates) {
    const excluded = matchSkillImportExclusion(candidate.folder, candidate.name);
    if (excluded) {
      ruleGroups[excluded.group] = (ruleGroups[excluded.group] || 0) + 1;
      rejected.push(rejection(candidate, "excluded-by-rule", {
        group: excluded.group,
        rule: excluded.rule,
        detail: excluded.reason
      }));
      continue;
    }

    const owner = existing.get(lower(candidate.name)) || existing.get(lower(candidate.folder));
    if (owner) {
      const custom = lower(owner.source) === "custom";
      const conflict = {
        name: candidate.name,
        folder: candidate.folder,
        keeps: `${owner.source}:${owner.name}`,
        keeps_path: owner.path,
        local_source: owner.source,
        custom_skill: custom
      };
      conflicts.push(conflict);
      rejected.push(rejection(candidate, "name-conflict", {
        keeps: conflict.keeps,
        detail: custom
          ? "A custom skill already owns this name; the local skill wins and the upstream one stays out of routing."
          : "The catalogue already owns this name; the local skill wins and the upstream one stays out of routing."
      }));
      continue;
    }

    if (candidate.privacy_findings?.length) {
      rejected.push(rejection(candidate, "privacy-finding", {
        findings: candidate.privacy_findings.map((finding) => `${finding.rule}: ${finding.path}`),
        detail: "The skill would fail the public-seed privacy audit and cannot ship in the catalogue."
      }));
      continue;
    }

    if (Number(candidate.quality_score || 0) < floor) {
      rejected.push(rejection(candidate, "below-quality-floor", {
        detail: `Structural quality ${candidate.quality_score} is under the ${floor} floor.`
      }));
      continue;
    }

    selected.push(candidate);
  }

  const counted = (reason) => rejected.filter((item) => item.reason === reason).length;
  return {
    quality_floor: floor,
    selected,
    rejected,
    conflicts,
    summary: {
      candidates: candidates.length,
      imported: selected.length,
      rejected: rejected.length,
      rejected_by_rule: counted("excluded-by-rule"),
      rejected_by_quality: counted("below-quality-floor"),
      rejected_by_name_conflict: counted("name-conflict"),
      rejected_by_privacy: counted("privacy-finding"),
      rule_groups: Object.fromEntries(
        Object.entries(ruleGroups).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      ),
      custom_skill_conflicts: conflicts.filter((item) => item.custom_skill).map((item) => item.name),
      catalog_name_conflicts: conflicts.filter((item) => !item.custom_skill).map((item) => item.name),
      selected_files: selected.reduce((total, item) => total + Number(item.files || 0), 0),
      selected_bytes: selected.reduce((total, item) => total + Number(item.bytes || 0), 0)
    }
  };
}

/**
 * Replace `<targetSkillsDirectory>` with exactly the selected skills, copied
 * verbatim from the clone. The directory is rebuilt from scratch so a re-import
 * drops skills that the policy no longer selects instead of leaving them behind.
 *
 * @param {Array<{ folder: string, directory: string }>} selected - Plan result.
 * @param {string} targetSkillsDirectory - `<repo>/skills` inside the vault.
 * @returns {Promise<{ folders: string[] }>}
 */
export async function stageSelectedSkills(selected, targetSkillsDirectory) {
  await fs.rm(targetSkillsDirectory, { recursive: true, force: true });
  await fs.mkdir(targetSkillsDirectory, { recursive: true });
  const folders = [];
  for (const candidate of selected) {
    await copyDistributionTree(candidate.directory, path.join(targetSkillsDirectory, candidate.folder));
    folders.push(candidate.folder);
  }
  folders.sort((left, right) => left.localeCompare(right));
  return { folders };
}

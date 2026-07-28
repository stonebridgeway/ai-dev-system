import { createHash } from "node:crypto";

export const SKILL_SCHEMA_VERSION = 2;
export const SKILL_QUALITY_RULES_VERSION = 2;

export const SKILL_MATURITY_LEVELS = ["draft", "reviewed", "validated", "production", "deprecated"];
export const SKILL_TRUST_LEVELS = ["trusted-local", "pinned-upstream", "known-upstream", "community-source", "unverified"];

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "and", "any", "are", "before", "being", "between",
  "both", "can", "data", "does", "each", "from", "have", "into", "more", "must", "only", "other",
  "should", "skill", "that", "the", "their", "then", "there", "these", "this", "through", "tool", "use",
  "user", "using", "when", "where", "which", "with", "without", "workflow", "your"
]);

const EXPLICIT_REQUIREMENTS = new Map([
  ["backend-api-engineer", ["repository context", "API or service requirements"]],
  ["api-contract-reviewer", ["API contract, routes, schema, or client usage"]],
  ["database-migration-guardian", ["database schema and migration context", "rollback expectations"]],
  ["devops-release-engineer", ["deployment target", "CI/CD or release configuration"]],
  ["container-deployment-reviewer", ["container build and runtime configuration"]],
  ["application-security-reviewer", ["repository context", "threat-sensitive change scope"]],
  ["secrets-dependencies-auditor", ["dependency manifests and configuration context"]],
  ["data-pipeline-engineer", ["data contract, lineage, and operational requirements"]],
  ["llm-integration-engineer", ["model/provider requirements", "evaluation and fallback expectations"]]
]);

const EXPLICIT_CONFLICTS = new Map([
  ["database-migration-guardian", ["policy:destructive-schema-shortcut"]],
  ["application-security-reviewer", ["policy:unsafe-production-testing"]],
  ["secrets-dependencies-auditor", ["policy:credential-dumping-workflow"]]
]);

const FRAMEWORK_PATTERNS = [
  ["react", /\breact\b/i], ["next.js", /\bnext(?:\.js|js)\b/i], ["vue", /\bvue(?:\.js)?\b/i],
  ["svelte", /\bsvelte(?:kit)?\b/i], ["angular", /\bangular\b/i], ["fastapi", /\bfastapi\b/i],
  ["django", /\bdjango\b/i], ["flask", /\bflask\b/i], ["express", /\bexpress(?:\.js|js)\b|\bexpress\s+(?:app|server|framework|middleware)\b/i],
  ["nestjs", /\bnestjs\b/i], ["spring", /\bspring(?: boot)?\b/i], [".net", /\basp\.net|\b\.net\b/i],
  ["rails", /\bruby on rails|\brails\b/i], ["laravel", /\blaravel\b/i], ["sqlalchemy", /\bsqlalchemy\b/i],
  ["alembic", /\balembic\b/i], ["celery", /\bcelery\b/i], ["aiogram", /\baiogram\b/i],
  ["playwright", /\bplaywright\b/i], ["docker", /\bdocker(?:file| compose)?\b/i],
  ["kubernetes", /\bkubernetes|\bk8s\b/i], ["terraform", /\bterraform\b/i],
  ["github-actions", /\bgithub actions\b/i], ["postgresql", /\bpostgres(?:ql)?\b/i],
  ["redis", /\bredis\b/i], ["mysql", /\bmysql\b/i], ["mongodb", /\bmongo(?:db)?\b/i],
  ["pytorch", /\bpytorch\b/i], ["transformers", /\btransformers\b/i], ["langchain", /\blangchain\b/i]
];

const LANGUAGE_PATTERNS = [
  ["python", /\bpython\b|\.py\b/i], ["typescript", /\btypescript\b|\.tsx?\b/i],
  ["javascript", /\bjavascript\b|\.jsx?\b/i], ["go", /\bgolang\b|\bgo\s+(?:module|service|code)\b/i],
  ["rust", /\brust\b|cargo\.toml/i], ["java", /\bjava\b|\.java\b/i],
  ["csharp", /\bc#\b|\bcsharp\b|\.cs\b/i], ["php", /\bphp\b|composer\.json/i],
  ["ruby", /\bruby\b|gemfile/i], ["swift", /\bswift(?:ui)?\b/i], ["kotlin", /\bkotlin\b/i],
  ["sql", /\bsql\b|\bselect\s+.+\bfrom\b/i], ["shell", /\b(?:bash|powershell|shell)\b|```(?:bash|sh|powershell)/i]
];

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeMarkdown(markdown) {
  return String(markdown || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

function stripFrontmatter(markdown) {
  return normalizeMarkdown(markdown).replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim();
}

function hashText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function qualityGrade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function inferSkillProfile(item) {
  const source = String(item?.source || "");
  if (String(item?.type || "") === "app-integration" || source.includes("membrane")) return "app-integration";
  if (source === "custom") return "workflow";
  if (source.startsWith("design/")) return "design";
  return "external";
}

export function inferTrustLevel(item) {
  const source = String(item?.source || "");
  if (source === "custom") return "trusted-local";
  if (item?.commit && item?.repository) return "pinned-upstream";
  if (source.includes("membrane")) return "known-upstream";
  if (source.startsWith("design/") || source.startsWith("external/")) return "community-source";
  return "unverified";
}

export function inferFrameworks(text) {
  return FRAMEWORK_PATTERNS.filter(([, pattern]) => pattern.test(String(text || ""))).map(([name]) => name);
}

export function inferLanguages(text) {
  return LANGUAGE_PATTERNS.filter(([, pattern]) => pattern.test(String(text || ""))).map(([name]) => name);
}

function addFinding(findings, severity, code, message) {
  findings.push({ severity, code, message });
}

function riskAwareSafetyScore(body, profile, findings) {
  let score = 0;
  const hasGuardrails = /(^|\n)#{1,4}\s+(guardrails?|safety|security|constraints?|do not|limitations?)/i.test(body)
    || /\bdo not\b|\bnever\b|\bavoid\b/i.test(body);
  const hasAuthSafety = /authentication|authorization|permission|credential|secret|token|oauth|least privilege/i.test(body);
  const hasRisk = /production|delete|drop\s+table|destructive|credential|secret|token|payment|migration|force|sudo/i.test(body);
  const hasRiskControl = /confirm|approval|backup|rollback|redact|do not|never|avoid|least privilege|dry[- ]run|non-destructive/i.test(body);
  const hasPlaceholder = /(^|\n)\s*(?:[-*]\s*)?(?:TODO|TBD|FIXME)(?::|\s*$)|<fill[-_ ]?in>|\[placeholder\]/im.test(body);

  if (hasGuardrails || (profile === "app-integration" && hasAuthSafety)) score += 6;
  else addFinding(findings, "warn", "missing-guardrails", "No explicit guardrails, safety section, or equivalent constraints were found.");

  if (!hasRisk || hasRiskControl || (profile === "app-integration" && hasAuthSafety)) score += 5;
  else addFinding(findings, "error", "uncontrolled-risk", "Risk-sensitive operations are mentioned without confirmation, rollback, redaction, or equivalent controls.");

  if (!hasPlaceholder) score += 4;
  else addFinding(findings, "error", "placeholder-content", "The skill contains TODO, TBD, FIXME, or placeholder content.");
  return score;
}

export function evaluateSkillQuality(item, markdown) {
  const normalized = normalizeMarkdown(markdown);
  const body = stripFrontmatter(normalized);
  const profile = inferSkillProfile(item);
  const description = String(item?.description || "").trim();
  const genericIntegrationDescription = profile === "app-integration"
    && /manage data, records, and automate workflows/i.test(description);
  const findings = [];
  const breakdown = { metadata: 0, structure: 0, specificity: 0, actionability: 0, safety: 0 };
  const hasFrontmatter = /^---\s*[\s\S]*?\s*---/.test(normalized);
  const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(item?.name || ""));
  const triggerDescription = /\buse when\b|\buse for\b|\btrigger/i.test(description);
  const headings = [...body.matchAll(/^#{2,4}\s+.+$/gm)].length;
  const numberedSteps = [...body.matchAll(/^\s*\d+\.\s+.+$/gm)].length;
  const hasWorkflow = /(^|\n)#{1,4}\s+(workflow|process|procedure|implementation|review flow|gate)/i.test(body) || numberedSteps >= 3;
  const hasOutput = /(^|\n)#{1,4}\s+(output|verification|acceptance|evidence|report|completion|quality gate)/i.test(body);
  const hasConstraints = /\bdo not\b|\bnever\b|\bavoid\b|\bmust not\b/i.test(body);
  const hasVerification = /verify|verification|test|check|evidence|assert|smoke|rollback|acceptance criteria/i.test(body);
  const hasImperatives = /(^|\n)(?:\d+\.|[-*])\s+(?:read|inspect|identify|confirm|run|check|verify|implement|review|compare|record|report|preserve|avoid|require)\b/im.test(body);
  const codeBlocks = [...body.matchAll(/```/g)].length / 2;
  const officialDocs = /official docs:\s*https?:\/\//i.test(body);
  const overviewSection = body.match(/##\s+.+?\s+Overview\s*([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "";
  const hasEntityModel = /^\s*[-*]\s+\*\*[^*]+\*\*/m.test(overviewSection);
  const popularActionsSection = body.match(/##\s+Popular actions\s*([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "";
  const actionRows = [...popularActionsSection.matchAll(/^\|\s*(?![-:]+\s*\|)[^|\n]+\|[^|\n]+\|[^|\n]+\|\s*$/gm)].length;
  const tokens = body.toLowerCase().match(/[a-zа-я0-9][a-zа-я0-9._-]+/gi) || [];
  const uniqueTokenCount = new Set(tokens).size;
  const bodyMinimum = profile === "app-integration" ? 900 : profile === "workflow" ? 450 : 350;

  if (hasFrontmatter) breakdown.metadata += 5;
  else addFinding(findings, "error", "missing-frontmatter", "SKILL.md has no YAML frontmatter.");
  if (validName) breakdown.metadata += 5;
  else addFinding(findings, "error", "invalid-name", "Skill name must use lowercase hyphen-case.");
  if (description.length >= (profile === "app-integration" ? 45 : 70)) {
    breakdown.metadata += genericIntegrationDescription ? 3 : 6;
    if (genericIntegrationDescription) {
      addFinding(findings, "warn", "generic-integration-description", "Description names the app but does not identify its specific capability or object model.");
    }
  }
  else addFinding(findings, "warn", "weak-description", "Description is too short to route the skill reliably.");
  if (triggerDescription) breakdown.metadata += 4;
  else addFinding(findings, "warn", "missing-trigger", "Description does not clearly state when the skill should trigger.");

  if (headings >= 2) breakdown.structure += 6;
  else if (headings === 1) breakdown.structure += 3;
  else addFinding(findings, "warn", "weak-structure", "Body has no useful section structure.");
  if (hasWorkflow || (profile === "app-integration" && /working with|searching for actions|connection ensure/i.test(body))) breakdown.structure += 8;
  else addFinding(findings, "error", "missing-workflow", "No repeatable workflow or procedural sequence was found.");
  if (hasConstraints || /guardrail|safety|authentication|permission/i.test(body)) breakdown.structure += 6;
  else addFinding(findings, "warn", "missing-constraints", "No explicit constraints or safety guidance were found.");
  if (hasOutput || (profile === "app-integration" && /--json|machine-readable/i.test(body))) breakdown.structure += 5;
  else addFinding(findings, "warn", "missing-verification-output", "No output, evidence, or verification contract was found.");

  if (body.length >= bodyMinimum) breakdown.specificity += 8;
  else if (body.length >= Math.floor(bodyMinimum * 0.6)) breakdown.specificity += 5;
  else addFinding(findings, "warn", "thin-body", "Skill body is too short for its validation profile.");
  if (profile === "app-integration") {
    if (officialDocs) breakdown.specificity += 3;
    else addFinding(findings, "warn", "missing-official-docs", "No official product or API documentation link was found.");
    if (hasEntityModel) breakdown.specificity += 3;
    else addFinding(findings, "warn", "missing-object-model", "The integration overview does not name concrete resources or entities.");
    if (actionRows >= 5) breakdown.specificity += 3;
    else if (actionRows >= 1) breakdown.specificity += 1;
    else addFinding(findings, "warn", "missing-popular-actions", "No concrete popular-action catalog was found.");
    if (!genericIntegrationDescription) breakdown.specificity += 3;
  } else {
    if (codeBlocks >= 1 || profile === "workflow") breakdown.specificity += 4;
    if (description.split(/\s+/).length >= 12) breakdown.specificity += 4;
    else addFinding(findings, "warn", "generic-description", "Description is too generic for confident routing.");
    if (uniqueTokenCount >= 45) breakdown.specificity += 4;
    else if (uniqueTokenCount >= 25) breakdown.specificity += 2;
  }

  if (numberedSteps >= 3 || (profile === "app-integration" && codeBlocks >= 3)) breakdown.actionability += 8;
  else addFinding(findings, "warn", "weak-procedure", "Fewer than three concrete steps or equivalent executable examples were found.");
  if (hasImperatives || profile === "app-integration") breakdown.actionability += 4;
  if (hasVerification) breakdown.actionability += 4;
  else addFinding(findings, "warn", "missing-verification", "The skill does not explicitly require verification.");
  if (hasConstraints || profile === "app-integration") breakdown.actionability += 4;

  breakdown.safety = riskAwareSafetyScore(body, profile, findings);
  const score = clamp(Object.values(breakdown).reduce((total, value) => total + value, 0));
  const hasErrors = findings.some((finding) => finding.severity === "error");
  const status = hasErrors || score < 55 ? "fail" : score < 75 ? "warn" : "pass";
  return {
    profile,
    score,
    grade: qualityGrade(score),
    status,
    breakdown,
    findings
  };
}

function inferMaturity(item, evaluation) {
  if (item?.deprecated) return "deprecated";
  if (evaluation.status === "fail") return "draft";
  const source = String(item?.source || "");
  const empiricalPassed = item?.empirical_status === "pass"
    || item?.empirical_validation?.status === "pass"
    || (Array.isArray(item?.validation_evidence) && item.validation_evidence.some((entry) => entry?.status === "pass"));
  if (source === "custom") {
    if (evaluation.score < 75) return "draft";
    return empiricalPassed ? "validated" : "reviewed";
  }
  if (source.includes("membrane") || source.startsWith("design/")) return evaluation.score >= 65 ? "reviewed" : "draft";
  return evaluation.score >= 75 ? "reviewed" : "draft";
}

export function enrichSkillQuality(item, markdown) {
  const evaluation = evaluateSkillQuality(item, markdown);
  const combinedText = `${item?.name || ""}\n${item?.description || ""}\n${stripFrontmatter(markdown)}`;
  const explicitRequirements = EXPLICIT_REQUIREMENTS.get(String(item?.name || "").toLowerCase()) || [];
  const explicitConflicts = EXPLICIT_CONFLICTS.get(String(item?.name || "").toLowerCase()) || [];
  const empiricalEvidence = Array.isArray(item?.validation_evidence)
    ? item.validation_evidence.filter((entry) => entry && typeof entry === "object")
    : [];
  const empiricalStatus = item?.empirical_status
    || item?.empirical_validation?.status
    || (empiricalEvidence.some((entry) => entry.status === "pass") ? "pass" : "not-measured");
  const validationStatus = evaluation.status === "fail"
    ? "fail"
    : empiricalStatus === "pass"
      ? "validated"
      : "provisional";
  return {
    ...item,
    requires: unique([...(item?.requires || []), ...explicitRequirements]),
    conflicts: unique([...(item?.conflicts || []), ...explicitConflicts]),
    frameworks: unique([...(item?.frameworks || []), ...inferFrameworks(combinedText)]),
    languages: unique([...(item?.languages || []), ...inferLanguages(combinedText)]),
    maturity: inferMaturity(item, evaluation),
    trust_level: inferTrustLevel(item),
    quality_profile: evaluation.profile,
    structure_score: evaluation.score,
    structure_grade: evaluation.grade,
    structure_status: evaluation.status,
    quality_score: evaluation.score,
    quality_grade: evaluation.grade,
    quality_status: evaluation.status,
    quality_basis: empiricalStatus === "pass" ? "structure-and-empirical" : "structure-only",
    empirical_score: Number.isFinite(Number(item?.empirical_score)) ? Number(item.empirical_score) : null,
    empirical_status: empiricalStatus,
    validation_status: validationStatus,
    validation_evidence: empiricalEvidence,
    quality_breakdown: evaluation.breakdown,
    quality_findings: evaluation.findings,
    content_hash: hashText(normalizeMarkdown(markdown)),
    skill_schema_version: SKILL_SCHEMA_VERSION,
    quality_rules_version: SKILL_QUALITY_RULES_VERSION
  };
}

function duplicateTokens(item, markdown) {
  const name = String(item?.name || "").toLowerCase();
  const text = stripFrontmatter(markdown)
    .toLowerCase()
    .replaceAll(name, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return new Set(
    text.split(/\s+/)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token))
      .slice(0, 2000)
  );
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const token of smaller) if (larger.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function analyzeDuplicateSkills(records, { threshold = 0.82, max_pairs = 100 } = {}) {
  const exactGroups = new Map();
  for (const record of records) {
    const hash = hashText(normalizeMarkdown(record.markdown));
    if (!exactGroups.has(hash)) exactGroups.set(hash, []);
    exactGroups.get(hash).push(record.item);
  }
  const exact = [...exactGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([hash, items]) => ({
      hash,
      skills: items.map((item) => ({ name: item.name, source: item.source, path: item.path }))
    }));

  const candidates = records.filter((record) => inferSkillProfile(record.item) !== "app-integration");
  const tokenSets = candidates.map((record) => duplicateTokens(record.item, record.markdown));
  const near = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const similarity = jaccard(tokenSets[leftIndex], tokenSets[rightIndex]);
      if (similarity < threshold) continue;
      near.push({
        left: { name: candidates[leftIndex].item.name, source: candidates[leftIndex].item.source, path: candidates[leftIndex].item.path },
        right: { name: candidates[rightIndex].item.name, source: candidates[rightIndex].item.source, path: candidates[rightIndex].item.path },
        similarity: Number(similarity.toFixed(4)),
        method: "token-jaccard"
      });
    }
  }
  near.sort((a, b) => b.similarity - a.similarity || a.left.name.localeCompare(b.left.name));
  return {
    exact,
    near: near.slice(0, Math.max(1, Number(max_pairs) || 100)),
    near_total: near.length,
    compared_non_integration_skills: candidates.length,
    membrane_policy: "Template similarity is expected and excluded from near-duplicate findings; exact duplicates remain reportable."
  };
}

export function summarizeSkillQuality(items) {
  const byMaturity = {};
  const byTrust = {};
  const byStatus = {};
  const byGrade = {};
  const byValidationStatus = {};
  const findingCounts = {};
  let scoreTotal = 0;
  let schemaCurrent = 0;
  for (const item of items) {
    byMaturity[item.maturity || "missing"] = (byMaturity[item.maturity || "missing"] || 0) + 1;
    byTrust[item.trust_level || "missing"] = (byTrust[item.trust_level || "missing"] || 0) + 1;
    byStatus[item.quality_status || "missing"] = (byStatus[item.quality_status || "missing"] || 0) + 1;
    byGrade[item.quality_grade || "missing"] = (byGrade[item.quality_grade || "missing"] || 0) + 1;
    byValidationStatus[item.validation_status || "missing"] = (byValidationStatus[item.validation_status || "missing"] || 0) + 1;
    for (const finding of item.quality_findings || []) {
      findingCounts[finding.code || "unknown"] = (findingCounts[finding.code || "unknown"] || 0) + 1;
    }
    scoreTotal += Number(item.quality_score || 0);
    if (item.skill_schema_version === SKILL_SCHEMA_VERSION) schemaCurrent += 1;
  }
  const important = items.filter((item) => item.source === "custom");
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    quality_rules_version: SKILL_QUALITY_RULES_VERSION,
    total: items.length,
    schema_current: schemaCurrent,
    average_score: items.length ? Number((scoreTotal / items.length).toFixed(2)) : 0,
    by_maturity: byMaturity,
    by_trust: byTrust,
    by_status: byStatus,
    by_grade: byGrade,
    by_validation_status: byValidationStatus,
    finding_counts: Object.fromEntries(Object.entries(findingCounts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    important_skills: important.length,
    important_validated: important.filter((item) => ["validated", "production"].includes(item.maturity)).length,
    important_structure_ready: important.filter((item) => item.structure_status === "pass" || item.quality_status === "pass").length,
    important_empirical_ready: important.filter((item) => item.empirical_status === "pass").length,
    important_failures: important.filter((item) => item.quality_status === "fail").map((item) => item.name)
  };
}

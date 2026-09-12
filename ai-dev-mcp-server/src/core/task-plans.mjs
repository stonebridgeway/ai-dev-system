import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomic-files.mjs";

export const PLANS_RELATIVE_DIR = ".ai-dev/plans";
export const PLAN_CRITERION_TEXT = "An implementation plan is recorded with plan_task before broad implementation (large or high-risk task).";
export const PLAN_RISK_LEVELS = ["low", "medium", "high"];

const LARGE_SIGNALS = /(refactor|migrat|architect|redesign|rewrite|rework|re-?platform|integrat|end-to-end|multiple|several|across|all modules|whole|entire|переписа|рефактор|миграц|архитектур|редизайн|интеграц|несколько|весь|всех|целиком|сквозн)/i;
const SMALL_SIGNALS = /(\btypo\b|\brename\b|\bsmall\b|\bminor\b|\bquick\b|\bone[- ]line\b|\bsingle\b|опечат|мелк|небольш|быстр|одн[уао]\s|переимен)/i;

function normalize(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function list(values) {
  return (Array.isArray(values) ? values : [values]).map(normalize).filter(Boolean);
}

/**
 * Classify task complexity from cheap deterministic signals (risk, wording,
 * size of the compiled context, criteria count) and decide whether a written
 * plan is required before broad implementation. Mirrors the "plan before
 * execute" and model-routing rules of Everything Claude Code.
 *
 * @param {{ task: string, risk?: string, projectTypes?: string[], selectedFiles?: unknown[], acceptanceCriteria?: string[] }} input
 * @returns {{ complexity: "small" | "medium" | "large", score: number, plan_required: boolean, reasons: string[], suggested_effort: string, suggested_model_tier: string }}
 */
export function classifyTaskComplexity({ task, risk = "low", projectTypes = [], selectedFiles = [], acceptanceCriteria = [] }) {
  const text = normalize(task);
  const words = text ? text.split(/\s+/).length : 0;
  const files = Array.isArray(selectedFiles) ? selectedFiles.length : 0;
  const criteria = list(acceptanceCriteria).length;
  let score = 0;
  const reasons = [];
  if (risk === "high") {
    score += 3;
    reasons.push("high-risk area (payments, production, migration, security, auth, deletion)");
  } else if (risk === "medium") {
    score += 1;
    reasons.push("medium risk (shared config, routing, API, dependencies)");
  }
  if (LARGE_SIGNALS.test(text)) {
    score += 2;
    reasons.push("wording implies cross-cutting or architectural work");
  }
  if (SMALL_SIGNALS.test(text)) {
    score -= 1;
    reasons.push("wording implies a narrow change");
  }
  if (words >= 120) {
    score += 2;
    reasons.push("long task statement");
  } else if (words >= 60) {
    score += 1;
    reasons.push("detailed task statement");
  }
  if (files >= 8) {
    score += 2;
    reasons.push(`${files} relevant files selected by the context compiler`);
  } else if (files >= 4) {
    score += 1;
    reasons.push(`${files} relevant files selected by the context compiler`);
  }
  if (criteria >= 4) {
    score += 1;
    reasons.push(`${criteria} explicit acceptance criteria`);
  }
  if (projectTypes.includes("mobile") || projectTypes.includes("api")) {
    reasons.push(`project type ${projectTypes.join("/")} raises verification cost`);
  }
  const complexity = score >= 4 ? "large" : score >= 2 ? "medium" : "small";
  const planRequired = complexity === "large" || risk === "high";
  return {
    complexity,
    score,
    plan_required: planRequired,
    reasons,
    suggested_effort: complexity === "large" ? "high" : complexity === "medium" ? "medium" : "low",
    suggested_model_tier: complexity === "large" ? "deep" : complexity === "medium" ? "balanced" : "fast"
  };
}

/**
 * Skeleton the agent fills in for `plan_task`, in the planner output format.
 *
 * @param {string} task
 * @returns {object}
 */
export function planTemplate(task) {
  return {
    overview: `2-3 sentences: what changes for "${normalize(task)}" and why.`,
    requirements: ["Observable requirement 1", "Observable requirement 2"],
    phases: [
      {
        title: "Phase 1: minimum viable slice",
        steps: [
          { action: "What to change", file: "path/to/file", why: "Why this step is needed", risk: "low", depends_on: "" }
        ],
        tests: ["Test that proves this phase"]
      },
      { title: "Phase 2: complete happy path", steps: [], tests: [] },
      { title: "Phase 3: edge cases and polish", steps: [], tests: [] }
    ],
    testing_strategy: "Unit: ...; Integration: ...; E2E: ...",
    risks: [{ risk: "What could go wrong", mitigation: "How it is prevented or detected" }],
    rollback: "How to revert safely.",
    open_questions: [],
    success_criteria: ["All acceptance criteria met", "Relevant checks pass via verify_task"]
  };
}

/**
 * Validate and normalize a plan document.
 *
 * @param {object} input
 * @returns {object} Normalized plan.
 */
export function normalizePlan(input = {}) {
  const overview = normalize(input.overview);
  if (!overview) throw new Error("overview is required.");
  const phases = (Array.isArray(input.phases) ? input.phases : []).map((phase, phaseIndex) => {
    const title = normalize(phase?.title) || `Phase ${phaseIndex + 1}`;
    const steps = (Array.isArray(phase?.steps) ? phase.steps : []).map((step, stepIndex) => {
      const action = normalize(typeof step === "string" ? step : step?.action);
      if (!action) throw new Error(`Phase ${phaseIndex + 1}, step ${stepIndex + 1}: action is required.`);
      const risk = normalize(step?.risk).toLowerCase() || "low";
      if (!PLAN_RISK_LEVELS.includes(risk)) throw new Error(`Phase ${phaseIndex + 1}, step ${stepIndex + 1}: risk must be low, medium, or high.`);
      return {
        action,
        file: normalize(step?.file),
        why: normalize(step?.why),
        risk,
        depends_on: normalize(step?.depends_on)
      };
    });
    return { title, steps, tests: list(phase?.tests) };
  });
  if (!phases.length || !phases.some((phase) => phase.steps.length)) {
    throw new Error("At least one phase with one concrete step is required.");
  }
  const risks = (Array.isArray(input.risks) ? input.risks : []).map((item) => ({
    risk: normalize(typeof item === "string" ? item : item?.risk),
    mitigation: normalize(item?.mitigation)
  })).filter((item) => item.risk);
  return {
    overview,
    requirements: list(input.requirements),
    phases,
    testing_strategy: normalize(input.testing_strategy),
    risks,
    rollback: normalize(input.rollback),
    open_questions: list(input.open_questions),
    success_criteria: list(input.success_criteria)
  };
}

function bullets(values, fallback = "- None recorded.") {
  return values.length ? values.map((value) => `- ${value.replace(/\n+/g, " ")}`).join("\n") : fallback;
}

/**
 * Render a plan in the planner format (Overview, Requirements, Implementation
 * Steps by phase with File/Why/Dependencies/Risk, Testing Strategy, Risks &
 * Mitigations, Success Criteria).
 *
 * @param {{ taskId: string, task: string, plan: object, recordedAt?: string }} input
 * @returns {string}
 */
export function renderPlanMarkdown({ taskId, task, plan, recordedAt = new Date().toISOString() }) {
  const lines = [
    "---",
    `task_id: ${taskId}`,
    `recorded_at: ${recordedAt}`,
    "---",
    "",
    `# Implementation Plan: ${normalize(task)}`,
    "",
    "## Overview",
    "",
    plan.overview,
    "",
    "## Requirements",
    "",
    bullets(plan.requirements, "- Not recorded."),
    "",
    "## Implementation Steps",
    ""
  ];
  plan.phases.forEach((phase, phaseIndex) => {
    lines.push(`### ${/^phase\s+\d+/i.test(phase.title) ? phase.title : `Phase ${phaseIndex + 1}: ${phase.title}`}`, "");
    if (!phase.steps.length) lines.push("- (no steps recorded yet)", "");
    phase.steps.forEach((step, stepIndex) => {
      lines.push(`${stepIndex + 1}. **${step.action}**${step.file ? ` (File: \`${step.file}\`)` : ""}`);
      if (step.why) lines.push(`   - Why: ${step.why}`);
      lines.push(`   - Dependencies: ${step.depends_on || "None"}`);
      lines.push(`   - Risk: ${step.risk[0].toUpperCase()}${step.risk.slice(1)}`);
    });
    if (phase.tests.length) {
      lines.push("", `Tests for this phase:`, "", bullets(phase.tests));
    }
    lines.push("");
  });
  lines.push(
    "## Testing Strategy",
    "",
    plan.testing_strategy || "Not recorded.",
    "",
    "## Risks & Mitigations",
    "",
    plan.risks.length ? plan.risks.map((item) => `- **${item.risk}** → ${item.mitigation || "mitigation not recorded"}`).join("\n") : "- None recorded.",
    "",
    "## Rollback",
    "",
    plan.rollback || "Not recorded.",
    "",
    "## Open Questions",
    "",
    bullets(plan.open_questions, "- None."),
    "",
    "## Success Criteria",
    "",
    plan.success_criteria.length ? plan.success_criteria.map((item) => `- [ ] ${item}`).join("\n") : "- [ ] All acceptance criteria are met and verified.",
    ""
  );
  return lines.join("\n");
}

/**
 * Persist a plan as Markdown plus JSON under `.ai-dev/plans/<task-id>.*`.
 *
 * @param {{ projectRoot: string, taskId: string, task: string, plan: object, recordedAt?: string }} input
 * @returns {Promise<{ path: string, json_path: string, sha256: string, phases: number, steps: number, recorded_at: string }>}
 */
export async function writeTaskPlan({ projectRoot, taskId, task, plan, recordedAt = new Date().toISOString() }) {
  const normalized = normalizePlan(plan);
  const markdown = renderPlanMarkdown({ taskId, task, plan: normalized, recordedAt });
  const relativeMarkdown = `${PLANS_RELATIVE_DIR}/${taskId}.md`;
  const relativeJson = `${PLANS_RELATIVE_DIR}/${taskId}.json`;
  const root = path.resolve(projectRoot);
  await atomicWriteFile(path.join(root, ...relativeMarkdown.split("/")), markdown, "utf8");
  await atomicWriteJson(path.join(root, ...relativeJson.split("/")), { schema_version: 1, task_id: taskId, task: normalize(task), recorded_at: recordedAt, plan: normalized });
  return {
    path: relativeMarkdown,
    json_path: relativeJson,
    sha256: crypto.createHash("sha256").update(markdown).digest("hex"),
    phases: normalized.phases.length,
    steps: normalized.phases.reduce((sum, phase) => sum + phase.steps.length, 0),
    recorded_at: recordedAt,
    markdown,
    plan: normalized
  };
}

/**
 * Attach a warning to a task record when implementation started (changed
 * files were checkpointed) but the required plan is still missing.
 *
 * @param {object} record - Task record.
 * @param {string[]} changedFiles
 * @returns {object} The record, possibly with `plan_warning`.
 */
export function withPlanGateWarning(record, changedFiles = []) {
  if (record?.plan_policy?.plan_required && !record.plan && changedFiles.length) {
    return {
      ...record,
      plan_warning: `This ${record.plan_policy.complexity} / ${record.risk}-risk task requires a recorded plan. Call plan_task before continuing broad implementation; the "${PLAN_CRITERION_TEXT.slice(0, 40)}..." criterion stays pending until then.`
    };
  }
  return record;
}

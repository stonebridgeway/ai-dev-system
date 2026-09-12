# 07. Гейт планирования: классификация сложности и `plan_task`

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01, lifecycle (`task-lifecycle.mjs`).

## Идея из ECC

Агент `planner` и подход PRP («plan before execute»): для сложных задач сначала план с фазами,
файлами, рисками, тестами и откатом; формат плана фиксирован. В `ai-dev-system` гейт встроен в
жизненный цикл:

- `begin_task` считает `plan_policy` (`classifyTaskComplexity`: small/medium/large по формулировке
  задачи, риску, числу файлов в контексте и критериев; `plan_required` для large или high-risk;
  подсказка по effort и tier модели) и, если план нужен, добавляет критерий приёмки
  «implementation plan recorded…» (`PLAN_CRITERION_TEXT`);
- `checkpoint_task` через `withPlanGateWarning` предупреждает, если код уже меняется, а план не
  записан;
- `plan_task` валидирует и записывает план в `.ai-dev/plans/<task-id>.md` (+ `.json`) и помечает
  критерий `met`; `plan_status` показывает политику и шаблон плана.

Ни один существующий инструмент не сломан: для small/medium задач критерий не добавляется.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/task-plans.mjs`** (271 строк)

```js
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
```

**Файл: `ai-dev-mcp-server/src/core/task-plans.test.mjs`** (111 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PLAN_CRITERION_TEXT,
  classifyTaskComplexity,
  normalizePlan,
  planTemplate,
  renderPlanMarkdown,
  withPlanGateWarning,
  writeTaskPlan
} from "./task-plans.mjs";
import { TaskStore } from "./task-lifecycle.mjs";

test("classifyTaskComplexity scores risk, wording, and context size", () => {
  const small = classifyTaskComplexity({ task: "Fix a typo in the README", risk: "low" });
  assert.equal(small.complexity, "small");
  assert.equal(small.plan_required, false);
  assert.equal(small.suggested_model_tier, "fast");

  const large = classifyTaskComplexity({
    task: "Refactor the payment service and migrate the database schema across all modules",
    risk: "high",
    selectedFiles: new Array(9).fill("f")
  });
  assert.equal(large.complexity, "large");
  assert.equal(large.plan_required, true);
  assert.equal(large.suggested_model_tier, "deep");
  assert.ok(large.reasons.some((reason) => /high-risk/.test(reason)));

  const russian = classifyTaskComplexity({ task: "Переписать архитектуру модуля уведомлений целиком", risk: "medium", selectedFiles: ["a", "b", "c", "d"] });
  assert.equal(russian.complexity, "large");

  const highRiskSmall = classifyTaskComplexity({ task: "Rename the deploy script", risk: "high" });
  assert.equal(highRiskSmall.plan_required, true, "high risk always requires a plan");
  assert.equal(classifyTaskComplexity({ task: "Add a field to the API response", risk: "medium" }).complexity, "small");
});

test("normalizePlan validates phases and renderPlanMarkdown follows the planner format", () => {
  assert.throws(() => normalizePlan({}), /overview is required/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [] }), /At least one phase/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [{ steps: [{ action: "" }] }] }), /action is required/);
  assert.throws(() => normalizePlan({ overview: "x", phases: [{ steps: [{ action: "a", risk: "huge" }] }] }), /risk must be/);
  const plan = normalizePlan({
    overview: "Add subscriptions.",
    requirements: ["Users can pick a plan"],
    phases: [
      { title: "Phase 1: schema", steps: [{ action: "Add migration", file: "db/001.sql", why: "store tier", risk: "Medium" }, "Run migration locally"], tests: ["migration applies"] },
      { title: "Webhooks", steps: [{ action: "Handle stripe events", file: "api/webhooks.ts", depends_on: "Phase 1" }] }
    ],
    risks: [{ risk: "Out-of-order events", mitigation: "idempotent updates" }, "Unmitigated risk"],
    success_criteria: ["Checkout works"]
  });
  assert.equal(plan.phases[0].steps[0].risk, "medium");
  assert.equal(plan.phases[0].steps[1].action, "Run migration locally");
  assert.equal(plan.risks.length, 2);
  const markdown = renderPlanMarkdown({ taskId: "task-1", task: "Add subscriptions", plan, recordedAt: "2026-01-01T00:00:00.000Z" });
  assert.match(markdown, /# Implementation Plan: Add subscriptions/);
  assert.match(markdown, /### Phase 1: schema/);
  assert.match(markdown, /### Phase 2: Webhooks/);
  assert.match(markdown, /1\. \*\*Add migration\*\* \(File: `db\/001\.sql`\)\n   - Why: store tier\n   - Dependencies: None\n   - Risk: Medium/);
  assert.match(markdown, /- \*\*Out-of-order events\*\* → idempotent updates/);
  assert.match(markdown, /- \[ \] Checkout works/);
  assert.ok(planTemplate("Do X").phases.length >= 1);
});

test("writeTaskPlan persists md+json and the task lifecycle enforces the plan criterion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-plans-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TaskStore({ stateRoot: path.join(root, "state") });
  const record = await store.begin({
    task: "Migrate the production payment database to the new schema across all services",
    project: { project_name: "fixture", project_path: root, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" },
    context: { selected_files: new Array(10).fill({ path: "x" }) }
  });
  assert.equal(record.plan_policy.plan_required, true);
  assert.equal(record.plan, null);
  const criterion = record.acceptance_criteria.find((item) => item.text === PLAN_CRITERION_TEXT);
  assert.ok(criterion, "plan criterion added");

  const warned = withPlanGateWarning(record, ["src/a.js"]);
  assert.match(warned.plan_warning, /requires a recorded plan/);
  assert.equal(withPlanGateWarning(record, []).plan_warning, undefined);

  const written = await writeTaskPlan({
    projectRoot: root,
    taskId: record.id,
    task: record.task,
    plan: { overview: "Move to the new schema.", phases: [{ title: "Phase 1", steps: [{ action: "Write migration", file: "db/m.sql" }] }] }
  });
  assert.equal(written.path, `.ai-dev/plans/${record.id}.md`);
  assert.equal(written.phases, 1);
  assert.equal(written.steps, 1);
  const json = JSON.parse(await fs.readFile(path.join(root, ".ai-dev", "plans", `${record.id}.json`), "utf8"));
  assert.equal(json.task_id, record.id);
  assert.match(await fs.readFile(path.join(root, written.path), "utf8"), /Write migration/);

  const small = await store.begin({
    task: "Fix a typo",
    project: { project_name: "fixture", project_path: root, project_types: [] },
    skills: [],
    baseline: { fingerprint: "b" }
  });
  assert.equal(small.plan_policy.plan_required, false);
  assert.equal(small.acceptance_criteria.some((item) => item.text === PLAN_CRITERION_TEXT), false);
  assert.equal(withPlanGateWarning(small, ["x"]).plan_warning, undefined);
});
```

**Файл: `ai-dev-mcp-server/src/extensions/plans.mjs`** (136 строк)

```js
import {
  PLAN_CRITERION_TEXT,
  PLANS_RELATIVE_DIR,
  planTemplate,
  writeTaskPlan
} from "../core/task-plans.mjs";

/**
 * Plan gate tools: record an implementation plan for a task (phases, files,
 * tests, risks, rollback) and satisfy the plan criterion that `begin_task`
 * adds to large or high-risk tasks.
 *
 * @param {{ taskStore: { read: Function, update: Function, checkpoint: Function }, resolveProjectIdentity: Function }} host
 */
export function createPlanTools(host) {
  const stepSchema = {
    type: "object",
    properties: {
      action: { type: "string" },
      file: { type: "string" },
      why: { type: "string" },
      risk: { type: "string", enum: ["low", "medium", "high"], default: "low" },
      depends_on: { type: "string" }
    },
    required: ["action"]
  };
  return {
    definitions: [
      {
        name: "plan_task",
        description: "Record an implementation plan for a task before broad implementation: overview, requirements, phases with concrete steps (file, why, risk, dependencies), tests per phase, testing strategy, risks with mitigations, rollback, and success criteria. Writes .ai-dev/plans/<task-id>.md and marks the plan criterion met. Required for large or high-risk tasks (see plan_policy on the task).",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            overview: { type: "string", description: "2-3 sentences: what changes and why." },
            requirements: { type: "array", items: { type: "string" }, default: [] },
            phases: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  steps: { type: "array", items: stepSchema },
                  tests: { type: "array", items: { type: "string" }, default: [] }
                },
                required: ["steps"]
              }
            },
            testing_strategy: { type: "string" },
            risks: {
              type: "array",
              default: [],
              items: { type: "object", properties: { risk: { type: "string" }, mitigation: { type: "string" } }, required: ["risk"] }
            },
            rollback: { type: "string" },
            open_questions: { type: "array", items: { type: "string" }, default: [] },
            success_criteria: { type: "array", items: { type: "string" }, default: [] }
          },
          required: ["task_id", "overview", "phases"]
        }
      },
      {
        name: "plan_status",
        description: "Show the plan policy (complexity, whether a plan is required, suggested effort and model tier) and the recorded plan of a task, or a fill-in template when none exists.",
        inputSchema: {
          type: "object",
          properties: { task_id: { type: "string" } },
          required: ["task_id"]
        }
      }
    ],
    handlers: {
      async plan_task(args) {
        const record = await host.taskStore.read(args.task_id);
        if (record.status === "complete") throw new Error("Completed task cannot be planned.");
        const projectRoot = (await host.resolveProjectIdentity(record.project.path)).project_root;
        const written = await writeTaskPlan({
          projectRoot,
          taskId: record.id,
          task: record.task,
          plan: {
            overview: args.overview,
            requirements: args.requirements,
            phases: args.phases,
            testing_strategy: args.testing_strategy,
            risks: args.risks,
            rollback: args.rollback,
            open_questions: args.open_questions,
            success_criteria: args.success_criteria
          }
        });
        const { markdown, plan, ...summary } = written;
        await host.taskStore.update(record.id, (current) => {
          current.plan = summary;
          return current;
        });
        const criterion = record.acceptance_criteria.find((item) => item.text === PLAN_CRITERION_TEXT);
        const updated = await host.taskStore.checkpoint(record.id, {
          summary: `Implementation plan recorded (${summary.phases} phase(s), ${summary.steps} step(s)).`,
          changedFiles: [summary.path, summary.json_path],
          criteria: criterion ? [{ id: criterion.id, status: "met", note: "Plan recorded with plan_task.", evidence: [summary.path] }] : [],
          notes: `Plan: ${summary.path}`
        });
        return {
          action: "plan_recorded",
          task_id: record.id,
          plan: summary,
          normalized_plan: plan,
          markdown,
          plan_policy: updated.plan_policy,
          acceptance_criteria: updated.acceptance_criteria,
          next_step: `Implement ${plan.phases[0].title} first, checkpoint_task after each phase, and re-run plan_task if the plan changes materially.`
        };
      },
      async plan_status(args) {
        const record = await host.taskStore.read(args.task_id);
        return {
          task_id: record.id,
          status: record.status,
          risk: record.risk,
          plan_policy: record.plan_policy ?? null,
          plan: record.plan ?? null,
          plans_dir: PLANS_RELATIVE_DIR,
          template: record.plan ? null : planTemplate(record.task),
          next_step: record.plan
            ? "Plan recorded; keep checkpoints aligned with its phases."
            : record.plan_policy?.plan_required
              ? "Plan required: fill the template and call plan_task before broad implementation."
              : "Plan optional for this task; record one if the scope grows."
        };
      }
    },
    readOnly: ["plan_status"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/plans.test.mjs`** (59 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLAN_CRITERION_TEXT } from "../core/task-plans.mjs";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createPlanTools } from "./plans.mjs";

test("plan tools record a plan, satisfy the plan criterion, and report status", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createPlanTools]);
  const task = await taskStore.begin({
    task: "Migrate production billing to the new payment provider across all services",
    project: { project_name: "fixture", project_path: projectRoot, project_types: ["api"] },
    skills: [],
    baseline: { fingerprint: "a" }
  });
  assert.equal(task.plan_policy.plan_required, true);

  const status = await registry.handlers.get("plan_status")({ task_id: task.id });
  assert.equal(status.plan, null);
  assert.ok(status.template.phases.length >= 1);
  assert.match(status.next_step, /Plan required/);

  const recorded = await registry.handlers.get("plan_task")({
    task_id: task.id,
    overview: "Swap the provider behind the billing facade.",
    phases: [
      { title: "Phase 1: adapter", steps: [{ action: "Add provider adapter", file: "src/billing/provider.ts", risk: "medium" }], tests: ["adapter contract test"] },
      { title: "Phase 2: cutover", steps: [{ action: "Switch facade to the adapter", file: "src/billing/index.ts", depends_on: "Phase 1", risk: "high" }] }
    ],
    risks: [{ risk: "Double charges during cutover", mitigation: "idempotency keys" }],
    rollback: "Feature flag back to the old provider."
  });
  assert.equal(recorded.action, "plan_recorded");
  assert.equal(recorded.plan.phases, 2);
  assert.match(recorded.markdown, /Phase 2: cutover/);
  const criterion = recorded.acceptance_criteria.find((item) => item.text === PLAN_CRITERION_TEXT);
  assert.equal(criterion.status, "met");
  assert.deepEqual(criterion.evidence, [`.ai-dev/plans/${task.id}.md`]);

  const after = await registry.handlers.get("plan_status")({ task_id: task.id });
  assert.equal(after.plan.steps, 2);
  assert.equal(after.template, null);
  const stored = await taskStore.read(task.id);
  assert.equal(stored.plan.path, `.ai-dev/plans/${task.id}.md`);
  assert.equal(stored.checkpoints.length, 1);
  await assert.rejects(registry.handlers.get("plan_task")({ task_id: task.id, overview: "x", phases: [] }), /At least one phase/);
});
```

## Изменения существующих файлов

```diff
diff --git a/ai-dev-mcp-server/src/core/task-lifecycle.mjs b/ai-dev-mcp-server/src/core/task-lifecycle.mjs
index 021bbae..473d4cd 100644
--- a/ai-dev-mcp-server/src/core/task-lifecycle.mjs
+++ b/ai-dev-mcp-server/src/core/task-lifecycle.mjs
@@ -3,6 +3,7 @@ import fs from "node:fs/promises";
 import path from "node:path";
 import { atomicWriteJson } from "./atomic-files.mjs";
 import { taskRequestsDiagram, taskRequiresFrontendProductWorkflow } from "./skill-router.mjs";
+import { PLAN_CRITERION_TEXT, classifyTaskComplexity } from "./task-plans.mjs";
 
 const TASK_ID = /^task-\d{8}T\d{6}-[a-f0-9]{8}$/;
 
@@ -91,6 +92,14 @@ export class TaskStore {
     if (!project?.project_path) throw new Error("project.project_path is required.");
     const createdAt = now();
     const id = taskId(task, project.project_path);
+    const risk = riskFor(task, project.project_types || []);
+    const planPolicy = classifyTaskComplexity({
+      task,
+      risk,
+      projectTypes: project.project_types || [],
+      selectedFiles: context?.selected_files || [],
+      acceptanceCriteria
+    });
     const record = {
       schema_version: 1,
       id,
@@ -108,8 +117,13 @@ export class TaskStore {
         stack: project.stack || [],
         components: project.components || []
       },
-      risk: riskFor(task, project.project_types || []),
-      acceptance_criteria: normalizeCriteria(task, project.project_types || [], acceptanceCriteria),
+      risk,
+      plan_policy: planPolicy,
+      plan: null,
+      acceptance_criteria: normalizeCriteria(task, project.project_types || [], [
+        ...acceptanceCriteria,
+        ...(planPolicy.plan_required ? [PLAN_CRITERION_TEXT] : [])
+      ]),
       skills: skills || [],
       context,
       baseline,
```

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index a0696b0..4963167 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -53,6 +53,7 @@ import {
 } from "./core/context-compiler.mjs";
 import { loadContextExtras } from "./core/context-extras.mjs";
 import { verifyChangeHygiene } from "./core/change-hygiene.mjs";
+import { withPlanGateWarning } from "./core/task-plans.mjs";
 import {
   DIAGRAM_REQUEST_PATTERN,
   prioritizeRoutedRecommendations,
@@ -8457,12 +8458,12 @@ async function checkpointTask({
   criteria = [],
   notes = ""
 }) {
-  return taskStore.checkpoint(task_id, {
+  return withPlanGateWarning(await taskStore.checkpoint(task_id, {
     summary,
     changedFiles: changed_files,
     criteria,
     notes
-  });
+  }), changed_files);
 }
 
 function verificationPassed(checks) {
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index 510d4ac..3fd7374 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -22,6 +22,7 @@
 
 import { createDecisionTools } from "./extensions/decisions.mjs";
 import { createHygieneTools } from "./extensions/hygiene.mjs";
+import { createPlanTools } from "./extensions/plans.mjs";
 import { createRulesTools } from "./extensions/rules.mjs";
 import { createUsageTools } from "./extensions/usage.mjs";
 import { createWorktreeTools } from "./extensions/worktrees.mjs";
@@ -29,6 +30,7 @@ import { createWorktreeTools } from "./extensions/worktrees.mjs";
 export const EXTENSION_FACTORIES = [
   createDecisionTools,
   createHygieneTools,
+  createPlanTools,
   createRulesTools,
   createUsageTools,
   createWorktreeTools
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/task-plans.test.mjs src/extensions/plans.test.mjs src/core/task-lifecycle.test.mjs
node scripts/lifecycle-smoke.mjs
```

## Использование

```json
{ "tool": "plan_status", "args": { "task_id": "task-…" } }

{ "tool": "plan_task", "args": { "task_id": "task-…",
  "overview": "Move job claims to advisory locks and add retries.",
  "requirements": ["No double claims under 50 concurrent workers"],
  "phases": [
    { "title": "Phase 1: lock", "steps": [
        { "action": "Wrap claim in pg_try_advisory_xact_lock", "file": "src/jobs/claim.ts", "why": "atomic claim", "risk": "medium" } ],
      "tests": ["claim.test.ts: 50 workers, 1 claim"] },
    { "title": "Phase 2: retries", "steps": [
        { "action": "Add bounded retry with jitter", "file": "src/jobs/worker.ts", "why": "lock contention", "risk": "low", "depends_on": "Phase 1" } ],
      "tests": ["worker.test.ts: retry cap"] } ],
  "testing_strategy": "unit + integration against Postgres in CI",
  "risks": [{ "risk": "lock held across await", "mitigation": "single transaction scope" }],
  "rollback": "revert claim.ts; no schema change",
  "success_criteria": ["no duplicate claims in soak test"] } }
```

## Для Argentum

Воркспейс может показывать `plan_policy` сразу после создания задачи и не запускать «большую»
сессию `claude -p`, пока план не записан — это ровно тот gate, который ECC делает руками через
`/plan`.

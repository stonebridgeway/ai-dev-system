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

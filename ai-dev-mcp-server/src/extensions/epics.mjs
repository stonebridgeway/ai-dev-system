import {
  MAX_SUBTASKS,
  epicProgress,
  normalizeSubtasks,
  renderEpicMarkdown,
  resolveSubtaskDependencies
} from "../core/task-epics.mjs";

/**
 * Epics: a task with children and an order between them.
 *
 * `decompose_task` turns one task into a parent and a set of real tasks — each
 * child goes through `begin_task`, so it gets its own routed skills, context
 * pack, acceptance criteria and plan policy, and every other tool works on it
 * unchanged. `epic_status` reads the family back and says what is ready.
 *
 * The parent is gated in `complete_task` (src/extensions/lifecycle.mjs): an
 * epic whose children are open cannot close.
 *
 * @param {{ taskStore: object, callTool: Function }} host
 */
export function createEpicTools(host) {
  return {
    definitions: [
      {
        name: "decompose_task",
        description: `Break a task into child tasks and make it their parent. Each child is opened with begin_task, so it routes its own skills, compiles its own context pack and carries its own acceptance criteria. A child may wait for siblings through depends_on, referenced by key or by 1-based position; a reference to nothing, to itself, or a ring of them is refused. At most ${MAX_SUBTASKS} children. The parent cannot be completed until every child is.`,
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The task that becomes the parent. It keeps its own criteria and history." },
            subtasks: {
              type: "array",
              description: "The children, in the order they should be worked.",
              items: {
                type: "object",
                properties: {
                  task: { type: "string", description: "What this child does, as one sentence." },
                  key: { type: "string", description: "Name other children use in depends_on. Default: its 1-based position." },
                  acceptance_criteria: { type: "array", items: { type: "string" }, default: [] },
                  depends_on: { type: "array", items: { type: "string" }, default: [], description: "Keys or positions of the siblings this child waits for." }
                },
                required: ["task"]
              }
            },
            project_path: { type: "string", description: "Where the children are opened. Default: the parent's project." }
          },
          required: ["task_id", "subtasks"]
        }
      },
      {
        name: "epic_status",
        description: "Read a parent task and its children: what each one is waiting for, how far the epic has come, and the one child to work on next. Also answers for a child, by reporting its parent's epic. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "The parent, or any of its children." }
          },
          required: ["task_id"]
        }
      }
    ],
    handlers: {
      async decompose_task(args) {
        const parent = await host.taskStore.read(args.task_id);
        if (parent.status === "complete") throw new Error("A completed task cannot be decomposed.");
        if (parent.parent_id) throw new Error(`Task ${parent.id} is already a child of ${parent.parent_id}; an epic is one level deep.`);
        const subtasks = normalizeSubtasks(args.subtasks);
        const dependencies = resolveSubtaskDependencies(subtasks);

        const idByKey = new Map();
        const created = [];
        for (const subtask of subtasks) {
          const begun = parseToolText(await host.callTool("begin_task", {
            project_path: args.project_path || parent.project.path,
            task: subtask.task,
            project_name: parent.project.name || "",
            acceptance_criteria: subtask.acceptance_criteria
          }));
          idByKey.set(subtask.key, begun.id);
          created.push({ key: subtask.key, id: begun.id, task: subtask.task });
        }
        // The links are written after every child exists, because a dependency
        // is an id and the ids only become known here.
        for (const subtask of subtasks) {
          const id = idByKey.get(subtask.key);
          await host.taskStore.update(id, (record) => {
            record.parent_id = parent.id;
            record.depends_on = (dependencies.get(subtask.key) ?? []).map((key) => idByKey.get(key));
            return record;
          });
        }
        const updatedParent = await host.taskStore.update(parent.id, (record) => {
          record.epic = { children: [...(record.epic?.children ?? []), ...created.map((child) => child.id)] };
          return record;
        });
        const progress = await readEpic(host, updatedParent);
        return {
          action: "task_decomposed",
          task_id: parent.id,
          children: created.map((child) => ({ ...child, depends_on: (dependencies.get(child.key) ?? []).map((key) => idByKey.get(key)) })),
          epic: progress,
          markdown: renderEpicMarkdown(updatedParent, progress),
          next_step: progress.next
            ? `Work ${progress.next.id} next (${progress.next.task}). The parent ${parent.id} stays open until every child is complete.`
            : `Every child is already complete; complete_task on ${parent.id} will go through.`
        };
      },
      async epic_status(args) {
        const record = await host.taskStore.read(args.task_id);
        const parent = record.parent_id ? await host.taskStore.read(record.parent_id) : record;
        const progress = await readEpic(host, parent);
        return {
          task_id: parent.id,
          task: parent.task,
          status: parent.status,
          is_epic: Boolean(parent.epic?.children?.length),
          asked_about: record.id,
          epic: progress,
          markdown: renderEpicMarkdown(parent, progress),
          next_step: nextStep(parent, progress)
        };
      }
    },
    readOnly: ["epic_status"]
  };
}

function parseToolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected tool result: ${text.slice(0, 200)}`);
  }
}

/**
 * Read a parent's children back from the store. A child the parent points at
 * and the store no longer has is reported rather than skipped: it is the one
 * way an epic can look finished without being finished.
 *
 * @param {{ taskStore: { read: Function } }} host
 * @param {object} parent
 * @returns {Promise<ReturnType<typeof epicProgress>>}
 */
export async function readEpic(host, parent) {
  const children = [];
  const missing = [];
  for (const id of parent.epic?.children ?? []) {
    try {
      children.push(await host.taskStore.read(id));
    } catch {
      missing.push(id);
    }
  }
  return epicProgress({ children, missing });
}

function nextStep(parent, progress) {
  if (!progress.total) return `${parent.id} has no children. decompose_task creates them.`;
  if (progress.deadlocked) {
    return "Every open child is waiting for a sibling that is itself waiting. Complete one of them, or open a replacement child without the dependency.";
  }
  if (progress.next) return `Work ${progress.next.id} next: ${progress.next.task}`;
  if (progress.missing.length) return `Child records are missing (${progress.missing.join(", ")}); the epic cannot be closed on evidence that is gone.`;
  return parent.status === "complete"
    ? "The epic is closed."
    : `Every child is complete. Run verify_task and complete_task on ${parent.id}.`;
}

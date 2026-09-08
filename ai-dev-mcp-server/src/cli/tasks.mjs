import { TaskStore } from "../core/task-lifecycle.mjs";
import { tasksStateRoot } from "../core/runtime-paths.mjs";
export async function run(args = []) {
  const store = new TaskStore({ stateRoot: tasksStateRoot() });
  if (args[0] === "show") { if (!args[1]) throw new Error("tasks show requires an id"); process.stdout.write(`${JSON.stringify(await store.read(args[1]), null, 2)}\n`); return; }
  const statusAt = args.indexOf("--status"); const projectAt = args.indexOf("--project");
  const tasks = await store.list({ status: statusAt >= 0 ? args[statusAt + 1] : "", projectPath: projectAt >= 0 ? args[projectAt + 1] : "", limit: 200 });
  process.stdout.write(`${JSON.stringify(tasks.map((task) => ({ id: task.id, project: task.project?.path, status: task.status, criteria: `${task.acceptance_criteria.filter((item) => item.status === "met").length}/${task.acceptance_criteria.length}`, updated_at: task.updated_at })), null, 2)}\n`);
}

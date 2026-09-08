import { createRuntimeContext } from "./runtime-context.mjs";

export { createRuntimeContext };

export function createServices({ context, legacyTools, legacyCallTool }) {
  const handlers = new Map(legacyTools.map(({ name }) => [
    name,
    (args) => legacyCallTool(name, args)
  ]));

  return Object.freeze({
    context,
    handlers,
    domains: Object.freeze({
      search: "services/search.mjs",
      system: "services/system-ops.mjs",
      project: "services/project.mjs",
      frontend: "services/frontend-product.mjs",
      lifecycle: "services/task-lifecycle.mjs",
      routing: "services/skill-routing.mjs"
    })
  });
}

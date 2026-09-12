/**
 * Extension registry for MCP tools that live outside `mcp-stdio.mjs`.
 *
 * `mcp-stdio.mjs` is capped by the static quality gate, so new capabilities are
 * added as extension modules under `src/extensions/`. Each
 * module exports a factory `createXxxTools(host)` that returns:
 *
 * ```js
 * {
 *   definitions: [{ name, description, inputSchema }],   // MCP tool contracts
 *   handlers: { [name]: async (args) => result },         // one handler per tool
 *   readOnly: ["tool_name"]                               // optional readOnlyHint list
 * }
 * ```
 *
 * The `host` object is built once by `mcp-stdio.mjs` and gives extensions
 * access to shared runtime services (task store, project identity, project
 * file helpers, knowledge writers, `callTool` for composing existing tools).
 * Extensions must not import `mcp-stdio.mjs` directly: that would create an
 * import cycle and couple pure logic to the vault.
 */

import { createCoverageTools } from "./extensions/coverage.mjs";
import { createDecisionTools } from "./extensions/decisions.mjs";
import { createEpicTools } from "./extensions/epics.mjs";
import { createFrontendDesignTools } from "./extensions/frontend-design.mjs";
import { createFrontendQaTools } from "./extensions/frontend-qa.mjs";
import { createHookTools } from "./extensions/hooks.mjs";
import { createHygieneTools } from "./extensions/hygiene.mjs";
import { createInstinctTools } from "./extensions/instincts.mjs";
import { createLifecycleTools } from "./extensions/lifecycle.mjs";
import { createMcpInventoryTools } from "./extensions/mcp-inventory.mjs";
import { createPlanTools } from "./extensions/plans.mjs";
import { createProjectTools } from "./extensions/projects.mjs";
import { createPullRequestTools } from "./extensions/pull-requests.mjs";
import { createRulesTools } from "./extensions/rules.mjs";
import { createSearchTools } from "./extensions/search.mjs";
import { createSecurityTools } from "./extensions/security.mjs";
import { createSessionTools } from "./extensions/sessions.mjs";
import { createSkillTools } from "./extensions/skills.mjs";
import { createSnapshotTools } from "./extensions/snapshots.mjs";
import { createStateTools } from "./extensions/state.mjs";
import { createSystemTools } from "./extensions/system.mjs";
import { createUsageTools } from "./extensions/usage.mjs";
import { createWorktreeTools } from "./extensions/worktrees.mjs";

export const EXTENSION_FACTORIES = [
  createCoverageTools,
  createDecisionTools,
  createEpicTools,
  createFrontendDesignTools,
  createFrontendQaTools,
  createHookTools,
  createHygieneTools,
  createInstinctTools,
  createLifecycleTools,
  createMcpInventoryTools,
  createPlanTools,
  createProjectTools,
  createPullRequestTools,
  createRulesTools,
  createSearchTools,
  createSecurityTools,
  createSessionTools,
  createSkillTools,
  createSnapshotTools,
  createStateTools,
  createSystemTools,
  createUsageTools,
  createWorktreeTools
];

/**
 * Compose every registered extension into one definitions list plus a handler
 * map. Duplicate tool names and missing handlers fail fast at startup so a
 * broken extension never reaches an MCP client.
 *
 * @param {object} host - Shared runtime services from `mcp-stdio.mjs`.
 * @param {Array<(host: object) => { definitions?: object[], handlers?: Record<string, Function>, readOnly?: string[] }>} [factories]
 * @returns {{ definitions: object[], handlers: Map<string, Function>, readOnly: string[] }}
 */
export function createExtensionTools(host, factories = EXTENSION_FACTORIES) {
  const definitions = [];
  const handlers = new Map();
  const readOnly = new Set();
  for (const factory of factories) {
    if (typeof factory !== "function") throw new Error("Extension factory must be a function.");
    const extension = factory(host) ?? {};
    for (const definition of extension.definitions ?? []) {
      const name = String(definition?.name || "");
      if (!name) throw new Error("Extension tool definition has no name.");
      if (handlers.has(name)) throw new Error(`Duplicate extension tool: ${name}`);
      const handler = extension.handlers?.[name];
      if (typeof handler !== "function") throw new Error(`Extension tool has no handler: ${name}`);
      if (definition.inputSchema?.type !== "object") {
        throw new Error(`Extension tool inputSchema must be an object schema: ${name}`);
      }
      definitions.push(definition);
      handlers.set(name, handler);
    }
    for (const name of extension.readOnly ?? []) {
      if (!handlers.has(name)) throw new Error(`readOnly names an unknown extension tool: ${name}`);
      readOnly.add(name);
    }
  }
  return { definitions, handlers, readOnly: [...readOnly] };
}

import { POLICY_RELATIVE_PATH } from "../core/agent-hooks.mjs";
import { RATE_TABLE, mergeRateTable } from "../core/usage-ledger.mjs";

/**
 * Usage ledger tools: clients report model usage per turn/task, the
 * `cost-capture` hook records what a session spent straight from the
 * transcript, and `usage_report` aggregates both together with the
 * automatically recorded MCP tool-call telemetry.
 *
 * @param {{ usageLedger: import("../core/usage-ledger.mjs").UsageLedger, resolveProjectIdentity: Function, taskStore: { read: Function }, readProjectTextIfExists: Function }} host
 */
export function createUsageTools(host) {
  async function scope({ project_path = "", task_id = "" }) {
    if (task_id) {
      const record = await host.taskStore.read(task_id);
      return { taskId: task_id, projectPath: record.project.path };
    }
    if (project_path) {
      return { taskId: "", projectPath: (await host.resolveProjectIdentity(project_path)).project_root };
    }
    return { taskId: "", projectPath: "" };
  }

  /**
   * Published prices, with this project's `.ai-dev/policy.json` overrides on
   * top. Prices move; a project should not have to wait for a release to price
   * its own usage correctly.
   */
  async function rateTableFor(projectPath) {
    if (!projectPath) return { table: RATE_TABLE, overrides: [], rejected: [], policy_path: null };
    const text = await host.readProjectTextIfExists(projectPath, POLICY_RELATIVE_PATH);
    let policy = null;
    if (text) {
      try {
        policy = JSON.parse(text);
      } catch {
        return { table: RATE_TABLE, overrides: [], rejected: [], policy_path: POLICY_RELATIVE_PATH, warning: `${POLICY_RELATIVE_PATH} is not valid JSON; published prices were used.` };
      }
    }
    const merged = mergeRateTable(policy?.model_rates, RATE_TABLE);
    return { table: merged.table, overrides: merged.applied, rejected: merged.rejected, policy_path: policy ? POLICY_RELATIVE_PATH : null };
  }

  return {
    definitions: [
      {
        name: "record_usage",
        description: "Record model usage reported by the client for a turn, task, or session (tokens, cache, cost, duration). The MCP server never sees tokens itself; a session runner or the agent posts them here so cost per task becomes visible. Give at least one of input_tokens, output_tokens or cost_usd — there is nothing to record otherwise.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            project_path: { type: "string" },
            session_id: { type: "string" },
            model: { type: "string" },
            input_tokens: { type: "number" },
            output_tokens: { type: "number" },
            cache_read_tokens: { type: "number" },
            cache_creation_tokens: { type: "number" },
            cost_usd: { type: "number" },
            duration_ms: { type: "number" },
            turns: { type: "number" },
            source: { type: "string", description: "Who reported it: client, session-runner, manual.", default: "client" },
            note: { type: "string" }
          }
        }
      },
      {
        name: "usage_report",
        description: "Aggregate recorded tool calls and model usage: per-tool call counts, failure rates and latency, per-task tokens and cost, per-model totals, and the today / yesterday / last-seven-days slices. Cost is what the client reported where it reported one, and an estimate from the published rate table (overridable per project in .ai-dev/policy.json) everywhere else. Models the price page no longer lists are priced from what it said while they were current: their cost stays in every total, usage.historical_cost_usd says how much of it that is, and they are reported under historical_models rather than models unless include_historical_models is set. Filter by project, task, or start time.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            since: { type: "string", description: "ISO timestamp lower bound, for example 2026-09-01T00:00:00Z." },
            limit_tools: { type: "number", default: 15 },
            include_historical_models: { type: "boolean", default: false, description: "Fold retired models back into the per-model breakdown. Their prices come from a page that no longer lists them and nothing re-verifies them, so by default they are reported separately." }
          }
        }
      }
    ],
    handlers: {
      async record_usage(args) {
        const scoped = await scope(args);
        const event = await host.usageLedger.recordUsage({
          model: args.model,
          inputTokens: args.input_tokens,
          outputTokens: args.output_tokens,
          cacheReadTokens: args.cache_read_tokens,
          cacheCreationTokens: args.cache_creation_tokens,
          costUsd: args.cost_usd,
          durationMs: args.duration_ms,
          turns: args.turns,
          taskId: scoped.taskId,
          projectPath: scoped.projectPath,
          sessionId: args.session_id,
          source: args.source,
          note: args.note
        });
        return { action: "usage_recorded", event, ledger_path: host.usageLedger.filePath };
      },
      async usage_report(args) {
        const scoped = await scope(args);
        const { table, ...rateInfo } = await rateTableFor(scoped.projectPath);
        const report = await host.usageLedger.report({
          projectPath: scoped.projectPath,
          taskId: scoped.taskId,
          since: args.since,
          limitTools: args.limit_tools,
          includeHistoricalModels: Boolean(args.include_historical_models),
          rates: table
        });
        return { ...report, rates: { ...report.rates, ...rateInfo } };
      }
    },
    readOnly: ["usage_report"]
  };
}

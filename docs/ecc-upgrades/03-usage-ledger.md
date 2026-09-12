# 03. Учёт вызовов инструментов и стоимости

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** 01.

## Идея из ECC

ECC ведёт cost tracking и tool telemetry (команда `/cost`, счётчики в session-end). У MCP-сервера
нет доступа к токенам модели, зато он видит каждый вызов инструмента. Апгрейд добавляет
JSONL-журнал `~/.ai-dev/state/usage/events.jsonl`:

- `server.mjs` автоматически пишет запись на каждый вызов (инструмент, успех, длительность,
  подсказки `task_id`/`project_path` из аргументов);
- `record_usage` принимает токены/стоимость от клиента или раннера;
- `usage_report` агрегирует: по инструментам (число, доля ошибок, средняя латентность), по задачам
  (токены, USD), по моделям;
- журнал самоограничивается по размеру (`maxBytes`, `keepLines`).

## Новые файлы

**Файл: `ai-dev-mcp-server/src/core/usage-ledger.mjs`** (226 строк)

```js
import fs from "node:fs/promises";
import path from "node:path";
import { atomicAppendFile, atomicWriteFile } from "./atomic-files.mjs";

export const USAGE_EVENT_KINDS = ["tool_call", "usage"];
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const KEEP_LINES_AFTER_PRUNE = 20_000;

function now() {
  return new Date().toISOString();
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

/**
 * Append-only JSONL ledger of MCP tool calls and client-reported model usage
 * (`~/.ai-dev/state/usage/events.jsonl`). The MCP server cannot see model
 * tokens itself; the client (or an orchestrator such as a session runner) posts
 * them through `record_usage`, while tool calls are recorded by the tool
 * dispatcher (`callTool` in `mcp-stdio.mjs`) whichever caller invoked it: the
 * MCP transport, the CLI, a smoke script, or a tool composed from other tools.
 */
export class UsageLedger {
  constructor({ stateRoot, maxBytes = MAX_LEDGER_BYTES, keepLines = KEEP_LINES_AFTER_PRUNE }) {
    this.stateRoot = path.resolve(stateRoot);
    this.filePath = path.join(this.stateRoot, "usage", "events.jsonl");
    this.maxBytes = maxBytes;
    this.keepLines = Math.max(1, Number(keepLines) || KEEP_LINES_AFTER_PRUNE);
    this.queue = Promise.resolve();
  }

  async append(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await atomicAppendFile(this.filePath, line, "utf8");
        await this.pruneIfNeeded();
      });
    await this.queue;
    return event;
  }

  /**
   * Wait for every queued append to reach disk. Callers that record a tool call
   * without awaiting it (the tool dispatcher) use this to settle the ledger
   * before reading it back.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await this.queue.catch(() => undefined);
  }

  async pruneIfNeeded() {
    const stats = await fs.stat(this.filePath).catch(() => null);
    if (!stats || stats.size <= this.maxBytes) return false;
    const lines = (await fs.readFile(this.filePath, "utf8")).split("\n").filter(Boolean);
    const kept = lines.slice(-this.keepLines);
    await atomicWriteFile(this.filePath, `${kept.join("\n")}\n`, "utf8");
    return true;
  }

  /**
   * Record one MCP tool invocation (name, duration, outcome, task/project hints).
   *
   * @param {{ tool: string, ok: boolean, durationMs: number, taskId?: string, projectPath?: string, error?: string, client?: string }} input
   */
  async recordToolCall({ tool, ok, durationMs, taskId = "", projectPath = "", error = "", client = "" }) {
    return this.append({
      at: now(),
      kind: "tool_call",
      tool: String(tool || ""),
      ok: Boolean(ok),
      duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
      task_id: String(taskId || ""),
      project_path: String(projectPath || ""),
      error: String(error || "").slice(0, 300),
      client: String(client || "")
    });
  }

  /**
   * Record model usage reported by the client for a turn, task, or session.
   *
   * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number, costUsd?: number, durationMs?: number, turns?: number, taskId?: string, projectPath?: string, sessionId?: string, source?: string, note?: string }} input
   */
  async recordUsage(input = {}) {
    const inputTokens = finiteOrNull(input.inputTokens);
    const outputTokens = finiteOrNull(input.outputTokens);
    if (inputTokens === null && outputTokens === null && finiteOrNull(input.costUsd) === null) {
      throw new Error("record_usage needs input_tokens, output_tokens, or cost_usd.");
    }
    return this.append({
      at: now(),
      kind: "usage",
      model: String(input.model || "unknown"),
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
      cache_read_tokens: finiteOrNull(input.cacheReadTokens) ?? 0,
      cache_creation_tokens: finiteOrNull(input.cacheCreationTokens) ?? 0,
      cost_usd: finiteOrNull(input.costUsd) ?? 0,
      duration_ms: Math.max(0, Math.round(finiteOrNull(input.durationMs) ?? 0)),
      turns: Math.max(0, Math.round(finiteOrNull(input.turns) ?? 0)),
      task_id: String(input.taskId || ""),
      project_path: String(input.projectPath || ""),
      session_id: String(input.sessionId || ""),
      source: String(input.source || "client"),
      note: String(input.note || "").slice(0, 300)
    });
  }

  async readEvents() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return text.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Aggregate the ledger: per-tool call counts, failures, and latency; per-task
   * token and cost totals; and overall model usage, optionally filtered by
   * project path, task id, or a start timestamp.
   *
   * @param {{ projectPath?: string, taskId?: string, since?: string, limitTools?: number }} [filter]
   * @returns {Promise<object>} Report.
   */
  async report({ projectPath = "", taskId = "", since = "", limitTools = 15 } = {}) {
    const events = (await this.readEvents()).filter((event) => {
      if (taskId && event.task_id !== taskId) return false;
      if (projectPath && event.project_path && path.resolve(event.project_path) !== path.resolve(projectPath)) return false;
      if (projectPath && !event.project_path && !taskId) return false;
      if (since && String(event.at || "") < since) return false;
      return true;
    });
    const tools = new Map();
    const tasks = new Map();
    const usage = { events: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, duration_ms: 0, turns: 0 };
    const models = new Map();
    for (const event of events) {
      if (event.kind === "tool_call") {
        const entry = tools.get(event.tool) ?? { tool: event.tool, calls: 0, failures: 0, total_ms: 0, max_ms: 0 };
        entry.calls += 1;
        if (!event.ok) entry.failures += 1;
        entry.total_ms += Number(event.duration_ms) || 0;
        entry.max_ms = Math.max(entry.max_ms, Number(event.duration_ms) || 0);
        tools.set(event.tool, entry);
        if (event.task_id) {
          const task = tasks.get(event.task_id) ?? { task_id: event.task_id, tool_calls: 0, tool_failures: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
          task.tool_calls += 1;
          if (!event.ok) task.tool_failures += 1;
          tasks.set(event.task_id, task);
        }
      } else if (event.kind === "usage") {
        usage.events += 1;
        for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "duration_ms", "turns"]) {
          usage[key] += Number(event[key]) || 0;
        }
        const model = models.get(event.model) ?? { model: event.model, events: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        model.events += 1;
        model.input_tokens += Number(event.input_tokens) || 0;
        model.output_tokens += Number(event.output_tokens) || 0;
        model.cost_usd += Number(event.cost_usd) || 0;
        models.set(event.model, model);
        if (event.task_id) {
          const task = tasks.get(event.task_id) ?? { task_id: event.task_id, tool_calls: 0, tool_failures: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
          task.input_tokens += Number(event.input_tokens) || 0;
          task.output_tokens += Number(event.output_tokens) || 0;
          task.cost_usd += Number(event.cost_usd) || 0;
          tasks.set(event.task_id, task);
        }
      }
    }
    const toolRows = [...tools.values()]
      .map((item) => ({
        ...item,
        average_ms: item.calls ? Math.round(item.total_ms / item.calls) : 0,
        failure_rate: item.calls ? round(item.failures / item.calls, 4) : 0
      }))
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool))
      .slice(0, Math.max(1, Math.min(Number(limitTools) || 15, 200)));
    return {
      ledger_path: this.filePath,
      events: events.length,
      filter: { project_path: projectPath || null, task_id: taskId || null, since: since || null },
      tool_calls: events.filter((event) => event.kind === "tool_call").length,
      tools: toolRows,
      slowest_tools: [...tools.values()].sort((left, right) => right.max_ms - left.max_ms).slice(0, 5).map((item) => ({ tool: item.tool, max_ms: item.max_ms })),
      usage: { ...usage, cost_usd: round(usage.cost_usd, 4) },
      models: [...models.values()].map((item) => ({ ...item, cost_usd: round(item.cost_usd, 4) })),
      tasks: [...tasks.values()].map((item) => ({ ...item, cost_usd: round(item.cost_usd, 4) }))
        .sort((left, right) => right.cost_usd - left.cost_usd || right.tool_calls - left.tool_calls)
        .slice(0, 50)
    };
  }
}

/**
 * Pull the task id / project path hints out of tool arguments without storing
 * anything else from the call.
 *
 * @param {Record<string, unknown>} args
 * @returns {{ taskId: string, projectPath: string }}
 */
export function usageHintsFromArgs(args = {}) {
  return {
    taskId: typeof args?.task_id === "string" ? args.task_id : "",
    projectPath: typeof args?.project_path === "string" ? args.project_path : ""
  };
}
```

**Файл: `ai-dev-mcp-server/src/core/usage-ledger.test.mjs`** (61 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger, usageHintsFromArgs } from "./usage-ledger.mjs";

test("usage ledger records tool calls and usage, then aggregates a report", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot });
  const project = path.join(stateRoot, "project");

  await ledger.recordToolCall({ tool: "begin_task", ok: true, durationMs: 120, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "verify_task", ok: false, durationMs: 900, taskId: "task-1", projectPath: project, error: "quality gate failed" });
  await ledger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 300, taskId: "task-1", projectPath: project });
  await ledger.recordToolCall({ tool: "search_knowledge", ok: true, durationMs: 10 });
  await ledger.recordUsage({ model: "claude-opus-5", inputTokens: 1000, outputTokens: 200, costUsd: 0.05, taskId: "task-1", projectPath: project, turns: 3 });
  await ledger.recordUsage({ model: "claude-sonnet-5", inputTokens: 500, outputTokens: 50, costUsd: 0.01, taskId: "task-2", projectPath: project });
  await assert.rejects(ledger.recordUsage({ model: "x" }), /needs input_tokens/);

  const all = await ledger.report();
  assert.equal(all.events, 6);
  assert.equal(all.tool_calls, 4);
  assert.equal(all.tools[0].tool, "verify_task");
  assert.equal(all.tools[0].failures, 1);
  assert.equal(all.tools[0].failure_rate, 0.5);
  assert.equal(all.tools[0].average_ms, 600);
  assert.equal(all.slowest_tools[0].tool, "verify_task");
  assert.equal(all.usage.input_tokens, 1500);
  assert.equal(all.usage.cost_usd, 0.06);
  assert.equal(all.models.length, 2);

  const task = await ledger.report({ taskId: "task-1" });
  assert.equal(task.events, 4);
  assert.equal(task.tasks[0].tool_calls, 3);
  assert.equal(task.tasks[0].cost_usd, 0.05);

  const scoped = await ledger.report({ projectPath: project });
  assert.equal(scoped.events, 5, "events without a project path are excluded from a project report");

  const future = await ledger.report({ since: "2999-01-01T00:00:00.000Z" });
  assert.equal(future.events, 0);
  assert.deepEqual(usageHintsFromArgs({ task_id: "t", project_path: "/p", other: 1 }), { taskId: "t", projectPath: "/p" });
  assert.deepEqual(usageHintsFromArgs({ task_id: 5 }), { taskId: "", projectPath: "" });
});

test("usage ledger prunes to the newest lines when the file grows past the cap", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-ledger-prune-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const ledger = new UsageLedger({ stateRoot, maxBytes: 600, keepLines: 5 });
  for (let index = 0; index < 12; index += 1) {
    await ledger.recordToolCall({ tool: `tool_${index}`, ok: true, durationMs: index });
  }
  const events = await ledger.readEvents();
  assert.ok(events.length <= 6 && events.length >= 1, `unexpected ${events.length} events after prune`);
  assert.equal(events.at(-1).tool, "tool_11");
  await fs.writeFile(ledger.filePath, "not json\n{\"kind\":\"tool_call\",\"tool\":\"kept\",\"ok\":true,\"at\":\"2026-01-01T00:00:00.000Z\"}\n");
  const report = await ledger.report();
  assert.equal(report.events, 1);
});
```

**Файл: `ai-dev-mcp-server/src/extensions/usage.mjs`** (90 строк)

```js
/**
 * Usage ledger tools: clients report model usage per turn/task, and
 * `usage_report` aggregates it together with the automatically recorded MCP
 * tool-call telemetry.
 *
 * @param {{ usageLedger: import("../core/usage-ledger.mjs").UsageLedger, resolveProjectIdentity: Function, taskStore: { read: Function } }} host
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

  return {
    definitions: [
      {
        name: "record_usage",
        description: "Record model usage reported by the client for a turn, task, or session (tokens, cache, cost, duration). The MCP server never sees tokens itself; a session runner or the agent posts them here so cost per task becomes visible.",
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
        description: "Aggregate recorded tool calls and model usage: per-tool call counts, failure rates and latency, per-task tokens and cost, and per-model totals. Filter by project, task, or start time.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: { type: "string" },
            task_id: { type: "string" },
            since: { type: "string", description: "ISO timestamp lower bound, for example 2026-09-01T00:00:00Z." },
            limit_tools: { type: "number", default: 15 }
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
        return host.usageLedger.report({
          projectPath: scoped.projectPath,
          taskId: scoped.taskId,
          since: args.since,
          limitTools: args.limit_tools
        });
      }
    },
    readOnly: ["usage_report"]
  };
}
```

**Файл: `ai-dev-mcp-server/src/extensions/usage.test.mjs`** (48 строк)

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../core/task-lifecycle.mjs";
import { UsageLedger } from "../core/usage-ledger.mjs";
import { createExtensionTools } from "../tool-extensions.mjs";
import { createUsageTools } from "./usage.mjs";

test("usage tools scope reports by task and project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const taskStore = new TaskStore({ stateRoot: path.join(root, "state") });
  const usageLedger = new UsageLedger({ stateRoot: path.join(root, "state") });
  const host = {
    taskStore,
    usageLedger,
    resolveProjectIdentity: async (projectPath) => ({ project_root: projectPath, project_id: "project-test" })
  };
  const registry = createExtensionTools(host, [createUsageTools]);
  const task = await taskStore.begin({
    task: "Measure cost",
    project: { project_name: "fixture", project_path: projectRoot },
    skills: [],
    baseline: { fingerprint: "a" }
  });

  const recorded = await registry.handlers.get("record_usage")({
    task_id: task.id,
    model: "claude-opus-5",
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: 0.07,
    source: "session-runner"
  });
  assert.equal(recorded.event.project_path, projectRoot);
  await usageLedger.recordToolCall({ tool: "verify_task", ok: true, durationMs: 50, taskId: task.id, projectPath: projectRoot });

  const byTask = await registry.handlers.get("usage_report")({ task_id: task.id });
  assert.equal(byTask.events, 2);
  assert.equal(byTask.tasks[0].cost_usd, 0.07);
  const byProject = await registry.handlers.get("usage_report")({ project_path: projectRoot });
  assert.equal(byProject.events, 2);
  await assert.rejects(registry.handlers.get("record_usage")({ model: "x" }), /needs input_tokens/);
});
```

## Изменения существующих файлов

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index af8803e..8374428 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -85,6 +85,7 @@ import {
   captureProjectState
 } from "./core/evidence.mjs";
 import { TaskStore } from "./core/task-lifecycle.mjs";
+import { UsageLedger } from "./core/usage-ledger.mjs";
 import {
   applySkillOutcome,
   SkillOutcomeStore
@@ -260,6 +261,7 @@ const taskStateRoot = path.resolve(
 const taskStore = new TaskStore({ stateRoot: taskStateRoot });
 const skillOutcomeStore = new SkillOutcomeStore({ stateRoot: taskStateRoot });
 const pilotStore = new PilotStore({ stateRoot: taskStateRoot });
+const usageLedger = new UsageLedger({ stateRoot: taskStateRoot });
 const bgeM3EmbedCliPath = path.join(embeddingsDir, "bge_m3_embed.py");
 const bgeM3WorkerCliPath = path.join(embeddingsDir, "bge_m3_worker.py");
 const defaultBgeM3ModelDir = path.resolve(
@@ -8740,7 +8742,7 @@ async function completeTask({
 // Extension tools live in src/extensions/* and receive shared runtime services
 // through this host object (see src/tool-extensions.mjs).
 const extensions = createExtensionTools({
-  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, callTool,
+  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, usageLedger, callTool,
   resolveProjectIdentity, detectProject, captureProjectState, readProjectTextIfExists,
   writeProjectFile, safeProjectFile, safeProjectRoot, writeKnowledgeNote, appendKnowledgeNote,
   markSearchIndexDirty
@@ -10413,6 +10415,7 @@ export {
   resolveTaskProjectRoot,
   shutdownBgeWorkers,
   tools,
+  usageLedger,
   vaultRoot
 };
 
```

```diff
diff --git a/ai-dev-mcp-server/src/server.mjs b/ai-dev-mcp-server/src/server.mjs
index 2738a56..96dd800 100644
--- a/ai-dev-mcp-server/src/server.mjs
+++ b/ai-dev-mcp-server/src/server.mjs
@@ -21,9 +21,11 @@ import {
   extensionReadOnlyTools,
   shutdownBgeWorkers,
   tools as legacyTools,
+  usageLedger,
   vaultRoot
 } from "./mcp-stdio.mjs";
 import { isDirectExecution } from "./core/direct-execution.mjs";
+import { usageHintsFromArgs } from "./core/usage-ledger.mjs";
 
 const serverFile = fileURLToPath(import.meta.url);
 const serverRoot = path.resolve(path.dirname(serverFile), "..");
@@ -379,16 +381,21 @@ export function createAiDevServer() {
       throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
     }
     await reportProgress(extra, 0, 1, `Starting ${name}`);
+    const startedAt = Date.now();
+    const hints = usageHintsFromArgs(args);
     try {
       const result = structuredResult(await callTool(name, args));
       await reportProgress(extra, 1, 1, `Completed ${name}`);
+      usageLedger.recordToolCall({ tool: name, ok: true, durationMs: Date.now() - startedAt, ...hints }).catch(() => undefined);
       return result;
     } catch (error) {
       await reportProgress(extra, 1, 1, `Failed ${name}`).catch(() => undefined);
+      const message = error instanceof Error ? error.message : String(error);
+      usageLedger.recordToolCall({ tool: name, ok: false, durationMs: Date.now() - startedAt, error: message, ...hints }).catch(() => undefined);
       return {
         content: [{
           type: "text",
-          text: error instanceof Error ? error.message : String(error)
+          text: message
         }],
         isError: true
       };
```

```diff
diff --git a/ai-dev-mcp-server/src/tool-extensions.mjs b/ai-dev-mcp-server/src/tool-extensions.mjs
index e861e1b..240ad05 100644
--- a/ai-dev-mcp-server/src/tool-extensions.mjs
+++ b/ai-dev-mcp-server/src/tool-extensions.mjs
@@ -21,9 +21,11 @@
  */
 
 import { createDecisionTools } from "./extensions/decisions.mjs";
+import { createUsageTools } from "./extensions/usage.mjs";
 
 export const EXTENSION_FACTORIES = [
-  createDecisionTools
+  createDecisionTools,
+  createUsageTools
 ];
 
 /**
```

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/core/usage-ledger.test.mjs src/extensions/usage.test.mjs src/server.test.mjs
```

### Обновление (пункт 2.4 плана)

Запись вызова живёт не в транспорте, а в самом диспетчере `callTool` (`src/mcp-stdio.mjs`):
`dispatchTool` выполняет инструмент, `callTool` оборачивает его и пишет событие в ledger.
Поэтому в `usage_report` попадают и вызовы мимо MCP — `scripts/ai-dev.mjs`, smoke-скрипты,
инструменты, собранные из других инструментов (`begin_task_in_worktree` → `begin_task`:
два события, по одному на каждый выполненный инструмент). `server.mjs` не пишет ничего сам,
он только передаёт свою долю времени:

```js
const startedAt = Date.now();
await reportProgress(extra, 0, 1, `Starting ${name}`);
const transportMs = Date.now() - startedAt;
const result = structuredResult(await callTool(name, args, { transportMs }));
```

Двойной записи нет по построению (один вызов — одно событие), и это закреплено тестом
в `src/server.test.mjs`: прямой вызов, вызов через транспорт и ошибка дают ровно по одному
событию каждый. `UsageLedger.flush()` ждёт незавершённые записи — запись из `callTool`
намеренно не ожидается, чтобы результат инструмента её не ждал.

## Использование

```json
{ "tool": "record_usage", "args": { "task_id": "task-…", "model": "claude-opus-5",
  "input_tokens": 41200, "output_tokens": 3900, "cache_read_tokens": 30000, "cost_usd": 0.31,
  "duration_ms": 84000, "turns": 12, "source": "argentum-runner" } }

{ "tool": "usage_report", "args": { "project_path": "/repo", "since": "2026-09-01T00:00:00Z" } }
```

### Обновление (пункт 3.15 плана, C-1 гэп-анализа)

Стоимость больше не ждёт клиента. Хук `hooks/cost-capture.mjs` (событие `Stop`, профиль
`minimal` и выше) читает `transcript_path`, суммирует `usage` сообщений ассистента, появившихся
с прошлого запуска, и дописывает в `usage/events.jsonl` по одному событию `kind: "usage"` на
модель — напрямую в файл, потому что сервер может быть в Docker. Транскрипт — JSONL и растёт
только в конец, поэтому курсором служит байтовое смещение (`usage/sessions/<session>.json`):
один и тот же ответ не оплачивается дважды, сколько бы раз ни сработал `Stop`, а транскрипт,
который стал короче, читается с начала. Записи `isSidechain` включены: субагент живёт в своём
окне контекста, но в том же счёте (поэтому `latestAssistantUsage`, отвечающий на вопрос «насколько
полон контекст», их пропускает, а этот хук — нет). Повторные `message.id` внутри одного куска
считаются один раз: один ответ API попадает в транскрипт несколькими строками с одним и тем же
`usage`.

Хук пишет токены, а не деньги. Тарифы лежат в `usage-ledger.mjs` как данные: `RATE_TABLE`
(доллары за миллион токенов по моделям), `RATE_TABLE_SOURCE` (страница цен Anthropic и дата
сверки) и множители кэша — запись 1.25×, часовая запись 2×, чтение 0.1× — которыми достраиваются
строки без собственных цен (у Claude Fable 5.1 чтение кэша 0.025×, поэтому цена указана явно).
`estimateCostUsd(usage, table)` применяется только там, где клиент не прислал `cost_usd`:
присланная стоимость — это то, что выставлено к оплате, а оценка — арифметика по прейскуранту.
Считается при чтении, а не при записи, поэтому смена цен переоценивает историю, а не замораживает
в журнале вчерашнюю ставку. Цены меняются, поэтому `model_rates` в `.ai-dev/policy.json`
переопределяет или добавляет любую строку; неизвестная модель попадает в `rates.unpriced_models`,
а не считается бесплатной.

`usage_report` к разрезам «по моделям» и «по задачам» добавляет `periods`:
`today` / `yesterday` / `last_7_days` (границы — локальная полночь, день разработчика, а не UTC),
и в каждом разрезе разделяет `reported_cost_usd` и `estimated_cost_usd`.

```json
{ "tool": "usage_report", "args": { "project_path": "/repo" } }
```

## Для Argentum

Воркспейс запускает `claude -p --output-format stream-json` и видит `usage` в финальном событии:
достаточно после каждой сессии вызвать `record_usage`, и `usage_report` станет источником для
панели затрат по проектам и задачам. Если воркспейс стоимость не считает, хватит хука: он даёт
те же события из транскрипта, а цены подставит `usage_report`.

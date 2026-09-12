# 01. Реестр расширений инструментов

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

**Зависимости:** нет. **Требуется для:** всех остальных апгрейдов с MCP-инструментами (02–07, 09–11).

## Зачем

`src/mcp-stdio.mjs` содержит определения и диспетчер всех инструментов и упирается в лимит
`scripts/static-quality.mjs` (10 500 строк; сейчас 10434). В ECC
каждая возможность (хуки, скиллы, команды) — отдельный модуль, который подключается через
манифест. Здесь то же самое: каждый новый набор инструментов — фабрика
`createXxxTools(host)` в `src/extensions/`, которая возвращает `{ definitions, handlers, readOnly }`.
`mcp-stdio.mjs` один раз собирает `host` (общие сервисы) и добавляет к своим инструментам
результат реестра. Диспетчер `callTool` получает один fallback на карту обработчиков.

Побочный эффект: расширения не импортируют `mcp-stdio.mjs`, поэтому тестируются без vault
(через stub-host), что видно по тестам в последующих апгрейдах.

## Новые файлы

**Файл: `ai-dev-mcp-server/src/tool-extensions.mjs`** (79 строк)

```js
/**
 * Extension registry for MCP tools that live outside `mcp-stdio.mjs`.
 *
 * `mcp-stdio.mjs` is capped by the static quality gate (10,500 lines), so new
 * capabilities are added as extension modules under `src/extensions/`. Each
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

import { createDecisionTools } from "./extensions/decisions.mjs";
import { createHookTools } from "./extensions/hooks.mjs";
import { createHygieneTools } from "./extensions/hygiene.mjs";
import { createInstinctTools } from "./extensions/instincts.mjs";
import { createPlanTools } from "./extensions/plans.mjs";
import { createRulesTools } from "./extensions/rules.mjs";
import { createSessionTools } from "./extensions/sessions.mjs";
import { createUsageTools } from "./extensions/usage.mjs";
import { createWorktreeTools } from "./extensions/worktrees.mjs";

export const EXTENSION_FACTORIES = [
  createDecisionTools,
  createHookTools,
  createHygieneTools,
  createInstinctTools,
  createPlanTools,
  createRulesTools,
  createSessionTools,
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
```

> В этом файле уже перечислены фабрики всех расширений из документов 02–11. Если переносите
> апгрейды выборочно, оставьте в `EXTENSION_FACTORIES` только те, что реально добавили; остальные
> импорты удалите.

**Файл: `ai-dev-mcp-server/src/tool-extensions.test.mjs`** (52 строк)

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionTools } from "./tool-extensions.mjs";

function fakeExtension(host) {
  return {
    definitions: [
      { name: "ping_extension", description: "Ping.", inputSchema: { type: "object", properties: {} } }
    ],
    handlers: {
      ping_extension: async (args) => ({ pong: true, host: host.label, args })
    },
    readOnly: ["ping_extension"]
  };
}

test("extension registry composes definitions, handlers, and read-only hints", async () => {
  const registry = createExtensionTools({ label: "test-host" }, [fakeExtension]);
  assert.deepEqual(registry.definitions.map((item) => item.name), ["ping_extension"]);
  assert.deepEqual(registry.readOnly, ["ping_extension"]);
  const result = await registry.handlers.get("ping_extension")({ value: 1 });
  assert.deepEqual(result, { pong: true, host: "test-host", args: { value: 1 } });
});

test("extension registry fails fast on duplicates, missing handlers, and bad schemas", () => {
  assert.throws(
    () => createExtensionTools({}, [fakeExtension, fakeExtension]),
    /Duplicate extension tool: ping_extension/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [{ name: "orphan", inputSchema: { type: "object" } }],
      handlers: {}
    })]),
    /has no handler: orphan/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [{ name: "bad", inputSchema: { type: "string" } }],
      handlers: { bad: async () => ({}) }
    })]),
    /must be an object schema: bad/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [],
      handlers: {},
      readOnly: ["ghost"]
    })]),
    /unknown extension tool: ghost/
  );
});
```

## Изменения существующих файлов

Diff первого коммита (только реестр, без расширений). Итоговый вид `host` со всеми полями
показан в README (сводный diff `mcp-stdio.mjs`).

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index c6d1918..46ce88d 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -141,6 +141,7 @@ import {
 } from "./core/reference-factory.mjs";
 import { buildToolDefinitions } from "./tool-definitions.mjs";
 import { autoCommands } from "./auto-commands.mjs";
+import { createExtensionTools } from "./tool-extensions.mjs";
 
 const serverDir = path.dirname(fileURLToPath(import.meta.url));
 const packageVersion = (() => {
@@ -8733,7 +8734,16 @@ async function completeTask({
   return { task: record, report, skill_outcomes: skillOutcomes };
 }
 
-const tools = buildToolDefinitions({
+// Extension tools live in src/extensions/* and receive shared runtime services
+// through this host object (see src/tool-extensions.mjs).
+const extensions = createExtensionTools({
+  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, callTool,
+  resolveProjectIdentity, detectProject, captureProjectState, readProjectTextIfExists,
+  writeProjectFile, safeProjectFile, safeProjectRoot, writeKnowledgeNote, appendKnowledgeNote,
+  markSearchIndexDirty
+});
+const extensionReadOnlyTools = extensions.readOnly;
+const tools = [...buildToolDefinitions({
   CONCEPT_JURY_DIMENSIONS,
   FRONTEND_PRODUCT_MODES,
   PILOT_DIMENSIONS,
@@ -8743,7 +8753,7 @@ const tools = buildToolDefinitions({
   REFERENCE_FACTORY_SURFACES,
   UI_UX_PRO_MAX_DOMAINS,
   UI_UX_PRO_MAX_STACKS
-});
+}), ...extensions.definitions];
 
 async function searchKnowledge({ query, limit = 10 }) {
   const files = await listMarkdownFiles(vaultRoot);
@@ -10299,6 +10309,8 @@ async function callTool(name, args) {
   if (name === "complete_task") return textContent(await completeTask(args));
   if (name === "write_knowledge_note") return textContent(await writeKnowledgeNote(args));
   if (name === "append_knowledge_note") return textContent(await appendKnowledgeNote(args));
+  const extension = extensions.handlers.get(name);
+  if (extension) return textContent(await extension(args));
   throw new Error(`Unknown tool: ${name}`);
 }
 
@@ -10394,6 +10406,7 @@ export function startLegacyServer() {
 
 export {
   callTool,
+  extensionReadOnlyTools,
   resolveTaskProjectRoot,
   shutdownBgeWorkers,
   tools,
```

```diff
diff --git a/ai-dev-mcp-server/src/server.mjs b/ai-dev-mcp-server/src/server.mjs
index f452424..2738a56 100644
--- a/ai-dev-mcp-server/src/server.mjs
+++ b/ai-dev-mcp-server/src/server.mjs
@@ -18,6 +18,7 @@ import {
 } from "@modelcontextprotocol/sdk/types.js";
 import {
   callTool,
+  extensionReadOnlyTools,
   shutdownBgeWorkers,
   tools as legacyTools,
   vaultRoot
@@ -80,6 +81,8 @@ const READ_ONLY_TOOLS = new Set([
   "archify_brands"
 ]);
 
+for (const name of extensionReadOnlyTools) READ_ONLY_TOOLS.add(name);
+
 const OPEN_WORLD_TOOLS = new Set(["import_skill_repo"]);
 
 const FIXED_RESOURCES = [
```

## Контракт `host`

Поля, которые `mcp-stdio.mjs` передаёт в фабрики (все — уже существующие функции/объекты сервера):

| Поле | Что это |
| --- | --- |
| `vaultRoot`, `taskStateRoot`, `serverRoot` | корень vault, `~/.ai-dev/state`, корень `ai-dev-mcp-server` |
| `taskStore`, `skillOutcomeStore` | существующие хранилища задач и исходов скиллов |
| `usageLedger`, `sessionStore`, `instinctStore` | новые хранилища из 03, 09, 10 |
| `callTool(name, args)` | вызов любого инструмента сервера (композиция, например `begin_task` внутри `begin_task_in_worktree`) |
| `resolveProjectIdentity`, `detectProject`, `captureProjectState` | идентичность проекта, детект стека, git-фингерпринт |
| `readProjectTextIfExists`, `writeProjectFile`, `safeProjectFile`, `safeProjectRoot` | безопасный доступ к файлам проекта (path-policy) |
| `writeKnowledgeNote`, `appendKnowledgeNote`, `markSearchIndexDirty` | запись в vault |

## Подключение

1. Добавить `src/tool-extensions.mjs` и тест.
2. Применить diff к `mcp-stdio.mjs`: импорт, объект `host`, `tools = [...buildToolDefinitions(...), ...extensions.definitions]`,
   fallback в `callTool`, экспорт `extensionReadOnlyTools`.
3. В `server.mjs` добавить read-only имена расширений в `READ_ONLY_TOOLS` (аннотация `readOnlyHint` для клиентов).

## Проверка

```bash
cd ai-dev-mcp-server
node --test src/tool-extensions.test.mjs
node scripts/static-quality.mjs
node scripts/protocol-smoke.mjs
```

## Как писать новое расширение

```js
// src/extensions/example.mjs
export function createExampleTools(host) {
  return {
    definitions: [{
      name: "example_tool",
      description: "…",
      inputSchema: { type: "object", properties: { project_path: { type: "string" } }, required: ["project_path"] }
    }],
    handlers: {
      async example_tool({ project_path }) {
        const identity = await host.resolveProjectIdentity(project_path);
        return { project_id: identity.project_id };
      }
    },
    readOnly: ["example_tool"]
  };
}
```

и одна строка в `EXTENSION_FACTORIES`. Обработчик возвращает объект; `callTool` сам оборачивает его в
`textContent`, а `server.mjs` — в `structuredContent`.

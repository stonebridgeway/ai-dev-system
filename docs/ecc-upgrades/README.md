# Апгрейды ai-dev-system по мотивам ECC (Everything Claude Code)

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

Это набор изменений для `stonebridgeway/ai-dev-system`, собранных из идей
репозитория `affaan-m/ECC` (v2.2.1) и адаптированных под архитектуру MCP-сервера
(`ai-dev-mcp-server`, Node ESM `.mjs`, `node --test`, лимит 10 500 строк на `src/mcp-stdio.mjs`,
секьюрити- и статик-гейты).

Весь код ниже **реально применён и проверен** на копии `ai-dev-system` (база: коммит `3667783`,
merge PR #7). Итог на копии:

| Проверка | Результат |
| --- | --- |
| `node --test` | 189 тестов, 182 pass, 7 skipped, 0 fail |
| `node scripts/static-quality.mjs` | pass (`mcp-stdio.mjs`: 10434 строк из 10 500) |
| `node scripts/security-check.mjs` | pass |
| `node scripts/protocol-smoke.mjs` | pass, 115 инструментов |
| `node scripts/lifecycle-smoke.mjs` | pass |
| `npm run test:coverage` (src/core) | lines 92.8 / branches 72.4 / functions 91.7 (порог 85/60/85) |

Проверялось на Node 22.22 (в контейнере не было 24). Код не использует ничего, чего нет в
Node 22, но `engines` в `package.json` не трогался: `>=24` остаётся.

## Карта кода

[CODE-MAP.md](CODE-MAP.md): куда переехал код из `src/mcp-stdio.mjs` после этапа 1. Документы
01–23 писались, когда он лежал в одном модуле, и их пути читать надо через эту таблицу.

## План развития

[PLAN.md](PLAN.md): состояние `stonebridgeway/ai-dev-system` после PR #36, сравнение с полной
реализацией в ветке `claude/ecc-upgrades` форка, этапы стабилизации, модульности сервера,
доводки перенесённого, оставшиеся идеи ECC с приоритетами и подготовка к вливанию в Argentum.

## Этап 3

Документы с номерами больше 12 описывают пункты этапа 3 плана — идеи ECC, которые
переносятся после двенадцати апгрейдов.

| № | Файл | Пункт плана | Что даёт |
| --- | --- | --- | --- |
| 13 | [13-ecc-skill-catalog.md](13-ecc-skill-catalog.md) | 3.1 | Выборочный импорт каталога скиллов ECC как `external/ecc`: четыре ворот отбора, группы исключений с цитатами разбора, `trust: known-upstream` |
| 14 | [14-pull-request-preparation.md](14-pull-request-preparation.md) | 3.16 | `prepare_pull_request`: описание PR из доказательств задачи, заполнение шаблона репозитория, секция «осталось», ссылка из `complete_task` |
| 15 | [15-completion-statement-linter.md](15-completion-statement-linter.md) | 3.17 | Линтер заявлений о завершении в `checkpoint_task` / `complete_task`: двенадцать рационализаций против сигналов проверок, waiver в `.ai-dev/policy.json`, seed-скилл `self-evaluation` |
| 16 | [16-task-snapshots.md](16-task-snapshots.md) | 3.2 | Снимки рабочего дерева задачи в `refs/ai-dev/snapshots/<task_id>/<n>` и обратимый откат: `snapshot_task`, `list_task_snapshots`, `rollback_task`, автоснимок в `checkpoint_task`, удаление в `complete_task` |
| 17 | [17-policy-rules-and-mcp-inventory.md](17-policy-rules-and-mcp-inventory.md) | 3.9, 3.10 | Правила guard без ручной правки JSON (`list_policy_rules`, `upsert_policy_rule`, `remove_policy_rule`: компиляция шаблона как в guard, дедуп, обязательный пример) и инвентарь MCP-серверов проекта (`list_mcp_servers`: шесть конфигов, транспорты, подстановки, секрет в открытом виде — находка `block`) |
| 17 | [17-docs-freshness.md](17-docs-freshness.md) | 3.6 | Правило гигиены `docs_stale`: экспорт, схема инструмента или CLI-флаг изменились, а документа никто не тронул |
| 18 | [18-fact-forcing.md](18-fact-forcing.md) | 3.18 | Режим `fact_force` в guard: первая правка файла за сессию требует четырёх фактов, первая разрушительная команда — строки отката |
| 19 | [19-git-hooks.md](19-git-hooks.md) | 3.20 | Цель `git` в `install_agent_hooks`: `pre-commit` и `pre-push` через `core.hooksPath`, для любого клиента и для человека |
| 20 | [20-rule-packs.md](20-rule-packs.md) | 3.19 | Одиннадцать новых паков правил и метки стека, по которым они выбираются |
| 21 | [21-instinct-proposals.md](21-instinct-proposals.md) | 3.5 | `propose_instincts` и `list_sessions`: журнал наблюдений от хука конца сессии и кандидаты в инстинкты со статусом `proposed` |
| 22 | [22-coverage-gaps.md](22-coverage-gaps.md) | 3.23 | `coverage_gaps`: четыре формата отчёта, ранжирование по изменённым файлам, порог `coverage_min` в `verify_task` |
| 23 | [23-epics.md](23-epics.md) | 3.4 | Эпики: `decompose_task`, `epic_status`, `depends_on` между детьми, родитель закрывается последним |

## Как читать этот каталог

Код всех двенадцати апгрейдов уже применён в этой ветке (`claude/ecc-upgrades`): см.
`ai-dev-mcp-server/src/extensions/*`, `ai-dev-mcp-server/src/core/*`, `ai-dev-mcp-server/hooks/*`
и `docker/public-seed/03-skills-catalog/sources/custom/*`. Документы ниже хранят обоснование,
происхождение идей в ECC, шаги подключения, примеры вызова инструментов и полные листинги кода
на момент переноса. Если листинг и код в ветке расходятся, канонический вариант — код в ветке
(он прошёл merge с исправлениями T-xx из main).

Патчи `git format-patch` для переноса в другой checkout лежат в репозитории
`BreezeAreaSay/ArgentumWorkspace`, каталог `ai-dev-system-upgrades/patches/`.

Открытые долги и незакрытые вопросы собраны в [DEBTS.md](DEBTS.md): всё, что осталось
недоделанным или непроверенным по ходу работ, чинится одним заходом в конце.

Что делать дальше, описано в [PLAN.md](PLAN.md); полный разбор ECC против этого проекта, с
43 кандидатами на перенос, в [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md); готовые промпты для
сессий по каждому этапу плана — в [PROMPTS.md](PROMPTS.md).

## Содержание

| № | Файл | Что даёт | Идея из ECC | Новые MCP-инструменты |
| --- | --- | --- | --- | --- |
| 01 | [01-extension-registry.md](01-extension-registry.md) | Реестр расширений: новые инструменты живут в `src/extensions/*`, а не в `mcp-stdio.mjs` (лимит 10 500 строк) | архитектура «plugin/skills/hooks как модули» | — |
| 02 | [02-decision-ledger.md](02-decision-ledger.md) | ADR-лайт журнал решений в `.ai-dev/decisions`, попадает в context pack | `docs/decisions`, планировщик, memory-persistence | `record_decision`, `list_decisions` |
| 03 | [03-usage-ledger.md](03-usage-ledger.md) | Телеметрия вызовов инструментов и учёт токенов/стоимости | cost tracking, tool telemetry, `/cost` | `record_usage`, `usage_report` |
| 04 | [04-change-hygiene.md](04-change-hygiene.md) | Сканер диффа: секреты, `.only`, debugger, конфликт-маркеры, ослабленный линтер; встроен в `verify_task` | hooks `check-console-log`, `secret-capture`, `config-protection`, `block-no-verify` | `verify_change_hygiene` |
| 05 | [05-task-worktrees.md](05-task-worktrees.md) | Изолированный git worktree на задачу | `worktree-manager`, `parallel-tasks` | `begin_task_in_worktree`, `list_task_worktrees`, `remove_task_worktree` |
| 06 | [06-rules-library.md](06-rules-library.md) | Каталог инженерных правил (common + стековые паки с `paths:`), проекции в `.claude/rules`, `.cursor/rules/*.mdc`, `AGENTS.md` | `rules/common`, `rules/<lang>`, cursor adapter | `list_rule_packs`, `install_project_rules` |
| 07 | [07-plan-gate.md](07-plan-gate.md) | Классификация сложности задачи и обязательный план для больших/рискованных | `planner`, PRP «plan before execute» | `plan_task`, `plan_status` |
| 08 | [08-process-runner-fix.md](08-process-runner-fix.md) | Исправление гонки `exit` vs `close` в `process-runner.mjs` (флаки в тестах и усечённый вывод git) | — (найдено при прогоне тестов) | — |
| 09 | [09-session-memory.md](09-session-memory.md) | Структурированные handoff-сессии (`save_session`/`resume_session`), бюджет контекста | `save-session`, `resume-session`, `strategic-compact`, `suggest-compact` | `save_session`, `resume_session`, `context_budget_status` |
| 10 | [10-instincts.md](10-instincts.md) | «Инстинкты» с уверенностью, распадом, продвижением в глобальные и эволюцией в скиллы | `continuous-learning-v2`, `instinct-relevance` | `record_instinct`, `list_instincts`, `update_instinct`, `evolve_instincts`, `export_instincts`, `import_instincts` |
| 11 | [11-agent-hooks.md](11-agent-hooks.md) | Устанавливаемый пакет хуков для Claude Code / Cursor: guard, session start/end, pre-compact, форматирование, стоп-проверка, `policy.json` | `hooks/*`, `hookify`, `session-start/end`, `pre-compact` | `install_agent_hooks`, `agent_hooks_status` |
| 12 | [12-seed-skills.md](12-seed-skills.md) | Пять новых скиллов в seed + обновлённый `ai-dev-orchestrator` | `verification-loop`, `silent-failure-hunter`, `planner`, `security-reviewer`, memory-curator (из `continuous-learning`) | — |

## Что осталось за кадром и почему

- **`mcp-stdio.mjs` почти упёрся в лимит** (10434/10 500). Реестр
  расширений (`01`) снимает проблему на будущее: новые инструменты добавляются одной строкой в
  `EXTENSION_FACTORIES`. Секцию «Memory And Learning» в `buildAgentsMd` я не стал добавлять в
  `mcp-stdio.mjs`, чтобы не съедать остаток; вместо этого правила попадают в `AGENTS.md` через
  `install_project_rules` (`06`).
- **Seed.** Новые скиллы положены в `docker/public-seed/03-skills-catalog/sources/custom/`, а
  `public-seed.manifest.json` обновлён точечно. У себя правильнее скопировать скиллы в приватный
  vault и прогнать `npm run docker:seed` (он собирает seed из vault и пересчитает манифест).
- **Cursor.** Формат `.cursor/hooks.json` (`beforeShellExecution`, `afterFileEdit`, ...) взят из
  адаптера ECC и меняется у Cursor быстрее, чем у Claude Code. Регистрация для Claude Code
  (`.claude/settings.json`) проверена по документации, для Cursor считайте best-effort.
- **Токены.** MCP-сервер не видит usage модели; `record_usage` принимает данные от клиента или
  раннера (в Argentum это будет делать сам воркспейс, читая stream-json от `claude -p`).

## Сводный diff по существующим файлам

Полные версии новых файлов лежат в соответствующих md. Ниже все изменения существующих файлов
сервера (накопительно, от базы до последнего апгрейда), чтобы было видно, что именно трогается
в «большом» коде.

```text
 ai-dev-mcp-server/hooks/compact-advisor.mjs        | 104 +++++
 ai-dev-mcp-server/hooks/guard.mjs                  | 218 ++++++++++
 ai-dev-mcp-server/hooks/lib.mjs                    | 186 +++++++++
 ai-dev-mcp-server/hooks/post-edit.mjs              |  72 ++++
 ai-dev-mcp-server/hooks/session-end.mjs            | 107 +++++
 ai-dev-mcp-server/hooks/session-start.mjs          | 103 +++++
 ai-dev-mcp-server/hooks/stop-check.mjs             |  68 ++++
 .../scripts/prepare-docker-context.mjs             |   2 +
 ai-dev-mcp-server/src/core/agent-hooks.mjs         | 313 +++++++++++++++
 ai-dev-mcp-server/src/core/agent-hooks.test.mjs    | 212 ++++++++++
 ai-dev-mcp-server/src/core/change-hygiene.mjs      | 424 ++++++++++++++++++++
 ai-dev-mcp-server/src/core/change-hygiene.test.mjs | 161 ++++++++
 ai-dev-mcp-server/src/core/context-compiler.mjs    |  19 +-
 .../src/core/context-compiler.test.mjs             |  37 ++
 ai-dev-mcp-server/src/core/context-extras.mjs      | 101 +++++
 ai-dev-mcp-server/src/core/context-extras.test.mjs |  64 +++
 ai-dev-mcp-server/src/core/decision-ledger.mjs     | 231 +++++++++++
 .../src/core/decision-ledger.test.mjs              |  89 +++++
 ai-dev-mcp-server/src/core/instincts.mjs           | 440 +++++++++++++++++++++
 ai-dev-mcp-server/src/core/instincts.test.mjs      |  96 +++++
 ai-dev-mcp-server/src/core/process-runner.mjs      |   6 +-
 ai-dev-mcp-server/src/core/process-runner.test.mjs |  15 +
 ai-dev-mcp-server/src/core/rules-catalog.mjs       | 367 +++++++++++++++++
 ai-dev-mcp-server/src/core/rules-library.mjs       | 234 +++++++++++
 ai-dev-mcp-server/src/core/rules-library.test.mjs  |  91 +++++
 ai-dev-mcp-server/src/core/session-memory.mjs      | 347 ++++++++++++++++
 ai-dev-mcp-server/src/core/session-memory.test.mjs |  98 +++++
 ai-dev-mcp-server/src/core/task-lifecycle.mjs      |  18 +-
 ai-dev-mcp-server/src/core/task-plans.mjs          | 271 +++++++++++++
 ai-dev-mcp-server/src/core/task-plans.test.mjs     | 111 ++++++
 ai-dev-mcp-server/src/core/task-worktrees.mjs      | 230 +++++++++++
 ai-dev-mcp-server/src/core/task-worktrees.test.mjs | 106 +++++
 ai-dev-mcp-server/src/core/usage-ledger.mjs        | 214 ++++++++++
 ai-dev-mcp-server/src/core/usage-ledger.test.mjs   |  61 +++
 ai-dev-mcp-server/src/extensions/decisions.mjs     | 111 ++++++
 .../src/extensions/decisions.test.mjs              |  51 +++
 ai-dev-mcp-server/src/extensions/hooks.mjs         |  77 ++++
 ai-dev-mcp-server/src/extensions/hooks.test.mjs    |  31 ++
 ai-dev-mcp-server/src/extensions/hygiene.mjs       |  70 ++++
 ai-dev-mcp-server/src/extensions/hygiene.test.mjs  |  54 +++
 ai-dev-mcp-server/src/extensions/instincts.mjs     | 241 +++++++++++
 .../src/extensions/instincts.test.mjs              |  67 ++++
 ai-dev-mcp-server/src/extensions/plans.mjs         | 136 +++++++
 ai-dev-mcp-server/src/extensions/plans.test.mjs    |  59 +++
 ai-dev-mcp-server/src/extensions/rules.mjs         |  89 +++++
 ai-dev-mcp-server/src/extensions/rules.test.mjs    |  35 ++
 ai-dev-mcp-server/src/extensions/sessions.mjs      | 215 ++++++++++
 ai-dev-mcp-server/src/extensions/sessions.test.mjs |  77 ++++
 ai-dev-mcp-server/src/extensions/usage.mjs         |  90 +++++
 ai-dev-mcp-server/src/extensions/usage.test.mjs    |  48 +++
 ai-dev-mcp-server/src/extensions/worktrees.mjs     | 154 ++++++++
 .../src/extensions/worktrees.test.mjs              |  77 ++++
 ai-dev-mcp-server/src/mcp-stdio.mjs                |  41 +-
 ai-dev-mcp-server/src/server.mjs                   |  28 +-
 ai-dev-mcp-server/src/tool-definitions.mjs         |   2 +
 ai-dev-mcp-server/src/tool-extensions.mjs          |  79 ++++
 ai-dev-mcp-server/src/tool-extensions.test.mjs     |  52 +++
 .../sources/custom/ai-dev-orchestrator/SKILL.md    |  26 +-
 .../sources/custom/memory-curator/SKILL.md         |  36 ++
 .../sources/custom/planner/SKILL.md                |  40 ++
 .../sources/custom/security-reviewer/SKILL.md      |  47 +++
 .../sources/custom/silent-failure-hunter/SKILL.md  |  40 ++
 .../sources/custom/verification-loop/SKILL.md      |  45 +++
 docker/public-seed/public-seed.manifest.json       |  35 +-
 64 files changed, 7350 insertions(+), 19 deletions(-)
```

### `ai-dev-mcp-server/src/mcp-stdio.mjs`

```diff
diff --git a/ai-dev-mcp-server/src/mcp-stdio.mjs b/ai-dev-mcp-server/src/mcp-stdio.mjs
index c6d1918..9f782de 100644
--- a/ai-dev-mcp-server/src/mcp-stdio.mjs
+++ b/ai-dev-mcp-server/src/mcp-stdio.mjs
@@ -51,6 +51,9 @@ import {
   compileContextPack,
   contextPackFreshness
 } from "./core/context-compiler.mjs";
+import { loadContextExtras } from "./core/context-extras.mjs";
+import { verifyChangeHygiene } from "./core/change-hygiene.mjs";
+import { withPlanGateWarning } from "./core/task-plans.mjs";
 import {
   DIAGRAM_REQUEST_PATTERN,
   prioritizeRoutedRecommendations,
@@ -84,6 +87,9 @@ import {
   captureProjectState
 } from "./core/evidence.mjs";
 import { TaskStore } from "./core/task-lifecycle.mjs";
+import { UsageLedger } from "./core/usage-ledger.mjs";
+import { SessionStore } from "./core/session-memory.mjs";
+import { InstinctStore } from "./core/instincts.mjs";
 import {
   applySkillOutcome,
   SkillOutcomeStore
@@ -141,6 +147,7 @@ import {
 } from "./core/reference-factory.mjs";
 import { buildToolDefinitions } from "./tool-definitions.mjs";
 import { autoCommands } from "./auto-commands.mjs";
+import { createExtensionTools } from "./tool-extensions.mjs";
 
 const serverDir = path.dirname(fileURLToPath(import.meta.url));
 const packageVersion = (() => {
@@ -258,6 +265,9 @@ const taskStateRoot = path.resolve(
 const taskStore = new TaskStore({ stateRoot: taskStateRoot });
 const skillOutcomeStore = new SkillOutcomeStore({ stateRoot: taskStateRoot });
 const pilotStore = new PilotStore({ stateRoot: taskStateRoot });
+const usageLedger = new UsageLedger({ stateRoot: taskStateRoot });
+const sessionStore = new SessionStore({ stateRoot: taskStateRoot });
+const instinctStore = new InstinctStore({ stateRoot: taskStateRoot });
 const bgeM3EmbedCliPath = path.join(embeddingsDir, "bge_m3_embed.py");
 const bgeM3WorkerCliPath = path.join(embeddingsDir, "bge_m3_worker.py");
 const defaultBgeM3ModelDir = path.resolve(
@@ -8158,6 +8168,7 @@ async function buildProjectContextPack({
     projectBrief: brief,
     projectMap,
     qualityGate,
+    extras: await loadContextExtras({ projectRoot: identity.project_root, stateRoot: taskStateRoot, projectId: identity.project_id, task, stack: detected.stack }),
     maxSourceFiles,
     maxChars
   });
@@ -8283,6 +8294,7 @@ async function beginTask({
     projectBrief: brief,
     projectMap,
     qualityGate,
+    extras: await loadContextExtras({ projectRoot, stateRoot: taskStateRoot, projectId: identity.project_id, task, stack: detected.stack }),
     maxSourceFiles: 12,
     maxChars: 20_000
   });
@@ -8450,12 +8462,12 @@ async function checkpointTask({
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
@@ -8465,6 +8477,7 @@ function verificationPassed(checks) {
     if (item.type === "frontend_qa") return item.result?.gate === "pass";
     if (item.type === "frontend_product") return item.result?.ok === true;
     if (item.type === "archify_deliver" || item.type === "archify_visual_check") return item.result?.ok === true;
+    if (item.type === "change_hygiene") return item.result?.status !== "block";
     return false;
   });
 }
@@ -8489,6 +8502,8 @@ async function verifyTask({
   quality_labels = [],
   run_frontend = false,
   frontend_options = {},
+  run_hygiene = true,
+  hygiene_base_ref = "HEAD",
   evidence = []
 }) {
   const record = await taskStore.read(task_id);
@@ -8587,6 +8602,7 @@ async function verifyTask({
     }
   }
 
+  if (run_hygiene) checks.push({ type: "change_hygiene", result: await verifyChangeHygiene(projectRoot, { baseRef: hygiene_base_ref }) });
   const projectState = await captureProjectState(projectRoot);
   const passed = verificationPassed(checks);
   const verification = {
@@ -8730,10 +8746,21 @@ async function completeTask({
       overwrite: true
     });
   }
-  return { task: record, report, skill_outcomes: skillOutcomes };
+  const worktree = record.context?.worktree && !record.context.worktree.removed_at ? record.context.worktree : null;
+  return { task: record, report, skill_outcomes: skillOutcomes, ...(worktree ? { worktree, next_step: `Merge or open a PR from ${worktree.branch}, then call remove_task_worktree.` } : {}) };
 }
 
-const tools = buildToolDefinitions({
+// Extension tools live in src/extensions/* and receive shared runtime services
+// through this host object (see src/tool-extensions.mjs).
+const extensions = createExtensionTools({
+  vaultRoot, taskStateRoot, taskStore, skillOutcomeStore, usageLedger, sessionStore, instinctStore, callTool,
+  serverRoot: path.resolve(serverDir, ".."),
+  resolveProjectIdentity, detectProject, captureProjectState, readProjectTextIfExists,
+  writeProjectFile, safeProjectFile, safeProjectRoot, writeKnowledgeNote, appendKnowledgeNote,
+  markSearchIndexDirty
+});
+const extensionReadOnlyTools = extensions.readOnly;
+const tools = [...buildToolDefinitions({
   CONCEPT_JURY_DIMENSIONS,
   FRONTEND_PRODUCT_MODES,
   PILOT_DIMENSIONS,
@@ -8743,7 +8770,7 @@ const tools = buildToolDefinitions({
   REFERENCE_FACTORY_SURFACES,
   UI_UX_PRO_MAX_DOMAINS,
   UI_UX_PRO_MAX_STACKS
-});
+}), ...extensions.definitions];
 
 async function searchKnowledge({ query, limit = 10 }) {
   const files = await listMarkdownFiles(vaultRoot);
@@ -10299,6 +10326,8 @@ async function callTool(name, args) {
   if (name === "complete_task") return textContent(await completeTask(args));
   if (name === "write_knowledge_note") return textContent(await writeKnowledgeNote(args));
   if (name === "append_knowledge_note") return textContent(await appendKnowledgeNote(args));
+  const extension = extensions.handlers.get(name);
+  if (extension) return textContent(await extension(args));
   throw new Error(`Unknown tool: ${name}`);
 }
 
@@ -10394,9 +10423,11 @@ export function startLegacyServer() {
 
 export {
   callTool,
+  extensionReadOnlyTools,
   resolveTaskProjectRoot,
   shutdownBgeWorkers,
   tools,
+  usageLedger,
   vaultRoot
 };
 
```

### `ai-dev-mcp-server/src/server.mjs`

```diff
diff --git a/ai-dev-mcp-server/src/server.mjs b/ai-dev-mcp-server/src/server.mjs
index f452424..643ccf7 100644
--- a/ai-dev-mcp-server/src/server.mjs
+++ b/ai-dev-mcp-server/src/server.mjs
@@ -18,11 +18,14 @@ import {
 } from "@modelcontextprotocol/sdk/types.js";
 import {
   callTool,
+  extensionReadOnlyTools,
   shutdownBgeWorkers,
   tools as legacyTools,
+  usageLedger,
   vaultRoot
 } from "./mcp-stdio.mjs";
 import { isDirectExecution } from "./core/direct-execution.mjs";
+import { usageHintsFromArgs } from "./core/usage-ledger.mjs";
 
 const serverFile = fileURLToPath(import.meta.url);
 const serverRoot = path.resolve(path.dirname(serverFile), "..");
@@ -80,6 +83,8 @@ const READ_ONLY_TOOLS = new Set([
   "archify_brands"
 ]);
 
+for (const name of extensionReadOnlyTools) READ_ONLY_TOOLS.add(name);
+
 const OPEN_WORLD_TOOLS = new Set(["import_skill_repo"]);
 
 const FIXED_RESOURCES = [
@@ -207,6 +212,22 @@ const PROMPTS = [
       "Do not approve the design system until Reference Factory coverage is registered."
     ].filter(Boolean).join("\n")
   },
+  {
+    name: "learn_from_task",
+    title: "Извлеки уроки из задачи",
+    description: "After a task, turn corrections, resolved errors, repeated workflows, and decisions into durable memory: instincts, decisions, and a session handoff.",
+    arguments: [
+      { name: "project_path", description: "Absolute repository path.", required: true },
+      { name: "task_id", description: "Task lifecycle id to learn from (optional).", required: false }
+    ],
+    render: ({ project_path, task_id = "" }) => [
+      `Проект: ${project_path}${task_id ? `, задача: ${task_id}` : ""}`,
+      "Просмотри ход работы и выдели: исправления пользователя, ошибки, которые решались одинаково дважды и больше, повторяющиеся последовательности действий, архитектурные решения.",
+      "Для каждого устойчивого паттерна (3+ наблюдения или явное исправление) вызови record_instinct с коротким trigger/action, domain и note без кода и секретов; scope=project по умолчанию, global только для универсальных практик.",
+      "Архитектурные выборы запиши через record_decision. Если задача продолжится в другой сессии, сохрани handoff через save_session с точным next_step и списком неудачных подходов.",
+      "Не создавай инстинкты из единичных случаев и не дублируй уже существующие: сначала list_instincts, потом update_instinct action=confirm для совпадений."
+    ].join("\n")
+  },
   {
     name: "refresh_project_context",
     title: "Обнови память проекта",
@@ -376,16 +397,21 @@ export function createAiDevServer() {
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

### `ai-dev-mcp-server/src/tool-definitions.mjs`

```diff
diff --git a/ai-dev-mcp-server/src/tool-definitions.mjs b/ai-dev-mcp-server/src/tool-definitions.mjs
index 16a42f4..9f85e34 100644
--- a/ai-dev-mcp-server/src/tool-definitions.mjs
+++ b/ai-dev-mcp-server/src/tool-definitions.mjs
@@ -1689,6 +1689,8 @@ export function buildToolDefinitions({
         quality_labels: { type: "array", items: { type: "string" }, default: [] },
         run_frontend: { type: "boolean", default: false },
         frontend_options: { type: "object", additionalProperties: true, default: {} },
+        run_hygiene: { type: "boolean", default: true, description: "Scan added lines for secrets, debug leftovers, focused/skipped tests, conflict markers, weakened lint configs, and missing test changes. A block finding fails verification." },
+        hygiene_base_ref: { type: "string", default: "HEAD", description: "Git ref the hygiene scan diffs against; use the branch base (for example main) to include committed work." },
         evidence: ARCHIFY_EVIDENCE_SCHEMA
       },
       required: ["task_id"]
```

### `ai-dev-mcp-server/src/core/task-lifecycle.mjs`

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

### `ai-dev-mcp-server/src/core/context-compiler.mjs`

```diff
diff --git a/ai-dev-mcp-server/src/core/context-compiler.mjs b/ai-dev-mcp-server/src/core/context-compiler.mjs
index 4d446bc..1621b2b 100644
--- a/ai-dev-mcp-server/src/core/context-compiler.mjs
+++ b/ai-dev-mcp-server/src/core/context-compiler.mjs
@@ -181,7 +181,7 @@ function relevantCommands(commands, domains) {
  * acceptance criteria, routed skills, and the project brief/map/quality-gate,
  * all fingerprinted against the current project state for freshness checks.
  *
- * @param {{ projectRoot: string, task: string, project?: object, identity?: object, acceptanceCriteria?: string[], skills?: object[], projectState?: object, agentRules?: string, projectBrief?: string, projectMap?: string, qualityGate?: string, maxSourceFiles?: number, maxChars?: number, now?: string }} input
+ * @param {{ projectRoot: string, task: string, project?: object, identity?: object, acceptanceCriteria?: string[], skills?: object[], projectState?: object, agentRules?: string, projectBrief?: string, projectMap?: string, qualityGate?: string, extras?: { sections?: Array<{ id?: string, title?: string, markdown: string, items?: object[] }> }, maxSourceFiles?: number, maxChars?: number, now?: string }} input
  * @returns {Promise<object>} Context pack.
  */
 export async function compileContextPack({
@@ -196,6 +196,7 @@ export async function compileContextPack({
   projectBrief = "",
   projectMap = "",
   qualityGate = "",
+  extras = { sections: [] },
   maxSourceFiles = 12,
   maxChars = 24_000,
   now = new Date().toISOString()
@@ -265,6 +266,14 @@ export async function compileContextPack({
     },
     acceptance_criteria: criteria,
     routed_skills: skills.slice(0, 3),
+    extra_sections: (extras?.sections ?? [])
+      .filter((section) => section?.markdown)
+      .map((section) => ({
+        id: String(section.id || "extra"),
+        title: String(section.title || "Additional Context"),
+        markdown: String(section.markdown),
+        items: section.items ?? []
+      })),
     commands,
     quality_gaps: project.quality_gaps ?? [],
     risk_signals: project.risk_signals ?? [],
@@ -304,6 +313,13 @@ export async function compileContextPack({
     }
     markdown = renderContextPack(pack);
   }
+  if (markdown.length > maxChars) {
+    pack.extra_sections = pack.extra_sections.map((section) => ({
+      ...section,
+      markdown: section.markdown.slice(0, 400)
+    }));
+    markdown = renderContextPack(pack);
+  }
   if (markdown.length > maxChars) {
     pack.selected_files = [];
     markdown = renderContextPack(pack);
@@ -355,6 +371,7 @@ export function renderContextPack(pack) {
       `- \`${skill.name}\`${skill.source ? ` (${skill.source})` : ""}: ${normalize(skill.reason) || "Task route."}`
     )) : ["- No skills routed."]),
     "",
+    ...(pack.extra_sections ?? []).flatMap((section) => [`## ${section.title}`, "", section.markdown, ""]),
     "## Project Shape",
     "",
     `- Types: ${(pack.project.types ?? []).join(", ") || "unknown"}`,
```

### `ai-dev-mcp-server/scripts/prepare-docker-context.mjs`

```diff
diff --git a/ai-dev-mcp-server/scripts/prepare-docker-context.mjs b/ai-dev-mcp-server/scripts/prepare-docker-context.mjs
index 01763ff..97d1b37 100644
--- a/ai-dev-mcp-server/scripts/prepare-docker-context.mjs
+++ b/ai-dev-mcp-server/scripts/prepare-docker-context.mjs
@@ -58,6 +58,8 @@ async function copyApplication(stage) {
       || relative.replaceAll("\\", "/") === "core/public-distribution.mjs"
     )
   });
+  // Agent hook scripts are copied into user repositories by install_agent_hooks.
+  await copyDistributionTree(path.join(serverRoot, "hooks"), path.join(stage, "app", "hooks"));
   for (const name of [
     "ai-dev.mjs",
     "docker-bootstrap.mjs",
```

## Как это ляжет в Argentum Workspace

Argentum (см. `docs/` этого репозитория) запускает `claude` CLI из воркспейса и хочет держать
память, правила и контроль качества на своей стороне. Перенос MCP из `ai-dev-system` даёт
готовые примитивы:

- `begin_task` / `plan_task` / `verify_task` / `complete_task` + `verify_change_hygiene` как
  конвейер задач воркспейса;
- `save_session` / `resume_session` + `.ai-dev/context/handoff.md` как память между сессиями
  `claude -p`;
- `record_instinct` / `evolve_instincts` как «обучение» воркспейса на поправках пользователя;
- `install_agent_hooks` как единый способ поставить guard-хуки в любой репозиторий, который
  воркспейс открывает;
- `usage_report` + `record_usage` как источник данных для панели стоимости.

# Куда переехал код из `src/mcp-stdio.mjs`

Документы 01–23 в этом каталоге писались, когда почти весь код сервера лежал в
`ai-dev-mcp-server/src/mcp-stdio.mjs`. Этап 1 плана ([PLAN.md](PLAN.md), раздел 2) вынес его в
`src/core/*` (чистая логика со своими тестами) и `src/extensions/*` (инструменты MCP: фабрика
`createXxxTools(host)`, реестр в `src/tool-extensions.mjs`). Главный модуль похудел с 10 452 строк
до 4 785.

Поэтому путь `src/mcp-stdio.mjs` в тех документах — исторический: он верен для момента, когда
документ писали, и неверен как карта кода сегодня. Документы не переписывались: они описывают,
как это строилось и почему именно так, а такая запись портится от подмены путей задним числом.
Эта таблица — то, что читать вместо них.

Чего это не касается: упоминания самого файла как файла — его размер, потолок статического гейта,
его импорты — по-прежнему верны. В [PLAN.md](PLAN.md) и [DEBTS.md](DEBTS.md) речь идёт именно об
этом.

## Таблица переездов

| Что описывает документ | Где код сейчас |
| --- | --- |
| Реестр расширений, `host`, фабрики инструментов | `src/tool-extensions.mjs`, `src/extensions/*.mjs`; `host` по-прежнему собирается в `src/mcp-stdio.mjs` |
| Определения инструментов (`tools`) | `src/tool-definitions.mjs` плюс `definitions` внутри каждого расширения |
| Журнал решений (`record_decision`, `list_decisions`) | `src/core/decision-ledger.mjs`, `src/extensions/decisions.mjs` |
| Журнал расхода (`record_usage`, `usage_report`), тарифы | `src/core/usage-ledger.mjs`, `src/extensions/usage.mjs` |
| Гигиена изменений (`verify_change_hygiene`) | `src/core/change-hygiene.mjs`, `src/extensions/hygiene.mjs` |
| Worktree на задачу | `src/core/task-worktrees.mjs`, `src/extensions/worktrees.mjs` |
| Библиотека правил (`list_rule_packs`, `install_project_rules`) | `src/core/rules-catalog.mjs`, `src/core/rules-library.mjs`, `src/extensions/rules.mjs` |
| Гейт планирования (`plan_task`, `plan_status`) | `src/core/task-plans.mjs`, `src/extensions/plans.mjs` |
| Память сессий (`save_session`, `resume_session`) | `src/core/session-memory.mjs`, `src/extensions/sessions.mjs` |
| Инстинкты и их предложения | `src/core/instincts.mjs`, `src/core/instinct-proposals.mjs`, `src/extensions/instincts.mjs` |
| Хуки агента, профили, `policy.json` | `src/core/agent-hooks.mjs`, `src/core/policy-rules.mjs`, `src/extensions/hooks.mjs`, сами скрипты в `hooks/` |
| Fact forcing | `hooks/fact-force.mjs` (настройки — в `defaultPolicy` в `src/core/agent-hooks.mjs`) |
| Git-хуки через `core.hooksPath` | `hooks/git-hooks.mjs`, установка в `src/core/agent-hooks.mjs` |
| Подготовка PR (`prepare_pull_request`) | `src/core/pull-request.mjs`, `src/core/pr-template.mjs`, `src/extensions/pull-requests.mjs` |
| Линтер заявлений о завершении | `src/core/completion-claims.mjs`, вызовы — в `src/extensions/lifecycle.mjs` |
| Снимки задачи и откат | `src/core/task-snapshots.mjs`, `src/extensions/snapshots.mjs` |
| Правила guard и инвентарь MCP | `src/core/policy-rules.mjs`, `src/core/mcp-inventory.mjs`, `src/extensions/hooks.mjs`, `src/extensions/mcp-inventory.mjs` |
| Пробелы покрытия (`coverage_gaps`) | `src/core/coverage-reports.mjs`, `src/extensions/coverage.mjs` |
| Эпики (`decompose_task`, `epic_status`) | `src/core/task-epics.mjs`, `src/extensions/epics.mjs` |
| Жизненный цикл задачи (`begin_task`, `checkpoint_task`, `verify_task`, `complete_task`) | `src/extensions/lifecycle.mjs`; правила — `src/core/task-lifecycle.mjs`, `src/core/task-verification.mjs`, `src/core/task-completion.mjs` |
| Рекомендации скиллов, карточки, валидация каталога | `src/core/skill-recommendation.mjs`, `src/core/skill-router.mjs`, `src/core/task-vocabulary.mjs`, `src/core/skill-cards.mjs`, `src/core/skill-quality-report.mjs`, `src/core/skill-registry-docs.mjs`, `src/extensions/skills.mjs` |
| Импорт каталога скиллов ECC | `src/core/skill-import-policy.mjs`, `src/extensions/skills.mjs` (сборщики источников остались в `src/mcp-stdio.mjs`) |
| Frontend QA, Reference Factory, дизайн-система | `src/core/frontend-product-quality.mjs`, `src/core/reference-factory.mjs`, `src/core/ui-ux-pro-max.mjs`, `src/extensions/frontend-design.mjs`, `src/extensions/frontend-qa.mjs` |
| Поиск и эмбеддинги | `src/core/search-index.mjs`, `src/core/search-runtime.mjs`, `src/core/search-reranker.mjs`, `src/core/embedding-workers.mjs`, `src/extensions/search.mjs` |
| Карточка проекта, детектор, гейт качества | `src/core/project-cards.mjs`, `src/core/project-detection.mjs`, `src/core/project-markdown.mjs`, `src/core/quality-gate-runner.mjs`, `src/extensions/projects.mjs` |
| Здоровье системы и дашборд | `src/core/system-health.mjs`, `src/core/system-dashboard.mjs`, `src/extensions/system.mjs` |

## Что осталось в главном модуле

`src/mcp-stdio.mjs` держит то, что общее для всех: чтение vault, `resolveProjectIdentity`,
сборщики источников скиллов, `callTool` с записью в журнал расхода, сборка `host` и склейка с
реестром расширений. Актуальную карту слоёв — а не эту таблицу переездов — стоит читать в
[ai-dev-mcp-server/docs/ARCHITECTURE.md](../../ai-dev-mcp-server/docs/ARCHITECTURE.md);
список всех инструментов — в
[ai-dev-mcp-server/docs/TOOLS.md](../../ai-dev-mcp-server/docs/TOOLS.md).

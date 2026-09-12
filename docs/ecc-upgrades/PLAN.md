# План исправления и развития ai-dev-system

Дата: 2026-09-10. Основание: `stonebridgeway/ai-dev-system` на коммите `0fdffc0` (merge PR #36),
форк `BreezeAreaSay/ai-dev-system`, ветка `claude/ecc-upgrades` (коммит `255b782`), сравнение с
ECC v2.2.1 и прогон обеих версий сервера на живом тестовом проекте.

## 0. Где проект сейчас

| Показатель | main (`0fdffc0`) | ветка `claude/ecc-upgrades` |
| --- | --- | --- |
| Инструментов MCP | 115 | 115 |
| Тестов (`node --test`) | 197, 190 pass, 7 skipped | 227, 220 pass, 7 skipped |
| Покрытие `src/core` (lines / branches / funcs) | не проверялось | 92.8 / 72.9 / 91.6 |
| `src/mcp-stdio.mjs` | 10 449 строк из 10 600 | 10 452 из 10 600 |
| Хуки агента | 21 строка на 7 файлов, файловый guard не работает | 858 строк, все сценарии проверены |
| Seed: новые скиллы | нет | 5 скиллов + обновлённый оркестратор |
| Упоминаний новых инструментов в README / CHANGELOG / docs | 0 | 0 |
| Файлов seed, чьи хэши расходятся с `public-seed.manifest.json` | 74 из 927 | 74 из 927 |

Сильные стороны, которые план не трогает: жизненный цикл задач с привязкой доказательств к
git-состоянию, роутинг скиллов с оценкой качества, Frontend QA и Archify, гейты
(статический, секьюрити, покрытие, smoke), чистый Docker seed с аудитом приватности.

Главные проблемы, в порядке важности:

1. В main лежит сжатый порт апгрейдов (PR #36): нечитаемые однострочники, один тест на файл,
   мёртвые ветки кода в хуках. Это долг, который будет расти с каждой правкой.
2. `mcp-stdio.mjs` упёрся в потолок: 148 строк запаса. Любая новая встроенная возможность
   потребует либо поднимать потолок, либо выносить код.
3. Документация не знает о 23 новых инструментах и 7 хуках. Агент, читающий README, не
   узнает о `plan_task`, `save_session`, `install_agent_hooks`.
4. Seed-манифест разошёлся с содержимым seed: 74 файла имеют другой хэш. Аудит образа
   опирается на манифест, значит гарантия «что собрано, то и проверено» сейчас формальная.
5. Память привязана к `project_id`, который считается от realpath. При работе «задача =
   worktree» (так делает `begin_task_in_worktree` и так устроен Argentum) решения, handoff и
   инстинкты дробятся по worktree и не видны из основного checkout.

## 1. Этап 0. Стабилизация (1–2 дня)

Цель: main снова читаемый, проверяемый и задокументированный; никаких новых функций.

| # | Действие | Как проверить | Размер |
| --- | --- | --- | --- |
| 0.1 | Смержить `claude/ecc-upgrades` в main (PR из форка или прямой push ветки). Ветка заменяет сжатый порт полной реализацией, сохраняет все T-xx исправления и имена инструментов | `npm run check` зелёный; 227 тестов | S |
| 0.2 | CHANGELOG: раздел Unreleased → «Added: extension registry, decisions, usage ledger, change hygiene, task worktrees, rules library, plan gate, session memory, instincts, agent hooks, five seed skills»; «Fixed: hook file guard, compaction advisor, session-end extraction» | ревью | S |
| 0.3 | Документация инструментов: `ai-dev-mcp-server/docs/TOOLS.md` с таблицей всех 115 инструментов (имя, назначение, read-only, когда звать), сгенерированной скриптом из `tools` (`scripts/render-tool-reference.mjs`), и проверка в CI, что файл актуален | `node scripts/render-tool-reference.mjs --check` | M |
| 0.4 | `docs/ARCHITECTURE.md`: слои «extensions», «context extras», «hooks», «state roots» (`~/.ai-dev/state/{tasks,sessions,instincts.json,usage}`), схема данных задачи с `plan_policy` и `context.worktree` | ревью | S |
| 0.5 | README и README.ru: раздел «Память и обучение» (save_session, resume_session, record_decision, record_instinct, learn_from_task) и «Хуки» (install_agent_hooks, профили, policy.json) | ревью | S |
| 0.6 | Пересобрать seed из приватного vault: `npm run docker:seed`, закоммитить манифест; добавить `scripts/verify-public-seed.mjs` (сравнение хэшей манифеста с файлами, исключая сгенерированные `registries/cards/groups`) и шаг в CI | `node scripts/verify-public-seed.mjs` в `ci.yml` | S |
| 0.7 | Версия `1.2.0` в `package.json`, тег после merge | `npm run packaging:check` | S |

## 2. Этап 1. Модульность сервера (1–2 недели)

Цель: `mcp-stdio.mjs` ниже 6 000 строк без изменения поведения; потолок статического гейта
опустить обратно до 10 500, затем до 8 000 и 6 000 по мере выноса.

Принцип: тот же паттерн, что у `src/extensions/*` (фабрика получает `host`, возвращает
`definitions/handlers/readOnly`), плюс чистые модули в `src/core` для рендеров и анализа.
Каждый вынос — отдельный PR с тестом на новый модуль и без изменения выходов инструментов
(protocol-smoke и lifecycle-smoke как регрессионные проверки).

Порядок по размеру функций в `mcp-stdio.mjs` (строки на сегодня). Куда всё это в итоге
переехало — [CODE-MAP.md](CODE-MAP.md):

| Шаг | Что выносим | Куда | Строк |
| --- | --- | --- | --- |
| 1.1 | `systemHealthCheck` + `buildSystemDashboardSnapshot` | `src/extensions/system.mjs`, чистая часть в `src/core/system-health.mjs` | ~570 |
| 1.2 | `recommendSkillsProjectAware`, `renderSkillCard`, `renderSkillQualityDashboard`, `validateSkillLibrary` | `src/core/skill-recommendation.mjs`, `src/core/skill-rendering.mjs`, `src/extensions/skills.mjs` | ~670 |
| 1.3 | Frontend references и QA: `registerFrontendReferences`, `runFrontendQa`, `planFrontendReferences`, `runVisualReferenceQa`, `recordVisualReview`, `generateUiUxDesignSystem` | `src/extensions/frontend.mjs` поверх существующих `frontend-product-quality.mjs` / `reference-factory.mjs` | ~730 |
| 1.4 | Поиск: `hybridSearchIndex`, `searchAll`, `runSearchEval`, `embedTexts`, `getBgeWorker` | `src/core/search-runtime.mjs`, `src/extensions/search.mjs` | ~550 |
| 1.5 | `buildRichProjectCardMd`, `detectProject`, `runQualityGate` | `src/core/project-cards.mjs`, `src/core/quality-gate-runner.mjs` | ~550 |
| 1.6 | `verifyTask`, `completeTask`, `beginTask`, `checkpointTask` | `src/extensions/lifecycle.mjs` (host уже отдаёт `taskStore`, `captureProjectState`) | ~450 |

После шагов 1.1–1.4 файл теряет около 2 500 строк, после 1.6 около 3 500. Одновременно ввести
правило статического гейта «модуль не длиннее 800 строк» для `src/core` и `src/extensions`
(то же правило, что уже стоит в `COMMON_RULES` для пользовательских проектов).

Сопутствующее: `tool-definitions.mjs` (1 831 строка) разрезать по тем же группам, чтобы
определение инструмента лежало рядом с обработчиком, как в расширениях.

## 3. Этап 2. Доводка перенесённого (3–5 дней, параллельно с этапом 1)

Найдено при прогоне ветки на живом проекте и при сравнении с ECC.

| # | Проблема | Исправление | Размер |
| --- | --- | --- | --- |
| 2.1 | Память дробится по worktree: `project_id` считается от realpath каталога | Ввести `repository_id` от `git rev-parse --git-common-dir` (общий для всех worktree); `SessionStore`, `InstinctStore`, провайдеры контекста и хуки ключуют память по `repository_id`, задачи остаются по `project_id`. Миграция: при чтении искать оба ключа | M |
| 2.2 | Находки `verify_change_hygiene` возвращают поля `code` и `path`, а документация и скилл `verification-loop` говорят о `rule` и `file` | Единая форма `{ rule, severity, file, line, message, excerpt }` (или наоборот, но одна), тест на схему ответа, правка документации | S |
| 2.3 | Формат `failed` в `save_session`: поле `reason`, в примерах документации встречается `why` | Принимать оба, нормализовать в `reason`; поправить примеры | S |
| 2.4 | `usage_report` показывает вызовы только через `server.mjs`; `scripts/ai-dev.mjs` и smoke-скрипты, зовущие `callTool` напрямую, не учитываются | Перенести запись `recordToolCall` внутрь `callTool` (в `mcp-stdio.mjs`), `server.mjs` только добавляет длительность транспорта | S |
| 2.5 | Cursor: формат `.cursor/hooks.json` не проверен на актуальной версии Cursor | Проверить на реальном Cursor, зафиксировать версию формата в `cursorHooksDocument` и тесте; при расхождении сделать адаптер версионным | S |
| 2.6 | `session-end` извлекает handoff эвристиками из транскрипта | После `session-end` предлагать агенту подтвердить черновик через `resume_session` («hook-captured, unconfirmed»); `save_session` с `confirm_hook_draft=true` превращает черновик в полноценную запись | M |
| 2.7 | `compact-advisor` оценивает контекст без данных `usage` в Claude Code | Читать `transcript_path` из ввода хука и брать `usage` последнего сообщения `assistant` (как это делает ECC `suggest-compact`); в Argentum данные приходят из stream-json напрямую | S |
| 2.8 | Инстинкты записывает только сам агент по промпту `learn_from_task` | Добавить `propose_instincts(session_id)`: разбор сохранённого транскрипта хуком `session-end` → кандидаты (поправки пользователя, повторные ошибки) со статусом `proposed`, подтверждение через `update_instinct` | M |
| 2.9 | `install_project_rules` не знает про `CLAUDE.md`-импорты `@path` | Опция `targets: ["claude-md"]`: добавить строку `@.ai-dev/rules/common/*.md` в `CLAUDE.md` вместо копирования в `.claude/rules` | S |
| 2.10 | Тесты хуков запускают скрипты только на Linux | Включить `src/core/agent-hooks.test.mjs` и `hooks`-сценарии в Windows-job CI (`node --test src/core/agent-hooks.test.mjs`) | S |

## 4. Этап 3. Идеи ECC, которые ещё не перенесены

ECC v2.2.1: 68 агентов, 286 скиллов, 94 команды, 3 контекста, 50+ скриптов, лицензия MIT.
Перенесено двенадцатью апгрейдами: хуки и hookify, библиотека правил, continuous-learning
(инстинкты), save/resume-session, strategic-compact и context-budget, planner и PRP-гейт,
verification-loop, silent-failure-hunter, security-reviewer, worktree на задачу, cost tracking,
ADR-журнал. Уже было в ai-dev-system до апгрейдов: роутинг скиллов, оценка качества и
`import_skill_repo` (skill-scout / skill-health), `prepare_project` и карта проекта (codemaps,
project-init), Frontend QA с axe и Playwright (e2e-testing, browser-qa, frontend-a11y), Archify,
Reference Factory и жюри концепций (gan-*), `system_health_check` и дашборд (doctor, status),
`secrets-dependencies-auditor` и `code-reviewer` (security-scan, code-review),
`search_knowledge` (search-first, documentation-lookup), `PilotStore` (agent-eval, частично).

### 4.1. Стоит переносить (по ценности, затем по трудоёмкости)

| # | Идея ECC (источник) | Во что превращается в ai-dev-system | Ценность | Размер |
| --- | --- | --- | --- | --- |
| 3.1 | Каталог скиллов ECC целиком (`skills/*`, 286 штук, MIT) | Импорт в vault как источник `external/ecc` через существующий `import_skill_repo`, фильтр по оценке качества ≥ 75 и таксономии; отобранные (tdd-workflow, error-handling, api-design, database-migrations, `*-patterns`, `*-testing` по стекам, production-audit, intent-driven-development, contract-first, hexagonal-architecture) попадают в роутинг `begin_task` без переписывания | 5 | S–M |
| 3.2 | Снимок и откат состояния задачи (`checkpoint` команда, `worktree-lifecycle.js`) | Инструменты `snapshot_task` (коммит в теневую ветку `ai-dev/snapshots/<task>` или `git stash create` с меткой хода) и `rollback_task(snapshot_id)`; запись снимка в `checkpoint_task`. Это ровно «снимки worktree после хода и кнопка откатить» из фазы 0 Argentum | 4 | M |
| 3.3 | ~~`security-scan` (команда + скилл: semgrep, trivy, gitleaks, npm audit, pip-audit)~~ **сделано** | `run_security_scan(project_path, scanners=auto)`: запуск установленных сканеров с нормализованным отчётом `{ tool, severity, file, line, message }`, результат как проверка `security_scan` в `verify_task` рядом с `change_hygiene`; отсутствие сканера = `skipped` с причиной, не ошибка | 4 | M |
| 3.4 | Эпики (`epic-decompose`, `epic-claim`, `epic-sync`, `epic-validate`, `config/github-native-coordination.json`) | Родительская задача с дочерними: `decompose_task(task_id, subtasks[])`, `epic_status(task_id)`, зависимость `depends_on` между дочерними, `complete_task` родителя только когда дети закрыты. Синхронизация с GitHub Issues не переносится (это забота Argentum и его карточек) | 4 | L |
| 3.5 | Наблюдатель continuous-learning-v2 (`observer.md`, фоновый разбор транскриптов) | `propose_instincts(session_id)`: разбор транскрипта, сохранённого хуком `session-end`, по шаблонам «пользователь поправил», «ошибка решена повторно», «цепочка команд повторилась»; кандидаты со статусом `proposed`, подтверждение через `update_instinct`. Плюс `list_sessions(project_path, limit)`, которого сейчас нет (ECC: `sessions`, `session-inspect`) | 4 | M |
| 3.6 | `update-docs`, `living-docs-governance`, `doc-updater` | Правило гигиены `docs_stale`: если в диффе изменился публичный интерфейс (экспорты, схемы инструментов, CLI-флаги), а `README`/`docs/` не тронуты, находка `warn` с перечнем файлов; в `verify_task` как часть `change_hygiene` | 3 | S |
| 3.7 | ~~`rules-distill` (правила из кодовой базы)~~ **сделано** | `distill_project_rules(project_path)`: анализ соглашений (импорты, именование, структура тестов, обработка ошибок) из `project-map` и выборки файлов, результат как черновик `.ai-dev/rules/project.md` со статусом draft; дополняет `install_project_rules`, не заменяет | 3 | M |
| 3.8 | ~~`codemaps` (граф модулей и зависимостей)~~ **сделано** | Расширить `project-map.md` секцией «Import graph»: модули с наибольшим числом зависимых, циклы, точки входа; ленивый пересчёт при `prepare_project` и по `refresh_project_context` | 3 | M |
| 3.9 | Команды `hookify`, `hookify-list`, `hookify-configure` | `hook_policy(action=list\|add\|remove\|enable, rule)`: правка `.ai-dev/policy.json` без ручного JSON, валидация regex, проверка на дубликаты; `agent_hooks_status` показывает правила | 3 | S |
| 3.10 | `mcp-inventory.js`, `MCP-CONNECTOR-POLICY.md` | `list_mcp_servers(project_path)`: чтение `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json`, `codex` конфигов; отчёт о транспортах, env-подстановках и секретах в открытом виде (находка `block`). Основа реестра инструментов Argentum (фаза 3) | 3 | S |
| 3.11 | Адаптеры Codex/OpenCode (`codex-hooks.json`, `sync-ecc-to-codex.sh`, `build-opencode.js`) | Цель `codex` в `install_project_rules` (правила через `AGENTS.md`, который Codex читает нативно, уже есть; добавить только маркеры секций) и `install_agent_hooks targets: ["codex"]` в формате `codex-hooks.json` | 2 | S–M |
| 3.12 | ~~`prune`, `config-gc`~~ **сделано** | `prune_state(project_path, dry_run)`: retire инстинктов ниже 0.3 без наблюдений 90 дней, архив сессий старше N, ротация `usage/events.jsonl`, удаление снимков закрытых задач | 2 | S |
| 3.13 | `build-fix` / `build-error-resolver`, `refactor-clean` / `refactor-cleaner`, `plan-prd`, `production-audit`, `tdd-workflow` | Пять seed-скиллов по Skill Schema v2 (если 3.1 не даст их напрямую): build-error-resolver (цикл «ошибка → минимальная правка → пересборка», лимит итераций), refactor-cleaner (knip/depcheck/vulture, удаление только с доказательством отсутствия ссылок), prd-writer, production-audit (чеклист готовности), tdd-workflow (red-green-refactor с `verify_task` на каждом шаге) | 3 | S каждый |
| 3.14 | `model-route`, `token-budget-advisor` | Расширить `plan_policy` рекомендацией модели и усилия в терминах Argentum (`sonnet/low`, `opus/high`, `fable/xhigh`) и бюджетом токенов на задачу; воркспейс подставляет пресет при создании задачи | 3 | S |

Дополнения из полного разбора ECC (все 286 скиллов, 94 команды, 68 агентов, хуки и скрипты
проверены по дереву; документ [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md), 43 позиции с путями
файлов ECC, зависимостями от апгрейдов и дизайном верхних десяти). Позиции, которых нет в
таблице выше и которые стоит включить в этап 3:

| # | Идея ECC (источник) | Во что превращается | Ценность | Размер |
| --- | --- | --- | --- | --- |
| 3.15 | Захват стоимости из транскрипта с таблицей тарифов (`scripts/hooks/cost-tracker.js`, `commands/cost-report.md`) | Хук `cost-capture.mjs` суммирует `usage` по записям транскрипта и пишет в usage ledger; `RATE_TABLE` по моделям с множителями кэша (запись ×1.25, чтение ×0.1); разрезы «сегодня / 7 дней / по моделям» в `usage_report`. В Argentum источник тот же, но из stream-json | 4 | S |
| 3.16 | Подготовка PR из доказательств задачи (`commands/pr.md`, `prp-pr.md`, `prp-commit.md`) | `prepare_pull_request(task_id)`: описание из чекпойнтов, верификаций, решений и плана, шаблон PR из репозитория, staging по описанию; результат в `.ai-dev/pr/<task_id>.md` и как `next_step` в `complete_task` | 4 | S |
| 3.17 | Линтер «заявлений о завершении» (`skills/delivery-gate/hooks/quality-gate.py`, `skills/agent-self-evaluation/scripts/evaluate.py`) | В `complete_task` и `checkpoint_task`: регулярные выражения рационализаций («pre-existing issue», «skipping tests for now», «tests failing but I'll fix») блокируют завершение; seed-скилл `self-evaluation` | 4 | S |
| 3.18 | GateGuard fact-forcing (`scripts/hooks/gateguard-fact-force.js`) | Режим `fact_force` в `guard.mjs` и `policy.json`: первое изменение каждого файла за сессию требует четырёх фактов (импортёры, затронутый API, схема данных, цитата инструкции), первая деструктивная команда требует строки отката | 4 | M |
| 3.19 | Недостающие паки правил (`rules/{vue,kotlin,swift,php,csharp,cpp,dart,ruby,perl,angular,nuxt,arkts,fsharp,react-native}`, `python/fastapi`, `web/{performance,design-quality}`) | Записи в `RULE_PACKS` с `paths` и `stacks`; отдельный PR на 3–4 пака | 3 | M |
| 3.20 | Git-хуки через `core.hooksPath` (`scripts/codex-git-hooks/pre-commit`, `pre-push`) | Цель `git` в `install_agent_hooks`: pre-commit запускает `verifyChangeHygiene` (block-находки), pre-push проверяет статус `verify_task`; работает для любого агента и для людей | 3 | S |
| 3.21 | Монитор контекста, циклов и стоимости (`scripts/hooks/ecc-context-monitor.js`: пороги стоимости 5/10/50 USD, 20 файлов, 5 одинаковых вызовов подряд) | Расширение `compact-advisor.mjs`: предупреждения о зацикливании и стоимости из usage ledger; в Argentum те же пороги показывает воркспейс | 3 | S |
| 3.22 | ~~Скан конфигурации агентов проекта (`skills/security-scan`, AgentShield: авто-запуск в CLAUDE.md, `Bash(*)` в settings, `npx -y` и секреты в `mcp.json`)~~ **сделано** | Часть `list_mcp_servers` (3.10) и новая проверка `agent_config` в `verify_change_hygiene`; оценка A–F в карточке проекта | 3 | M |
| 3.23 | Пробелы покрытия (`commands/test-coverage.md`, `agents/pr-test-analyzer.md`) | `coverage_gaps(project_path)`: разбор lcov / istanbul JSON / coverage.py XML / go cover, ранжированный список непокрытых функций в изменённых файлах | 3 | M |
| 3.24 | ~~Состояния worktree (`scripts/lib/worktree-lifecycle/lifecycle.js`: merged / stale / dirty / orphan)~~ **сделано** | Поля состояния в `list_task_worktrees` и `plan_worktree_cleanup(dry_run)` | 2 | S |

Рекомендуемый порядок: 3.1, 3.9, 3.15, 3.16, 3.17 (дешёвые, сразу расширяют каталог,
управляемость и качество завершения), затем 3.2 и 3.5 (нужны Argentum в фазах 0–1), потом
3.3, 3.6, 3.10, 3.18, 3.20, дальше по таблицам. Полный список из 43 позиций с приоритетами
лежит в разделе C документа ECC-GAP-ANALYSIS.md, раздел D там же объясняет, что не переносится.

Дизайн верхних пунктов:

- **3.1 импорт каталога.** `import_skill_repo(repository_url=ECC, source_group="ecc")`, затем
  `rebuild_index` и `validate_skill_library`; в таксономии отметить дубликаты уже существующих
  custom-скиллов (например, ECC `verification-loop` против нашего) и оставить наш. Правило
  безопасности: импортированные скиллы получают `trust: known-upstream`, инструкции внутри
  них считаются данными до ручного ревью (уже поддержано полями `maturity`/`trust`).
- **3.2 снимки.** Снимок = `git stash create` над worktree задачи плюс запись
  `{ snapshot_id, turn, files, created_at }` в задачу; откат = `git checkout <snapshot> -- .`
  с предварительным снимком текущего состояния (откат обратим). Ничего не пишется в историю
  ветки пользователя; снимки живут в `refs/ai-dev/snapshots/<task_id>/<n>` и удаляются в
  `complete_task` или `prune_state`.
- **3.3 сканеры.** Один модуль `src/core/security-scan.mjs` с адаптерами `npm audit`,
  `pip-audit`, `cargo audit`, `gitleaks`, `semgrep`, `trivy fs`; каждый адаптер знает, как
  обнаружить бинарник и как привести вывод к общей форме. Гейт: `critical`/`high` из
  `gitleaks` и аудитов зависимостей блокируют, остальное `warn`.
- **3.4 эпики.** Родитель хранит `children: [{ task_id, depends_on, status }]`, дети наследуют
  `project`, `risk` и получают критерий «parent epic acceptance: …». `verify_task` родителя
  агрегирует последние верификации детей. В Argentum это ложится на `create_task` дочерних задач.
- **3.5 наблюдатель.** Хук `session-end` уже сохраняет `hook-<session>.json` с извлечёнными
  фрагментами; `propose_instincts` прогоняет по ним детерминированные шаблоны (регулярные
  выражения по репликам пользователя «не так», «используй», «всегда», «никогда», повторные
  одинаковые ошибки команд) и создаёт инстинкты с `confidence 0.3`, `status: proposed`.
  Никакого фонового процесса: вызов из `learn_from_task` или из воркспейса после сессии.

### 4.2. Не переносить (и почему)

| Группа ECC | Причина |
| --- | --- |
| `council`, `council-multi-model`, `multi-plan/execute/backend/frontend/workflow`, `gemini-adapt-agents.js` | Мультимодельный консилиум — задача раннера, а не MCP; в Argentum это выбор модели на задачу |
| `gan-*` (generator/evaluator/planner) | Покрыто Frontend product builder, жюри концепций и Reference Factory |
| `autonomous-loops`, `continuous-agent-loop`, `loop-start/status`, `santa-loop`, `ralphinho-rfc-pipeline`, `dynamic-workflow-mode` | Циклы «пока не готово» живут в Session Runner Argentum (перезапуск сессии по условию), сервер лишь даёт `verify_task` как критерий остановки |
| `team-agent-orchestration`, `dev-team`, `team-builder`, `parallel-execution-optimizer`, `orchestrate-worktrees.js`, `orchestrate-codex-worker.sh` | Мультиагентная оркестрация — раннер; worktree на задачу уже есть |
| `ecc2/`, `SESSION-ADAPTER-CONTRACT.md`, `harness-audit`, `harness-optimizer`, `harness-adapter-compliance.js`, `auto-update`, `install-*.js`, `uninstall.js`, `setup*.js`, `welcome.js` | Инфраструктура установки и самообновления самого ECC |
| `ecc_dashboard.py`, `dashboard-web.js`, `operator-readiness-dashboard.js`, `control-pane.js`, `plan-canvas` | Интерфейсы; данные для них уже отдают `usage_report`, `system_health_check`, `plan_status`. Рисовать будет Argentum |
| `jira-integration`, `github-coordination.js`, `work-items.js`, `epic-sync`, `epic-publish`, `pr`, `review-pr`, `github-ops` | Связь с трекерами и PR — через карточки и каналы Argentum; из MCP достаточно `list_decisions` и `verify_task` как источников для карточки |
| `pm2`, `setup-pm`, `terminal-ops`, `terminal-opener`, `dmux-workflows`, `flox-environments`, `uncloud` | Управление процессами и окружениями за пределами репозитория |
| Доменные и продуктовые скиллы: healthcare-*, logistics, customs, energy, finance-billing, investor-*, marketing-*, seo, social-*, video-*, blender, manim, x-api, defi-*, prediction-market-*, homelab-*, network-*, cisco-*, netmiko-* | Не относятся к движку разработки; при нужде импортируются точечно по 3.1 |
| Языковые команды `*-build`, `*-review`, `*-test` (cpp, go, rust, kotlin, flutter, react, vue, fastapi, python, gradle) | Покрываются паками правил и импортом языковых скиллов (3.1); отдельные команды не нужны, роутинг делает `begin_task` |
| `learn-eval`, `agent-self-evaluation`, `agent-introspection-debugging`, `benchmark-*`, `eval-harness`, `healthcare-eval-harness` | Оценочный харнесс ECC привязан к его формату сессий; у ai-dev-system есть `PilotStore` и `search-eval`, расширять их отдельным планом |
| `contexts/dev|research|review.md` | Пресеты режима — это пресеты задачи в Argentum (`docs/03`, «уровни усилия»), сервер отдаёт `plan_policy` |
| `unified-memory`, `memory-mcp.mjs`, `memory.js` | ai-dev-system сам является MCP памяти; дублировать нечего |

## 5. Этап 4. Подготовка к вливанию в Argentum Workspace (после этапов 0–2)

Argentum запускает `claude -p` с MCP-серверами на сессию, держит личную память в каталоге
Linux-пользователя, память проекта в репозитории, а счётчик контекста и стоимость берёт из
stream-json. Всё это уже совпадает с устройством ai-dev-system, если закрыть несколько разрывов.

| # | Что нужно | Зачем | Размер |
| --- | --- | --- | --- |
| 4.1 | `AI_DEV_STATE_ROOT` на пользователя и `repository_id` (2.1) | Личная память = `~/.ai-dev/state` Linux-пользователя, память проекта = `.ai-dev/` в репозитории. Ровно три уровня из `docs/03-projects-context.md` | S после 2.1 |
| 4.2 | Профиль «Argentum» для `install_agent_hooks`: только `guard` и `session-end`, без `post-edit` (форматирует Runner) и без `compact-advisor` (счётчик контекста рисует воркспейс) | Хуки не дублируют функции воркспейса | S |
| 4.3 | `record_usage` из Session Runner: после события `result` писать `total_cost_usd`, `usage`, `num_turns`, `duration_ms` с `task_id` | Дашборд расхода по проекту и человеку (фаза 1 Argentum) | S |
| 4.4 | Экран «Память проекта» читает `.ai-dev/decisions`, `.ai-dev/context/handoff.md`, `list_instincts`; кнопка «перенести в память проекта через PR» вызывает `evolve_instincts` и `install_project_rules` | Фаза 1 Argentum без нового хранилища | M |
| 4.5 | Гейт планирования как состояние задачи: воркспейс не даёт запустить «большую» сессию, пока `plan_status` не покажет план для `plan_required` | Экономия токенов на неудачных заходах | S |
| 4.6 | `verify_task` и `verify_change_hygiene` как обязательный шаг «закрытия задачи» перед merge/PR | Гигиена задач из `docs/03` | S |
| 4.7 | Транспорт: оставить stdio (сервер запускается CLI на сессию), но проверить холодный старт с индексом поиска (`ensureSearchIndex`) на общем каталоге `AI_DEV_SEARCH_INDEX_ROOT`, чтобы не строить индекс в каждой сессии | Время старта задачи | M |
| 4.8 | Совместимость с `--permission-prompt-tool`: аннотации `readOnlyHint` для всех read-only инструментов (сейчас список ведётся вручную в `server.mjs`) генерировать из определений | Меньше карточек «разрешить?» для чтения | S |

## 6. Порядок работ и ответственность

1. Неделя 1: этап 0 целиком (PR «stabilize»), 2.2–2.4, 2.10.
2. Недели 2–3: этап 1 шаги 1.1–1.4 (по одному PR на шаг), параллельно 2.1 и 2.5–2.7.
3. Неделя 4: этап 1 шаги 1.5–1.6, 2.8–2.9, первые пункты этапа 3 по приоритету.
4. Далее: оставшийся этап 3, затем этап 4 синхронно с фазами 0–1 Argentum.

Правила для каждого PR: `npm run check` зелёный, покрытие `src/core` не ниже текущего,
protocol-smoke показывает те же 115 инструментов (плюс новые), в CHANGELOG есть строка,
документация инструмента добавлена в `docs/TOOLS.md`.

## 7. Риски

- Вынос кода из `mcp-stdio.mjs` ломает неявные связи через замыкания модуля (общие
  `const` вроде `taskStore`, `vaultRoot`). Защита: выносить только через `host`, шаг за шагом,
  smoke-тесты после каждого шага.
- Приватный vault остаётся единственным источником seed. Защита: `verify-public-seed` в CI
  ловит расхождения, а `docker:seed` документирован как обязательный шаг релиза.
- Форматы хуков Cursor и Claude Code меняются. Защита: версия формата в коде и тест-фикстуры
  с реальными файлами настроек.
- Память между worktree (2.1) меняет ключи хранилищ. Защита: чтение по двум ключам в течение
  одного релиза, миграция при первом `save_session`.

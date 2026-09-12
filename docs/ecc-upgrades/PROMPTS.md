# Промпты для сессий по плану развития

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

Каждый блок — готовый текст для новой сессии Claude Code, открытой в репозитории
`ai-dev-system`. Промпты рассчитаны на то, что агент сам прочитает нужные файлы, поэтому
контекст в них минимальный: ссылка на план и конкретный пункт.

Общие правила, которые уже вшиты в промпты и которые стоит держать в голове:

- В конце каждой сессии `npm run check` в `ai-dev-mcp-server` (статик-гейт, индекс скиллов,
  тесты с покрытием, security-check, protocol-smoke, lifecycle-smoke).
- Один пункт плана — один коммит с осмысленным сообщением.
- Тесты, где нужны «секреты», собирают их конкатенацией строк. Литералы ломают security-check.
- Хуки в `ai-dev-mcp-server/hooks/` не импортируют код сервера: они копируются в чужие
  репозитории. Это ограничение сохранять.
- Новые скиллы кладутся в приватный vault, а не только в `docker/public-seed`; иначе
  следующий `npm run docker:seed` их сотрёт.

---

## Что уже сделано (на 2026-09-12, ветка `claude/stage-3-remaining-positions-lai2mm`)

> Доска ниже — история этапов 0–3 в том виде, в каком она велась по сессиям. Текущее состояние
> целиком — в [HANDOFF.md](HANDOFF.md) и [DEBTS.md](DEBTS.md): после очереди PROMPT-CLOSE-GAPS
> и захода по девяти долгам (Д-20 … Д-28) открытыми остаются Д-4, Д-5, Д-11 и Д-29, а из плана —
> 3.11, 3.14, 3.21, пак `arkts` из 3.19 и весь этап 4.

Сверяйтесь с этой доской перед тем, как отправлять сессию: **две сессии подряд** были потрачены
на повторную проверку готовых пунктов (3.3 и 3.4). Обе повели себя правильно — не поверили
доске, сверили код с требованиями, отчитались, что дописывать нечего, — но работа от этого не
появилась. Номер сессии в этом файле не совпадает с номером пункта плана, поэтому сверяйтесь
именно со столбцом состояния.

| Сессия | Пункт | Состояние |
| --- | --- | --- |
| 0 | влить ветку апгрейдов | сделано |
| 0.1, 0.2 | стабилизация, seed, версия | сделано |
| 1.1–1.7 | вынос кода, этап 1 целиком | сделано, главный модуль 4 775 строк из 10 018 |
| 2.1, 2.2, 2.3 | этап 2 целиком, все десять пунктов | сделано |
| 3.1 | импорт каталога скиллов ECC | сделано, но скиллы не доходят до роутинга (Д-1) |
| 3.2 | захват стоимости и тарифы | сделано |
| 3.3 | `prepare_pull_request` | **сделано**, коммит `8948d7d`, влито `3762e45` |
| 3.4 | линтер заявлений о завершении | сделано |
| 3.5 | снимки и откат состояния задачи | **сделано**, `src/core/task-snapshots.mjs`, `src/extensions/snapshots.mjs`, [16-task-snapshots.md](16-task-snapshots.md) |
| 3.6 | сканеры безопасности | не начато |
| 3.7 | правила policy и инвентарь MCP | **сделано**, `src/core/policy-rules.mjs`, `src/core/mcp-inventory.mjs`, [17-policy-rules-and-mcp-inventory.md](17-policy-rules-and-mcp-inventory.md) |
| 4.1, 4.2 | подготовка к Argentum | не начато |

Ближайшие невыполненные: 3.6. Остальные позиции этапа 3 живут в
| 3.6 | сканеры безопасности (пункт плана 3.3) | не начато |
| 3.7 | правила policy и инвентарь MCP (пункты 3.9 и 3.10) | не начато |
| 3.8 | пункт плана **3.6**, свежесть документации | сделано, находка `docs_stale` в `verify_change_hygiene`, [17-docs-freshness.md](17-docs-freshness.md) |
| 3.8 | пункт плана **3.18**, fact-forcing в guard | сделано, `hooks/fact-force.mjs`, [18-fact-forcing.md](18-fact-forcing.md) |
| 3.8 | пункт плана **3.20**, git-хуки через `core.hooksPath` | сделано, `hooks/git-hooks.mjs` и цель `git`, [19-git-hooks.md](19-git-hooks.md) |
| 3.8 | пункт плана **3.19**, недостающие паки правил | сделано частично: одиннадцать паков из четырнадцати, `perl` / `arkts` / `fsharp` — долг Д-16, [20-rule-packs.md](20-rule-packs.md) |
| 3.8 | пункт плана **3.5**, `propose_instincts` | сделано, плюс `list_sessions`, [21-instinct-proposals.md](21-instinct-proposals.md) |
| 3.8 | пункт плана **3.23**, пробелы покрытия | сделано, `coverage_gaps` и `coverage_min` в `verify_task`, [22-coverage-gaps.md](22-coverage-gaps.md) |
| 3.8 | пункт плана **3.4**, эпики | сделано, `decompose_task` / `epic_status`, [23-epics.md](23-epics.md) |
| 4.1, 4.2 | подготовка к Argentum | не начато |

Строки «сессия 3.8» — это семь пунктов плана, закрытых одним заходом в порядке,
который вы рекомендовали: 3.6, 3.18, 3.20, 3.19, 3.5, 3.23, 3.4. Каждый пункт — свой коммит и
свой документ.

Ближайшие невыполненные: сессии 3.6 (пункт плана 3.3, сканеры безопасности) и 3.7 (пункты 3.9
и 3.10, правила policy и инвентарь MCP), затем 4.1 и 4.2. Остальные позиции этапа 3 живут в
[PLAN.md](PLAN.md) и в разделе C файла [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md), там их сорок три.

Открытые долги — в [DEBTS.md](DEBTS.md). Отдельной сессией их чинить рано: договорённость была
собрать всё и закрыть одним заходом в конце.

---

## Сессия 0. Влить ветку с апгрейдами

```
Задача: влить ветку claude/ecc-upgrades форка BreezeAreaSay/ai-dev-system в main.

Ветка заменяет сжатый порт апгрейдов из PR #36 полной реализацией поверх текущего main.
Все имена инструментов и исправления T-xx сохранены. Правку process-runner ветка не несёт:
в main уже есть эквивалентная.

Шаги:
1. git remote add fork https://github.com/BreezeAreaSay/ai-dev-system (если ещё нет)
2. git fetch fork claude/ecc-upgrades
3. Смержить в main или открыть PR, на твой выбор — спроси меня, если не уверен.
4. cd ai-dev-mcp-server && npm ci && npm run check

Ожидаемый результат: 227 тестов, 220 pass, 7 skipped, 0 fail; покрытие src/core не ниже
92/72/91; protocol-smoke показывает 115 инструментов; lifecycle-smoke доходит до
task_status: complete.

Если что-то падает — покажи вывод и не чини на глаз, сначала разберись в причине.
```

---

## Этап 0. Стабилизация

### Сессия 0.1. Документация и CHANGELOG

```
Прочитай docs/ecc-upgrades/PLAN.md, раздел «Этап 0. Стабилизация». Выполни пункты 0.2–0.5.

0.2 CHANGELOG.md, раздел Unreleased:
    Added — реестр расширений, журнал решений, учёт вызовов и стоимости, гигиена изменений,
    worktree на задачу, библиотека правил, гейт планирования, память сессий, инстинкты,
    пакет хуков агента, пять seed-скиллов.
    Fixed — файловый guard в хуках, счётчик компакции, извлечение handoff в session-end.
    Формулировки бери из фактического diff, не из моего списка.

0.3 Справочник инструментов:
    Напиши ai-dev-mcp-server/scripts/render-tool-reference.mjs, который берёт массив tools из
    src/mcp-stdio.mjs и рендерит ai-dev-mcp-server/docs/TOOLS.md: имя, назначение (первое
    предложение описания), read-only или нет, группа. Флаг --check сравнивает файл на диске с
    отрендеренным и падает при расхождении. Добавь шаг в .github/workflows/ci.yml и скрипт
    "docs:tools" в package.json.

0.4 docs/ARCHITECTURE.md: слои extensions (src/extensions/*, реестр в tool-extensions.mjs),
    context extras (провайдеры секций в context pack), hooks (пакет для Claude Code и Cursor),
    состояние в ~/.ai-dev/state (tasks, sessions, instincts.json, usage). Опиши поля задачи
    plan_policy и context.worktree в разделе про состояние задач.

0.5 README.md и README.ru.md: раздел «Память и обучение» (save_session, resume_session,
    record_decision, record_instinct, промпт learn_from_task) и «Хуки агента»
    (install_agent_hooks, профили minimal/standard/strict, .ai-dev/policy.json).

Каждый пункт — отдельный коммит. В конце npm run check.
```

### Сессия 0.2. Seed и версия

```
Прочитай docs/ecc-upgrades/PLAN.md, пункты 0.6 и 0.7.

0.6 Seed-манифест разошёлся с содержимым: 74 файла из 927 имеют хэш, отличный от записанного
    в docker/public-seed/public-seed.manifest.json. Проверить можно так: пройти по файлам
    манифеста, посчитать sha256 и сравнить.
    Сделай два дела:
    а) пересобери seed из приватного vault (npm run docker:seed) и закоммить результат;
       если vault недоступен в этой сессии — скажи мне, я запущу локально;
    б) напиши ai-dev-mcp-server/scripts/verify-public-seed.mjs: сравнение хэшей манифеста с
       файлами на диске, исключая генерируемые 03-skills-catalog/{registries,cards,groups};
       ненулевой код возврата при расхождении. Добавь шаг в CI и скрипт "docker:verify-seed".

0.7 Подними версию ai-dev-mcp-server/package.json до 1.2.0, проверь npm run packaging:check.

В конце npm run check и npm run docker:verify-seed.
```

---

## Этап 1. Модульность сервера

> Актуальная версия этого раздела — [PROMPTS-STAGE-1.md](PROMPTS-STAGE-1.md): готовые промпты
> на каждый шаг с фактическими размерами функций, списком отдаваемых инструментов и ловушками
> каждого шага. Таблица ниже осталась от первой редакции и устарела.

`src/mcp-stdio.mjs` упёрся в потолок статического гейта: 10 452 строки из 10 600. Шесть шагов
выноса, каждый в отдельной сессии и отдельном PR. Шаблон промпта один, меняется только шаг.

### Шаблон

```
Прочитай docs/ecc-upgrades/PLAN.md, раздел «Этап 1. Модульность сервера», шаг <НОМЕР>.

Вынеси <ЧТО> из src/mcp-stdio.mjs в <КУДА>, следуя паттерну существующих расширений:
фабрика createXxxTools(host) возвращает { definitions, handlers, readOnly }, чистая логика
живёт в src/core/*, регистрация — одна строка в EXTENSION_FACTORIES.

Требования:
- Поведение инструментов не меняется. protocol-smoke до и после должен давать одинаковый
  список имён, lifecycle-smoke — одинаковый результат.
- Всё, что вынесенному коду нужно от сервера, приходит через host. Не импортируй
  mcp-stdio.mjs из расширения: это цикл.
- Новый модуль в src/core получает свой тест. Покрытие src/core не должно упасть.
- Определения инструментов переезжают из tool-definitions.mjs вместе с обработчиками.

В конце: npm run check, покажи, на сколько строк уменьшился mcp-stdio.mjs.
```

### Подстановки по шагам

| Шаг | ЧТО | КУДА | Строк |
| --- | --- | --- | --- |
| 1.1 | `systemHealthCheck`, `buildSystemDashboardSnapshot` | `src/extensions/system.mjs`, `src/core/system-health.mjs` | ~570 |
| 1.2 | `recommendSkillsProjectAware`, `renderSkillCard`, `renderSkillQualityDashboard`, `validateSkillLibrary` | `src/core/skill-recommendation.mjs`, `src/core/skill-rendering.mjs`, `src/extensions/skills.mjs` | ~670 |
| 1.3 | `registerFrontendReferences`, `runFrontendQa`, `planFrontendReferences`, `runVisualReferenceQa`, `recordVisualReview`, `generateUiUxDesignSystem` | `src/extensions/frontend.mjs` | ~730 |
| 1.4 | `hybridSearchIndex`, `searchAll`, `runSearchEval`, `embedTexts`, `getBgeWorker` | `src/core/search-runtime.mjs`, `src/extensions/search.mjs` | ~550 |
| 1.5 | `buildRichProjectCardMd`, `detectProject`, `runQualityGate` | `src/core/project-cards.mjs`, `src/core/quality-gate-runner.mjs` | ~550 |
| 1.6 | `beginTask`, `checkpointTask`, `verifyTask`, `completeTask` | `src/extensions/lifecycle.mjs` | ~450 |

### Сессия 1.7. Опустить потолок

```
После выноса из mcp-stdio.mjs опусти лимит в ai-dev-mcp-server/scripts/static-quality.mjs
с 10 600 до фактического размера плюс 300 строк запаса. Добавь второе правило: файлы в
src/core и src/extensions не длиннее 800 строк (то же правило, что COMMON_RULES навязывает
пользовательским проектам). Если какой-то модуль уже длиннее — либо раздели его, либо
внеси в явный список исключений с комментарием, почему.

В конце npm run check.
```

---

## Этап 2. Доводка перенесённого

### Сессия 2.1. Память между worktree (важный пункт)

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 2.1.

Проблема: project_id считается от realpath каталога, поэтому у worktree задачи он свой.
Решения, handoff и инстинкты, записанные внутри worktree, не видны из основного checkout и
наоборот. Для begin_task_in_worktree и для схемы Argentum «задача = worktree» это ломает память.

Сделай:
- функцию repositoryId(projectRoot) от `git rev-parse --git-common-dir` (общий для всех
  worktree одного клона), с тем же алгоритмом хэширования, что у project_id;
- SessionStore, InstinctStore и провайдеры context-extras ключуют память по repository_id;
  задачи и их состояние остаются на project_id;
- то же самое в hooks/lib.mjs (там своя копия projectIdOf, она должна дать тот же ответ);
- миграция: при чтении искать сначала repository_id, потом старый project_id, и при первой
  записи переносить найденное;
- тесты: запись в основном checkout видна из worktree и наоборот.

В конце npm run check плюс покажи вручную, что save_session в worktree виден через
resume_session из основного каталога.
```

### Сессия 2.2. Мелкие исправления

```
Прочитай docs/ecc-upgrades/PLAN.md, пункты 2.2, 2.3, 2.4, 2.9, 2.10. Сделай все пять.

2.2 Находки verify_change_hygiene возвращают поля code и path, а документация и скилл
    verification-loop говорят про rule и file. Приведи к одной форме
    { rule, severity, file, line, message, excerpt }, добавь тест на схему ответа, поправь
    документацию и текст скилла.
2.3 save_session принимает failed как { approach, reason }, а в примерах встречается why.
    Принимай оба, нормализуй в reason, поправь примеры.
2.4 usage_report видит только вызовы через server.mjs. Перенеси recordToolCall внутрь
    callTool в mcp-stdio.mjs, чтобы прямые вызовы (скрипты, smoke) тоже учитывались;
    server.mjs пусть добавляет только длительность транспорта. Проверь, что нет двойной записи.
2.9 Добавь в install_project_rules цель "claude-md": вместо копирования правил в .claude/rules
    вписать строку импорта @.ai-dev/rules/common/*.md в CLAUDE.md (Claude Code читает такие
    импорты при старте).
2.10 Включи тесты хуков в Windows-job CI: node --test src/core/agent-hooks.test.mjs и
    src/extensions/hooks.test.mjs. Если что-то не работает на Windows (пути, права на
    исполнение) — почини, а не пропускай.

Каждый пункт отдельным коммитом, в конце npm run check.
```

### Сессия 2.3. Хуки: черновики и контекст

```
Прочитай docs/ecc-upgrades/PLAN.md, пункты 2.5, 2.6, 2.7.

2.5 Формат .cursor/hooks.json взят из адаптера ECC и не проверен на актуальном Cursor.
    Найди документацию текущей версии, сверь имена событий (beforeShellExecution,
    afterFileEdit, sessionStart, sessionEnd, preCompact, stop) и формат ответа
    ({"permission":"deny"}). Зафиксируй версию формата в cursorHooksDocument и тесте.
    Если формат изменился — сделай адаптер версионным, а не переписывай молча.
2.6 Хук session-end сохраняет черновик handoff, извлечённый из транскрипта эвристиками.
    Пометь такие записи как unconfirmed: resume_session показывает их с оговоркой, а
    save_session с confirm_hook_draft=true превращает черновик в полноценную запись.
2.7 compact-advisor оценивает контекст без данных usage. Читай transcript_path из ввода хука
    и бери usage последнего сообщения assistant; пороги оставь настраиваемыми через
    policy.json. Тест на разбор транскрипта с фикстурой.

В конце npm run check.
```

---

## Этап 3. Идеи ECC, которые ещё не перенесены

Полный список из 43 позиций — в `docs/ecc-upgrades/ECC-GAP-ANALYSIS.md`, раздел C.
В плане они сведены в две таблицы этапа 3. Ниже промпты для первой волны, в порядке
рекомендуемого приоритета.

### Сессия 3.1. Импорт каталога скиллов ECC — сделано

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.1 и ECC-GAP-ANALYSIS.md.

У ECC (github.com/affaan-m/ECC, лицензия MIT) 286 скиллов. Многие — готовые методики
разработки, которых у нас нет: tdd-workflow, error-handling, api-design, database-migrations,
hexagonal-architecture, contract-first, intent-driven-development, production-audit,
языковые *-patterns и *-testing.

Импортируй их существующим инструментом import_skill_repo как источник external/ecc, затем
rebuild_index и validate_skill_library. Правила отбора:
- в каталог попадают только скиллы с оценкой качества не ниже 75;
- доменные и бизнес-скиллы (healthcare, логистика, финансы, крипто, медиа, сети, маркетинг)
  не импортируем: список исключений в разделе D разбора;
- при совпадении имени с нашим custom-скиллом побеждает наш, чужой не попадает в роутинг;
- импортированные получают trust: known-upstream, инструкции внутри них считаются данными
  до ручного ревью.

Покажи итог: сколько импортировано, сколько отсеяно по качеству, сколько по правилам,
какие конфликты имён. В конце npm run check.
```

### Сессия 3.2. Захват стоимости и справочник тарифов — сделано

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.15, и раздел C-1 в ECC-GAP-ANALYSIS.md.

В ECC есть scripts/hooks/cost-tracker.js: суммирует usage по всем записям транскрипта,
считает стоимость по таблице тарифов с множителями кэша (запись ×1.25, чтение ×0.1) и ведёт
накопительные строки; команда /cost-report показывает сегодня, вчера, итого, по моделям, за
7 дней.

Перенеси в наш пакет хуков:
- hooks/cost-capture.mjs: на событии Stop разбирает transcript_path, суммирует usage по
  сообщениям assistant, пишет событие в usage ledger;
- таблица тарифов в src/core/usage-ledger.mjs как данные (модель → цены за миллион токенов
  входа, выхода, записи и чтения кэша), с возможностью переопределить через
  .ai-dev/policy.json, потому что цены меняются;
- usage_report получает разрезы «сегодня», «7 дней», «по моделям» и оценку стоимости там,
  где клиент её не прислал.

Не выдумывай цены: возьми из документации Anthropic на момент работы и укажи дату в
комментарии. Тесты на подсчёт стоимости с фиктивной таблицей.

В конце npm run check.
```

### Сессия 3.3. Подготовка pull request из доказательств задачи — СДЕЛАНО — коммит `8948d7d`, влито `3762e45`, инструмент в main

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.16, и раздел C-2 в ECC-GAP-ANALYSIS.md.

Сделай инструмент prepare_pull_request(task_id, base_ref) в новом расширении
src/extensions/pull-requests.mjs:
- собирает описание из данных задачи: цель, критерии приёмки с их статусом, чекпойнты,
  результаты verify_task, записанные решения (list_decisions), план (если есть);
- ищет шаблон PR в репозитории (.github/pull_request_template.md и обычные варианты) и
  заполняет его секции, а не игнорирует;
- перечисляет изменённые файлы по группам и отмечает, какие проверки прогонялись;
- пишет результат в .ai-dev/pr/<task_id>.md и возвращает текст;
- complete_task добавляет next_step со ссылкой на этот файл.

Инструмент ничего не пушит и не создаёт PR на GitHub: только готовит текст.
Тесты: с шаблоном и без, с невыполненными критериями (они должны попасть в раздел
«осталось»), с worktree-задачей.

В конце npm run check.
```

### Сессия 3.4. Линтер заявлений о завершении — сделано

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.17, и раздел C-3 в ECC-GAP-ANALYSIS.md.

В ECC есть quality-gate.py, который ловит рационализации в отчётах агента: «pre-existing
issue», «skipping tests for now», «tests failing but I'll fix later», «works on my machine».

Добавь такую проверку в checkpoint_task и complete_task: если текст summary или notes
содержит рационализацию, а соответствующая проверка не пройдена, завершение блокируется с
объяснением. Список шаблонов вынеси в данные, дай отключить через .ai-dev/policy.json для
случаев, когда причина настоящая и записана явно.

Плюс seed-скилл self-evaluation: как проверить собственную работу перед complete_task, с
таблицей «заявление → чем подтверждается». Схема качества скилла v2, оценка не ниже 80.

Тесты: честный отчёт проходит, рационализация при красной проверке блокируется,
рационализация с явно записанной причиной и waiver проходит.

В конце npm run check.
```

### Сессия 3.5. Снимки и откат состояния задачи — сделано

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.2.

Нужны снимки состояния задачи и откат к ходу: это же нужно Argentum в фазе 0
(«снимки worktree после хода и кнопка откатить до хода»).

Сделай:
- snapshot_task(task_id, label): git stash create над рабочим деревом задачи, сохранить
  объект в refs/ai-dev/snapshots/<task_id>/<n>, записать { snapshot_id, turn, files,
  created_at } в задачу;
- list_task_snapshots(task_id);
- rollback_task(task_id, snapshot_id): перед откатом сделать снимок текущего состояния,
  чтобы откат был обратим, затем восстановить файлы;
- checkpoint_task делает снимок автоматически;
- complete_task и prune_state удаляют снимки задачи.

Ничего не пишется в историю ветки пользователя. Тесты на полный цикл: изменение, снимок,
ещё изменение, откат, обратный откат.

В конце npm run check.
```

### Сессия 3.6. Сканеры безопасности

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт 3.3, и разделы C-18, C-19 в ECC-GAP-ANALYSIS.md.

Сделай src/core/security-scan.mjs с адаптерами внешних сканеров: npm audit, pip-audit,
cargo audit, gitleaks, semgrep, trivy fs. Каждый адаптер умеет проверить наличие бинарника и
привести вывод к общей форме { tool, severity, file, line, message, rule }.

Инструмент run_security_scan(project_path, scanners=auto). Отсутствующий сканер — это
skipped с причиной, а не ошибка. Результат добавляется в verify_task как проверка
security_scan рядом с change_hygiene: critical и high из gitleaks и аудитов зависимостей
блокируют, остальное warn.

Учти политику сети: сканеры, которым нужен интернет, должны честно сообщать, что не могут
работать офлайн, и не подвешивать verify_task.

Тесты с фикстурами вывода каждого сканера, без реального запуска.

В конце npm run check.
```

### Сессия 3.7. Управление правилами policy и инвентарь MCP

```
Прочитай docs/ecc-upgrades/PLAN.md, пункты 3.9 и 3.10.

3.9 Инструменты для .ai-dev/policy.json без ручной правки JSON:
    list_policy_rules(project_path) и upsert_policy_rule(project_path, rule) с валидацией
    регулярного выражения, проверкой на дубликаты и на то, что правило вообще срабатывает на
    приведённом примере. remove_policy_rule по id. agent_hooks_status показывает правила.

3.10 list_mcp_servers(project_path): читает .mcp.json, .cursor/mcp.json, .claude/settings.json
     и конфиги Codex; отчёт о серверах, транспортах, подстановках переменных окружения.
     Секрет в открытом виде в конфиге — находка block. Основа реестра инструментов Argentum.

Тесты на фикстурах конфигов. В конце npm run check.
```

### Остальные позиции этапа 3

Для них используйте общий шаблон:

```
Прочитай docs/ecc-upgrades/PLAN.md, пункт <НОМЕР>, и соответствующий раздел C-<N> в
docs/ecc-upgrades/ECC-GAP-ANALYSIS.md (там указаны конкретные файлы ECC-источника).

Перенеси идею в архитектуру нашего сервера: чистая логика в src/core, инструменты в
src/extensions через фабрику, хуки в hooks/, скиллы в приватный vault по схеме качества v2.
Не копируй код ECC дословно: у него другой рантайм (bash, python, глобальные каталоги).
Возьми механику и пороги, реализацию напиши в нашем стиле, с JSDoc и тестами.

В конце npm run check.
```

Порядок, который я рекомендую после первой волны: 3.6 свежесть документации, 3.18
fact-forcing в guard, 3.20 git-хуки через core.hooksPath, 3.19 недостающие паки правил,
3.5 propose_instincts, 3.23 пробелы покрытия, 3.4 эпики.

---

## Этап 4. Подготовка к Argentum Workspace

### Сессия 4.1. Профиль и состояние под воркспейс

```
Прочитай docs/ecc-upgrades/PLAN.md, раздел «Этап 4», пункты 4.1, 4.2, 4.8.

Контекст: Argentum Workspace запускает claude -p от имени Linux-пользователя владельца
задачи, с личным CLAUDE_CONFIG_DIR и своим клоном. Описание в репозитории
BreezeAreaSay/ArgentumWorkspace, docs/02-architecture.md и docs/03-projects-context.md.

4.1 Проверь, что AI_DEV_STATE_ROOT корректно изолирует состояние по пользователю, и что
    после пункта 2.1 память проекта живёт в .ai-dev/ репозитория, а личная — в
    ~/.ai-dev/state. Опиши это в docs/ARCHITECTURE.md как три уровня памяти.
4.2 Добавь профиль хуков "argentum": только guard и session-end. Без post-edit (форматирует
    раннер воркспейса) и без compact-advisor (счётчик контекста рисует сам воркспейс).
4.8 Список read-only инструментов в server.mjs ведётся вручную и рассинхронизируется.
    Генерируй readOnlyHint из определений инструментов: пометка живёт рядом с инструментом,
    а не в отдельном множестве. Это уменьшает число карточек «разрешить?» в воркспейсе.

В конце npm run check.
```

### Сессия 4.2. Гейт задачи и стоимость для воркспейса

```
Прочитай docs/ecc-upgrades/PLAN.md, пункты 4.3, 4.5, 4.6, 4.7.

4.3 Опиши в docs/ протокол: воркспейс после события result вызывает record_usage с
    total_cost_usd, usage, num_turns, duration_ms и task_id. Проверь, что схема record_usage
    принимает ровно эти поля без переименований, поправь, если нет.
4.5 Убедись, что plan_status даёт воркспейсу однозначный ответ «можно запускать большую
    сессию или нет»: поле, а не текст. Добавь, если нужно.
4.6 Опиши сценарий закрытия задачи: verify_task и verify_change_hygiene обязательны перед
    merge или PR. Проверь, что complete_task действительно отказывает при незакрытых
    критериях, и что причина понятна из ответа.
4.7 Холодный старт: измерь, сколько занимает первый вызов инструмента, если индекс поиска
    пуст, и сделай так, чтобы общий AI_DEV_SEARCH_INDEX_ROOT не пересобирался в каждой
    сессии. Если пересобирается — почини и покажи замер до и после.

В конце npm run check.
```

---

## Как вести работу между сессиями

В конце каждой сессии просите агента сохранить состояние своими же инструментами:

```
Заверши сессию: вызови save_session с тем, что сделано, что не получилось и почему, что не
пробовали, и точным следующим шагом. Если по ходу были архитектурные решения — запиши их
через record_decision. Если я тебя поправлял — record_instinct.
```

Начало следующей сессии:

```
Вызови resume_session для этого проекта и покажи, на чём мы остановились. Потом продолжай
по docs/ecc-upgrades/PLAN.md.
```

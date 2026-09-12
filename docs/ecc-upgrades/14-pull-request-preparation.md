# 14. Подготовка pull request из доказательств задачи

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

Пункт [3.16 плана](PLAN.md), раздел C-2 в [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md).

## Идея из ECC

В ECC это команды `commands/pr.md` (VALIDATE → DISCOVER → PUSH → CREATE: поиск шаблона PR,
разбор коммитов и файлов, привязка plan-артефактов), `commands/prp-pr.md` и
`commands/prp-commit.md` (staging по описанию), плюс правило `rules/common/git-workflow.md`.

У нас к моменту завершения задачи уже записано всё, что должно попасть в описание: цель,
критерии приёмки с их статусом и доказательствами, чекпойнты, прогоны `verify_task` со
списком выполненных проверок, решения (ADR) и план. Описание PR — это проекция этих данных
на диф ветки, а не отдельная работа агента «вспомнить, что делал».

Переносится только сборка текста. Пуш ветки и создание PR остаются решением человека:
инструмент возвращает готовые команды, но не выполняет их и не ходит в GitHub.

## Что появилось в коде

| Файл | Роль |
| --- | --- |
| `ai-dev-mcp-server/src/core/pull-request.mjs` | Сборка секций из записи задачи, чтение дифа и коммитов через git, группировка файлов, conventional-заголовок, команды push/create |
| `ai-dev-mcp-server/src/core/pr-template.mjs` | Поиск шаблона PR в репозитории, разбор его заголовков, сопоставление с секциями, заполнение |
| `ai-dev-mcp-server/src/extensions/pull-requests.mjs` | Инструмент `prepare_pull_request` поверх обоих модулей |
| `ai-dev-mcp-server/src/mcp-stdio.mjs` | `complete_task` готовит тот же файл и даёт на него ссылку в `next_step` |
| `ai-dev-mcp-server/src/core/change-hygiene.mjs` | `IGNORED_CHANGE_PATH` экспортирован и знает про `.ai-dev/pr/`: сгенерированный текст не считается изменением |

Тесты: `src/core/pull-request.test.mjs` (9), `src/core/pr-template.test.mjs` (9),
`src/extensions/pull-requests.test.mjs` (4 — с шаблоном, без шаблона, с невыполненными
критериями, с worktree-задачей), плюс проверка в `scripts/lifecycle-smoke.mjs`.

## Секции описания

`buildPullRequestSections` всегда собирает один и тот же набор; пустые секции не
попадают в текст.

| Ключ | Заголовок | Откуда данные |
| --- | --- | --- |
| `summary` | Summary | Текст задачи, `completion.summary`, ветка против базы, worktree, подобранные скиллы |
| `changes` | Changed files | `git diff --name-status <base>` плюс untracked, по группам (tests, CI, docs, configuration, assets, source), плюс коммиты поверх базы |
| `acceptance` | Acceptance criteria | Таблица `acceptance_criteria`: статус, примечание, доказательства |
| `outstanding` | Outstanding | Невыполненные критерии, провалившаяся или отсутствующая верификация, блокирующие находки гигиены, незавершённая задача |
| `verification` | Verification | Последний `verify_task`: какие проверки прогонялись и с каким статусом, какие из `quality_gate` / `change_hygiene` / `frontend_qa` не прогонялись |
| `test_plan` | Test plan | `testing_strategy` и тесты фаз из плана, команды quality gate с их статусом |
| `decisions` | Decisions | `list_decisions`: решения этой задачи и те, чей файл входит в диф; чужие решения проекта — контекст, а не содержимое PR |
| `plan` | Implementation plan | `.ai-dev/plans/<task_id>.json`: обзор, число фаз и шагов |
| `checkpoints` | Checkpoints | Последние 12 чекпойнтов с числом файлов |
| `hygiene` | Change hygiene | `renderChangeHygieneMarkdown` последней проверки гигиены |

Секция «осталось» — главное, ради чего это делается детерминированно: если критерий
`blocked`, верификация провалена или гигиена блокирует, это написано в описании PR, а не
теряется между чекпойнтами.

## Шаблон репозитория

Порядок поиска повторяет сам GitHub: `.github/pull_request_template.md`,
`.github/PULL_REQUEST_TEMPLATE.md`, корневые варианты, `docs/`, затем каталоги
`.github/PULL_REQUEST_TEMPLATE/` и `.gitlab/merge_request_templates/` (внутри выигрывает
`default.md`). Параметр `template_path` задаёт шаблон явно.

Заполнение, а не замена:

- заголовок, который распознан (`## What and why` → `summary`, `## Testing` → `test_plan`),
  получает сгенерированные строки, сохраняя формулировку автора шаблона;
- чек-листы, оставшиеся под таким заголовком, переносятся под вставленный текст: они
  адресованы ревьюеру, а не нам;
- заголовки автора — `Checklist`, `Type of change`, `Screenshots`, `Breaking changes` —
  остаются нетронутыми;
- секции, которым не нашлось заголовка, дописываются в конец, чтобы ни одно доказательство
  не пропало;
- HTML-комментарии шаблона (`<!-- describe your change -->`) вычищаются: это инструкция
  тому, кто заполняет, а в заполненном файле — мусор.

## Заголовок

`type(scope): subject` в conventional-формате, не длиннее 72 символов, со строчной буквы
после двоеточия и без точки в конце — та же форма, которую проверяет линтер сообщений
коммита (C-25). Тип берётся из текста задачи (`fix`, `docs`, `test`, `refactor`, `perf`,
`ci`, `build`, `chore`, иначе `feat`), scope — из изменённых файлов: отбрасывается общий для
всех путей префикс и обёртки вроде `src`/`lib`, затем берётся каталог, под которым лежит хотя
бы половина файлов. Если изменения слишком разбросаны, scope не выдумывается. Параметр
`title` перекрывает всё это.

## База сравнения

`base_ref` ищется в таком порядке: явный аргумент (не резолвится — ошибка, а не тихий
откат), `base_ref` worktree задачи (кроме бесполезного литерала `HEAD`), `origin/HEAD`,
`origin/main`, `main`, `origin/master`, `master`. Для worktree-задачи описание пишется внутрь
worktree, рядом с веткой, которую оно описывает.

## Что инструмент не делает

Не пушит ветку, не создаёт PR, не трогает GitHub и не коммитит `.ai-dev/pr/<task_id>.md`.
Возвращает `git push -u origin <branch>` и `gh pr create --body-file <path>` как текст.
Отключить подготовку при завершении задачи можно параметром
`complete_task(prepare_pull_request: false)`.

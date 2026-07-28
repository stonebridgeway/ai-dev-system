# Auto Commands

## Frontend Product Builder

Phrase: `build frontend product`

Use for new product UI, landing pages, substantial redesigns, and any visible frontend work where visual quality matters.

```text
Use ai_dev_system MCP prompt build_frontend_product.
Call frontend_product_builder and use only its three selected skills.
Complete the Design Brief and real references, create two or three inspectable visual directions, and approve one.
Complete and approve the project design system before changing product UI code.
After implementation, run run_visual_reference_qa against approved baselines.
Inspect every screenshot, baseline, and diff through an independent reviewer.
Record all ten Product Design Scorecard dimensions without an overall score.
Finish only when frontend_product_gate gate=handoff and run_quality_gate pass.
```

Detailed policy: [[../07-quality-gates/Frontend Product Quality v2]].

## vNext Execution Rule

Natural-language commands choose the runbook, but every substantive code change now runs through
the same MCP lifecycle:

1. `begin_task`
2. implementation plus `checkpoint_task`
3. `verify_task`
4. `complete_task`

The agent loads only the one to three skills returned by the deterministic router. It does not fill
the list with loosely related semantic results. For visible frontend changes it passes
`run_frontend:true` and inspects the generated screenshots before completion.

Universal phrase:

```text
начни задачу: <что нужно сделать>
```

The agent should use MCP Prompt `start_engineering_task` or call `begin_task` directly. Existing
phrases below remain shortcuts for their domain-specific runbooks.

Auto commands are natural-language shortcuts for repeatable AI development workflows.

The user can write the phrase in chat. The agent should then use the AI Dev System MCP tools:

1. `match_auto_command`
2. `read_auto_command`
3. `recommend_skills`
4. task-specific tools such as `prepare_project`, `bootstrap_project`, `search_knowledge`, `read_skill`, or knowledge write tools

## Command Catalog

| Phrase | MCP command | Main skills | Purpose |
| --- | --- | --- | --- |
| `оформи проект для ИИ` | `format_project_for_ai` | `repo-onboarding`, `knowledge-curator`, `code-reviewer` | Turn any opened repository into an AI-ready workspace with agent files, indexed context, skill routing, and a short Project Brief. |
| `подготовь проект` | `prepare_repository` | `repo-onboarding`, `knowledge-curator` | Create agent files, sync the project card, and rebuild search. |
| `обнови память проекта` | `refresh_project_memory` | `repo-onboarding`, `knowledge-curator`, `code-reviewer` | Refresh `.ai-dev/project-brief.md`, project map, project card, and search index after project changes. |
| `начни новую фичу` | `start_feature` | `feature-builder`, `code-reviewer` | Implement a focused feature with tests and quality gate. |
| `найди баг` | `investigate_bug` | `bugfix-investigator`, `code-reviewer` | Reproduce, find root cause, add regression coverage, fix. |
| `сделай ревью` | `review_changes` | `code-reviewer` | Review changed code with findings first. |
| `улучши frontend/design` | `improve_frontend_design` | `frontend-product-builder` routes one specialist plus `frontend-quality-gate` | Complete product context, approve one of 2-3 directions, implement, compare references, and pass independent review. |
| `обнови базу знаний` | `update_knowledge_base` | `knowledge-curator` | Save durable knowledge to Obsidian. |

## Frontend Support Commands

| Phrase | MCP command | Main skills | Purpose |
| --- | --- | --- | --- |
| `поддержи frontend/beta` | `maintain_beta_frontend` | `beta-frontend-maintainer`, `frontend-quality-gate`, `code-reviewer` | Maintain existing beta frontends with minimal safe diffs and browser-aware verification. |
| `проверь frontend quality gate` | `frontend_quality_gate` | `frontend-quality-gate`, `code-reviewer`, `frontend-polisher` | Verify UI changes before handoff or release. |
| `проверь лендинг/конверсию` | `review_landing_conversion` | `landing-conversion-reviewer`, `design-taste-frontend`, `frontend-quality-gate` | Review or improve landing pages for clarity, trust, CTA flow, and conversion. |

## Skill Library Audit

| Phrase | MCP command | Main tools | Purpose |
| --- | --- | --- | --- |
| `проверь библиотеку скиллов` | `audit_skill_library` | `rebuild_index`, `validate_skill_library`, `system_health_check` | Validate Skill Schema v2, quality, relationships, routing specificity, and duplicate candidates. |

```text
проверь библиотеку скиллов
Используй ai_dev_system MCP. Если sources менялись, сначала выполни rebuild_index. Затем запусти validate_skill_library с include_duplicates:true и write_report:true. Проверь custom skills, schema/relationship errors, общие upstream-описания и кандидатов на дубли. Не удаляй и не переписывай upstream skills автоматически. Обнови search index и заверши system_health_check.
```

## User Prompts

### Format Project For AI

```text
оформи проект для ИИ
Используй ai_dev_system MCP. Найди настоящий root проекта, лучше git root. Сначала проверь текущую папку, git status и маркеры проекта, но код приложения не меняй. Выполни prepare_project с overwrite:false, include_project_map:true и include_quality_gate:true. Если repo нельзя безопасно менять, используй register_project и объясни ограничение.

Проверь, что созданы или уже существовали AGENTS.md, .ai-dev/README.md, .ai-dev/project-brief.md, .ai-dev/project-map.md и .ai-dev/quality-gate.md. Синхронизируй карточку проекта в Obsidian, перестрой или подтверди search index, прочитай созданные agent-файлы и карточку проекта. Подбери recommended skills через recommend_skills, сначала читай skill cards, если они доступны.

Не загружай весь репозиторий в чат. Сделай карту и индекс, а дальше доставай только нужный контекст через MCP/search. Не запускай команды с внешними side effects: deploy, publish, production migrations, Telegram/LLM/API calls, платежи, массовые записи. Quality gate можно показать в dry-run/read-only формате, если нет явного разрешения на запуск.

В конце дай Project Brief:
- имя проекта, root path и git status;
- что создано и что уже было;
- стек, важные папки, entry points и основные потоки;
- install/dev/test/lint/typecheck/build/quality commands;
- recommended skills для будущей разработки;
- риски, пробелы и что улучшить следующим;
- какую следующую команду лучше использовать: начни новую фичу, найди баг, сделай ревью, улучши frontend/design или обнови базу знаний.
```

### Refresh Project Memory

```text
обнови память проекта
Используй ai_dev_system MCP. Найди настоящий root проекта, лучше git root. Код приложения, зависимости, lockfiles, тесты и форматирование не меняй.

Запусти refresh_project_memory с overwrite:true, update_registry:true, register_if_missing:true и rebuild_search:true. Проверь, что обновились .ai-dev/project-brief.md и .ai-dev/project-map.md, карточка проекта в Obsidian и search index.

В конце дай короткий отчёт:
- какие memory-файлы обновлены;
- текущий профиль проекта: frontend/backend/mobile/bot/API, стек и основные команды;
- missing quality gates;
- dangerous/side-effectful scripts;
- README/docs/env/secrets risks;
- recommended next commands.
```

### Prepare Repository

```text
подготовь проект
Используй ai_dev_system MCP. Найди настоящий repo root, запусти prepare_project с overwrite:false. Убедись, что AGENTS.md, .ai-dev/project-map.md и .ai-dev/quality-gate.md созданы или уже существовали, карточка проекта синхронизирована в Obsidian, search index перестроен. Код приложения не меняй. В конце дай статус готовности проекта и следующие улучшения.
```

### Start Feature

```text
начни новую фичу: <описание>
Используй match_auto_command, recommend_skills и feature-builder. Сначала изучи AGENTS.md, project-map, quality-gate и похожий код. Реализуй минимально, добавь/обнови тесты, запусти релевантные проверки.
```

### Investigate Bug

```text
найди баг: <симптом/ошибка>
Используй bugfix-investigator. Сначала воспроизведи или локализуй причину, потом исправляй. Если возможно, добавь regression test. Не маскируй ошибку широким try/except или ослаблением тестов.
```

### Review Changes

```text
сделай ревью
Смотри diff/изменённые файлы. Выводи findings first: баги, регрессии, missing tests, security/data risks. Код не меняй, если я отдельно не попрошу исправить.
```

### Improve Frontend/Design

```text
улучши frontend/design: <экран/компонент>
Используй prompt `build_frontend_product` и MCP `frontend_product_builder`. Загружай только три выбранных им совместимых skill. Заполни обязательный Design Brief и реальные references, создай 2-3 визуальных направления в Figma или изображениях и утверди одно через `approve_frontend_direction`.

Заполни design-system, ui-inventory и visual-acceptance, затем вызови `approve_frontend_design_system` и проверь implementation gate до изменения UI-кода. После реализации запусти `run_visual_reference_qa`, просмотри каждый screenshot/baseline/diff независимым reviewer, запиши все 10 измерений через `record_visual_review` и пройди handoff gate. Обычный `run_frontend_qa` и единая оценка 8/10 не являются доказательством продуктового качества.
```

### Maintain Beta Frontend

```text
поддержи frontend/beta: <экран/компонент/тикет>
Используй ai_dev_system MCP. Сначала match_auto_command/read_auto_command, затем recommend_skills. Прочитай beta-frontend-maintainer и, если меняется визуальная поверхность, frontend-quality-gate. Изучи AGENTS.md, .ai-dev/project-brief.md, .ai-dev/project-map.md и .ai-dev/quality-gate.md. Сделай минимальный безопасный diff по существующим компонентам, токенам, хукам и API-клиентам. Проверь desktop/mobile и важные состояния через run_frontend_qa, если проект запускается. В конце дай changed files, checks, browser verification и риски.
```

### Frontend Quality Gate

```text
проверь frontend quality gate
Используй ai_dev_system MCP и skill frontend-quality-gate. Прочитай .ai-dev/quality-gate.md, package scripts и измененные файлы/экраны. Запусти доступные lint/typecheck/test/build, проверь desktop/mobile, keyboard/focus, accessibility, loading/empty/error/validation/disabled/success states. Верни Gate: pass, warn или block с evidence и skipped checks.
```

Frontend quality gate should use `run_frontend_qa` when the app can run:

```json
{
  "project_path": "<repo-root>",
  "routes": ["/"],
  "take_screenshots": true,
  "write_report": true,
  "update_registry": true
}
```

If the project has no Playwright dependency yet, report the `warn` result and the install command instead of pretending browser QA passed.

### Landing Conversion Review

```text
проверь лендинг/конверсию: <страница>
Используй ai_dev_system MCP и skill landing-conversion-reviewer. Определи offer, audience, conversion goal, proof и assumptions. Проверь hero, CTA, trust, objections, section flow, mobile readability, SEO basics и честность claims. Если вносишь код, используй существующую дизайн-систему и затем frontend-quality-gate + run_frontend_qa. Не выдумывай отзывы, логотипы, метрики или искусственную срочность.
```

### Update Knowledge Base

```text
обнови базу знаний
Сохрани только долговечные выводы: команды, архитектурные решения, риски, стандарты, project-specific lessons. Не сохраняй секреты, догадки и временный шум.
```

## Agent Rule

When a user phrase resembles one of these commands, do not rely on memory. Use `match_auto_command` and `read_auto_command` first, then execute the matched runbook.

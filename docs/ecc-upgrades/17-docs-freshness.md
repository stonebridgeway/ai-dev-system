# 17. Свежесть документации как правило гигиены

Пункт [3.6 плана](PLAN.md), позиция C-36 в [gap-анализе](ECC-GAP-ANALYSIS.md).

## Идея из ECC

`commands/update-docs.md` и `skills/living-docs-governance` держат документацию рядом с
кодом: у ECC есть staleness check — сверка того, что документ описывает, с тем, что в
репозитории сейчас, и роли документов (constitution / map / status / history).

Переносится не сверка целиком, а её дешёвая половина: если ход изменил публичную поверхность,
а ни один документ не тронут, об этом нужно сказать сразу, пока изменение ещё в рабочем дереве.
Полная синхронизация текста с истиной (инструмент `sync_project_docs`) остаётся отдельной
позицией.

## Что появилось в коде

| Файл | Роль |
| --- | --- |
| `ai-dev-mcp-server/src/core/change-hygiene.mjs` | `PUBLIC_INTERFACE_PATTERNS`, `findInterfaceSignals`, находка `docs_stale` в `analyzeChangeSet` |
| `ai-dev-mcp-server/src/extensions/hygiene.mjs` | Описание инструмента: правило видно в схеме `verify_change_hygiene` |

Тесты: `src/core/change-hygiene.test.mjs` — `findInterfaceSignals` на девяти объявлениях и
пяти строках, которые объявлением не являются, и `docs_stale` на трёх change set (сработало,
документ приложен, менять было нечего).

## Что считается публичной поверхностью

Три сигнала, ровно те, что названы в плане.

| Сигнал | Что ловит |
| --- | --- |
| `export` | `export function/class/const/interface/type`, `export { … }`, `module.exports`, модульные `def`/`class` в Python без ведущего подчёркивания, `__all__`, `pub fn/struct/trait` в Rust, `func Name(` с заглавной в Go, `public`/`protected` члены в Java, Kotlin, C#, Swift, PHP |
| `tool_schema` | `inputSchema` — контракт MCP-инструмента |
| `cli_flag` | объявление флага (`.option`, `add_argument`, `StringVar`) и его разбор (`case "--json"`, `argv.includes("--check")`) |

Ловятся только **объявления**. Строка внутри экспортированной функции поверхность не меняет,
а `git(root, ["diff", "--no-color"])` — это флаг чужой программы, а не наш, и правило на него
не реагирует. Тесты, `node_modules/`, `vendor/`, `dist/` и сама документация носителями
поверхности не считаются: сигнал ищется только в коде (расширения `SOURCE_EXTENSIONS` плюс
`.sh`, `.bash`, `.zsh`, `.ps1`). Данные — JSON, YAML — исключены намеренно: ключ схемы там
столь же часто фикстура, сколь контракт.

Документ — это `.md`, `.mdx`, `.rst`, `.adoc`, `.txt` или любой файл под `docs/`,
`doc/`, `documentation/`. `README.md` и `CHANGELOG.md` подходят под первое правило.

## Находка

```json
{
  "rule": "docs_stale",
  "severity": "warn",
  "file": "",
  "line": 0,
  "message": "The public interface changed (exports, CLI flags) but no documentation file changed. …",
  "excerpt": "",
  "files": ["src/api.ts", "scripts/cli.mjs"]
}
```

Форма — та же, что у остальных находок (`{ rule, severity, file, line, message, excerpt }`),
плюс `files` со списком файлов, как у `no_test_changes`; список обрезается на двадцати путях.
В `summary` добавились два счётчика: `interface_files` и `documentation_files`.

`warn` не роняет `verify_task` — его роняет только `block`. По договорённости
скилла `verification-loop` предупреждение нужно либо закрыть, либо объяснить в заметке
чекпойнта; с появлением линтера заявлений (пункт 3.17) объяснение проверяется на
рационализации.

## Почему warn, а не info

Правило шумное по своей природе: любой ход, добавивший экспорт, попадает под него. Это и есть
намерение — «добавил поверхность, скажи о ней» — и цена ошибки здесь несимметрична: лишнее
предупреждение стоит одной строки в заметке, а недописанный README живёт месяцами. Порог
снижен единственным способом, который не ослабляет правило: сигналом считается объявление, а
не любое упоминание.

# 15. Линтер заявлений о завершении и самооценка агента

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

Пункт [3.17 плана](PLAN.md), раздел C-3 в [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md).

## Идея из ECC

В ECC две половины. Первая — `skills/delivery-gate/hooks/quality-gate.py`: хук на `Stop` ловит
в отчёте агента регулярные выражения `RATIONALIZE` («pre-existing issue», «skipping tests for
now», «tests failing but I'll fix later», «works on my machine») и не даёт закончить сессию.
Вторая — `skills/agent-self-evaluation/scripts/evaluate.py`: оценка собственной работы с
`verified_patterns` и `danger_patterns` («should work», «I think», «untested», TODO/FIXME),
вычетами и вердиктом, плюс `agents/agent-evaluator.md` и `references/evaluation-criteria.md`.

Хук ECC смотрит только на текст: он не знает, прогонялись ли тесты на самом деле, поэтому
честный отчёт о красной проверке для него неотличим от отговорки. У нас проверки уже записаны
и привязаны к git-состоянию (`verify_task`, `src/core/evidence.mjs`), поэтому перенесена идея,
а не реализация: **фраза становится проблемой только тогда, когда проверка, которая её бы
закрыла, не прошла**.

## Что появилось в коде

| Файл | Роль |
| --- | --- |
| `ai-dev-mcp-server/src/core/completion-claims.mjs` | Таблица рационализаций как данные, чтение сигналов из записи задачи, разбор политики, сам линтер и текст отказа |
| `ai-dev-mcp-server/src/mcp-stdio.mjs` | `auditCompletionClaims` и вызовы в `checkpoint_task` и `complete_task`; результат возвращается полем `completion_claims` |
| `ai-dev-mcp-server/src/core/agent-hooks.mjs` | Блок `completion_claims` в дефолтном `.ai-dev/policy.json` с комментарием, как его отключить |
| `docker/public-seed/.../custom/self-evaluation/SKILL.md` | Seed-скилл: пять осей, таблица «заявление → чем подтверждается», пост-действия по среднему баллу |

Тесты: `src/core/completion-claims.test.mjs` (13 — честные формулировки, все двенадцать правил,
красная и зелёная проверка, устаревшая верификация, waiver с причиной и без, истёкший waiver,
выключение через политику, битый JSON), `src/completion-claims-lifecycle.test.mjs` (3 — сквозь
`checkpoint_task` / `verify_task` / `complete_task` на git-фикстуре), плюс проверка по протоколу
в `scripts/lifecycle-smoke.mjs`. Покрытие модуля: 100 % строк, 91 % ветвей, 95 % функций.

## Правило

Линтер читает `summary` и `notes` и сопоставляет каждое сработавшее правило с сигналом ворот из
последней верификации задачи:

| Сигнал | `true` | `false` | `null` |
| --- | --- | --- | --- |
| `verification` | последний `verify_task` прошёл и привязан к текущему состоянию | прошёл неудачно или устарел | не запускался |
| `quality_gate` | проверка `quality_gate` со статусом `passed` | другой статус | не было в прогоне |
| `change_hygiene` | статус не `block` | `block` | не было в прогоне |
| `frontend_qa` | `gate: "pass"` | иначе | не было в прогоне |

Заявление подтверждено только при `true`. `null` — это не «нейтрально»: проверка, которую никто
не запускал, ничего не доказывает, поэтому «tests are failing but I'll fix them later» без
прогона тестов блокирует так же, как при красных тестах.

- Ворота прошли → находка `warn`: доказательство есть, формулировка его занижает.
- Ворота не прошли → находка `block`, вызов отклоняется с текстом: какое правило, какие ворота,
  что сделать.

Отклонение происходит **до** записи: отвергнутый чекпойнт не попадает в задачу.

## Двенадцать правил

Список лежит в `RATIONALIZATION_PATTERNS` — данные, а не код: `{ id, gate, claim, proof, pattern }`.

| Правило | Ворота | Что ловит |
| --- | --- | --- |
| `pre_existing_failure` | `verification` | «pre-existing issue», «was already failing», «not caused by my change», «падало и до меня» |
| `tests_deferred` | `quality_gate` | «skipping tests for now», «will add tests later», «пока без тестов» |
| `tests_failing_deferred` | `quality_gate` | «tests are failing but I'll fix them later», «suite is red, however…» |
| `works_on_my_machine` | `verification` | «works on my machine», «works locally», «у меня всё работает» |
| `unverified_claim` | `verification` | «should work», «I think it works», «probably fine», «должно работать» |
| `untested_change` | `quality_gate` | «untested», «couldn't run the tests», «не проверял» |
| `unrelated_or_flaky` | `verification` | «unrelated to my change», «flaky», «random failure», «флак» |
| `suppressed_check` | `change_hygiene` | «disabled the lint rule», `--no-verify`, «added an @ts-ignore» |
| `leftover_marker` | `change_hygiene` | TODO/FIXME/HACK в самом отчёте без ссылки на задачу |
| `good_enough` | `verification` | «good enough for now», «quick and dirty», «временный костыль» |
| `ui_unchecked` | `frontend_qa` | «didn't check the UI», «layout should be fine», «вёрстку не проверял» |
| `manual_only` | `quality_gate` | «verified manually», «manual testing only», «проверил вручную» |

Выражения намеренно узкие: честный отчёт о красной проверке («3 tests fail in auth.test.ts,
fixing them now») не срабатывает ни на одном правиле. Это отдельный тест, а не пожелание.

## Отключение и waiver

`.ai-dev/policy.json`, ключ `completion_claims`:

```jsonc
{
  "completion_claims": {
    "enabled": true,
    "waivers": [
      {
        "rule": "tests_deferred",
        "reason": "Интеграционный набор требует staging-базы, которой нет у раннера; OPS-1421.",
        "expires": "2026-12-31"
      }
    ]
  }
}
```

- `"completion_claims": false` или `{ "enabled": false }` выключает линтер целиком.
- Waiver снимает одно правило (`"*"` — все) и требует двух вещей сразу: причины в политике
  (не короче 20 символов) и той же причины, выписанной в самом отчёте («reason: …», «because …»,
  «причина: …»). Waiver без причины в отчёте не применяется — именно чтобы «настоящая причина»
  оставалась записанной там, где её читают.
- `expires` необязателен; истёкший waiver перестаёт действовать сам.
- Неизвестное правило, слишком короткая причина, нечитаемая дата и битый JSON не выключают
  линтер молча: он остаётся включённым, а причина попадает в `completion_claims.warnings`.

## Seed-скилл `self-evaluation`

`docker/public-seed/03-skills-catalog/sources/custom/self-evaluation/SKILL.md`, Skill Schema v2,
оценка качества **100/100** (грейд A, `status: pass`, зрелость `reviewed`) при требуемых 80.

Пять осей (Correctness, Evidence, Scope, Robustness, Maintainability) по шкале 1–5; у каждой
оси сначала цитата доказательства, потом балл, а оценка ниже 5 обязана цитировать конкретный
пробел — файл и строку, упавшую проверку, недостающий тест. Таблица «заявление → чем
подтверждается» разбирает одиннадцать типовых фраз отчёта. Пост-действия по среднему: ≥ 4.5 —
`complete_task`; 3.5–4.4 — закрыть пробелы и переоценить; 2.5–3.4 — вернуться к реализации;
< 2.5 — начать заново через `plan_task`.

Подключение: раздел «Complete» в `ai-dev-orchestrator` и конец `verification-loop` отправляют к
нему перед `complete_task`. Отдельного правила в роутере нет намеренно — лимит в три скилла
принадлежит задаче, а не самопроверке.

## Чего линтер не делает

- Не читает код и не судит о качестве изменения: он сопоставляет текст отчёта с уже записанными
  проверками, не более.
- Не оценивает сам (нет «вердикта redo» из `evaluate.py`): балльная часть ECC живёт в скилле,
  где её ставит агент с цитатами, а в сервере остаётся детерминированная половина.
- Не трогает `verify_task`: тот работает с проверками, а не с текстом. Чекпойнт, который
  `verify_task` пишет сам («Automated verification passed.»), линтер не проходит и не должен.

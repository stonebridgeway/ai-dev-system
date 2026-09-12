# 13. Импорт каталога скиллов ECC (`external/ecc`)

> **Путь `src/mcp-stdio.mjs` ниже — исторический.** Документ описывает, как это строилось,
> когда почти весь код сервера лежал в одном модуле. Этап 1 плана вынес его в `src/core/*` и
> `src/extensions/*`; где какой код сейчас — [CODE-MAP.md](CODE-MAP.md).

Пункт [3.1 плана](PLAN.md). Каталог ECC (`affaan-m/ECC`, MIT) содержит 291 скилл в
`skills/<name>/SKILL.md`. Многие из них — готовые методики разработки, которых у нас нет:
`tdd-workflow`, `error-handling`, `api-design`, `database-migrations`, `contract-first`,
`hexagonal-architecture`, `intent-driven-development`, `production-audit`, языковые
`*-patterns` и `*-testing`. Остальное — бизнес-домены, регулируемые отрасли, медиа,
навигация по самому ECC и воркфлоу, которым нужны субагенты Claude Code или внешние MCP.

Скопировать дерево целиком нельзя: полезная сотня утонет, а непроверенные доменные
инструкции попадут в роутинг скиллов. Поэтому импорт стал выборочным.

## Что появилось в коде

`import_skill_repo` получил режим отбора; правила живут отдельным модулем.

| Файл | Роль |
| --- | --- |
| `ai-dev-mcp-server/src/core/skill-import-policy.mjs` | Политика отбора: пороги, группы исключений с цитатами, план импорта, стейджинг выбранных каталогов |
| `ai-dev-mcp-server/src/core/skill-import-policy.test.mjs` | 14 тестов: правила, приоритет ворот, конфликты имён, чтение и стейджинг дерева |
| `ai-dev-mcp-server/src/mcp-stdio.mjs` | `importSelectedSkills`: клон во временный каталог, план, стейджинг, `upstream.json`, `rebuild_index` |
| `ai-dev-mcp-server/src/skill-quality.mjs` | `inferTrustLevel` уважает `trust_level`, объявленный вендором; `instruction_policy` доходит до реестра |
| `ai-dev-mcp-server/scripts/refresh-public-seed.mjs` | `npm run docker:seed` переносит `external/ecc` в чистый seed |

Новые параметры инструмента:

```jsonc
{
  "repository_url": "https://github.com/affaan-m/ECC",
  "source_group": "external",
  "name": "ecc",
  "select_skills": true,       // включает отбор; без него поведение прежнее
  "min_quality_score": 75,     // порог оценки качества
  "dry_run": true              // показать план, ничего не записывая
}
```

`parseFrontmatter` переехал из `mcp-stdio.mjs` в модуль политики как
`parseSkillFrontmatter` — план импорта и реестр обязаны видеть одно и то же имя скилла.

## Четыре ворот, в этом порядке

1. **`excluded-by-rule`** — скилл попадает в группу, которую мы не берём. Проверяется до
   всего остального: качество доменного скилла роли не играет.
2. **`name-conflict`** — имя уже занято скиллом каталога. Побеждает наш; чужой не
   импортируется, поэтому в роутинг он попасть не может физически.
3. **`privacy-finding`** — каталог скилла не проходит приватный аудит публичного seed
   (`auditDistributionTree`). Такой скилл не может ехать в образе.
4. **`below-quality-floor`** — структурная оценка ниже `min_quality_score` (по умолчанию 75).

Всё, что прошло, копируется дословно. Ничего не пишется в vault, пока план не построен.

## Группы исключений

Источник — раздел D в [ECC-GAP-ANALYSIS.md](ECC-GAP-ANALYSIS.md) и §4.2 [плана](PLAN.md).
Каждая группа хранит `reason` и ссылку на строку разбора, поэтому решение можно оспорить
по одному скиллу, а не по всей куче.

| Группа | Скиллов | Почему |
| --- | --- | --- |
| `domain-business` | 39 | Бизнес, юридические и маркетинговые операции, не движок разработки |
| `regulated-and-niche-domains` | 36 | Healthcare, крипто, наука, сети, homelab |
| `ecc-self-service` | 25 | Навигация и самоаудит ECC, управление терминалом хоста |
| `superseded-by-ai-dev-system` | 24 | Дублируют наши модули: память, инстинкты, guard, evals, валидация каталога |
| `media-creative` | 14 | Видео, анимация, креатив; части нужны внешние медиа-API |
| `agent-orchestration` | 11 | Раздают фазы субагентам Claude Code — это работа раннера |
| `external-mcp-dependent` | 10 | Требуют Context7 / Exa / Firecrawl; сервер работает офлайн |
| `agent-loops` | 6 | Циклы «пока не готово» и наблюдатели транскриптов |
| `ecc-operator-surfaces` | 2 | Локальные браузерные и десктопные UI |
| `oversized-for-seed` | 1 | `angular-developer`: 36 файлов справочника, разбор прямо называет это бессмысленным для seed |

**Не исключены намеренно**: языковые, фреймворковые и базовые справочники, а также
`coding-standards`, `git-workflow`, `error-handling`, `api-connector-builder`,
`hexagonal-architecture`. Раздел D называет их «подключаются через `import_skill_repo`» —
они там потому, что не требуют ручного портирования, а это ровно то, что делает импорт.

**Решения сверх буквального списка раздела D** (каждое — по категории, названной в §4.2):
`orch-*`, `santa-method`, `opensource-pipeline` (субагенты), `ck`, `knowledge-ops`
(дублируют память сервера), `skill-comply`, `skill-stocktake`, `workspace-surface-audit`,
`terminal-opener` (самоаудит ECC и терминал хоста), `master-agreement-generator`,
`counterparty-channel-discipline`, `esign-field-placement`, `operator-approval-loop`
(договорные и коммуникационные операции), `taste-application`, `taste-distillation`
(видеогенерация через fal.ai), `continuous-learning-v2` (фоновый разбор транскриптов —
это пункт 3.5, который мы делаем сами).

## Результат прогона

Коммит ECC `c9148d0bb239ed01a95724a5928b98cdf9c30658`, 291 кандидат.

| Исход | Скиллов |
| --- | --- |
| Импортировано | 101 |
| Отсеяно по правилам | 168 |
| Отсеяно по качеству (< 75) | 17 |
| Отсеяно приватным аудитом | 4 |
| Конфликт имени | 1 |

Отсев по качеству: `bun-runtime` (50), `csharp-testing` (54), `springboot-verification` (55),
`hookify-rules` (56), `e2e-testing` (59), `frontend-patterns` (59), `fsharp-testing` (59),
`kotlin-exposed-patterns` (60), `laravel-tdd` (65), `design-system` (70), `canary-watch` (71),
`dotnet-patterns` (71), `nextjs-turbopack` (71), `perl-testing` (71), `quarkus-verification` (71),
`swift-actor-persistence` (71), `vite-patterns` (71).

Приватный аудит: `django-tdd`, `frontend-a11y`, `kubernetes-patterns`, `security-review` —
у каждого в тексте пример вида `password = "..."`, который правило `assigned-credential`
не отличает от настоящего секрета. Ослаблять аудит ради них не стали.

Конфликт имени: ECC `verification-loop` против нашего `custom:verification-loop` —
остаётся наш.

Каталог: 141 скилл (25 custom, 13 design, 103 external), дубликатов имён нет.

## Доверие: инструкции — это данные

`upstream.json` объявляет `trust: known-upstream` и
`instruction_policy: data-until-review`; `collectExternalSkills` переносит оба поля на
каждый скилл, `recommend_skills` их отдаёт, а `compatibility` в человекочитаемых таблицах
читается как «read as reference until a local review promotes it».

Коммит запинён, то есть известно, что именно скопировано, — но никто эти сто скиллов не
читал. Поэтому уровень доверия `known-upstream`, а не `pinned-upstream`: пин доказывает
происхождение, а не то, что содержимое проверено.

### Эти две метки ничего не запрещают

Сказать прямо, потому что читается иначе (Д-7): `trust` и `instruction_policy` —
**метаданные, а не механизм**. Ни одна строка кода не спрашивает `instruction_policy`
перед тем как что-то сделать или не сделать. Метки доходят до реестра, до выдачи
`recommend_skills` и до карточки скилла — и на этом их действие заканчивается. Если
`data-until-review` поменять на `trusted`, поведение сервера не изменится ни в чём.

Ограничивает попадание чужого текста в контекст другое, и это устройство, а не метка:

- **Контекст-пак не подставляет тело скилла.** `compileContextPack`
  (`src/core/context-compiler.mjs`) рендерит по каждому маршрутизированному скиллу три
  вещи — имя, источник и причину маршрута:
  `` - `tdd-workflow` (external/ecc): … ``. Сто один импортированный текст сам по себе в
  контекст не попадает никогда, сколько бы их ни было в каталоге.
- **Путь отдаётся, чтение — осознанное действие.** В объекте пака у скилла есть `path`,
  поэтому агент может открыть файл сам. Это и есть задуманная граница: импортированный
  скилл — предложение почитать, а не инструкция, которая уже в контексте.
- **Свой скилл впереди чужого.** Импорт, повторяющий имя нашего скилла, в роутинг не
  попадает (`pickTaskSpecialist`), а импортированному специалисту дан один отдельный слот
  рядом с нашей тройкой, а не вместо кого-то из неё (Д-1).
- **Оценка качества влияет на ранг, а не на доверие.** `skillQualityRankAdjustment`
  опускает `maturity: draft` и `quality_status: fail`; это про уместность, а не про то,
  можно ли верить содержимому.

То есть безопасность здесь построена на том, что чужой текст не оказывается в контексте сам,
а не на обещании, что он безвреден. Метки полезны как инвентарь: по ним видно, что в каталоге
есть непрочитанное. Строить на них решение — ошибка.

## Что осталось открытым

- 48 импортированных скиллов имеют `quality_status: fail` при оценке ≥ 75: единственная
  ошибка — `missing-workflow`. Это справочники паттернов (`kotlin-patterns`,
  `laravel-patterns`, `mcp-server-patterns`, …), а не процедуры; наша схема качества такой
  профиль не описывает. Порог задан оценкой, поэтому они в каталоге, но получают
  `maturity: draft` и −30 к рангу роутинга, то есть наши custom-скиллы всегда впереди.
  Либо схема получает профиль «reference», либо их надо переписать под workflow.
- Ручное ревью импортированных скиллов не проводилось: до него их текст — справочный
  материал. Промотировать по одному через `sync_skill_overlays`
  (`trust_level`, `maturity`).
- Детерминированный роутер (`src/core/skill-router.mjs`) по-прежнему знает только
  custom-скиллы по именам. Импортированные доступны через реестр, `recommend_skills` и
  `hybrid_search`, но правил роутинга для них нет — это отдельная работа.

## Обновление каталога

```bash
# посмотреть план на текущем HEAD апстрима, ничего не записывая
import_skill_repo { repository_url: …, name: "ecc", select_skills: true, dry_run: true }

# пересобрать выборку под новый коммит апстрима
import_skill_repo { repository_url: …, name: "ecc", select_skills: true, update_if_exists: true }

node scripts/verify-public-seed.mjs --write   # манифест seed
```

Стейджинг пересоздаёт `skills/` целиком, поэтому скилл, который политика больше не
выбирает, из каталога исчезает, а не остаётся лежать.

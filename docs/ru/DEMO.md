# Демо — одна задача от начала до конца

[← README](../../README.ru.md) · [Установка](INSTALL.md) · [Рабочий процесс](WORKFLOW.md) · [Возможности](CAPABILITIES.md)

**«Добавить авторизацию в API».** Одна задача — от первой команды до закрытой,
включая тот момент, когда всё идёт не так.

Всё, что ниже, — настоящий вывод. Вы можете получить его сами из клона
репозитория за несколько секунд, не устанавливая MCP-клиент и не трогая свои
репозитории:

```bash
cd ai-dev-mcp-server
npm ci          # один раз, в свежем клоне
npm run demo
```

Скрипт создаёт одноразовый проект API во временной папке, прогоняет задачу через
настоящий сервер — его runtime home, состояние и поисковый индекс лежат в той же
папке — и удаляет за собой всё, что создал. Оставить он может одно: реестр skills
клона. Если его нет или он устарел, демо сначала строит его, как это делает
`npm run setup`, — в три папки `docker/public-seed/03-skills-catalog`, которые git
игнорирует: `registries/` и при нём `groups/` и `cards/`.

---

## 1. Вы даёте агенту задачу

```text
begin_task — «Add authentication to the API»
```

```text
task task-20261019T003825-989724d2 is open

It loaded the project, without being told about it:
  stack Node.js, 4 relevant files read
    package.json - project configuration
    src/routes.mjs - application source
    src/server.mjs - application source

It routed 3 skills out of 614 - nobody named them:
  feature-builder (workflow)
  application-security-reviewer (domain)
  secrets-dependencies-auditor (verification)

And it wrote down what finished has to mean:
  AC-1 Requested behavior is implemented within the stated scope: Add authentication to the API
  AC-2 Relevant automated checks pass or every unavailable check has a recorded reason.
  AC-3 No known regression, unresolved error, placeholder, or unrelated refactor remains.
```

Никто не говорил «это Node-проект», «прочитай эти файлы» или «возьми
security-ревьюера». Пять слов описания дали скомпилированный пакет контекста, три
маршрутизированных skill из 614 и записанное определение готовности.

## 2. Агент пишет код — и ошибается

В middleware авторизации настоящая ошибка: запрос без токена пропускается как
анонимный вместо того, чтобы быть отклонённым.

```text
checkpoint_task

checkpoint recorded, snapshot-1 holds 3 files at commit 1d46c9f7
nothing was written to your branch, stash or index - rollback_task can undo this turn
```

Снапшот — это commit-объект, на который не указывает ни одна ветка, под
`refs/ai-dev/snapshots/<task_id>/`. Ваши ветка, stash и индекс не тронуты, а
`rollback_task` вернёт этот ход ровно как было.

## 3. Агент пытается заговорить проблему

Ради этого момента продукт и существует. Агент сдаёт отчёт, в котором работа
сделана, а падение — чужое:

> *«Authentication is done. One test is failing but it's a pre-existing issue,
> will fix later.»*

```text
REFUSED - the report claimed more than the evidence showed

The report claims more than the evidence shows: 2 rationalizations are not backed by a passing check.
- pre_existing_failure in notes: The report calls a failure pre-existing; the latest verify_task run
  never ran. Show it on the base ref and record a passing verify_task for this change.
  Quoted: "…ne test is failing but it's a pre-existing issue, will fix later."
- tests_failing_deferred in notes: The report leaves a red test for later; the project quality gate
  (verify_task with run_quality) never ran. Make the suite green before the report claims the change
  is done. Quoted: "One test is failing but it's a pre-existing issue, will fix later."
Fix the check and run verify_task again, or rewrite the report to say what actually happened. If the
reason is real, state it in the report ("reason: …") and waive the rule in .ai-dev/policy.json:
{"completion_claims":{"waivers":[{"rule":"pre_existing_failure","reason":"…"}]}}
```

Два названных правила, проверка за каждым из них, фраза, которая его вызвала, и
что именно его удовлетворит. Чекпоинт не записан. Если причина действительно
реальна, отказ говорит, что делать: написать её в отчёт и отключить правило в
`.ai-dev/policy.json` — осознанно, в файле, который можно отревьюить, а не удачной
формулировкой.

## 4. Проверка запускает собственные команды проекта

```text
verify_task

FAILED - quality_gate: failed, change_hygiene: warn, security_scan: unchecked

not ok 1 - a request with no token is rejected
  ---
  duration_ms: 1.498086
  type: 'test'
  location: '/tmp/.../test/auth.test.mjs:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    200 !== 401

# tests 3
# pass 2
# fail 1
```

Quality gate запустил тестовую команду самого проекта — `node --test`, прочитанную
из `.ai-dev/quality-gate.md`, а не угаданную. Заложенную ошибку ловит тест,
который агент написал сам.

`security_scan: unchecked` получает машина, на которой не установлен ни один сканер
безопасности, — как та, где записан этот прогон: ни один сканер не запускался, поэтому
ничто не названо чистым, а проверку это не останавливает. С установленным сканером —
gitleaks работает без сети — в строке стоит его вердикт.

## 5. Агент чинит настоящую ошибку

```js
if (token === "Bearer demo-token") return { ok: true };
return { ok: false, reason: "missing or invalid token" };
```

## 6. Проверка ещё раз

```text
verify_task

PASSED - quality_gate: passed, change_hygiene: warn, security_scan: unchecked
recorded as verification-1792370306204-0690efa3
```

`change_hygiene` остаётся в `warn` — он заметил, что публичный интерфейс
изменился, а документация нет. Предупреждение сообщается, но не фатально;
находка уровня `block` остановила бы завершение.

## 7. Вот теперь задачу можно закрыть

```text
complete_task

task complete
pull request description written to .ai-dev/pr/task-20261019T003825-989724d2.md
  title: feat(src): add authentication to the API
```

Описание pull request собрано из доказательств, которые собрала задача, а не
написано по памяти:

```markdown
## Verification

Latest run `verification-1792370306204-0690efa3` at 2026-10-19T00:38:26.204Z: **passed**.

| Check | Result |
| --- | --- |
| `quality_gate` | passed |
| `change_hygiene` | warn |
| `security_scan` | unchecked |

Not run: `frontend_qa`.

2 verification run(s) recorded; the latest one is the one that counts.
```

Там же — краткое описание, изменённые файлы по группам, каждый критерий приёмки
с проверкой, которая его закрыла, чекпоинты по порядку и находки change hygiene.
Ничего не пушится и pull request не открывается: команды `git push` и
`gh pr create` возвращаются текстом, чтобы выполнить их самому.

Если бы `complete_task` вызвали до шага 6, ответ был бы таким:

```text
The latest verification (verification-…) failed. Fix the problem and run verify_task again.
```

---

## Что показывает этот прогон

| Шаг | Что обычно делает агент | Что произошло здесь |
| --- | --- | --- |
| 1 | Спрашивает про проект или угадывает | Скомпилировал контекст и выбрал 3 skill по пяти словам |
| 2 | Правит на месте; неудачный ход разбирать вам | Снял снапшот хода вне вашей ветки и stash |
| 3 | *«Это pre-existing, починю позже»* | Отказал, назвав правило и недостающую проверку |
| 4–6 | Говорит, что тесты проходят | Запустил собственный gate проекта и показал вывод |
| 7 | *«Готово!»* | Закрыл по записанным доказательствам и собрал из них PR |

## Как это записать

`npm run demo` и есть запись. Весь прогон занял 2,5–3,1 секунды на Xeon
2,1 ГГц — около 4, когда сначала строился реестр skills, — MCP-клиент не нужен, и
после него не остаётся ничего, кроме этого реестра.

- `npm run demo -- --no-color` — чистый текст, например чтобы вставить в issue.
- Каждая сцена помещается в 40 строк, но не в 80 колонок: строки отказа на шаге 3
  длиной почти 300 символов.
- Шаги 3 и 4 стоит задержать: отказ и падающий тест — это то, чего люди от
  агента ещё не видели.

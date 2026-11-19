# Локальный AI Dev MCP в Docker

Этот образ запускает AI Dev MCP через локальный `stdio`. Он не открывает TCP-порт и не требует
удаленного сервера. Любая модель может использовать его через MCP-совместимый локальный хост:
Codex, Cursor, Claude Desktop/Code, Gemini CLI/Code Assist, VS Code или другой клиент с поддержкой
MCP tools.

Сама модель не подключается к MCP напрямую. Инструменты ей передает MCP-хост, в котором выбрана
модель.

Пошаговая установка для каждой системы и каждого клиента — в
[docs/ru/INSTALL.md](../docs/ru/INSTALL.md); здесь — как устроен образ и что из этого следует.

## Граница приватности

Образ — это дистрибутив, который делает `npm run dist`, и ничего больше:

- MCP-сервер и его зафиксированные npm-зависимости — только для своей платформы:
  `onnxruntime-node` без библиотек macOS, Windows и чужой архитектуры;
- чистые правила, промпты, quality gates и шаблоны;
- публичный seed — 614 навыков: Membrane 460, ECC 101, свои 28, дизайн (taste-skill) 13, Understand Anything 9,
  ui-ux-pro-max, mattpocock и Archify — по одному; все под MIT ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md));
- раннер Frontend QA; Playwright и Chromium — только в варианте `-browser`;
- `gitleaks` для `run_security_scan` без сети.

Python в образе нет: `query_ui_ux_knowledge` и `generate_ui_ux_design_system`, которые запускают
собственный Python-скрипт набора UI UX Pro Max, отвечают в контейнере, что Python не найден, а
проверка здоровья помечает `ui_ux_knowledge` пропущенной. Остальное от Python не зависит.

В образ не входят:

- пароли, токены, `.env` и приватные ключи;
- `02-knowledge/Projects` и `02-knowledge/Task Runs`;
- локальные `.ai-dev`, `.codex`, `.obsidian` и Git history;
- логи, артефакты, кэши сборки и бэкапы;
- личный Obsidian Vault;
- исходники пользовательских проектов;
- веса модели BGE-M3.

Сборка получает не корень Vault и не корень репозитория, а отдельный сгенерированный каталог
`.docker/build-context`: дистрибутив (`ai-dev/`), Dockerfile и entrypoint. Перед сборкой он
проверяется на запрещенные пути, секреты, имя локального пользователя и абсолютный путь исходного
Vault, а при сборке дистрибутив сверяется пофайлово со своим `distribution.json`.

## Быстрый запуск

Windows (нужны Docker Desktop, Node.js 22.12+ и клон репозитория: конфиги клиентов пишет Node):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Linux (нужен только запущенный Docker; на macOS скрипт тоже работает, но macOS в разработке и в 3.0 не
поддерживается):

```bash
sh ./bootstrap.sh
```

Оба скрипта проверяют Docker, скачивают `ghcr.io/stonebridgeway/ai-dev-system:latest`, проверяют,
что сервер в нём отвечает на MCP-рукопожатие своими инструкциями, и пишут в конфиги найденных
клиентов запись, которая сама запускает `docker run -i --rm …`. Docker они больше не ставят. На
macOS и Linux конфиги пишет сам образ — `ai-dev clients install --docker` в контейнере, которому
смонтированы только папки конфигов клиентов и папка состояния; Node на хосте не нужен.

Чтобы запустить образ, собранный из вашего клона, а не опубликованный, — со своими изменениями или
на машине, которой не достать реестр, — соберите и поставьте его одним шагом, которому Node на хосте
не нужен: контекст сборки готовит контейнер `node:24-bookworm-slim`:

```bash
sh ./bootstrap.sh --build-local   # собирает ai-dev-system:local из клона и ставит его
```

Он собирает образ сам, а не скачивает его из реестра. На Windows — `-BuildLocal`: там контекст готовит
Node хоста, который `bootstrap.ps1` нужен и так. С Node и npm сборка может быть и отдельным шагом:

```bash
cd ai-dev-mcp-server && npm run docker:build && cd ..   # даёт ai-dev-system:local
sh ./bootstrap.sh --image ai-dev-system:local --allow-stale-image
```

На Windows — `-Image ai-dev-system:local -AllowStaleImage`. Названный ему образ bootstrap всё равно
сначала пробует скачать, поэтому предупреждение «Registry pull failed … Installed from a stale
image» для образа, собранного здесь, тогда ожидаемо.

Одна сессия клиента — один контейнер:

```text
docker run -i --rm --read-only --tmpfs /tmp:rw,exec,nosuid,size=512m --shm-size 1g
  --network none --security-opt no-new-privileges:true --cap-drop ALL
  --mount type=volume,source=ai-dev-system-data,target=/data
  --mount type=bind,source=$HOME/.ai-dev/state,target=/ai-dev-state --env AI_DEV_STATE_ROOT=/ai-dev-state
  --mount type=bind,source=$HOME/AI-Dev-Projects,target=$HOME/AI-Dev-Projects
  ghcr.io/stonebridgeway/ai-dev-system:latest
```

- **Проекты** монтируются по своему же пути: путь, который называет агент, открывает и сервер
. На Windows путь хоста Linux-контейнер удержать не может, и проекты лежат в `/workspace`,
  как в 2.x.
- **Папка состояния хоста** — та, в которой хуки агента ведут задачи, handoff и журнал расхода, —
  у сервера та же. Пользователь контейнера — всегда `node`, uid 1000; папку он делит там, где
  это вы: macOS и Windows (Docker Desktop сопоставляет владельца), Linux с uid 1000 — и на Linux
  установщик сначала проверяет это делом: контейнер образа пишет в папку файл, и файл должен
  оказаться вашим. Где Docker переназначает пользователей (rootless, userns-remap, Podman) или uid
  не 1000, монтирования нет: сервер держит состояние в томе и не может писать в проекты (их папки
  для него — только для чтения), как и в 2.x; такой машине подходит локальный путь.
  На Windows папка общая, но общий в ней только журнал расхода: сервер видит проект как
  `/workspace/<имя>`, хуки — как `C:\…\<имя>`, и для обоих это разные проекты, а задачи и handoff
  хранятся по проекту; Stop-хук о задаче сервера не напомнит, сервер handoff хуков не увидит.
- **Модель** — в томе (см. [Локальная BGE-M3](#локальная-bge-m3)) или папка хоста read-only в
  `/models`.
- **git в образе** доверяет смонтированным проектам, кто бы ни владел ими на хосте: 2.x не
  признавала репозиторием проект другого пользователя, и идентичность проекта была не той.

Знания, состояние задач, поисковый индекс, модель и QA-артефакты живут в томе
`ai-dev-system-data`. Обновление образа их не перезаписывает — см.
[Обновление с 2.x](#обновление-с-2x).

### Первый старт

Что первый запуск строит — реестр skills, поисковый индекс, бенчмарк маршрутизации, — построено
при сборке образа, и Docker копирует это в новый том. Первый старт на новом томе ничего не
пересобирает и отвечает примерно за две секунды; 2.x строила всё это при первом старте каждого
тома, шесть секунд и больше. Времена файлов, которые слой образа хранит с точностью до
секунды, восстанавливаются по метке `/data/.ai-dev-image-data.json`, иначе проверка свежести
реестра сочла бы всё устаревшим. Docker наполняет новый том, когда на нём стартует первый
контейнер; второй клиент, запущенный мгновением позже, застаёт копирование — и ждёт его конца:
метка говорит, сколько в данных образа файлов и байт, и до этого старт тома не читает
(«Docker was still filling this new volume from the image: this start waited 0.8 s», не дольше
20 с).

Сразу после первого старта `system_health_check` даёт `ok`. Пропущенными (`skipped`) остаются
необязательные части, которых в образе нет: модель — `embedding_backend`, совет называет
`ai-dev model install` в томе; браузер Frontend QA — он в варианте `-browser`;
Python для UI UX Pro Max.

Сервер лежит в `/opt/ai-dev/ai-dev-mcp-server` — там, где его ищет раннер Frontend QA;
`/opt/ai-dev/app` — символьная ссылка на него, которую называют конфиги и тома 2.x.

## Локальная сборка

Требования: Docker Engine или Docker Desktop и Node.js 22.12+ для подготовки контекста.

Из корня `ai-dev-mcp-server`:

```bash
npm ci
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

`docker:prepare` собирает дистрибутив в `.docker/build-context/ai-dev` и кладёт рядом Dockerfile
и entrypoint. Обычная сборка никогда не должна использовать корень Vault как Docker context.
Вариант с браузером — та же сборка с `--target browser`; `docker:smoke -- --browser` проверяет,
что раннер Frontend QA в нём запускается. pnpm в нём — та версия, что названа в `packageManager`
у `frontend-qa/package.json`.

Поддерживающий проект разработчик обновляет committed public seed только после ревью:

```bash
npm run docker:seed
npm run docker:prepare
npm run docker:audit
```

`docker:seed` читает разрешенные исходные документы и skills, пересоздает только
`docker/public-seed` и не изменяет исходный Vault. История seed для томов 2.x
(`data/seed-history.json`) от правок seed не зависит: она считается от последнего коммита линии
2.x (`SEED_HISTORY_BASE` в `scripts/seed-history.mjs`) и переписывается, только когда выходит ещё
одна 2.x — `node scripts/seed-history.mjs --write` из клона с полной историей.

## Подключение к MCP-клиентам

`ai-dev clients install --docker` пишет запись во все найденные клиенты (это и делают скрипты
bootstrap), `ai-dev clients entry <клиент> --docker --projects <папка>` печатает одну — для
клиента, которого вы настраиваете руками. Для Cursor, Claude Desktop/Code и Gemini запись лежит
под `mcpServers`, у VS Code — под `servers` и с `"type": "stdio"`, у Codex — в `config.toml` с
`startup_timeout_sec = 120` и `tool_timeout_sec = 3600`. Ниже — запись `mcpServers` так, как её
пишет Linux; `command` — полный путь к `docker`, который находит `PATH`: на Linux обычно
`/usr/bin/docker`, на macOS с Docker Desktop — `/usr/local/bin/docker`:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "/usr/bin/docker",
      "args": [
        "run", "-i", "--rm", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
        "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
        "--mount", "type=volume,source=ai-dev-system-data,target=/data",
        "--mount", "type=bind,source=/home/you/.ai-dev/state,target=/ai-dev-state",
        "--env", "AI_DEV_STATE_ROOT=/ai-dev-state",
        "--mount", "type=bind,source=/home/you/Dev,target=/home/you/Dev",
        "ghcr.io/stonebridgeway/ai-dev-system:latest"
      ]
    }
  }
}
```

Docker CLI указывается полным путём: клиент, запущенный из Dock или меню «Пуск», не видит `PATH`
оболочки. Блоки для Windows и для каждого клиента — в
[docs/ru/INSTALL.md](../docs/ru/INSTALL.md#подключение-к-ии-агентам), шаблон —
`docker/mcp-config.example.json`. После изменения конфига полностью перезапустите клиент.
`ai-dev clients doctor` запускает каждую запись так, как это сделал бы клиент, и проверяет, что
сервер отвечает инструкциями.

Лаунчеры 2.x — `docker/run-mcp.sh`, `docker/run-mcp.ps1` — работают до 4.0 для конфигов, которые
их называют, и говорят в stderr, что они лаунчеры 2.x. Сами на рукопожатие они больше не отвечают:
ответ сервера — с инструкциями — проходит к клиенту как есть.

## Docker Compose

Создайте локальный override из `docker/compose.local.example.yaml`, задайте
`AI_DEV_PROJECT_PATH` (он монтируется по своему же пути) и запускайте MCP как одноразовый
stdio-процесс:

```bash
docker compose \
  -f docker/compose.yaml \
  -f docker/compose.local.yaml \
  run --rm -T ai-dev-mcp
```

Без `AI_DEV_IMAGE` сервис запускает `ai-dev-system:local` и собирает его из `.docker/build-context`
(`npm run docker:prepare`), если его нет; опубликованный образ — `AI_DEV_IMAGE=ghcr.io/stonebridgeway/ai-dev-system:latest`
перед командой или в `docker/.env`. `compose.local.yaml` и `docker/.env` игнорируются Git, потому что могут
содержать локальные пути.

## Сеть и права

Запись клиента и Compose запускают контейнер:

- с `network=none`;
- от пользователя `node` (uid 1000), не от root;
- с read-only root filesystem;
- с удаленными Linux capabilities;
- с `no-new-privileges`;
- с доступом на запись только к `/data`, `/tmp`, папке проектов и — где она смонтирована — папке
  состояния.

Если проекту действительно нужен интернет во время проверки, замените в записи клиента
`--network none` на `--network bridge` (у лаунчеров 2.x — `AI_DEV_DOCKER_NETWORK=bridge`). Это
осознанное расширение доступа, а не настройка по умолчанию; повторный bootstrap вернёт запись к
значению по умолчанию.

### Node образа исполняет команды проекта

`run_quality_gate` и `verify_task` запускают команды из `.ai-dev/quality-gate.md` тем Node,
который стоит в образе (сейчас 24), а не тем, что стоит у вас. Команда, которая ведёт себя
по-разному на разных мажорах, разойдётся с вашим терминалом, и виноват в этом не гейт.
Классический случай — `node --test test/`: с Node 21 позиционные аргументы стали
glob-паттернами, каталог исполняется как файл теста, и скрипт падает сам по себе. На Node 20
он проходил. Версию видно в ответе: `run_quality_gate` возвращает `runtime.node` и
`runtime.exec_path`, а провалившаяся команда несёт `hint`, если причина опознана.

Гейт не переписывает команды проекта за вас — он говорит, что увидел.

### Что из сканеров безопасности работает в `--network none`

Из шести сканеров `run_security_scan` в изолированном контейнере реально может работать
только gitleaks; semgrep — лишь если правила лежат в самом репозитории.

| Сканер | В образе | В `--network none` |
| --- | --- | --- |
| gitleaks | да | работает: читает рабочее дерево и историю git |
| semgrep | нет | работал бы только с локальными правилами (`.semgrep.yml`), не с `--config auto` |
| `npm audit` | да (вместе с npm) | нет: база advisory сетевая |
| trivy | нет | нет: база уязвимостей сетевая |
| pip-audit | нет | нет: сетевой |
| cargo audit | нет | нет: сетевой |

Поэтому прогон в контейнере — это прогон одного сканера, а не шести. Если не отработал ни
один, вердикт скана — `unchecked`, а не `pass`: «ничего не нашли» и «никто не смотрел» — разные
утверждения, и второе не выдаётся за первое. `verify_task` при этом не блокируется: правило
«отсутствующий сканер никогда не блокирует» осталось. `system_health_check` отдельно считает,
сколько из шести на месте, и предупреждает, если ноль.

## Локальная BGE-M3

Модель — не дополнение, а половина поиска: без неё остаётся совпадение по словам, с ней
появляется совпадение по смыслу. ONNX-рантайм в образе есть, Python ему не нужен. Весов в образе
нет — около 600 МБ, — и ставятся они один раз.

**В том**, одним запуском с сетью — остальные сессии остаются с `--network none`:

```bash
docker run --rm -it --network bridge \
  --mount type=volume,source=ai-dev-system-data,target=/data \
  ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev model install
```

Загрузка видна по ходу, оборванная продолжается с того же байта, каждый файл сверяется с sha256
манифеста, а затем строятся векторы документов, которые уже есть в индексе. Прокси и зеркало —
через `--env HTTPS_PROXY=…` и `--env AI_DEV_MODEL_MIRROR=…`. 2.x так не умела: папка модели была
прибита к монтированию с хоста, а векторы документов в контейнере не строились вовсе.

**Или с хоста, read-only.** `npm run model -- install --no-index` кладёт модель в
`~/.ai-dev/models/bge-m3-onnx`; монтируется папка *над* ней, `~/.ai-dev/models`, в `/models`:
`--model` у `ai-dev clients install --docker`, `--model-path` у `bootstrap.sh` (`-ModelPath` у
`bootstrap.ps1`), `AI_DEV_MODEL_PATH` у лаунчеров 2.x и Compose. Образ сначала смотрит в
`/models/bge-m3-onnx`, если там что-то есть, потом в том. Каталог, где лежат сами файлы модели
(`pytorch_model.bin`, `config.json`, `onnx/`), — значение до 2.1; каждая копия его распознаёт и
останавливается с подсказкой, а не монтирует на уровень глубже. Если `bge-m3-onnx` в этой папке —
ссылка на другой диск, запись 3.0 монтирует саму ссылку в `/models/bge-m3-onnx`, и Docker проходит по ней на
хосте; ссылка, которая и на хосте ведёт в никуда, отклоняется.

**Python-бэкенда больше нет** (3.0). Аргумент сборки `INSTALL_BGE_M3=1`, который его
ставил, ничего не делает и при сборке говорит, что пришло на смену. Терминальный вид BuildKit
сворачивает вывод законченного шага — на экране сообщение оставляет `--progress=plain`, — а шаг из
кэша не печатает ничего, так что при следующей сборке того же дерева сообщение видно только с `--no-cache`. Векторы, построенные
Python-бэкендом, относятся к другой модели и с вопросами ONNX не сравниваются; `ai-dev model
install` строит их заново.

### Образ с весами внутри

Если модель должна быть в самом образе — машина без сети, раздача команде, — это ваша сборка
поверх нашей: Dockerfile из двух строк и одна команда сборки:

```dockerfile
# Dockerfile.bge
FROM ghcr.io/stonebridgeway/ai-dev-system:latest
COPY --chown=node:node bge-m3-onnx/ /models/bge-m3-onnx/
```

```bash
docker build -f Dockerfile.bge -t ai-dev-system:bge-bundled "$HOME/.ai-dev/models"
```

Ни монтирования, ни переменной такому образу не нужно: `/models/bge-m3-onnx` уже на месте, там,
куда образ смотрит первым. Публикуемый образ при этом остаётся маленьким — веса не попадают ни в
allowlist-контекст, ни в GHCR.

### Как убедиться

В диагностике смотрите проверку `embedding_backend`: без модели — `skipped` с названием нужной
команды, с моделью — `ok`. Подробности даёт инструмент `embedding_status`: `installed` и
`available` — ответ, `reason` — фраза, а `dense_backend.onnx.missing` перечисляет файлы, которых
нет. `search_index_status` показывает `dense_documents` против `dense_pending_documents`.

## Обновление с 2.x

Конфиг, который написала 2.x, продолжает работать с новым образом до 4.0; скрипты 3.0 с теми же
именами говорят в stderr, что они лаунчеры 2.x. Повторный `bootstrap.sh` или `bootstrap.ps1`
переписывает конфиги на `docker run` и затем удаляет долгоживущий контейнер 2.x
(`ai-dev-system-runtime-<uid>`). Монтирует он папки, которые называют записи, — `AI_DEV_PROJECT_PATH`
и `AI_DEV_MODEL_PATH` записи 2.x или папки записи 3.0, — и говорит, какие оставил; папку модели — только
если в ней модель 3.0, `bge-m3-onnx/`. Другие папки называют `--project-path` (`-ProjectPath`) и
`--model-path` (`-ModelPath`); без записей — `~/AI-Dev-Projects` и никакой папки модели. Установленный `ClaudeMcpProxy.exe` — тот,
что собрала 2.x: 3.0 его больше не компилирует, и до перезаписи конфига Claude он отвечает на
рукопожатие сам, без инструкций сервера и без предупреждения.

Том сохраняется. При первом старте нового образа:

- **seed** приводится к seed образа по его манифесту, а не `cp -n`: что поставляла 2.x и убрала
  3.0 — удаляется; skill из seed, который вы правили, сохраняет правку, а обновление ложится рядом
  как `SKILL.md.seed-new`; ваш собственный skill не трогается. Что положила 2.x, а что вы,
  синхронизация узнаёт по истории seed 2.x;
- **состояние** тома — задачи, handoff, журнал — переезжает в папку состояния хоста, где она
  смонтирована;
- первый старт занимает больше обычного — около пятнадцати секунд на томе 2.x, — следующие около
  секунды;
- память, которую сервер 2.x вёл о проектах (сессии, инстинкты, решения), записана под проектом
  `/workspace/<имя>`; теперь проекты — по своему пути, сервер видит их другими проектами и начинает
  их память заново, а прежняя остаётся в папке состояния.

Путь назад — образ линии 2.x: `ghcr.io/stonebridgeway/ai-dev-system:2`. Через `--image` у bootstrap
(папки он оставляет те, что монтируют записи) он работает из записей 3.0 — их
пишет образ 3.0 или новее, `AI_DEV_INSTALLER_IMAGE` (по умолчанию
`:3`, линия 3.x), скачанный и проверенный на установщик, — которые дают ему папку состояния там,
где она общая, и задачи в ней видит;
из лаунчеров 2.x (`AI_DEV_IMAGE`) он держит состояние в томе и задач, переехавших в папку состояния
хоста, не видит — `docs/ru/UPGRADE-TEST.md` говорит, как скопировать их в том. Его `cp -n`
возвращает в том skills, которые 3.0 убрала. Возврат на 3.0 узнаёт их по манифесту 2.x, который тот же `cp -n`
кладёт в хранилище, и убирает снова; задачи, начатые 2.x за это время, переезжают на хост.
Проверка всего этого на настоящем томе и лаунчерах 2.x:

```bash
npm run docker:upgrade-check -- --old-image ghcr.io/stonebridgeway/ai-dev-system:2 --new-image ai-dev-system:local
```

`:2` появится с выходом 3.0 — это `:latest` 2.x, скопированный в него перед тегом 3.0 (`freeze_2x`,
ниже). До тех пор образ 2.x — сам `ghcr.io/stonebridgeway/ai-dev-system:latest`, и в командах выше
вместо `:2` берут его, а для `--image` у bootstrap ещё и `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local`:
установщик по умолчанию, `:latest`, до выпуска — тот же образ 2.x. bootstrap сначала пробует скачать
и образ установщика, так что ответ Docker «pull access denied for ai-dev-system …» тогда ожидаем: дальше
берётся образ, собранный здесь.

## GHCR

Workflow `.github/workflows/docker-publish.yml`:

- тестирует privacy policy и то, что обещают друг другу страницы установки и скрипты (`packaging:check`);
- заново создает и проверяет allowlisted context;
- собирает validation image и вариант `-browser`;
- выполняет MCP stdio smoke: новый том, следующая сессия, модель через том (синтетическая);
- обновляет том 2.x образом из PR и прогоняет лаунчеры 2.x;
- публикует `linux/amd64` и `linux/arm64` в GHCR с SBOM и provenance attestations.

Теги: push в `main` — `:edge`; тег выпуска `vX.Y.Z` — `:X.Y.Z`,
`:X.Y`, `:X` и, если это не пре-релиз новейшей линии, `:latest`; пре-релиз — только своё имя; тег
`v2.Y.Z` после выпуска 3.0 двигает `:2`, `:2.Y` и `:2.Y.Z`, но не `:latest`. Мерж — не выпуск. Вариант с браузером
получает те же теги с суффиксом `-browser`. `:2` — линия 2.x: перед первым тегом 3.0 ручной
запуск workflow с `freeze_2x` копирует текущий `:latest` в `:2`, если `:2` ещё нет.

Публикация выполняется только в репозитории апстрима и только после успешных validation jobs.
Доступ к GHCR идет через штатный `GITHUB_TOKEN`; токены не передаются в Docker build args.

После первой публикации откройте настройки package в GitHub и выберите подходящую видимость:
`public` для свободного скачивания либо `private/internal` с доступом нужным коллегам и командам.

Официальные справочники:

- [Docker build context и `.dockerignore`](https://docs.docker.com/build/concepts/context/)
- [Dockerfile best practices](https://docs.docker.com/build/building/best-practices/)
- [Multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

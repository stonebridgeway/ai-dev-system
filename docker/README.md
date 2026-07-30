# Локальный AI Dev MCP в Docker

Этот образ запускает AI Dev MCP через локальный `stdio`. Он не открывает TCP-порт и не требует
удаленного сервера. Любая модель может использовать его через MCP-совместимый локальный хост:
Codex, Cursor, Claude Desktop/Code, Gemini CLI/Code Assist, VS Code или другой клиент с поддержкой
MCP tools.

Сама модель не подключается к MCP напрямую. Инструменты ей передает MCP-хост, в котором выбрана
модель.

## Граница приватности

В образ входят только явно разрешенные файлы:

- MCP-сервер и зафиксированные npm-зависимости;
- чистые правила, промпты, quality gates и шаблоны;
- публичный набор custom skills;
- MIT-лицензированные `taste-skill` и `ui-ux-pro-max`;
- Python CLI для локального поиска;
- Playwright и Chromium для frontend QA.

В образ не входят:

- пароли, токены, `.env` и приватные ключи;
- `02-knowledge/Projects` и `02-knowledge/Task Runs`;
- локальные `.ai-dev`, `.codex`, `.obsidian` и Git history;
- индексы SQLite, логи, артефакты, кэши и бэкапы;
- личный Obsidian Vault;
- исходники пользовательских проектов;
- BGE-M3 модель и ее веса.

Сборка получает не корень Vault и не корень репозитория, а отдельный сгенерированный каталог
`.docker/build-context`. Перед сборкой он проверяется на запрещенные пути, секреты, имя локального
пользователя и абсолютный путь исходного Vault.

## Быстрый запуск готового образа

### Windows: автоматическая подготовка после clone

Из корня клона запустите:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Скрипт проверяет Docker Desktop и Node.js 24, при отсутствии устанавливает их через `winget`,
создаёт безопасную локальную папку проектов, скачивает опубликованный образ, проводит MCP smoke-проверку и
добавляет Docker launcher в локальные конфигурации Codex, Cursor, Gemini, VS Code и Claude.
Права администратора требуются только для первой установки Docker Desktop или Node.js.

### macOS и Linux: автоматическая подготовка без Node.js на хосте

```bash
sh ./bootstrap.sh --install-prerequisites
```

На macOS скрипт устанавливает Homebrew при необходимости, затем Docker Desktop через Homebrew,
запускает приложение и ждёт готовности engine. На Linux Docker Engine устанавливается через
`apt`, `dnf` или `pacman`; после добавления пользователя в группу `docker` потребуется заново
войти в систему и повторить команду. Если Docker уже готов, достаточно `sh ./bootstrap.sh`.
Временный `node:24` контейнер используется только для настройки клиентов.

Опубликованный образ:

```powershell
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\docker\run-mcp.ps1
```

macOS/Linux:

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

`AI_DEV_PROJECT_PATH` задается явно. Только этот каталог монтируется в `/workspace`; личный Vault
по умолчанию не монтируется вообще. Для одного проекта укажите его корень. Для нескольких
репозиториев можно указать общий каталог, например `C:\Dev` или `$HOME/Dev`.

Новые локальные знания, task state, поисковый индекс и QA-артефакты сохраняются в Docker volume
`ai-dev-system-data`. Обновление или пересоздание контейнера не перезаписывает существующие файлы в
этом volume.

## Локальная сборка

Требования:

- Docker Desktop или Docker Engine с Compose v2;
- Node.js 24 для подготовки проверяемого build context.

Из корня `ai-dev-mcp-server`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

`docker:prepare` копирует только allowlist-файлы в `.docker/build-context`. Обычная сборка никогда
не должна использовать корень Vault как Docker context.

Поддерживающий проект разработчик обновляет committed public seed только после ревью:

```bash
npm run docker:seed
npm run docker:prepare
npm run docker:audit
```

`docker:seed` читает разрешенные исходные документы и skills, пересоздает только
`docker/public-seed` и не изменяет исходный Vault.

## Подключение к MCP-клиентам

### Универсальный JSON

Для Cursor, Claude Desktop/Code и Gemini используйте формат `mcpServers`. Готовый вариант без
project mount находится в `docker/mcp-config.example.json`.

Windows-вариант с явным проектным каталогом:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

macOS/Linux:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "/bin/sh",
      "args": [
        "/absolute/path/docker/run-mcp.sh"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "/home/user/Dev"
      }
    }
  }
}
```

### Codex

Добавьте в `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

На macOS/Linux замените команду на `/bin/sh`, а `args` на абсолютный путь к `run-mcp.sh`.

### VS Code

Файл `.vscode/mcp.json` или пользовательский MCP config:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--read-only",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--mount",
        "type=volume,source=ai-dev-system-data,target=/data",
        "--mount",
        "type=bind,source=C:\\Dev,target=/workspace",
        "ai-dev-system:local"
      ]
    }
  }
}
```

После изменения MCP-конфига полностью перезапустите или reload-ните клиент. Корни репозиториев
внутри контейнера начинаются с `/workspace`, поэтому `begin_task` нужно вызывать с контейнерным
путем, например `/workspace/my-project`.

## Docker Compose

Сначала подготовьте контекст и образ:

```bash
cd ai-dev-mcp-server
npm run docker:prepare
npm run docker:build
```

Затем создайте локальный override из `docker/compose.local.example.yaml`, задайте
`AI_DEV_PROJECT_PATH` и запускайте MCP как одноразовый stdio-процесс:

```bash
docker compose \
  -f docker/compose.yaml \
  -f docker/compose.local.yaml \
  run --rm -T ai-dev-mcp
```

`compose.local.yaml` и `docker/.env` игнорируются Git, потому что могут содержать локальные пути.

## Сеть и права

По умолчанию wrapper и Compose запускают контейнер:

- с `network=none`;
- от пользователя `node`, не от root;
- с read-only root filesystem;
- с удаленными Linux capabilities;
- с `no-new-privileges`;
- с доступом на запись только к `/data`, `/tmp` и явно подключенному `/workspace`.

Если проекту действительно нужен интернет во время проверки, явно задайте
`AI_DEV_DOCKER_NETWORK=bridge`. Это осознанное расширение доступа, а не настройка по умолчанию.

## Локальная BGE-M3

Базовый образ работает со sparse/FTS-поиском без тяжелой ML-модели. Для образа с Python
зависимостями BGE-M3:

```bash
docker build \
  --build-arg INSTALL_BGE_M3=1 \
  --tag ai-dev-system:bge \
  .docker/build-context
```

Веса модели не встраиваются. Укажите отдельный локальный каталог:

```bash
export AI_DEV_IMAGE="ai-dev-system:bge"
export AI_DEV_MODEL_PATH="/absolute/path/to/bge-m3"
sh ./docker/run-mcp.sh
```

Каталог модели подключается read-only в `/models/bge-m3`.

## GHCR

Workflow `.github/workflows/docker-publish.yml`:

- тестирует privacy policy;
- заново создает и проверяет allowlisted context;
- собирает validation image;
- выполняет MCP stdio smoke;
- публикует `linux/amd64` и `linux/arm64` в GHCR;
- добавляет SBOM и provenance attestations.

Публикация выполняется только после успешной validation job. Доступ к GHCR идет через штатный
`GITHUB_TOKEN`; токены не передаются в Docker build args.

После первой публикации откройте настройки package в GitHub и выберите подходящую видимость:
`public` для свободного скачивания либо `private/internal` с доступом нужным коллегам и командам.
Локальный Git remote в исходной копии проекта нужно добавить отдельно перед первым push.

Официальные справочники:

- [Docker build context и `.dockerignore`](https://docs.docker.com/build/concepts/context/)
- [Dockerfile best practices](https://docs.docker.com/build/building/best-practices/)
- [Multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

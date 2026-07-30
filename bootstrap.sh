#!/bin/sh
set -eu

project_path="${HOME}/AI-Dev-Projects"
image="${AI_DEV_IMAGE:-ghcr.io/stonebridgeway/ai-dev-system:latest}"
image_set=0
clients="codex,cursor,gemini,vscode,claude"
skip_smoke=0
skip_client_install=0
install_prerequisites=0
build_local=0
plan=0
node_image="${AI_DEV_BOOTSTRAP_NODE_IMAGE:-node:24-bookworm-slim}"
data_volume="${AI_DEV_DATA_VOLUME:-ai-dev-system-data}"

usage() {
  cat <<'EOF'
Usage: sh ./bootstrap.sh [options]

Options:
  --project-path PATH       Folder to mount as /workspace.
  --image NAME              Docker image tag (default: published GHCR latest).
  --clients LIST            Comma-separated: codex,cursor,gemini,vscode,claude.
  --install-prerequisites   Install Docker with Homebrew, apt, dnf, or pacman.
  --build-local             Build ai-dev-system:local from this checkout.
  --skip-smoke              Skip the final MCP stdio negotiation check.
  --skip-client-install     Do not modify local AI-client configuration files.
  --plan                    Print the local plan without installing or building.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-path) project_path="$2"; shift 2 ;;
    --image) image="$2"; image_set=1; shift 2 ;;
    --clients) clients="$2"; shift 2 ;;
    --install-prerequisites) install_prerequisites=1; shift ;;
    --build-local) build_local=1; shift ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --skip-client-install) skip_client_install=1; shift ;;
    --plan) plan=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '%s\n' "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ "$build_local" -eq 1 ] && [ "$image_set" -eq 0 ]; then
  image="ai-dev-system:local"
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
server_root="${repo_root}/ai-dev-mcp-server"
launcher="${repo_root}/docker/run-mcp.sh"
platform=$(uname -s)
runtime_container="ai-dev-system-runtime-$(id -u)"

if [ ! -f "${server_root}/package.json" ] || [ ! -f "${launcher}" ]; then
  printf '%s\n' "Run bootstrap.sh from a complete AI Dev MCP System clone." >&2
  exit 66
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$plan" -eq 1 ]; then
  plan_repo=$(json_escape "$repo_root")
  plan_project=$(json_escape "$project_path")
  plan_image=$(json_escape "$image")
  plan_clients=$(json_escape "$clients")
  plan_runtime=$(json_escape "$runtime_container")
  plan_volume=$(json_escape "$data_volume")
  printf '{"repository":"%s","project_path":"%s","image":"%s","clients":"%s","runtime_container":"%s","data_volume":"%s","build_local":%s,"node_on_host_required":false}\n' \
    "$plan_repo" "$plan_project" "$plan_image" "$plan_clients" "$plan_runtime" "$plan_volume" "$build_local"
  exit 0
fi

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi
  if [ "$install_prerequisites" -ne 1 ]; then
    printf '%s\n' "Homebrew or Docker Desktop is required on macOS. Re-run with --install-prerequisites, or install Docker Desktop manually." >&2
    exit 69
  fi
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s\n' "curl is required to install Homebrew from its official installer." >&2
    exit 69
  fi
  printf '%s\n' "Installing Homebrew from https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh ..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew_path in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "${brew_path}/brew" ]; then
      PATH="${brew_path}:${PATH}"
      export PATH
      break
    fi
  done
  if ! command -v brew >/dev/null 2>&1; then
    printf '%s\n' "Homebrew was installed but is not available in this shell. Open a new terminal and run bootstrap.sh again." >&2
    exit 69
  fi
}

install_docker_macos() {
  if [ "$install_prerequisites" -ne 1 ]; then
    printf '%s\n' "Docker Desktop is required on macOS. Re-run with --install-prerequisites, or install and start Docker Desktop manually." >&2
    exit 69
  fi
  ensure_homebrew
  printf '%s\n' "Installing Docker Desktop through Homebrew..."
  brew install --cask docker
  if [ -d "/Applications/Docker.app/Contents/Resources/bin" ]; then
    PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"
    export PATH
  fi
}

install_docker_linux() {
  if [ "$install_prerequisites" -ne 1 ]; then
    printf '%s\n' "Docker is required. Re-run with --install-prerequisites, or install Docker Engine/Desktop and run again." >&2
    exit 69
  fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y docker docker-compose-plugin
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm docker docker-compose
  else
    printf '%s\n' "No supported Linux package manager was found. Install Docker Engine manually, then run again." >&2
    exit 69
  fi
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now docker
  fi
  sudo usermod -aG docker "$(id -un)"
  printf '%s\n' "Docker was installed. Sign out and sign in (or run newgrp docker), then run bootstrap.sh again." >&2
  exit 0
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$platform" = "Darwin" ]; then
      install_docker_macos
    else
      install_docker_linux
    fi
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' "Docker was installed but its CLI is not available in this shell. Open a new terminal and run bootstrap.sh again." >&2
    exit 69
  fi
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    return
  fi
  if [ "$platform" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    open -a Docker >/dev/null 2>&1 || true
    attempt=0
    while [ "$attempt" -lt 24 ]; do
      sleep 5
      if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then return; fi
      attempt=$((attempt + 1))
    done
  fi
  printf '%s\n' "Docker is installed but its engine is not ready. Start Docker Desktop/Engine and run bootstrap.sh again." >&2
  exit 69
}

ensure_docker
mkdir -p "$project_path"
case "$project_path" in
  *,*) printf '%s\n' "Project path cannot contain a comma when Docker --mount syntax is used." >&2; exit 64 ;;
esac
project_path=$(CDPATH= cd -- "$project_path" && pwd -P)

uid=$(id -u)
gid=$(id -g)
run_node() {
  docker run --rm \
    --user "${uid}:${gid}" \
    --mount "type=bind,source=${repo_root},target=${repo_root}" \
    --workdir "$server_root" \
    "$node_image" "$@"
}

if [ "$build_local" -eq 1 ]; then
  printf '%s\n' "Preparing the checked Docker context with temporary Node.js 24..."
  run_node sh -lc 'node scripts/prepare-docker-context.mjs && node scripts/audit-docker-context.mjs'
  printf '%s\n' "Building ${image}..."
  docker build --tag "$image" "${repo_root}/.docker/build-context"
else
  printf '%s\n' "Pulling ${image}..."
  if ! docker pull "$image"; then
    if docker image inspect "$image" >/dev/null 2>&1; then
      printf '%s\n' "Registry pull failed; using the existing local image ${image}." >&2
    else
      printf '%s\n' "Could not pull ${image}, and no cached copy exists." >&2
      exit 69
    fi
  fi
fi

existing_runtime=$(docker ps -a --filter "name=^/${runtime_container}$" --format '{{.ID}}')
if [ -n "$existing_runtime" ]; then
  runtime_label=$(docker inspect --format '{{index .Config.Labels "ai-dev.system.runtime"}}' "$runtime_container")
  if [ "$runtime_label" != "true" ]; then
    printf '%s\n' "Container name is already used by an unmanaged container: ${runtime_container}" >&2
    exit 73
  fi
  printf '%s\n' "Refreshing managed fast-start runtime ${runtime_container}..."
  docker rm -f "$runtime_container" >/dev/null
fi

printf '%s\n' "Starting protected fast-start runtime ${runtime_container}..."
docker run -d \
  --name "$runtime_container" \
  --restart unless-stopped \
  --label ai-dev.system.runtime=true \
  --label "ai-dev.system.owner=$(id -u)" \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --shm-size 1g \
  --network none \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=volume,source=${data_volume},target=/data" \
  --mount "type=bind,source=${project_path},target=/workspace" \
  "$image" tail -f /dev/null >/dev/null

if [ "$skip_smoke" -ne 1 ]; then
  printf '%s\n' "Running cold fallback MCP stdio smoke check..."
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
  if ! printf '%s\n' "$init" | docker run --rm -i --read-only --tmpfs /tmp:rw,exec,nosuid,size=512m --shm-size 1g --network none "$image" | grep -q '"serverInfo"'; then
    printf '%s\n' "MCP stdio smoke check failed." >&2
    exit 70
  fi
  printf '%s\n' "Running fast-start MCP stdio smoke check..."
  if ! printf '%s\n' "$init" | AI_DEV_RUNTIME_CONTAINER="$runtime_container" "$launcher" | grep -q '"serverInfo"'; then
    printf '%s\n' "Fast-start MCP stdio smoke check failed." >&2
    exit 70
  fi
fi

if [ "$skip_client_install" -ne 1 ]; then
  app_data="${XDG_CONFIG_HOME:-${HOME}/.config}"
  installer_platform="linux"
  if [ "$platform" = "Darwin" ]; then
    app_data="${HOME}/Library/Application Support"
    installer_platform="darwin"
  fi
  printf '%s\n' "Installing local MCP client configurations..."
  docker run --rm --network none \
    --user "${uid}:${gid}" \
    --mount "type=bind,source=${repo_root},target=${repo_root},readonly" \
    --mount "type=bind,source=${HOME},target=${HOME}" \
    --workdir "$server_root" \
    "$node_image" node scripts/install-docker-mcp-clients.mjs \
      --apply \
      --launcher "$launcher" \
      --runtime-container "$runtime_container" \
      --image "$image" \
      --project-path "$project_path" \
      --clients "$clients" \
      --home "$HOME" \
      --app-data "$app_data" \
      --platform "$installer_platform"
fi

printf '%s\n' "AI Dev MCP System is ready. Restart the selected AI clients to load ai-dev."

#!/bin/sh
set -eu

image="${AI_DEV_IMAGE:-ai-dev-system:local}"
data_volume="${AI_DEV_DATA_VOLUME:-ai-dev-system-data}"
network="${AI_DEV_DOCKER_NETWORK:-none}"
runtime_container="${AI_DEV_RUNTIME_CONTAINER:-}"

run_warm_runtime() {
  runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/ai-dev-mcp.XXXXXX")
  backend_input="${runtime_dir}/backend-input"
  backend_output="${runtime_dir}/backend-output"
  mkfifo "$backend_input" "$backend_output"
  exec 3<> "$backend_input"

  (
    first_response=1
    while IFS= read -r backend_line; do
      if [ "$first_response" -eq 1 ]; then
        first_response=0
        continue
      fi
      printf '%s\n' "$backend_line"
    done < "$backend_output"
  ) &
  output_pid=$!

  docker exec -i "$runtime_container" node /opt/ai-dev/app/src/server.mjs \
    < "$backend_input" > "$backend_output" &
  backend_pid=$!

  cleanup_warm_runtime() {
    exec 3>&-
    kill "$backend_pid" "$output_pid" 2>/dev/null || true
    wait "$backend_pid" "$output_pid" 2>/dev/null || true
    rm -f "$backend_input" "$backend_output"
    rmdir "$runtime_dir" 2>/dev/null || true
  }
  trap cleanup_warm_runtime EXIT HUP INT TERM

  while IFS= read -r client_line; do
    if printf '%s\n' "$client_line" | grep -Eq '"method"[[:space:]]*:[[:space:]]*"initialize"'; then
      request_id=$(printf '%s\n' "$client_line" | sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*([^,}]+).*/\1/p')
      protocol_version=$(printf '%s\n' "$client_line" | sed -nE 's/.*"protocolVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p')
      if [ -z "$request_id" ] || [ -z "$protocol_version" ]; then
        printf '%s\n' "Invalid MCP initialize request." >&2
        exit 65
      fi
      printf '%s\n' "$client_line" >&3
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"prompts":{"listChanged":false},"logging":{}},"serverInfo":{"name":"ai-dev-system","version":"1.0.0"}}}\n' \
        "$request_id" "$protocol_version"
      continue
    fi
    printf '%s\n' "$client_line" >&3
  done
}

if [ -n "$runtime_container" ]; then
  run_warm_runtime
  exit $?
fi

set -- \
  run \
  --rm \
  -i \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --shm-size 1g \
  --network "${network}" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=volume,source=${data_volume},target=/data"

if [ -n "${AI_DEV_PROJECT_PATH:-}" ]; then
  case "${AI_DEV_PROJECT_PATH}" in
    *,*) printf '%s\n' "AI_DEV_PROJECT_PATH cannot contain a comma." >&2; exit 64 ;;
  esac
  project_path="$(cd "${AI_DEV_PROJECT_PATH}" && pwd -P)"
  set -- "$@" --mount "type=bind,source=${project_path},target=/workspace"
fi

if [ -n "${AI_DEV_MODEL_PATH:-}" ]; then
  case "${AI_DEV_MODEL_PATH}" in
    *,*) printf '%s\n' "AI_DEV_MODEL_PATH cannot contain a comma." >&2; exit 64 ;;
  esac
  model_path="$(cd "${AI_DEV_MODEL_PATH}" && pwd -P)"
  set -- "$@" --mount "type=bind,source=${model_path},target=/models/bge-m3,readonly"
fi

exec docker "$@" "${image}"

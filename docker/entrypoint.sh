#!/bin/sh
set -eu

umask 077

vault_root="${AI_DEV_VAULT_ROOT:-/data/ai-dev-system}"
case "${vault_root}" in
  /data/*) ;;
  *)
    printf '%s\n' "AI_DEV_VAULT_ROOT must stay below /data inside the container." >&2
    exit 64
    ;;
esac

mkdir -p \
  "${vault_root}" \
  "${HOME:-/data/runtime-home}" \
  "${AI_DEV_STATE_ROOT:-/data/runtime-home/.ai-dev/state}" \
  "${AI_DEV_SEARCH_INDEX_DIR:-/data/runtime-home/.ai-dev/cache/search-index}" \
  "${AI_DEV_FRONTEND_QA_ARTIFACT_ROOT:-/data/runtime-home/.ai-dev/artifacts/frontend-qa}" \
  "${vault_root}/09-mcp"

# Seed only missing files. Existing local knowledge and task state are never overwritten.
cp -a -n /opt/ai-dev/public-seed/. "${vault_root}/"

link_runtime() {
  source_path="$1"
  target_path="$2"
  if [ ! -e "${target_path}" ] && [ ! -L "${target_path}" ]; then
    ln -s "${source_path}" "${target_path}"
  fi
}

link_runtime /opt/ai-dev/app "${vault_root}/09-mcp/ai-dev-mcp-server"
link_runtime /opt/ai-dev/frontend-qa "${vault_root}/09-mcp/frontend-qa"
link_runtime /opt/ai-dev/search-index "${vault_root}/09-mcp/search-index"
link_runtime /opt/ai-dev/search-eval "${vault_root}/09-mcp/search-eval"
link_runtime /opt/ai-dev/embeddings "${vault_root}/09-mcp/embeddings"

node /opt/ai-dev/app/scripts/docker-bootstrap.mjs
exec "$@"

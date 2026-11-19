#!/bin/sh
# Before the command the container runs (the stdio server by default): the
# volume's folders, then the seed brought up to this image's by its manifest and
# whatever a first start builds — the skill registry, the quality report, the
# search index, the routing benchmark — when it is missing or out of date.
# On a volume Docker filled from the image it is all there and current: a read.
#
# 2.x copied the seed with `cp -a -n`, which never updated a file already in the
# volume, and linked the image's folders into 09-mcp/.
# Of the links a 2.x volume has, /opt/ai-dev/app, frontend-qa and search-eval
# still lead where they did; search-index and embeddings are gone with what they
# linked to (3.0 runs no Python), and what reads 09-mcp/ passes them over.
set -eu

umask 077

# Writing a client's config (bootstrap.sh runs `ai-dev clients …` in the image)
# reads nothing of the volume.
case "${1:-} ${2:-}" in
  "ai-dev clients") exec "$@" ;;
esac

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
  "${AI_DEV_FRONTEND_QA_ARTIFACT_ROOT:-/data/runtime-home/.ai-dev/artifacts/frontend-qa}"

node /opt/ai-dev/ai-dev-mcp-server/scripts/docker-bootstrap.mjs
exec "$@"

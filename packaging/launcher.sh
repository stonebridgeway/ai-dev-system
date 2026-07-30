#!/bin/sh
set -eu

system_root="@AI_DEV_SYSTEM_ROOT@"
command_name="${1:-bootstrap}"

case "$command_name" in
  bootstrap)
    shift
    exec /bin/sh "${system_root}/bootstrap.sh" "$@"
    ;;
  mcp)
    shift
    exec /bin/sh "${system_root}/docker/run-mcp.sh" "$@"
    ;;
  root)
    printf '%s\n' "$system_root"
    ;;
  --help|-h|help)
    cat <<'EOF'
Usage:
  ai-dev-system bootstrap [bootstrap options]
  ai-dev-system mcp
  ai-dev-system root

Bootstrap options can also be passed directly:
  ai-dev-system --install-prerequisites
EOF
    ;;
  *)
    exec /bin/sh "${system_root}/bootstrap.sh" "$@"
    ;;
esac

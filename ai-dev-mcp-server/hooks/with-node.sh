#!/bin/sh
# Installed by ai-dev-system (install_agent_hooks). Runs one hook script with
# Node, wherever this machine keeps it:
#
#   /bin/sh .ai-dev/hooks/with-node.sh <script.mjs> [arguments...]
#
# A bare `node` in a hook command is looked up on the PATH of whatever starts
# the hook, and an editor or a Git client opened from the Dock, a launcher or
# the Start menu does not have the shell's PATH: Node from nvm, fnm, Volta or
# Homebrew is not on it, and the hook failed with "node: not found" while the
# guard, the session handoff and the Stop check silently did nothing.
#
# Node is taken from, in order: AI_DEV_NODE; the Node this repository's hooks
# were installed with on this machine (.node-path next to this file, which
# git ignores); `node` on PATH; the places installers put it.
#
# A mistake here exits 1, never 2: Claude Code reads 2 from a hook as "block",
# and a launcher called wrongly would refuse every tool call.

# The folder of this file, without `dirname`: the PATH may hold nothing.
case $0 in
  */*) dir=${0%/*} ;;
  *) dir=. ;;
esac
script=$1
if [ -z "$script" ]; then
  echo "ai-dev hook: with-node.sh needs the hook script to run" >&2
  exit 1
fi
shift

# A Node is an executable file. `-x` alone is true of a folder as well, and
# AI_DEV_NODE naming Node's bin folder ended every hook in "Permission
# denied", exit 126, without trying anything else.
runnable() {
  [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ]
}

if [ -n "$AI_DEV_NODE" ] && ! runnable "$AI_DEV_NODE"; then
  echo "ai-dev hook: AI_DEV_NODE=$AI_DEV_NODE is not a Node executable; looking for Node elsewhere" >&2
fi

recorded=""
if [ -r "$dir/.node-path" ]; then
  IFS= read -r recorded < "$dir/.node-path" || true
fi

for candidate in "$AI_DEV_NODE" "$recorded"; do
  if runnable "$candidate"; then
    exec "$candidate" "$dir/$script" "$@"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec node "$dir/$script" "$@"
fi

for candidate in \
  "$HOME/.volta/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node \
  "$HOME/.asdf/shims/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$HOME/.local/bin/node"; do
  if runnable "$candidate"; then
    exec "$candidate" "$dir/$script" "$@"
  fi
done

echo "ai-dev hook: no Node found to run $script. Set AI_DEV_NODE to it, or run install_agent_hooks again from the machine's own Node." >&2
exit 127

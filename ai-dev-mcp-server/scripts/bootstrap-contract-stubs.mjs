// The `docker` both bootstrap contracts run against: bootstrap.sh's (bootstrap-contract.test.mjs) and bootstrap.ps1's
// (bootstrap-ps1-contract.test.mjs), each with a home of its own and this script first on PATH.
/**
 * A `docker` that logs each call (one line, the arguments joined by tabs) and
 * answers as a working engine would: the version, a pull (or a failed one, with
 * a cached copy of the image), the handshake with the server's instructions, and
 * for `ai-dev clients entry` an entry as JSON, for `ai-dev clients folders` FOLDERS (printf %b: \\t, \\n), or exit FOLDERS_EXIT. PULL=fail makes the pull fail;
 * SMOKE=bad answers the handshake with something that is not the server's;
 * NO_CLI names the images without the 3.0 installer (2.x ones), space-separated;
 * INSTALL=fail makes the installer fail as one client it could not write does.
 * The probe of the state folder writes nothing, as where Docker maps the
 * container's users; PROBE=shared writes the file as this user, PROBE=refused
 * is the container's own `touch` refused, and PROBE=broken a Docker that did
 * not run the image at all. MOUNT_DENY names a folder Docker refuses to mount,
 * as Docker Desktop refuses one outside its file sharing — with MOUNT_DENY_SAYS=
 * desktop in Docker Desktop's words, over lines ending in CRLF. TRUE_FAIL fails
 * the throwaway runs (`--entrypoint true`) as a failing engine does: `deadline`
 * (a timeout), `overlay` (a storage driver error that names a mount), `silent`
 * (exit 137, nothing said), `once` (only the first one: a passing flake), `bare`
 * (only the one with no folder: the engine check, flaking).
 */
export const stubDocker = [
  "#!/bin/sh",
  "{ first=1; for a in \"$@\"; do if [ $first = 1 ]; then printf '%s' \"$a\"; first=0; else printf '\\t%s' \"$a\"; fi; done; printf '\\n'; } >> \"$STUB_LOG\"",
  'sub="$1"',
  "shift",
  'case "$sub" in',
  "  version) echo 27.0.0; exit 0 ;;",
  '  pull) if [ "${PULL:-}" = fail ]; then echo "Error response from daemon: unauthorized" >&2; exit 1; fi; exit 0 ;;',
  "  image)",
  '    for a in "$@"; do',
  '      case "$a" in',
  "        *Created*) echo 2019-01-02T03:04:05.000000000Z; exit 0 ;;",
  "        *RepoDigests*) echo ghcr.io/example/ai-dev-system@sha256:cafebabe; exit 0 ;;",
  "      esac",
  "    done",
  "    exit 0 ;;",
  '  inspect) [ -n "${OLD_RUNTIME:-}" ] && { echo true; exit 0; }; exit 1 ;;',
  "  rm) exit 0 ;;",
  "  run)",
  '    if [ -n "${MOUNT_DENY:-}" ]; then for a in "$@"; do case "$a" in *"source=${MOUNT_DENY},"*)',
  '      if [ "${MOUNT_DENY_SAYS:-}" = desktop ]; then printf "docker: Error response from daemon: Mounts denied: \\r\\nThe path %s is not shared from the host and is not known to Docker.\\r\\nYou can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.\\r\\n" "$MOUNT_DENY" >&2;',
  '      else echo "docker: Error response from daemon: Mounts denied: the path ${MOUNT_DENY} is not shared from the host." >&2; fi; exit 125 ;; esac; done; fi',
  '    if [ -n "${TRUE_FAIL:-}" ]; then prev=""; for a in "$@"; do',
  '      if [ "$prev" = --entrypoint ] && [ "$a" = true ]; then',
  '        case "$TRUE_FAIL" in',
  '          silent) exit 137 ;;',
  '          overlay) echo "docker: Error response from daemon: error creating overlay mount to /var/lib/docker/overlay2/3f9c1a-init/merged: no such file or directory." >&2; exit 125 ;;',
  '          once) [ "$(grep -c -e "$(printf \'%s\\t%s\' --entrypoint true)" "$STUB_LOG")" -gt 1 ] && break ;;',
  '          bare) for m in "$@"; do [ "$m" = --mount ] && break 2; done ;;',
  '        esac',
  '        echo "docker: Error response from daemon: failed to create task for container: context deadline exceeded" >&2; exit 125',
  '      fi',
  '      prev=$a',
  '    done; fi',
  '    for a in "$@"; do [ "$a" = "command -v ai-dev" ] && { for i in "$@"; do case " ${NO_CLI:-} " in *" $i "*) exit 1 ;; esac; done; exit 0; }; done',
  '    for a in "$@"; do',
  '      [ "$a" = touch ] || continue',
  '      case "${PROBE:-}" in',
  '        shared) for m in "$@"; do case "$m" in type=bind,source=*,target=/ai-dev-state) s="${m#type=bind,source=}"; s="${s%,target=/ai-dev-state}" ;; esac; f="$m"; done; touch "$s/${f#/ai-dev-state/}" ;;',
  '        refused) echo "touch: cannot touch \'/ai-dev-state/probe\': Permission denied" >&2; exit 1 ;;',
  '        broken) echo "docker: Error response from daemon: failed to connect to the docker API." >&2; echo "Run \'docker run --help\' for more information" >&2; exit 125 ;;',
  '      esac',
  '      exit 0',
  '    done',
  '    for a in "$@"; do [ "$a" = folders ] && { printf "%b" "${FOLDERS:-}"; exit "${FOLDERS_EXIT:-0}"; }; done',
  '    for a in "$@"; do [ "$a" = entry ] && { echo \'{"type":"stdio","command":"/usr/bin/docker","args":["run","-i","--rm","stub"]}\'; exit 0; }; done',
  '    for a in "$@"; do [ "$a" = install ] && { [ "${INSTALL:-}" = fail ] && { echo "  Cursor   FAILED  ~/.cursor/mcp.json: EACCES" >&2; exit 1; }; echo "  Cursor   added   ~/.cursor/mcp.json"; exit 0; }; done',
  '    cat > /dev/null',
  '    if [ "${SMOKE:-}" = bad ]; then echo \'{"result":{"serverInfo":{"name":"made-up"}}}\'; else echo \'{"result":{"serverInfo":{"name":"ai-dev-system"},"instructions":"Begin with begin_task."}}\'; fi',
  "    exit 0 ;;",
  "esac",
  "exit 0",
  ""
].join("\n");

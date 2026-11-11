#!/bin/sh
# The Docker path in one command: check Docker, pull the image, write the AI
# clients' configs. The configs run the image themselves — `docker run -i --rm …`
# — and the image writes them: `ai-dev clients install --docker`, run in the
# image with nothing of this machine mounted but each client's config folder and
# the state folder. Node is not needed here.
#
# 2.x installed Docker itself, kept a long-lived "runtime container", answered
# the MCP handshake in a launcher instead of the server, and mounted the whole
# home folder to write the configs.
set -eu

project_path=""
project_default="${HOME}/AI-Dev-Projects"
project_given=0
image="${AI_DEV_IMAGE:-ghcr.io/stonebridgeway/ai-dev-system:latest}"
image_set=0
clients="all"
skip_smoke=0
skip_client_install=0
no_client=0
allow_stale_image=0
stale_warning=""
build_local=0
plan=0
node_image="${AI_DEV_BOOTSTRAP_NODE_IMAGE:-node:24-bookworm-slim}"
data_volume="${AI_DEV_DATA_VOLUME:-ai-dev-system-data}"
model_path="${AI_DEV_MODEL_PATH:-}"
model_given=0
[ -z "$model_path" ] || model_given=1

usage() {
  cat <<'EOF'
Usage: sh ./bootstrap.sh [options]

Options:
  --project-path PATH       The projects folder the server sees, at the same path (default: the one the
                            entries this replaces mount, 2.x's too; with none, ~/AI-Dev-Projects).
  --model-path PATH         A folder holding bge-m3-onnx/, mounted read-only as /models
                            (default: AI_DEV_MODEL_PATH, or the one the entries this replaces mount; none: the model is the volume's —
                            `docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev model install`).
  --image NAME              Docker image (default: ghcr.io/stonebridgeway/ai-dev-system:latest).
  --clients LIST            all (every client found here; the default), or some of
                            claude-code, claude-desktop, cursor, vscode, codex, gemini (claude = both).
  --build-local             Build ai-dev-system:local from this checkout.
  --skip-smoke              Skip the MCP handshake check.
  --allow-stale-image       Install the cached image when the registry pull fails.
  --skip-client-install     Do not write the AI clients' configs.
  --plan                    Print the plan as JSON without doing anything (the folders the
                            entries mount are read only on a run, so it shows the defaults).

Environment: AI_DEV_IMAGE, AI_DEV_DATA_VOLUME and AI_DEV_MODEL_PATH (the defaults of
--image, the data volume and --model-path); AI_DEV_STATE_ROOT or AI_DEV_HOME (the state
folder, found as the agent hooks find it); AI_DEV_INSTALLER_IMAGE (an image of 3.0 or later
that writes the configs when --image names a 2.x one; ghcr.io/stonebridgeway/ai-dev-system:3).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-path) project_path="$2"; project_given=1; shift 2 ;;
    --model-path) model_path="$2"; model_given=1; shift 2 ;;
    --image) image="$2"; image_set=1; shift 2 ;;
    --clients) clients="$2"; shift 2 ;;
    --build-local) build_local=1; shift ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --allow-stale-image) allow_stale_image=1; shift ;;
    --skip-client-install) skip_client_install=1; shift ;;
    --plan) plan=1; shift ;;
    --install-prerequisites)
      printf '%s\n' "--install-prerequisites: bootstrap.sh no longer installs Docker. Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/" >&2
      shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf '%s\n' "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ "$build_local" -eq 1 ] && [ "$image_set" -eq 0 ]; then
  image="ai-dev-system:local"
fi

# A misspelled client is a mistake, not "nothing to do"; and so is none at all.
case "$clients" in
  *[!,]*) ;;
  *) printf '%s\n' "--clients: name at least one client, or all." >&2; exit 64 ;;
esac
set -f
old_ifs=$IFS
IFS=','
for client_name in $clients; do
  case "$client_name" in
    all|claude|claude-code|claude-desktop|cursor|vscode|codex|gemini) ;;
    *)
      IFS=$old_ifs
      printf '%s\n' "--clients: \"${client_name}\" is no client here (all, claude, claude-code, claude-desktop, cursor, vscode, codex, gemini)." >&2
      exit 64 ;;
  esac
done
IFS=$old_ifs
set +f

# The state folder the agent hooks keep theirs in, found as they find it:
# AI_DEV_STATE_ROOT, else AI_DEV_HOME's — unless it names the home itself, which
# keeps 2.x's meaning — else ~/.ai-dev/state.
state_path="${HOME}/.ai-dev/state"
if [ -n "${AI_DEV_STATE_ROOT:-}" ]; then
  state_path="$AI_DEV_STATE_ROOT"
elif [ -n "${AI_DEV_HOME:-}" ]; then
  ai_dev_home_real=$(CDPATH= cd -- "$AI_DEV_HOME" 2>/dev/null && pwd -P || printf '%s' "$AI_DEV_HOME")
  home_real=$(CDPATH= cd -- "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")
  if [ "$ai_dev_home_real" != "$home_real" ]; then
    state_path="${AI_DEV_HOME}/state"
  fi
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
platform=$(uname -s)
installer_platform="linux"
app_data="${XDG_CONFIG_HOME:-${HOME}/.config}"
if [ "$platform" = "Darwin" ]; then
  installer_platform="darwin"
  app_data="${HOME}/Library/Application Support"
fi
uid=$(id -u)
gid=$(id -g)

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$plan" -eq 1 ]; then
  plan_model=""
  if [ -n "$model_path" ]; then
    plan_model=",\"model_path\":\"$(json_escape "$model_path")\""
  fi
  printf '{"repository":"%s","project_path":"%s","image":"%s","clients":"%s","data_volume":"%s","state_path":"%s"%s,"build_local":%s,"node_on_host_required":false}\n' \
    "$(json_escape "$repo_root")" "$(json_escape "${project_path:-$project_default}")" "$(json_escape "$image")" "$(json_escape "$clients")" \
    "$(json_escape "$data_volume")" "$(json_escape "$state_path")" "$plan_model" "$build_local"
  exit 0
fi

# Docker: there and running. Installing it is the platform's business.
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is required: install Docker Desktop (macOS) or Docker Engine (Linux) — https://docs.docker.com/get-docker/ — then run bootstrap.sh again." >&2
  exit 69
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  if [ "$platform" = "Darwin" ] && command -v open >/dev/null 2>&1; then
    open -a Docker >/dev/null 2>&1 || true
    attempt=0
    while [ "$attempt" -lt 24 ] && ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
      sleep 5
      attempt=$((attempt + 1))
    done
  fi
  if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    printf '%s\n' "Docker is installed but its engine is not running (or this user may not use it). Start Docker Desktop/Engine and run bootstrap.sh again." >&2
    exit 69
  fi
fi
docker_command=$(command -v docker)

# A folder a docker --mount can hold: no comma, no double quote.
mountable_folder() {
  case "$1" in
    *,*|*\"*) printf '%s\n' "${1} has a comma or a double quote, which a docker --mount cannot hold. Choose a folder without one." >&2; exit 64 ;;
  esac
}
for folder_value in "$project_path" "$state_path" "$model_path"; do
  mountable_folder "$folder_value"
done
# The projects folder, made and named by its real path; the default when none is named or found.
settle_projects() {
  [ -n "$project_path" ] || project_path="$project_default"
  mountable_folder "$project_path"
  mkdir -p "$project_path"
  project_path=$(CDPATH= cd -- "$project_path" && pwd -P)
}
mkdir -p "$state_path"
state_path=$(CDPATH= cd -- "$state_path" && pwd -P)
# The model folder, checked as Docker will mount it.
settle_model() {
  [ -n "$model_path" ] || return 0
  mountable_folder "$model_path"
  if [ ! -d "$model_path" ]; then
    printf '%s\n' "Model path does not exist: ${model_path}" >&2
    exit 64
  fi
  model_path=$(CDPATH= cd -- "$model_path" && pwd -P)
  # The folder above the model, holding bge-m3-onnx/:
  # one that holds model files itself is the 2.0.0 value and leaves the model
  # a level too deep; a lone bge-m3/ is the removed Python backend's weights.
  for marker in pytorch_model.bin modules.json config.json onnx; do
    if [ -e "${model_path}/${marker}" ]; then
      printf '%s\n' "--model-path names the folder above the models, and ${model_path} holds model files itself (${marker}). Point it at the parent folder that contains bge-m3-onnx/ (docs/INSTALL.md)." >&2
      exit 64
    fi
  done
  # A bge-m3-onnx that is a link is mounted itself, and Docker follows it here; the image, writing the configs, cannot
  # see where it leads, so a link that leads nowhere is refused now: no session would start over it.
  if [ -L "${model_path}/bge-m3-onnx" ] && [ ! -d "${model_path}/bge-m3-onnx" ]; then
    printf '%s\n' "${model_path}/bge-m3-onnx is a link to $(readlink "${model_path}/bge-m3-onnx") that leads nowhere here: connect the disk it leads to, or point --model-path at another folder." >&2
    exit 64
  fi
  # And a session mounts it every time: while what it leads to is away — a disk unplugged — Docker starts no
  # session at all, so that is said now.
  if [ -L "${model_path}/bge-m3-onnx" ]; then
    printf '%s\n' "${model_path}/bge-m3-onnx is a link to $(readlink "${model_path}/bge-m3-onnx"): every session mounts what it leads to, so if that is a disk you disconnect, Docker starts no session while it is away, and the AI client's log shows Docker's \"bind source path does not exist\"." >&2
  fi
  if [ ! -d "${model_path}/bge-m3-onnx" ]; then
    printf '%s\n' "${model_path} holds no bge-m3-onnx/ yet; dense search will report that it is not set up until a model is put there." >&2
  fi
}
# A folder named is settled now; one not named waits for the entries this install replaces.
if [ "$project_given" -eq 1 ] || [ "$skip_client_install" -eq 1 ]; then
  settle_projects
fi
if [ "$model_given" -eq 1 ]; then
  settle_model
fi

if [ "$build_local" -eq 1 ]; then
  printf '%s\n' "Preparing the Docker context with a temporary Node.js 24..."
  docker run --rm --user "${uid}:${gid}" \
    --mount "type=bind,source=${repo_root},target=${repo_root}" \
    --workdir "${repo_root}/ai-dev-mcp-server" \
    "$node_image" sh -c 'node scripts/prepare-docker-context.mjs && node scripts/audit-docker-context.mjs'
  printf '%s\n' "Building ${image}..."
  docker build --tag "$image" "${repo_root}/.docker/build-context"
else
  printf '%s\n' "Pulling ${image}..."
  if ! docker pull "$image"; then
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      printf '%s\n' "Could not pull ${image}, and no cached copy exists." >&2
      exit 69
    fi
    # Installing whatever happened to be in the cache produced bug reports
    # about defects already fixed upstream, so the age
    # of that copy is stated and using it is a deliberate choice.
    stale_created=$(docker image inspect --format '{{.Created}}' "$image" 2>/dev/null || true)
    stale_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || true)
    [ -n "$stale_created" ] || stale_created="unknown"
    [ -n "$stale_digest" ] || stale_digest="none (image was built locally)"
    stale_warning="Registry pull failed. The cached copy of ${image} was created ${stale_created} (digest: ${stale_digest}) and is missing anything released since."
    printf '%s\n' "$stale_warning" >&2
    if [ "$allow_stale_image" -ne 1 ]; then
      printf '%s\n' "Stopping rather than installing an image of unknown age. Restore the registry connection and run again, or re-run with --allow-stale-image." >&2
      exit 69
    fi
  fi
fi

if [ "$skip_smoke" -ne 1 ]; then
  printf '%s\n' "Checking the MCP handshake..."
  # The server's own answer, instructions and all: 2.x checked for a serverInfo
  # its launcher wrote itself.
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ai-dev-bootstrap","version":"1"}}}'
  if ! printf '%s\n' "$init" | docker run --rm -i --read-only --tmpfs /tmp:rw,exec,nosuid,size=512m --network none \
      --security-opt no-new-privileges:true --cap-drop ALL \
      --mount "type=volume,source=${data_volume},target=/data" "$image" 2>/dev/null | grep -q '"instructions"'; then
    printf '%s\n' "The server in ${image} did not answer the MCP handshake." >&2
    exit 70
  fi
fi

install_status=0
if [ "$skip_client_install" -ne 1 ]; then
  # The configs are written by the image's own installer. A 2.x image has none —
  # the way back to :2 is still a 3.0 entry, which runs it — so an image of 3.0
  # writes them then: AI_DEV_INSTALLER_IMAGE, pulled as the image is, and used
  # only once it is seen to have one. Both images
  # are here by now, so no `--pull never`, which a Docker CLI before 20.10 does
  # not know.
  has_installer() {
    docker run --rm --network none --entrypoint sh "$1" -c 'command -v ai-dev' >/dev/null 2>&1
  }
  installer_image="$image"
  if ! has_installer "$image"; then
    # The 3.x line, not :latest, which a rollback points at 2.x again.
    installer_image="${AI_DEV_INSTALLER_IMAGE:-ghcr.io/stonebridgeway/ai-dev-system:3}"
    printf '%s\n' "${image} has no installer of its own (a 2.x image): ${installer_image} writes the configs that run it."
    if ! docker pull "$installer_image" && ! docker image inspect "$installer_image" >/dev/null 2>&1; then
      printf '%s\n' "Could not pull ${installer_image}, and no copy of it is here: name an image of 3.0 or later with AI_DEV_INSTALLER_IMAGE." >&2
      exit 69
    fi
    if ! has_installer "$installer_image"; then
      printf '%s\n' "${installer_image} has no installer either (a 2.x image too): name an image of 3.0 or later with AI_DEV_INSTALLER_IMAGE." >&2
      exit 69
    fi
  fi

  # Whether the image's user may share the state folder, tried on Linux whatever
  # the uid: where Docker maps the container's uid 1000 to another host user —
  # rootless Docker, userns-remap, Podman — it cannot write the folder, and the
  # server keeps its state in the volume, as 2.x did. A Docker that did
  # not run the image tried nothing, and is not taken for one. Docker
  # Desktop on macOS gives what the container writes to the user. This script
  # decided it, so this script says why, once. The image is here
  # by now: no `--pull`, which a Docker CLI before 20.10 does not know.
  shared_state=yes
  if [ "$platform" != "Darwin" ]; then
    probe=".ai-dev-share-probe-$$"
    if probe_error=$(docker run --rm --network none --entrypoint touch \
        --mount "type=bind,source=${state_path},target=/ai-dev-state" "$image" "/ai-dev-state/${probe}" 2>&1 >/dev/null); then
      if [ -O "${state_path}/${probe}" ]; then
        shared_state=yes
      else
        shared_state=no
        why="what a container of the image wrote into your state folder is not yours: Docker maps the container's users here (rootless Docker, userns-remap or Podman)"
      fi
    else
      case "$probe_error" in
        *"cannot touch"*)
          shared_state=no
          why="a container of the image could not write your state folder (${probe_error%%
*})" ;;
        *) shared_state=untried ;;
      esac
    fi
    rm -f "${state_path:?}/${probe:?}" 2>/dev/null || true
    if [ "$shared_state" = untried ]; then
      printf '%s\n' "Could not try sharing ${state_path} with ${image}: ${probe_error}" \
        "Your state folder is not shared with the server for now: it keeps its state in the volume. Run bootstrap.sh again once Docker runs the image." >&2
    elif [ "$shared_state" = no ]; then
      [ "$uid" -eq 1000 ] || why="the image's user (uid 1000) is not yours (uid ${uid}), so a folder of yours is not one the container may share"
      printf '%s\n' "The agent hooks keep their state apart from the server's: ${why}. The server keeps its state in the volume, as 2.x did, and cannot write into your projects. On this machine the local install is the one to use (docs/INSTALL.md)." >&2
    fi
  fi

  # The image writes the configs, given each client's own folder and nothing
  # else of this machine. A client named on the command line gets its folder
  # made, as the installer would write it anyway.
  codex_home="${CODEX_HOME:-${HOME}/.codex}"
  wants() {
    case ",${clients}," in
      *,all,*|*",$1,"*) return 0 ;;
      *,claude,*) [ "$1" = "claude-desktop" ] || [ "$1" = "claude-code" ] ;;
      *) return 1 ;;
    esac
  }
  # Mounts are lines of "source,target": a docker --mount holds no comma, so a
  # path with one is refused before it gets here. One line a folder:
  # "Application Support" has a space in it.
  nl='
'
  add_mount() {
    case "$1$2" in
      *,*|*\"*|*"$nl"*) printf '%s\n' "${2} has a comma, a double quote or a line break, which a docker --mount cannot hold; skipped." >&2; return 1 ;;
    esac
    case "$client_mounts" in
      *",${2}${nl}"*) return 0 ;;
    esac
    client_mounts="${client_mounts}${1},${2}${nl}"
  }
  # A path as the container resolves it, with only the mounts it is given: `.`
  # and `..` taken out as text.
  normalize_path() {
    out=""
    IFS=/
    set -f
    for part in $1; do
      case "$part" in
        ''|.) ;;
        ..) out="${out%/*}" ;;
        *) out="${out}/${part}" ;;
      esac
    done
    printf '%s' "${out:-/}"
  }
  home_real=$(CDPATH= cd -- "$HOME" 2>/dev/null && pwd -P) || home_real=$HOME
  # The root, the home or a folder above it is not handed to the installer whole.
  too_wide() {
    case "$1" in /) return 0 ;; esac
    case "${HOME%/}/" in "${1%/}/"*) return 0 ;; esac
    case "${home_real%/}/" in "${1%/}/"*) return 0 ;; esac
    return 1
  }
  # A config that is a link — a dotfiles repository — is written through it:
  # each folder on the way is mounted at the path the link spells, from the
  # folder it really is, since the container follows the link by its spelling.
  follow_links() {
    c_dir=$2
    h_dir=$(CDPATH= cd -- "$2" 2>/dev/null && pwd -P) || return 0
    name=$3
    hops=0
    while [ -L "${h_dir}/${name}" ] && [ "$hops" -lt 8 ]; do
      target=$(readlink "${h_dir}/${name}")
      case "$target" in
        /*) c_target=$(normalize_path "$target"); h_base=$(dirname -- "$target") ;;
        *) c_target=$(normalize_path "${c_dir}/${target}"); h_base="${h_dir}/$(dirname -- "$target")" ;;
      esac
      if ! h_tdir=$(CDPATH= cd -- "$h_base" 2>/dev/null && pwd -P); then
        printf '%s\n' "${1}: its config leads to ${c_target}, in a folder that is not there: not configured. Make the folder, or point the link elsewhere." >&2
        return 1
      fi
      c_tdir=$(dirname -- "$c_target")
      if too_wide "$c_tdir" || too_wide "$h_tdir"; then
        printf '%s\n' "${1}: its config leads to ${c_target}, and bootstrap does not hand the installer ${c_tdir} whole (the root, your home or a folder above it): not configured. Link it into a folder of its own." >&2
        return 1
      fi
      add_mount "$h_tdir" "$c_tdir" || return 1
      c_dir=$c_tdir
      h_dir=$h_tdir
      name=$(basename -- "$target")
      hops=$((hops + 1))
    done
  }
  # Docker takes these folders ("source,target" lines), or says why not.
  mounts_taken() {
    lines=$1
    set -- run --rm --network none --entrypoint true
    set -f
    old_ifs=$IFS
    IFS=$nl
    for line in $lines; do
      set -- "$@" --mount "type=bind,source=${line%%,*},target=${line#*,}"
    done
    IFS=$old_ifs
    set +f
    docker "$@" "$installer_image" 2>&1 >/dev/null
  }
  # Whether Docker runs the image at all, with no folder of the clients': what
  # it says when it does not — a timeout, a storage driver, a daemon gone.
  engine_check() {
    docker run --rm --network none --entrypoint true "$installer_image" 2>&1 >/dev/null
  }
  # What Docker said: its first line, carried on to the next when it ends at a
  # colon — Docker Desktop names the path there — and with no carriage return;
  # its exit status when it said nothing.
  said() {
    text=$(printf '%s' "$1" | tr -d '\r')
    first=${text%%"$nl"*}
    case "$first" in
      *: | *": ")
        rest=${text#*"$nl"}
        [ "$rest" = "$text" ] || first="${first% } ${rest%%"$nl"*}"
        ;;
    esac
    printf '%s' "${first:-exit status $2}"
  }
  # The folders of the clients named (",cursor,codex,"), each target once.
  mounts_of() {
    picked="$nl"
    set -f
    old_ifs=$IFS
    IFS=$nl
    for line in $candidate_mounts; do
      case "$1" in *",${line%%,*},"*) ;; *) continue ;; esac
      pair="${line#*,}"
      case "$picked" in *",${pair#*,}${nl}"*) ;; *) picked="${picked}${pair}${nl}" ;; esac
    done
    IFS=$old_ifs
    set +f
    printf '%s' "$picked"
  }
  candidate_mounts="$nl"
  candidates=","
  for entry in "claude-desktop:${app_data}/Claude:claude_desktop_config.json:Claude Desktop" "cursor:${HOME}/.cursor:mcp.json:Cursor" \
      "vscode:${app_data}/Code/User:mcp.json:VS Code" "codex:${codex_home}:config.toml:Codex" "gemini:${HOME}/.gemini:settings.json:Gemini CLI"; do
    client="${entry%%:*}"
    rest="${entry#*:}"
    label="${rest##*:}"
    rest="${rest%:*}"
    file="${rest##*:}"
    folder="${rest%:*}"
    # As the links are: a HOME with a slash at its end spells the same folder twice otherwise.
    case "$folder" in /*) folder=$(normalize_path "$folder") ;; esac
    wants "$client" || continue
    case ",${clients}," in
      *,all,*) [ -d "$folder" ] || continue ;;
      *) mkdir -p "$folder" ;;
    esac
    client_mounts="$nl"
    if ! add_mount "$folder" "$folder" || ! follow_links "$label" "$folder" "$file"; then
      install_status=1
      continue
    fi
    set -f
    old_ifs=$IFS
    IFS=$nl
    for line in $client_mounts; do
      candidate_mounts="${candidate_mounts}${client},${line}${nl}"
    done
    IFS=$old_ifs
    set +f
    candidates="${candidates}${client},"
  done
  # Docker takes every client's folders in one look, or each client is looked
  # at alone: a folder it refuses — outside Docker Desktop's file sharing, say —
  # costs that client alone. A client whose look passes shows that
  # Docker runs the image, so the others' were refused; only when none passes is
  # Docker asked to run it with no folder at all, and if that fails too it is the
  # engine: said once, and the install goes on and says what fails.
  look=0
  refused=""
  if [ "$candidates" != "," ]; then
    refused=$(mounts_taken "$(mounts_of "$candidates")") || look=$?
  fi
  if [ "$look" != 0 ]; then
    taken=","
    lost=""
    set -f
    old_ifs=$IFS
    IFS=,
    for client in $candidates; do
      [ -n "$client" ] || continue
      IFS=$old_ifs
      status=0
      refused=$(mounts_taken "$(mounts_of ",${client},")") || status=$?
      if [ "$status" = 0 ]; then
        taken="${taken}${client},"
      else
        lost="${lost}${client},$(said "$refused" "$status")${nl}"
      fi
      IFS=,
    done
    engine=0
    engine_said=""
    if [ "$taken" = "," ]; then
      engine_said=$(engine_check) || engine=$?
    fi
    if [ "$engine" != 0 ]; then
      printf '%s\n' "Docker could not look at the clients' folders first ($(said "$engine_said" "$engine")): the install goes on, and says what fails." >&2
    else
      IFS=$nl
      for line in $lost; do
        IFS=$old_ifs
        case "${line%%,*}" in
          claude-desktop) label="Claude Desktop" ;;
          vscode) label="VS Code" ;;
          gemini) label="Gemini CLI" ;;
          cursor) label="Cursor" ;;
          *) label="Codex" ;;
        esac
        printf '%s\n' "${label}: Docker did not take a folder its config leads to (${line#*,}): not configured." >&2
        install_status=1
        IFS=$nl
      done
      candidates=$taken
    fi
    IFS=$old_ifs
    set +f
  fi
  mounted=$(mounts_of "$candidates")
  install_clients=${candidates#,}
  install_clients=${install_clients%,}
  # A folder not named is the one the entries this install replaces mount — a 2.x entry's AI_DEV_PROJECT_PATH and
  # AI_DEV_MODEL_PATH too — so running bootstrap again, or after 2.x, keeps what the server sees.
  if [ "$project_given" -eq 0 ] || [ "$model_given" -eq 0 ]; then
    set -- run --rm --network none --user "${uid}:${gid}" --read-only --tmpfs /tmp:rw,size=64m \
      --env "HOME=${HOME}" --env "XDG_CONFIG_HOME=${app_data}" --env "CODEX_HOME=${codex_home}"
    set -f
    old_ifs=$IFS
    IFS=$nl
    for line in $mounted; do
      set -- "$@" --mount "type=bind,source=${line%%,*},target=${line#*,},readonly"
    done
    IFS=$old_ifs
    set +f
    if wants claude-code && [ -f "${HOME}/.claude.json" ]; then
      set -- "$@" --mount "type=bind,source=${HOME}/.claude.json,target=${HOME}/.claude.json,readonly"
    fi
    # A lookup that fails — an installer older than the command, a Docker error — says so.
    if ! entry_folders=$(docker "$@" "$installer_image" ai-dev clients folders --clients="$clients" --home="$HOME" \
      --platform="$installer_platform" 2>/dev/null </dev/null); then
      entry_folders=""
      printf '%s\n' "Could not read the folders the clients' entries mount: name yours with --project-path and --model-path, or the defaults stand." >&2
    fi
    tab=$(printf '\t')
    while IFS=$tab read -r role folder labels; do
      # Only an absolute folder is taken from an entry: `~` or a relative one is a hand edit no session mounted as meant.
      case "$role:$folder" in
        projects:/*|model:/*) ;;
        projects:*|model:*)
          printf '%s\n' "${folder}, the ${role} folder ${labels} mounted, is not an absolute path: it is not kept; name one with --$([ "$role" = projects ] && printf project-path || printf model-path)." >&2
          continue
          ;;
      esac
      case "$role" in
        projects) [ "$project_given" -eq 1 ] || { project_path=$folder; project_from=$labels; } ;;
        model) [ "$model_given" -eq 1 ] || { model_path=$folder; model_from=$labels; } ;;
        differ)
          if { [ "$folder" = projects ] && [ "$project_given" -eq 0 ]; } || { [ "$folder" = model ] && [ "$model_given" -eq 0 ]; }; then
            printf '%s\n' "The clients' entries mount different ${folder} folders: ${labels}. Name the one to keep with --$([ "$folder" = projects ] && printf project-path || printf model-path)." >&2
            exit 64
          fi
          ;;
      esac
    done <<EOF
${entry_folders}
EOF
    if [ -n "${project_from:-}" ]; then
      printf '%s\n' "Projects folder: ${project_path}, the one ${project_from} mounted (--project-path names another)."
    fi
    # A folder that holds 2.x's Python model and not 3.0's is not kept: 3.0 does not run it; one that is gone mounts
    # nothing. Any other is kept, as the first install took it.
    if [ -n "${model_from:-}" ]; then
      if [ -d "$model_path" ] && [ ! -d "${model_path}/bge-m3-onnx" ] && { [ -d "${model_path}/bge-m3" ] || [ -e "${model_path}/pytorch_model.bin" ]; }; then
        printf '%s\n' "${model_path}, the model folder ${model_from} mounted, holds 2.x's Python model and no bge-m3-onnx/, which 3.0 runs: none is mounted; name one with --model-path." >&2
        model_path=""
      elif [ -d "$model_path" ]; then
        printf '%s\n' "Model folder: ${model_path}, the one ${model_from} mounted (--model-path names another)."
      else
        printf '%s\n' "${model_path}, the model folder ${model_from} mounted, is not here: none is mounted; name one with --model-path." >&2
        model_path=""
      fi
    fi
  fi
  settle_projects
  [ "$model_given" -eq 1 ] || settle_model
  set -- run --rm --network none --user "${uid}:${gid}" --read-only --tmpfs /tmp:rw,size=64m \
    --env "HOME=${HOME}" --env "XDG_CONFIG_HOME=${app_data}" --env "CODEX_HOME=${codex_home}"
  if [ -n "$model_path" ]; then
    set -- "$@" --mount "type=bind,source=${model_path},target=${model_path},readonly"
  fi
  # Claude Code's entry is printed, not written: it needs none of the clients' folders.
  claude_entry=""
  if wants claude-code && { [ -e "${HOME}/.claude.json" ] || [ -d "${HOME}/.claude" ] || [ "$clients" != "all" ]; }; then
    if entry=$(docker "$@" "$installer_image" ai-dev clients entry claude-code \
        --docker --image="$image" --projects="$project_path" --state="$state_path" --shared-state="$shared_state" --volume="$data_volume" \
        --home="$HOME" --platform="$installer_platform" --docker-command="$docker_command" \
        ${model_path:+"--model=$model_path"}); then
      claude_entry=$entry
    else
      install_status=1
    fi
  fi
  if [ -n "$install_clients" ]; then
    set -f
    old_ifs=$IFS
    IFS=$nl
    for line in $mounted; do
      set -- "$@" --mount "type=bind,source=${line%%,*},target=${line#*,}"
    done
    IFS=$old_ifs
    set +f
    set -- "$@" --mount "type=bind,source=${state_path},target=${state_path}"
    printf '%s\n' "Writing the AI clients' configs (${install_clients})..."
    # One client that cannot be written does not stop the others, nor Claude Code below.
    if ! docker "$@" "$installer_image" ai-dev clients install --clients="$install_clients" \
        --docker --image="$image" --projects="$project_path" --state="$state_path" --shared-state="$shared_state" --volume="$data_volume" \
        --home="$HOME" --platform="$installer_platform" --docker-command="$docker_command" \
        ${model_path:+"--model=$model_path"}; then
      install_status=1
    fi
  fi
  # Claude Code keeps its servers in ~/.claude.json, a file in the home, which
  # the image is not given: its own CLI writes the entry the image printed.
  if [ -n "$claude_entry" ]; then
    if command -v claude >/dev/null 2>&1; then
      if [ -f "${HOME}/.claude.json" ]; then
        cp "${HOME}/.claude.json" "${HOME}/.claude.json.backup-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
      fi
      claude mcp remove ai-dev --scope user >/dev/null 2>&1 || true
      claude mcp remove ai-dev-system --scope user >/dev/null 2>&1 || true
      if claude mcp add-json ai-dev "$claude_entry" --scope user; then
        printf '%s\n' "  Claude Code             added through \`claude mcp add-json\`"
      else
        install_status=1
      fi
    else
      printf '%s\n' "Claude Code: its CLI is not on PATH here. Add the entry with:" >&2
      printf "  claude mcp add-json ai-dev '%s' --scope user\n" "$claude_entry" >&2
    fi
  fi
  # Every client by default, and none of them here: nothing was written, and that is said, as the image's
  # installer says it when it is asked.
  if [ -z "$install_clients" ] && [ -z "$claude_entry" ] && [ "$install_status" -eq 0 ]; then
    no_client=1
    printf '%s\n' "No AI client found here (Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI). Name one to write its config anyway, --clients cursor,vscode,…, or install one and run bootstrap.sh again."
  fi
fi

# 2.x kept a long-lived container per user; 3.0 runs one per session. It goes
# once the configs that named it are rewritten, not before.
old_runtime="ai-dev-system-runtime-${uid}"
if [ "$skip_client_install" -ne 1 ] && [ "$install_status" -eq 0 ] \
    && [ "$(docker inspect --format '{{index .Config.Labels "ai-dev.system.runtime"}}' "$old_runtime" 2>/dev/null || true)" = "true" ]; then
  printf '%s\n' "Removing the 2.x runtime container ${old_runtime}: each session runs the image now."
  docker rm -f "$old_runtime" >/dev/null
fi

if [ -n "$stale_warning" ]; then
  printf '%s\n' "Installed from a stale image. ${stale_warning}" >&2
fi
if [ "$install_status" -ne 0 ]; then
  printf '%s\n' "Some AI clients were not configured: see above for which, and why. Run bootstrap.sh again once that is fixed." >&2
  exit 1
fi
# The last line says what was done to the clients, no more: a restart when there were clients to connect —
# written, already current, or Claude Code's entry printed for you to add.
if [ "$skip_client_install" -eq 1 ]; then
  printf '%s\n' "AI Dev is ready; the AI clients' configs were left as they were."
elif [ "$no_client" -eq 1 ]; then
  printf '%s\n' "AI Dev is ready; no AI client is connected to it yet."
else
  printf '%s\n' "AI Dev is ready. Restart the AI clients to load ai-dev."
fi

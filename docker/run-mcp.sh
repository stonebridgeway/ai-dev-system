#!/bin/sh
# The 2.x launcher, kept so that the client configs naming it work until 4.0.
# 3.0 writes `docker run -i --rm …` into a client's config
# itself — ./bootstrap.sh, or `ai-dev clients install --docker` — and this file
# runs the same image the way 2.x's cold path did.
#
# Two things 2.x did here are gone. It answered `initialize` itself while the
# server started, which lost the server's instructions and fixed the version
# at 2.0.0: the image answers in about a second now.
# And with AI_DEV_RUNTIME_CONTAINER set it ran the server in a long-lived
# container, which kept the image it was started with, so a pulled image never
# reached a session: every session runs AI_DEV_IMAGE now.
set -eu

image="${AI_DEV_IMAGE:-ai-dev-system:local}"
data_volume="${AI_DEV_DATA_VOLUME:-ai-dev-system-data}"
network="${AI_DEV_DOCKER_NETWORK:-none}"

printf '%s\n' "ai-dev: this client config runs docker/run-mcp.sh, the 2.x launcher, which works until 4.0. Run ./bootstrap.sh (or \`ai-dev clients install --docker\`) to write the 3.0 entry: docker run, with the projects at their own path and the state your agent hooks share." >&2
if [ -n "${AI_DEV_RUNTIME_CONTAINER:-}" ]; then
  printf '%s\n' "ai-dev: the container ${AI_DEV_RUNTIME_CONTAINER} is not used any more: each session runs ${image}. \`docker rm -f ${AI_DEV_RUNTIME_CONTAINER}\` removes it." >&2
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
  # The folder above the model: it holds bge-m3-onnx/.
  # A bge-m3/ beside it is the Python backend's weights, which 3.0 removed:
  # said, not taken for a model.
  #
  # In 2.0.0 the variable named the model directory itself. A folder that
  # holds model files is that old value; mounted at /models it would leave both
  # backends looking one level too deep and reporting "not set up".
  for marker in pytorch_model.bin modules.json config.json onnx; do
    if [ -e "${model_path}/${marker}" ]; then
      printf '%s\n' "AI_DEV_MODEL_PATH now names the folder above the models, and ${model_path} holds model files itself (${marker}). Point it at the parent folder that contains bge-m3-onnx/ — for a default install that is \$HOME/.ai-dev/models (docs/INSTALL.md)." >&2
      exit 64
    fi
  done
  if [ -L "${model_path}/bge-m3-onnx" ] && [ ! -d "${model_path}/bge-m3-onnx" ]; then
    printf '%s\n' "AI_DEV_MODEL_PATH=${model_path}: its bge-m3-onnx is a link to $(readlink "${model_path}/bge-m3-onnx") that leads nowhere here; dense search will report that it is not set up until the disk it leads to is connected." >&2
  elif [ ! -d "${model_path}/bge-m3-onnx" ]; then
    if [ -d "${model_path}/bge-m3" ]; then
      printf '%s\n' "AI_DEV_MODEL_PATH=${model_path} holds bge-m3/, the weights of the Python backend 3.0 removed, and no bge-m3-onnx/; dense search will report that it is not set up. Put the ONNX model there: npm run model -- install --dir ${model_path}/bge-m3-onnx (docs/INSTALL.md)." >&2
    else
      printf '%s\n' "AI_DEV_MODEL_PATH=${model_path} holds no bge-m3-onnx/; dense search will report that it is not set up until a model is put there." >&2
    fi
  fi
  # A bge-m3-onnx that is a link is mounted itself: Docker follows it here, where the container could not.
  if [ -L "${model_path}/bge-m3-onnx" ] && [ -d "${model_path}/bge-m3-onnx" ]; then
    set -- "$@" --mount "type=bind,source=${model_path}/bge-m3-onnx,target=/models/bge-m3-onnx,readonly"
  else
    set -- "$@" --mount "type=bind,source=${model_path},target=/models,readonly"
  fi
fi

exec docker "$@" "${image}"

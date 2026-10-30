# syntax=docker/dockerfile:1.7

# The image is the distribution `npm run dist` builds — the same files, checked
# against its distribution.json — run by Node in a small Linux. The build
# context is `npm run docker:prepare`'s: the distribution in ai-dev/, this file,
# and the entrypoint in container/.
#
# Two variants, by target:
#   server  (the default)  the MCP server, git, tini and gitleaks; no Python, no browser;
#   browser                the same plus Chromium for Frontend QA, ~0.8 GB more —
#                          a separate tag (`-browser`), because most users never run it.
#
# gitleaks is the only one of the six security scanners that works with no
# network at all, and the container runs with `--network none`. Without it
# `run_security_scan` in the image comes back `unchecked`. A static Go binary,
# copied out of the upstream image; the digest is the
# multi-arch index for v8.30.1 (linux/amd64 and linux/arm64). MIT licensed; see
# THIRD_PARTY_NOTICES.md.
#
# Every image argument is declared before the first FROM: an ARG after a FROM
# belongs to that stage alone. BASE_IMAGE is any Debian
# or Ubuntu with apt and glibc; Node comes from NODE_IMAGE.
ARG GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
ARG NODE_IMAGE=node:24-bookworm-slim
ARG BASE_IMAGE=debian:bookworm-slim
FROM ${GITLEAKS_IMAGE} AS gitleaks
FROM ${NODE_IMAGE} AS node

FROM ${BASE_IMAGE} AS server-build

ARG VERSION=dev
ARG VCS_REF=unknown
ARG SOURCE_URL=""
ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="AI Dev MCP System" \
      org.opencontainers.image.description="Local-first MCP engineering system for AI agents" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"

# git for the project tools, tini as PID 1. The account is 2.x's: `node`,
# uid 1000 (a base that already has a uid 1000, as Ubuntu's `ubuntu`, gives it up).
# git trusts the projects mounted into the container whoever owns them on the
# host: without it a project of another uid was silently "not a repository".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && if getent passwd 1000 >/dev/null && [ "$(getent passwd 1000 | cut -d: -f1)" != "node" ]; then userdel --remove "$(getent passwd 1000 | cut -d: -f1)"; fi \
    && if getent group 1000 >/dev/null && [ "$(getent group 1000 | cut -d: -f1)" != "node" ]; then groupdel "$(getent group 1000 | cut -d: -f1)"; fi \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home --home-dir /home/node --shell /bin/sh node \
    && git config --system --add safe.directory '*'

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

# The dependencies first, from the distribution's own shrinkwrap, so a change to
# the code does not reinstall them. --ignore-scripts on purpose:
# onnxruntime-node ships its binaries inside the package, and the step
# proves they load. Only this platform's are kept: the package carries
# macOS and Windows builds too, 245 MB no container runs; and
# onnxruntime-web, which transformers.js bundles into its Node build. HOME is a
# scratch folder, so no cache lands in /data, which every new volume copies.
WORKDIR /opt/ai-dev
COPY ai-dev/package.json ai-dev/npm-shrinkwrap.json ./
RUN HOME=/tmp/build-home npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && case "${TARGETARCH:-}" in amd64) keep=x64 ;; arm64) keep=arm64 ;; *) keep="" ;; esac \
    && if [ -n "${keep}" ]; then \
         for build in node_modules/onnxruntime-node/bin/napi-v*/*/*; do \
           case "${build}" in */linux/"${keep}") ;; *) rm -rf "${build}" ;; esac; \
         done; \
         find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d -empty -delete; \
       fi \
    && rm -rf node_modules/onnxruntime-web \
    && node -e "import('onnxruntime-node').then((m) => { if (!m.InferenceSession) { throw new Error('onnxruntime-node loaded without InferenceSession'); } })" \
    && node -e "import('@huggingface/transformers').then((m) => { if (!m.pipeline) { throw new Error('transformers.js loaded without pipeline'); } })" \
    && rm -rf /tmp/build-home

# The rest of the distribution, checked file by file against distribution.json.
# Then the paths 2.x configs and volumes name: the server at /opt/ai-dev/app
# (`docker exec … node /opt/ai-dev/app/src/server.mjs`, 2.x volumes' 09-mcp
# links) and the seed at /opt/ai-dev/public-seed; and `ai-dev` on PATH.
COPY ai-dev/ ./
RUN node ai-dev-mcp-server/scripts/verify-distribution.mjs --root /opt/ai-dev \
    && ln -s ai-dev-mcp-server /opt/ai-dev/app \
    && ln -s seed /opt/ai-dev/public-seed \
    && chmod 0755 ai-dev-mcp-server/bin/ai-dev.mjs \
    && ln -s /opt/ai-dev/ai-dev-mcp-server/bin/ai-dev.mjs /usr/local/bin/ai-dev

COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
COPY container/entrypoint.sh /usr/local/bin/ai-dev-entrypoint

# /models is where 2.x launchers mount the host's model (AI_DEV_MODEL_PATH);
# /workspace where they mount the projects. /data is the volume.
RUN chmod 0755 /usr/local/bin/ai-dev-entrypoint \
    && mkdir -p /data /models /workspace \
    && chown node:node /data /workspace

# The 2.x names, kept: a config or a volume of 2.x reads them. The model is found
# in /models when the host mounts it there, else in the volume, where
# `ai-dev model install` puts it.
ENV NODE_ENV=production \
    AI_DEV_RUNTIME=docker \
    AI_DEV_VAULT_ROOT=/data/ai-dev-system \
    AI_DEV_HOME=/data/runtime-home/.ai-dev \
    AI_DEV_STATE_ROOT=/data/runtime-home/.ai-dev/state \
    AI_DEV_SEARCH_INDEX_DIR=/data/runtime-home/.ai-dev/cache/search-index \
    AI_DEV_FRONTEND_QA_ARTIFACT_ROOT=/data/runtime-home/.ai-dev/artifacts/frontend-qa \
    HOME=/data/runtime-home \
    USERPROFILE=/data/runtime-home

# What a first start builds, built here: the seed in the vault, the skill
# registry, the quality report, the search index, the routing benchmark. Docker
# copies /data of the image into a new named volume, so the first session of a
# new volume starts with all of it; the build stops if any of it would be built
# again (scripts/docker-prepare-data.mjs). The container runs as `node` whatever
# started it, so the volume has one owner.
USER node
RUN mkdir -p "${AI_DEV_VAULT_ROOT}" "${AI_DEV_STATE_ROOT}" "${AI_DEV_SEARCH_INDEX_DIR}" "${AI_DEV_FRONTEND_QA_ARTIFACT_ROOT}" \
    && node /opt/ai-dev/ai-dev-mcp-server/scripts/docker-prepare-data.mjs

# Removed in 3.0 with the dense backend it installed, and declared until 4.0 so that a build passing
# it is told what replaced it rather than having it dropped without a word. Last in the
# stage, as every RUN after an ARG sees it: a build that passes it reruns only this.
ARG INSTALL_BGE_M3=0
RUN if [ "${INSTALL_BGE_M3}" = "1" ]; then \
      echo "INSTALL_BGE_M3=1 is no longer used: 3.0 removed the dense backend it installed, and the ONNX model needs nothing built into the image. Put the model in the data volume once: docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev model install — or mount a host folder that holds bge-m3-onnx/ at /models (bootstrap.sh --model-path)." >&2; \
    fi

VOLUME ["/data"]
WORKDIR /workspace
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-dev-entrypoint"]
CMD ["node", "/opt/ai-dev/app/src/server.mjs"]

# The browser variant: Chromium and its libraries for Frontend QA. pnpm is the
# version Frontend QA names in its packageManager, not one written here.
# Chromium is fetched in a stage of its own, so everything else can be built
# where its download host is closed.
FROM server-build AS browser-deps
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm_version="$(node -p "require('/opt/ai-dev/frontend-qa/package.json').packageManager.split('+')[0]")" \
    && case "${pnpm_version}" in pnpm@*) ;; *) echo "frontend-qa/package.json names no pnpm in packageManager: ${pnpm_version}" >&2; exit 1 ;; esac \
    && HOME=/tmp/build-home npm install --global --ignore-scripts --no-audit --no-fund "${pnpm_version}" \
    && cd /opt/ai-dev/frontend-qa \
    && HOME=/tmp/build-home pnpm install --frozen-lockfile --prod=false \
    && HOME=/tmp/build-home pnpm exec playwright install-deps chromium \
    && rm -rf /tmp/build-home /var/lib/apt/lists/*

FROM browser-deps AS browser
RUN cd /opt/ai-dev/frontend-qa \
    && HOME=/tmp/build-home pnpm exec playwright install chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /tmp/build-home
USER node

FROM server-build AS server

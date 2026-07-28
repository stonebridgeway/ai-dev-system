# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG INSTALL_BGE_M3=0
ARG VERSION=dev
ARG VCS_REF=unknown
ARG SOURCE_URL=""

LABEL org.opencontainers.image.title="AI Dev MCP System" \
      org.opencontainers.image.description="Local-first MCP engineering system for AI agents" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    AI_DEV_VAULT_ROOT=/data/ai-dev-system \
    AI_DEV_STATE_ROOT=/data/runtime-home/.codex/state/ai-dev-system \
    AI_DEV_SEARCH_INDEX_DIR=/data/runtime-home/.codex/cache/ai-dev-system/search-index \
    AI_DEV_FRONTEND_QA_ARTIFACT_ROOT=/data/runtime-home/.codex/artifacts/frontend-qa \
    AI_DEV_PYTHON=/usr/bin/python3 \
    BGE_M3_MODEL_DIR=/models/bge-m3 \
    HOME=/data/runtime-home \
    USERPROFILE=/data/runtime-home

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-freefont-ttf \
      fonts-ipafont-gothic \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-tlwg-loma-otf \
      fonts-unifont \
      fonts-wqy-zenhei \
      git \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libfontconfig1 \
      libfreetype6 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      python3 \
      python3-venv \
      tini \
      xfonts-scalable \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ai-dev/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY app/ ./

WORKDIR /opt/ai-dev/frontend-qa
COPY runtime/frontend-qa/package.json runtime/frontend-qa/pnpm-lock.yaml ./
RUN npm install --global pnpm@11.9.0 --ignore-scripts --no-audit --no-fund \
    && pnpm install --frozen-lockfile --prod=false \
    && pnpm exec playwright install chromium \
    && pnpm store prune \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY runtime/frontend-qa/frontend_qa_runner.mjs ./

COPY runtime/search-index/ /opt/ai-dev/search-index/
COPY runtime/search-eval/ /opt/ai-dev/search-eval/
COPY runtime/embeddings/ /opt/ai-dev/embeddings/
RUN if [ "${INSTALL_BGE_M3}" = "1" ]; then \
      python3 -m venv /opt/ai-dev/embeddings/.venv \
      && /opt/ai-dev/embeddings/.venv/bin/python -m pip install \
        --no-cache-dir \
        -r /opt/ai-dev/embeddings/requirements-bge-m3.txt; \
    fi

COPY public-seed/ /opt/ai-dev/public-seed/
COPY LICENSE THIRD_PARTY_NOTICES.md /opt/ai-dev/
COPY container/entrypoint.sh /usr/local/bin/ai-dev-entrypoint

RUN chmod 0755 /usr/local/bin/ai-dev-entrypoint \
    && mkdir -p /data /models /workspace \
    && chown -R node:node /data /models /workspace

VOLUME ["/data"]
WORKDIR /workspace
USER node
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ai-dev-entrypoint"]
CMD ["node", "/opt/ai-dev/app/src/server.mjs"]

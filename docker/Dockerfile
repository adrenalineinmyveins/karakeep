################# Monolith Builder ##############
FROM rust:1-bookworm AS monolith_builder

# Use USTC apt mirror for reliable downloads in China
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Use USTC cargo mirror for faster downloads in China
RUN mkdir -p /usr/local/cargo && \
    printf '[source.crates-io]\nreplace-with = "ustc"\n\n[source.ustc]\nregistry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"\n' > /usr/local/cargo/config.toml \
    && cargo install monolith --locked

################# Base Builder ##############
FROM node:24-slim AS base

WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Use npmmirror for faster downloads in China
RUN npm config set registry https://registry.npmmirror.com

# Keep Corepack current enough to verify modern pnpm release signatures.
RUN npm install -g corepack@latest && corepack enable pnpm

# Use USTC apt mirror for reliable downloads in China
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        make \
        g++ \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json ./apps/cli/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/web/package.json ./apps/web/
COPY apps/workers/package.json ./apps/workers/
COPY packages/api/package.json ./packages/api/
COPY packages/db/package.json ./packages/db/
COPY packages/open-api/package.json ./packages/open-api/
COPY packages/plugins/package.json ./packages/plugins/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/shared-react/package.json ./packages/shared-react/
COPY packages/shared-server/package.json ./packages/shared-server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/trpc/package.json ./packages/trpc/
COPY tooling/github/package.json ./tooling/github/
COPY tooling/oxlint/package.json ./tooling/oxlint/
COPY tooling/prettier/package.json ./tooling/prettier/
COPY tooling/tailwind/package.json ./tooling/tailwind/
COPY tooling/typescript/package.json ./tooling/typescript/
COPY ./patches ./patches

ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
# 容器内直连 github.com/nodejs.org 均不可达（被墙断连）：
# better-sqlite3 的 prebuild 下载失败后回退 node-gyp 源码编译，
# 用 npmmirror 的 node headers 镜像（.npmrc 的 disturl 未必传入子进程 env，此处 ENV 直设保底）
ENV npm_config_disturl=https://npmmirror.com/mirrors/node/
# disturl: node-gyp 编译原生模块（如 better-sqlite3 prebuild 下载失败回退源码编译时）
# 从 npmmirror 拉 node headers，不依赖 nodejs.org
RUN printf 'registry=https://registry.npmmirror.com\nfetch-retries=10\nfetch-timeout=300000\nfetch-retry-mintimeout=20000\nfetch-retry-maxtimeout=300000\nnetwork-concurrency=4\ndisturl=https://npmmirror.com/mirrors/node/\n' > /app/.npmrc \
    && pnpm install --frozen-lockfile --fetch-retries 10 --fetch-timeout 300000

COPY . .

# Build the db migration script
# (verify-deps-before-run=false：依赖刚装好，避免 pnpm 重新校验并触发多余的 install)
RUN cd packages/db && \
    pnpm --config.verify-deps-before-run=false exec ncc build migrate.ts -o /db_migrations && \
    cp -R drizzle /db_migrations


# Compile the web app
# 代理仅内联在本 RUN 内（宿主 Clash: host.docker.internal:7897），让 next build 拉 Google Fonts 走代理；
# 不能用 --build-arg 传代理——Docker 预定义代理 build-arg 无需 ARG 声明即注入所有 RUN，
# 会污染 pnpm install 层（better-sqlite3 prebuild/node-gyp 经代理下载会断连）。
# NODE_USE_ENV_PROXY=1: Node 24 的 fetch 需显式启用环境变量代理
RUN (cd apps/web && \
    HTTP_PROXY=http://host.docker.internal:7897 \
    HTTPS_PROXY=http://host.docker.internal:7897 \
    NO_PROXY=localhost,127.0.0.1 \
    NODE_USE_ENV_PROXY=1 \
    pnpm --config.verify-deps-before-run=false exec next build --experimental-build-mode compile)

# Build the worker code
RUN (cd apps/workers && pnpm --config.verify-deps-before-run=false build)
RUN CI=true pnpm deploy --node-linker=isolated --legacy --filter @saiye/workers --prod /prod/workers

# Build the cli
RUN (cd apps/cli && pnpm --config.verify-deps-before-run=false build)

# Build the mcp server
RUN (cd apps/mcp && pnpm --config.verify-deps-before-run=false build)

################# The All-in-one builder ##############

FROM node:24-slim AS aio_builder
LABEL org.opencontainers.image.source="https://github.com/adrenalineinmyveins/karakeep"
WORKDIR /app

ARG SERVER_VERSION=nightly
ENV SERVER_VERSION=${SERVER_VERSION}

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"
EXPOSE 3000

######################
# Prepare s6-overlay
######################
ARG S6_OVERLAY_VERSION=3.2.1.0
ARG TARGETARCH

# Install curl for reliable downloads with retries
# (USTC apt mirror for reliable downloads in China)
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        curl \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl --retry 10 --retry-delay 10 --retry-all-errors -fsSL \
        -o /tmp/s6-overlay-noarch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && case ${TARGETARCH} in \
            "amd64")  S6_ARCH=x86_64   ;; \
            "arm64")  S6_ARCH=aarch64  ;; \
        esac \
    && curl --retry 10 --retry-delay 10 --retry-all-errors -fsSL \
        -o /tmp/s6-overlay-${S6_ARCH}.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
    && tar -C / -Jxpf /tmp/s6-overlay-${S6_ARCH}.tar.xz \
    && rm -f /tmp/s6-overlay-noarch.tar.xz /tmp/s6-overlay-${S6_ARCH}.tar.xz

# Copy the s6-overlay config
COPY --chmod=755 ./docker/root/etc/s6-overlay /etc/s6-overlay

######################
# Install runtime deps
######################
# (USTC apt mirror + fetch retries: buildkit 并行构建时 Docker 内嵌 DNS 可能瞬时抖动)
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true \
    && echo 'Acquire::Retries "10";' > /etc/apt/apt.conf.d/80-retries
# 防 DNS 争抢：等待 base 阶段（pnpm install 等重网络任务）全部完成后才开始 apt。
# BuildKit 各 stage 默认并行执行，并行网络负载曾导致 Docker 内嵌 DNS 查询失败
# （Could not resolve 'mirrors.ustc.edu.cn'）。COPY --from 强制依赖 base 完整构建。
COPY --from=base /app/package.json /tmp/.base-done
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        curl \
        graphicsmagick \
        ghostscript \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case ${TARGETARCH} in \
        "amd64")  YTDLP_FILE=yt-dlp_linux ;; \
        "arm64")  YTDLP_FILE=yt-dlp_linux_aarch64 ;; \
        *) echo "Unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac \
    && curl --retry 10 --retry-delay 10 --retry-all-errors -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_FILE} -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# yt-dlp >=2025.x requires a JavaScript runtime to extract YouTube formats.
# Deno is yt-dlp's default but is not present in this image. Node is the
# base image and is fully supported by yt-dlp (min v20). Point yt-dlp at it
# via its system config file so every invocation picks it up without
# changes to the worker. Fixes adrenalineinmyveins/karakeep#2758.
RUN echo "--js-runtimes node" > /etc/yt-dlp.conf

# Copy monolith binary from builder
COPY --from=monolith_builder /usr/local/cargo/bin/monolith /usr/local/bin/monolith

######################
# Prepare the web app
######################

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXTAUTH_URL_INTERNAL=http://localhost:${PORT}

COPY --from=base --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=base /app/apps/web/public ./apps/web/public
COPY --from=base /db_migrations /db_migrations

# Turbopack standalone 对 serverExternalPackages 外部包的 tracing 有缺口：
# 只拷贝了 @plait-board/mermaid-to-drawnix 的 package.json（缺 dist/），
# 运行时动态 import 会报 ERR_MODULE_NOT_FOUND。
# 其余依赖（@plait/*、mermaid、slate、dompurify）tracing 均完整，无需补。
COPY --from=base --chown=node:node /app/packages/trpc/node_modules/@plait-board/mermaid-to-drawnix/dist /app/node_modules/@plait-board/mermaid-to-drawnix/dist

# Set the correct permission for prerender cache
RUN mkdir -p ./apps/web/.next && chown node:node ./apps/web/.next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=base --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

######################
# Prepare the workers app
######################
COPY --from=base /prod/workers /app/apps/workers

ENTRYPOINT ["/init"]

################# The AIO ##############

FROM aio_builder AS aio

# Windows 检出的 CRLF 行尾会让 s6-rc-compile 与 execline 脚本失效，统一转为 LF
RUN find /etc/s6-overlay -type f -exec sed -i 's/\r$//' {} + \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/init-db-migration \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-web \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-workers

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

################# The web container ##############

FROM aio_builder AS web

RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/init-db-migration \
    /etc/s6-overlay/s6-rc.d/user/contents.d/svc-web
ENV USING_LEGACY_SEPARATE_CONTAINERS=true

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

################# The workers container ##############

FROM aio_builder AS workers

# In the current implemtation, the workers assume the migration
# is done for them.
RUN rm /etc/s6-overlay/s6-rc.d/svc-workers/dependencies.d/init-db-migration \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/svc-workers
ENV USING_LEGACY_SEPARATE_CONTAINERS=true

################# The cli ##############

FROM node:24-slim AS cli
LABEL org.opencontainers.image.source="https://github.com/adrenalineinmyveins/karakeep"
WORKDIR /app

COPY --from=base /app/apps/cli/dist/index.mjs apps/cli/index.mjs

WORKDIR /app/apps/cli

ARG SERVER_VERSION=nightly
ENV SERVER_VERSION=${SERVER_VERSION}

ENTRYPOINT ["node", "index.mjs"]

################# MCP server ##############

FROM node:24-slim AS mcp
LABEL org.opencontainers.image.source="https://github.com/adrenalineinmyveins/karakeep"
WORKDIR /app

COPY --from=base /app/apps/mcp/dist/index.js apps/mcp/index.js

WORKDIR /app/apps/mcp

ENTRYPOINT ["node", "index.js"]

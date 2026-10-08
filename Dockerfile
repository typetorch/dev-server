# syntax=docker/dockerfile:1
#
# @typetorch/dev-server (remote-claude) as one container. Bun runs the dev-server, Node runs Claude Code, cloudflared
# opens the Quick Tunnel. The game repo is /work/game; the worktree Claude edits is /work/game-remote-claude, next to
# it, so /work is one volume. Claude's login and settings live in /home/dev/.claude.
#
#   docker build -t typetorch-dev-server .        (or: docker compose build)
#
# Not in the image: the TypeTorch CLI (deploy from the chat) and ffmpeg (optional image formats). See README "Docker".

FROM oven/bun:1-debian

ARG NODE_VERSION=22.22.0
ARG CLAUDE_CODE_VERSION=2.1.295
# Empty: the newest cloudflared from Cloudflare's apt repository. Set e.g. 2026.10.0 to pin it.
ARG CLOUDFLARED_VERSION=
# uid of the non-root container user. The base image may already use 1000; that user is replaced.
ARG DEV_UID=1000
ARG TARGETARCH

# Claude Code keeps its login (.credentials.json) and .claude.json in CLAUDE_CONFIG_DIR, so the named volume holds both.
ENV HOME=/home/dev \
    CLAUDE_CONFIG_DIR=/home/dev/.claude

# git, tini (PID 1: forwards signals, reaps children), xz for the Node tarball, and cloudflared from Cloudflare's apt
# repository (signed by the key fetched here).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git tini xz-utils; \
    install -d -m 0755 /usr/share/keyrings; \
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "cloudflared${CLOUDFLARED_VERSION:+=${CLOUDFLARED_VERSION}}"; \
    rm -rf /var/lib/apt/lists/*

# Node 22 for Claude Code (its npm package needs Node 22+; Debian's packaged Node is older). The official tarball,
# checked against nodejs.org's SHASUMS256.txt for this version.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    name="node-v${NODE_VERSION}-linux-${node_arch}"; \
    base="https://nodejs.org/dist/v${NODE_VERSION}"; \
    curl -fsSLO "${base}/${name}.tar.xz"; \
    curl -fsSL -o SHASUMS256.txt "${base}/SHASUMS256.txt"; \
    grep " ${name}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${name}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${name}.tar.xz" SHASUMS256.txt; \
    node --version; \
    npm --version

# Claude Code, from npm. Pinned: bump CLAUDE_CODE_VERSION to update.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# Commits made by remote-claude use this identity unless the game repo sets its own user.name / user.email. The game
# repo may be owned by another uid (a bind mount, or a clone made by someone else), so git must trust both repos.
RUN git config --system user.name "remote-claude" \
 && git config --system user.email "remote-claude@localhost" \
 && git config --system --add safe.directory /work/game \
 && git config --system --add safe.directory /work/game-remote-claude

# Non-root user `dev`. The worktree and the game clone live under /work; ~/.claude is created here so a new named
# volume starts with the right owner.
RUN set -eux; \
    old="$(getent passwd "${DEV_UID}" | cut -d: -f1 || true)"; \
    if [ -n "${old}" ]; then userdel -r "${old}" 2>/dev/null || userdel "${old}"; fi; \
    useradd --uid "${DEV_UID}" --create-home --home-dir /home/dev --shell /bin/bash dev; \
    install -d -o dev -g dev -m 0755 /work /home/dev/.claude

# The dev-server (Bun runs the TypeScript sources directly). Only jose is a runtime dependency.
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/tt-entrypoint
RUN chmod 0755 /usr/local/bin/tt-entrypoint

USER dev
WORKDIR /work

# tini runs the entrypoint; `remote-claude` (the default) starts the dev-server, anything else runs as given, so
# `docker compose run --rm dev-server claude auth login` logs in.
ENTRYPOINT ["tini", "--", "/usr/local/bin/tt-entrypoint"]
CMD ["remote-claude"]

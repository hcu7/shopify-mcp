# syntax=docker/dockerfile:1
# =============================================================================
# cob-shopify-mcp — Production Dockerfile
# Author: SV
# Build: multi-stage (builder → runtime) on node:22-alpine
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder
# Installs all dependencies, compiles TypeScript via tsup.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

# pnpm is the package manager; install via corepack (ships with Node 22)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy manifests first so dependency layers are cached independently of source
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDeps needed for tsup + tsc)
RUN pnpm install --frozen-lockfile

# Copy source tree and build scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY scripts ./scripts

# Compile
RUN pnpm build

# Create production node_modules using npm (resolves pnpm symlinks into real files)
RUN mkdir -p /prod && cp package.json /prod/package.json && cd /prod && npm install --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: runtime
# Minimal image containing only the compiled output and prod dependencies.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Security: run as a non-root user
RUN addgroup -S mcp && adduser -S -G mcp mcp

ENV NODE_ENV=production

WORKDIR /app

# Copy compiled output
COPY --from=builder /build/dist ./dist

# Copy production node_modules from pnpm deploy output
COPY --from=builder /prod/node_modules ./node_modules

# Copy package.json so Node can resolve the "type": "module" field
COPY --from=builder /build/package.json ./package.json

# Bundle custom YAML tools into the image so they are available on platforms
# (e.g. Coolify) that don't mount ./custom-tools as a volume.
COPY custom-tools ./custom-tools
ENV COB_SHOPIFY_CUSTOM_TOOLS=/app/custom-tools

# Data directory for JSON/SQLite storage AND the Shopify install-flow token
# (/app/data/installed-token.json). MUST be backed by a persistent volume in
# production — otherwise the merchant-granted token is lost on container
# rebuild and the app has to be re-installed in Shopify. In Coolify: add
# a persistent storage mount on "/app/data" in the application's Storage tab.
RUN mkdir -p /app/data && chown mcp:mcp /app/data
VOLUME ["/app/data"]

USER mcp

# HTTP transport listens on this port
EXPOSE 3000

# Default: start in HTTP mode so the container is reachable.
# Override with `docker run ... cob-shopify-mcp start --transport stdio`
# for stdio / Claude Desktop use-cases.
# Default: start in HTTP mode so the container is reachable.
# Override with --transport stdio for Claude Desktop use-cases.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start", "--transport", "http", "--host", "0.0.0.0", "--port", "3000"]

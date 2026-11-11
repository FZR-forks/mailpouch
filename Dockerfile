# MailPouch MCP server as a container: runs the shared HTTP daemon against a
# Proton Bridge reachable on the network (see compose.yaml and docs/docker.md).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:18052396bf1d0c6e0a8c58181b5c1457da19409efbd5032a3f4d86974e74d13c

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Toolchain only for native modules that ship no prebuilt binary for the target.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts skips the dev-only git hook installer and the implicit build;
# better-sqlite3 (full-text search) is the only native module to build.
RUN npm ci --ignore-scripts --no-audit --no-fund && npm rebuild better-sqlite3 --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOME=/data \
    MAILPOUCH_BRIDGE_HOST=protonmail-bridge \
    MAILPOUCH_PORT=8788
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/ ./docker/
RUN chmod 0755 docker/entrypoint.sh \
 && printf '#!/bin/sh\nexec node /app/dist/index.js "$@"\n' > /usr/local/bin/mailpouch \
 && chmod 0755 /usr/local/bin/mailpouch \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MAILPOUCH_PORT||8788)+'/.well-known/oauth-protected-resource').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["daemon"]

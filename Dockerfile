# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder

# npm ci checks the shrinkwrap integrity. A version on npm install -g is not a hash.
WORKDIR /opt/pnpm-cli
COPY docker/pnpm-cli/package.json docker/pnpm-cli/npm-shrinkwrap.json ./
RUN npm ci --ignore-scripts \
 && ln -s /opt/pnpm-cli/node_modules/.bin/pnpm /usr/local/bin/pnpm

WORKDIR /app

# Install dependencies (layer cached unless lock changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN pnpm build

# Remove dev dependencies
RUN pnpm prune --prod

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS production

LABEL org.opencontainers.image.title="Mailoo" \
      org.opencontainers.image.description="Mailoo — IMAP/SMTP MCP server. Multi-account, per-folder profiles." \
      org.opencontainers.image.url="https://github.com/bitfloo/mailoo" \
      org.opencontainers.image.source="https://github.com/bitfloo/mailoo" \
      org.opencontainers.image.licenses="LGPL-3.0-or-later" \
      org.opencontainers.image.vendor="Bitfloo"

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY LICENSE COPYING NOTICE ./

# Create config directory for volume mount
RUN mkdir -p /home/node/.config/mailoo && chown -R node:node /home/node/.config

ENV NODE_ENV=production

# No HEALTHCHECK: the default command is stdio and does not listen on a port.
USER node

ENTRYPOINT ["node", "dist/main.js"]
CMD ["stdio"]

# =========================
# Stage 1: Builder
# =========================
FROM node:22-alpine AS builder

WORKDIR /app

# Build Toolchain für native Module
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    make \
    g++ \
    linux-headers

# Package Files zuerst (Caching!)
COPY package.json package-lock.json ./

# Production Install + native rebuild
RUN npm ci --omit=dev \
    && npm rebuild --build-from-source

# App Code kopieren
COPY warema-bridge/srv ./srv


# =========================
# Stage 2: Node Runtime Layer
# =========================
# Wir extrahieren nur Node aus node:22-alpine
FROM node:22-alpine AS node_runtime


# =========================
# Stage 3: Final HA Runtime
# =========================
FROM ghcr.io/hassio-addons/base:18.2.1

WORKDIR /app

# Node Binary + npm aus offiziellem Node Image übernehmen
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node_runtime /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node_runtime /usr/local/bin/npx /usr/local/bin/npx

# Symlink für npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

# App + Modules kopieren
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/srv ./srv

# s6 Service Scripts bleiben erhalten
COPY warema-bridge/etc/services.d/warema-bridge /etc/services.d/warema-bridge

RUN chmod +x /etc/services.d/warema-bridge/run \
    && chmod +x /etc/services.d/warema-bridge/finish

ENV NODE_ENV=production
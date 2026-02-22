# =========================
# Stage 1: Builder
# =========================
FROM ghcr.io/hassio-addons/base-nodejs:18.2.1 AS builder

WORKDIR /app

# Nur Build-Dependencies (werden nicht ins finale Image übernommen)
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    make \
    g++ \
    linux-headers

# Nur Package-Files zuerst (besseres Layer-Caching)
COPY package.json package-lock.json ./

# Saubere Installation (production only)
RUN npm ci --omit=dev \
    && npm rebuild --build-from-source

# App-Code kopieren
COPY warema-bridge/srv ./srv

# =========================
# Stage 2: Runtime
# =========================
FROM ghcr.io/hassio-addons/base-nodejs:18.2.1

WORKDIR /app

# Nur das Nötigste kopieren
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/srv ./srv

# s6 Service
COPY warema-bridge/etc/services.d/warema-bridge /etc/services.d/warema-bridge

RUN chmod +x /etc/services.d/warema-bridge/run \
    && chmod +x /etc/services.d/warema-bridge/finish

ENV NODE_ENV=production
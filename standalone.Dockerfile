# =========================
# Stage 1: Builder
# =========================
FROM node:22-alpine as builder

WORKDIR /app

## Install build toolchain, install node deps and compile native add-ons
RUN apk add --no-cache python3 make g++ linux-headers

COPY package-lock.json ./
COPY package.json ./

# rebuild from sources to avoid issues with prebuilt binaries (https://github.com/serialport/node-serialport/issues/2438
RUN npm ci --omit=dev && npm rebuild --build-from-source

# Copy root filesystem
COPY warema-bridge/srv ./srv

# =========================
# Stage 2: Runtime (HA Base Image)
# =========================
FROM ghcr.io/hassio-addons/base:18.2.1

RUN apk add --no-cache nodejs npm

WORKDIR /app

## Copy built node modules and binaries without including the toolchain
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/srv ./srv

COPY warema-bridge/etc/services.d/warema-bridge /etc/services.d/warema-bridge
RUN chmod +x /etc/services.d/warema-bridge/run \
    && chmod +x /etc/services.d/warema-bridge/finish

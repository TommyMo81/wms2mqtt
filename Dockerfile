ARG BUILD_FROM=hassioaddons/base:edge
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Setup base
# hadolint ignore=DL3003
RUN \
    apk add --no-cache --virtual .build-deps python3 make g++ linux-headers
RUN \
    apk add --no-cache npm

# Copy root filesystem
# COPY rootfs/srv/package-lock.json /srv
COPY warema-bridge/package.json /srv

WORKDIR /srv

# RUN npm ci
RUN npm install

RUN apk del --no-cache --purge .build-deps && rm -rf /root/.npm /root/.cache

COPY warema-bridge/ /

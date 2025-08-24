FROM node:22-alpine as builder

## Install build toolchain, install node deps and compile native add-ons
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR app

COPY package-lock.json .
COPY package.json .

# rebuild from sources to avoid issues with prebuilt binaries (https://github.com/serialport/node-serialport/issues/2438
RUN npm ci --omit=dev && npm rebuild --build-from-source

ARG BUILD_FROM=hassioaddons/base:edge
# hadolint ignore=DL3006
FROM ${BUILD_FROM} as app

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /srv

## Copy built node modules and binaries without including the toolchain
COPY --from=builder app/node_modules ./srv/node_modules

COPY warema-bridge/ /

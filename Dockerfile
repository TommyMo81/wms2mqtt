ARG BUILD_FROM=alpine:3.21.2
FROM ${BUILD_FROM}

# Setup base
RUN apk add --no-cache npm

# Copy root filesystem
COPY warema-bridge/srv /srv

WORKDIR /srv

RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers \
    && npm ci --omit=dev && npm rebuild --build-from-source\
    && apk del --no-cache --purge .build-deps \
    && rm -rf /root/.npm /root/.cache

ENTRYPOINT ["node", "/srv/index.js"]

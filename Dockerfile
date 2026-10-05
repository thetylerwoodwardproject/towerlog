# Towerlog container image. Multicast (RTP, Livewire) needs host networking:
#   docker compose up -d        (see docker-compose.yml)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production \
    TOWERLOG_CONFIG=/config/config.json \
    TOWERLOG_DATA=/data \
    TOWERLOG_LOG_DIR=/logs \
    HOST=0.0.0.0
VOLUME ["/config", "/data", "/logs"]
EXPOSE 8090 8000
USER node
CMD ["node", "dist/towerlog.mjs"]

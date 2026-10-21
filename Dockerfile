FROM oven/bun:1.3-alpine

# Build context is the monorepo root so the local @mupt-ai/dari-router
# dependency is available at install time.
WORKDIR /app

COPY dari-router ./dari-router
RUN cd dari-router && bun install --frozen-lockfile && bun run build && rm -rf node_modules

WORKDIR /app/dari-gateway
ENV NODE_ENV=production

COPY dari-gateway/package.json dari-gateway/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY dari-gateway/src ./src

# Mount a config file and a volume for the database, e.g.
#   docker run -v ./dari-gateway.yaml:/config/dari-gateway.yaml -v gateway-data:/data ...
ENV DARI_GATEWAY_CONFIG=/config/dari-gateway.yaml \
    DARI_GATEWAY_DB=/data/dari-gateway.db \
    PORT=8080
VOLUME /data
EXPOSE 8080

CMD ["bun", "run", "start"]

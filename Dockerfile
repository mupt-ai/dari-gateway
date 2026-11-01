FROM oven/bun:1.3-alpine

# Build from this directory: `docker build -t dari-gateway dari-gateway` from the
# monorepo root, or `docker build -t dari-gateway .` from a clone of the public
# repository. The router is the published @mupt-ai/dari-router release.
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --omit dev

COPY src ./src

# Mount a config file and a volume for the database, e.g.
#   docker run -v ./dari-gateway.yaml:/config/dari-gateway.yaml -v gateway-data:/data ...
# DARI_GATEWAY_HOST=0.0.0.0 lets published ports reach the server; outside the container it defaults to loopback.
ENV DARI_GATEWAY_CONFIG=/config/dari-gateway.yaml \
    DARI_GATEWAY_DB=/data/dari-gateway.db \
    DARI_GATEWAY_HOST=0.0.0.0 \
    PORT=8080
VOLUME /data
EXPOSE 8080

CMD ["bun", "run", "start"]

# atmo, built, served by wrangler's local runtime: D1, KV and R2 live in SQLite under
# /data. For an atmo pointed at a private atproto network (a snowglobe globe). Nothing
# in the image deploys anywhere, and nothing is fetched at start.
#
#   docker build -f deploy/snowglobe/Dockerfile .
#
# Settings come from env files at run time (see run.sh); none are built in.

FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
# node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
WORKDIR /app/apps/web
# vite build regenerates _worker.js; append-scheduled adds the cron handler to it. Both, or
# the feed timer throws on every tick.
RUN npx vite build && npx contrail append-scheduled \
 && test "$(grep -c '// contrail: scheduled handler' .svelte-kit/cloudflare/_worker.js)" = 1

FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node deploy/snowglobe/wrangler.jsonc /app/apps/web/wrangler.snowglobe.jsonc
COPY --chown=node:node deploy/snowglobe/run.sh deploy/snowglobe/cron.mjs /app/deploy/snowglobe/
USER node
WORKDIR /app/apps/web
# No metrics, and no fetch of the request-metadata file from workers.cloudflare.com at start.
ENV WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
EXPOSE 8787
ENTRYPOINT ["/app/deploy/snowglobe/run.sh"]

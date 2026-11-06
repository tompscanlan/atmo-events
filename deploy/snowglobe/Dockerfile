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
# The app's own build: vite build, then scripts/build-worker.mjs wraps the Worker so its
# scheduled() posts to /api/cron with CRON_SECRET. Without the wrapper the timer does nothing.
RUN pnpm build \
 && head -1 .svelte-kit/worker.js | grep -qx '// atmo: SvelteKit Worker with scheduled cron forwarding'

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

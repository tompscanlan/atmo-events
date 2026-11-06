#!/bin/sh
set -eu

# Serve the built atmo on 0.0.0.0:8787.
#
#   ATMO_PUBLIC_HOST  the name browsers use (atmo.<globe>.snowglobe.at). wrangler treats it
#                     as the origin over https, or SvelteKit's origin check refuses every
#                     form post behind the Gateway.
#   ATMO_ENV_FILES    space-separated env files holding the vars and secrets
#                     (default /config/vars.env /secrets/secrets.env; later files win).
#   ATMO_DATA         where D1, KV and R2 persist (default /data).

: "${ATMO_PUBLIC_HOST:?ATMO_PUBLIC_HOST is not set}"
set --
for f in ${ATMO_ENV_FILES:-/config/vars.env /secrets/secrets.env}; do
  [ -f "$f" ] || { echo "run.sh: env file $f is missing" >&2; exit 1; }
  set -- "$@" --env-file "$f"
done

WRANGLER=/app/apps/web/node_modules/.bin/wrangler
CONFIG=/app/apps/web/wrangler.snowglobe.jsonc

# The og image's tables are applied by hand on Cloudflare (scripts/og-cache-schema.sql: "apply
# once before deploying"); here each boot applies them. The file only creates what is missing,
# so a second run changes nothing.
"$WRANGLER" d1 execute atmo --local --config "$CONFIG" --persist-to "${ATMO_DATA:-/data}" \
  --file /app/apps/web/scripts/og-cache-schema.sql >/dev/null

exec "$WRANGLER" dev \
  --config "$CONFIG" \
  --ip 0.0.0.0 --port 8787 \
  --persist-to "${ATMO_DATA:-/data}" \
  --test-scheduled \
  --local-upstream "${ATMO_PUBLIC_HOST}" --upstream-protocol https \
  --show-interactive-dev-session=false \
  "$@"

#!/usr/bin/env bash
# Parity assertions: each rsvp.atmo.* endpoint served by HappyView returns the
# envelope atmo's @atcute client + flattenEventRecord/buildAttendee consume.
#
# NOTE: XRPC endpoints require client identification via the `X-Client-Key`
# header (NOT Authorization: Bearer — that yields 401). See NOTES.md.
set -euo pipefail
HV="${HAPPYVIEW_URL:-http://127.0.0.1:3100}"
KEY="${HAPPYVIEW_API_KEY:?set HAPPYVIEW_API_KEY}"
g() { curl -fsS "$HV/xrpc/$1" -H "X-Client-Key: $KEY"; }
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

echo "== event.listRecords =="
g "rsvp.atmo.event.listRecords?limit=3&sort=startsAt&order=desc" | jq -e '
  (.records | type == "array") and (.records | length > 0)
  and (.records[0] | has("uri") and has("did") and has("rkey") and has("value")
       and has("rsvpsGoingCount") and has("rsvpsCount")
       and (.value | has("$type")))' >/dev/null \
  && echo "  shape OK" || { echo "  FAIL"; exit 1; }

echo "== event.listDiscoverable =="
g "rsvp.atmo.event.listDiscoverable?startsAtMin=2020-01-01T00:00:00Z&rsvpsCountMin=2&hydrateRsvps=5&limit=5" | jq -e '
  (.records | type == "array") and (.records | length > 0)
  and (all(.records[]; .rsvpsCount >= 2))
  and (.records[0] | has("uri") and has("did") and has("value") and has("cid")
       and ((.rsvps // []) | type == "array"))' >/dev/null \
  && echo "  shape+filter OK" || { echo "  FAIL"; exit 1; }

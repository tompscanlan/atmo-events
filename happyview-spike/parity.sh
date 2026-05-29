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
       and (.rsvps | has("going") and (.going | type == "array")))' >/dev/null \
  && echo "  shape+filter OK" || { echo "  FAIL"; exit 1; }

echo "== event.getRecord =="
# pick a real event uri that has rsvps, then fetch it singularly
URI=$(g "rsvp.atmo.event.listDiscoverable?startsAtMin=2020-01-01T00:00:00Z&rsvpsCountMin=2&limit=1" | jq -r '.records[0].uri')
g "rsvp.atmo.event.getRecord?uri=$(enc "$URI")&hydrateRsvps=10" | jq -e '
  (.uri | type == "string") and (.did | type == "string") and (.rkey | type == "string")
  and (.value | has("$type")) and (.value.startsAt != null)
  and (.rsvpsCount >= 2) and (.rsvpsGoingCount + .rsvpsInterestedCount + .rsvpsNotgoingCount == .rsvpsCount)
  and (.rsvps | has("going") and has("interested"))
  and ((.rsvps.going | length) == .rsvpsGoingCount)' >/dev/null \
  && echo "  shape+counts OK" || { echo "  FAIL"; exit 1; }

echo "== rsvp.listRecords =="
# attendees: subjectUri + qualified status -> records[].did, value.status normalizes
g "rsvp.atmo.rsvp.listRecords?subjectUri=$(enc "$URI")&status=community.lexicon.calendar.rsvp%23going&limit=200" | jq -e '
  (.records | type == "array") and (.records | length > 0)
  and (all(.records[]; (.did | type == "string") and (.value.status | test("going$"))))
  and (.records[0] | has("uri") and has("rkey") and has("value"))' >/dev/null \
  && echo "  attendees OK" || { echo "  FAIL attendees"; exit 1; }
# attending: actor + hydrateEvent -> records[].event has a flattenable body
RSVPER=$(g "rsvp.atmo.rsvp.listRecords?subjectUri=$(enc "$URI")&limit=1" | jq -r '.records[0].did')
g "rsvp.atmo.rsvp.listRecords?actor=$RSVPER&hydrateEvent=true&limit=5" | jq -e '
  (.records | type == "array") and (.records | length > 0)
  and (.records[0].value.status | type == "string")
  and (.records[0].event | has("uri") and (.record.startsAt != null))' >/dev/null \
  && echo "  attending+hydrateEvent OK" || { echo "  FAIL attending"; exit 1; }
# profiles=true -> top-level profiles[] of rsvp authors, each with a blob avatar/name
g "rsvp.atmo.rsvp.listRecords?subjectUri=$(enc "$URI")&status=community.lexicon.calendar.rsvp%23going&profiles=true&limit=200" | jq -e '
  (.profiles | type == "array") and (.profiles | length > 0)
  and (.profiles[0] | has("did") and (.value | has("displayName") or has("avatar")))' >/dev/null \
  && echo "  profiles OK" || { echo "  FAIL profiles"; exit 1; }

echo "== getProfile =="
HOSTDID=$(echo "$URI" | sed -E 's#at://([^/]+)/.*#\1#')
g "rsvp.atmo.getProfile?actor=$HOSTDID" | jq -e '
  (.profiles | type == "array") and (.profiles | length == 1)
  and (.profiles[0] | (.did == "'"$HOSTDID"'") and (.rkey == "self")
       and (.value | has("displayName") or has("avatar")))' >/dev/null \
  && echo "  shape OK" || { echo "  FAIL"; exit 1; }
# avatar (when present) is a raw blob object getProfileBlobUrl can resolve (ref.$link or cid)
g "rsvp.atmo.getProfile?actor=$HOSTDID" | jq -e '
  (.profiles[0].value.avatar == null)
  or (.profiles[0].value.avatar | (.ref."$link" != null) or (.cid != null))' >/dev/null \
  && echo "  avatar-blob OK" || { echo "  FAIL avatar-blob"; exit 1; }

#!/usr/bin/env bash
# Idempotent upload of rsvp.atmo.* spike lexicons + Lua scripts to local HappyView.
#
# CORRECTIONS vs the original plan (discovered in Task 0, see NOTES.md):
#  - /admin/lexicons expects a FULL lexicon document under `lexicon_json`
#    (a real {lexicon:1, id, defs:{main:{type:"query",...}}} doc), NOT the
#    plan's bare {id, lexicon_type, script_type, source}. So lexicons/*.json
#    here are real lexicon docs (mostly copied from apps/web/lexicons/generated)
#    and we wrap them as {"lexicon_json": <doc>} at POST time.
#  - A query NSID dispatches to a Lua script bound at trigger `xrpc.query:<nsid>`.
#  - Each Lua script runs in a FRESH sandbox (no shared globals), so helpers are
#    inlined per-script; there is no _helpers library file.
#  - Admin endpoints (/admin/*) authenticate with `Authorization: Bearer <key>`.
#    XRPC endpoints (/xrpc/*) instead require client identification via the
#    `X-Client-Key` header (see parity.sh) — NOT a Bearer token.
set -euo pipefail
HV="${HAPPYVIEW_URL:-http://127.0.0.1:3100}"
KEY="${HAPPYVIEW_API_KEY:?set HAPPYVIEW_API_KEY}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Register a lexicon: file is a raw lexicon document; wrap as {lexicon_json: doc}.
post_lexicon() {
  local f="$1"
  python3 -c "import json,sys; print(json.dumps({'lexicon_json': json.load(open(sys.argv[1]))}))" "$f" \
    | curl -fsS -X POST "$HV/admin/lexicons" \
        -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
        --data-binary @- >/dev/null
  echo "lexicon: $(basename "$f")"
}

# Register a Lua script bound to its NSID. Filename `<rest>.lua` -> nsid
# `rsvp.atmo.<rest>`, trigger `xrpc.query:rsvp.atmo.<rest>`.
post_script() {
  local f="$1"
  local base nsid
  base="$(basename "$f" .lua)"
  nsid="rsvp.atmo.${base}"
  python3 -c "import json,sys; print(json.dumps({'id':'xrpc.query:'+sys.argv[1],'script_type':'lua','body':open(sys.argv[2]).read()}))" "$nsid" "$f" \
    | curl -fsS -X POST "$HV/admin/scripts" \
        -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
        --data-binary @- >/dev/null
  echo "script:  ${nsid}"
}

for f in "$DIR"/lexicons/*.json; do [ -e "$f" ] && post_lexicon "$f"; done
for f in "$DIR"/scripts/*.lua;   do [ -e "$f" ] && post_script  "$f"; done
echo "deploy complete"

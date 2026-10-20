#!/usr/bin/env bash
# om-3r2nx.23.4 gate. Run from the repo root.
set -u; FAILED=0; ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
BASE=c081f5b; . "$ROOT/verify-common.sh"
cd "$ROOT/apps/web"
for f in src/lib/groups/server/__fixtures__/stub-pds.ts src/lib/groups/server/__fixtures__/provisioned-spaces.ts; do [ ! -e "$f" ] && pass "$f deleted" || fail "$f still exists"; done
H=$(git grep -n -i -E 'stand-?in|STAND_IN|pdsProvisioner|pdsSpaceUpdater|setAboutSpaceReadPolicy|stub-pds|provisioned-spaces|the mint\b' -- src scripts || true)
[ -z "$H" ] && pass "no stand-in name in src or scripts" || { fail "stand-in names remain ($(echo "$H" | wc -l) lines):"; echo "$H" | head -40; }
H=$(git grep -n -E 'list mirrors' -- src || true)
[ -z "$H" ] && pass "members-writer no longer claims a mirrored list" || { fail "stale mirror comment:"; echo "$H"; }
git grep -q -E 'SpaceAccessDenied' -- src/lib/groups/server/refresh.test.ts && pass "refresh test covers the caller's own access refused" || fail "refresh test lacks the SpaceAccessDenied case"
B=$(git show $BASE:apps/web/scripts/groups-e2e.mjs | command grep -c -E '\brecord\(' ); Hn=$(command grep -c -E '\brecord\(' scripts/groups-e2e.mjs)
[ "$B" = "$Hn" ] && pass "groups-e2e keeps its $Hn record() checks" || fail "groups-e2e record() count $B -> $Hn"
exit $FAILED

#!/usr/bin/env bash
# om-3r2nx.23.1 gate. Run from the repo root.
set -u; FAILED=0; ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
. "$ROOT/verify-common.sh"
cd "$ROOT/apps/web"
for f in src/lib/groups/create-group.ts src/lib/groups/server/mint.ts; do [ ! -e "$f" ] && pass "$f deleted" || fail "$f still exists"; done
H=$(git grep -n -E "create-group'|server/mint'|/mint'|runCreateGroup|mintConfig|creationConfig" -- src scripts | grep -v '__fixtures__' || true)
[ -z "$H" ] && pass "no reference to the old create path in src or scripts" || { fail "old create path still referenced:"; echo "$H"; }
H=$(git grep -n -E 'GROUP_PDS_SERVICE|GROUP_PDS_INVITE_CODE|GROUP_HANDLE_DOMAIN' -- src scripts .env.example ':!src/lib/groups/server/__fixtures__' ':!*.test.ts' || true)
[ -z "$H" ] && pass "no app or script reads the old create settings" || { fail "old create settings still read:"; echo "$H"; }
H=$(git grep -n -E '\bAT_HOST\b|standInLogin|setStandInLogin' -- scripts || true)
[ -z "$H" ] && pass "groups e2e has no stand-in mode switch" || { fail "e2e stand-in mode remains:"; echo "$H"; }
grep -q -E "E2E_GROUP_HOST.*required|required\('E2E_GROUP_HOST'\)" scripts/groups-e2e.mjs && pass "e2e requires E2E_GROUP_HOST" || fail "e2e does not require E2E_GROUP_HOST"
[ -e "src/routes/(app)/layout.server.test.ts" ] && grep -q GROUP_HOST_URL "src/routes/(app)/layout.server.test.ts" && pass "layout gate test kept" || fail "layout gate test changed"
exit $FAILED

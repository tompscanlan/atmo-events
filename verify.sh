#!/usr/bin/env bash
# om-3r2nx.23.2 gate. Run from the repo root.
set -u; FAILED=0; ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
. "$ROOT/verify-common.sh"
cd "$ROOT/apps/web"
grep -q 'Refresh from the group host' src/lib/groups/components/GroupSettings.svelte && pass "settings shows 'Refresh from the group host'" || fail "button not renamed"
H=$(git grep -n -i 'repair' -- src/lib/groups/components src/lib/groups/group.remote.ts 'src/routes' ':!*.test.ts' || true)
[ -z "$H" ] && pass "no 'repair' in settings UI, group.remote.ts or routes" || { fail "repair still named:"; echo "$H"; }
H=$(git grep -n 'Repair this group' -- src ':!*.test.ts' | grep -v -E '^src/lib/groups/(form-error|create-group)\.ts:' || true)
[ -z "$H" ] && pass "'Repair this group' only in files units 1 and 3 own" || { fail "'Repair this group' elsewhere:"; echo "$H"; }
H=$(git grep -n -E 'alignToAccess|unrecordedMembers|authzHeldBack' -- src ':!*.test.ts' || true)
[ -z "$H" ] && pass "repair's record-writing steps are gone" || { fail "record-writing repair remains:"; echo "$H"; }
F=$(git ls-files 'src/lib/groups/server/refresh*.test.ts' | head -1)
[ -n "$F" ] && grep -q -i -E 'writes nothing|no write|never writes' "$F" && pass "refresh test asserts it writes nothing ($F)" || fail "no refresh test asserting no writes"
exit $FAILED

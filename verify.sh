#!/usr/bin/env bash
# om-3r2nx.23.7 gate. Run from the repo root.
set -u; FAILED=0; ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
BASE=2160738; . "$ROOT/verify-common.sh"
cd "$ROOT/apps/web"
G='src/lib/groups src/routes/(app)/groups src/routes/(oauth) scripts'
# AC1: no owner role in app code (tests and fixtures may name it only to test the upgrade)
H=$(git grep -n -E "'owner'|is_owner|isOwner|owner-protected|refuseOwner|roles_one_owner" -- $G ':!*.test.ts' ':!**/__fixtures__/**' || true)
[ -z "$H" ] && pass "no owner role in groups app code" || { fail "owner role remains ($(echo "$H" | wc -l) lines):"; echo "$H" | head -30; }
# AC2 (amended 2026-10-20, TS: no real users, no migration): 0001 itself has no owner rule; no 0002
N=$(command grep -c -E 'CREATE TRIGGER IF NOT EXISTS (groups_seed_owner_role|roles_owner_|memberships_owner_)' migrations/0001_groups.sql)
[ "$N" = 0 ] && pass "0001 creates no owner trigger" || fail "0001 still creates $N owner triggers"
N=$(command grep -c -i -E "is_owner|'owner'|roles_one_owner" migrations/0001_groups.sql)
[ "$N" = 0 ] && pass "0001 names no owner role" || fail "0001 still names the owner role ($N lines)"
ls migrations/0002_*.sql >/dev/null 2>&1 && fail "a 0002 migration exists; TS ruled none" || pass "no 0002 migration"
# AC5: restore keys off admins
git grep -q -E "no-owner-record" -- src && fail "rebuild still refuses with no-owner-record" || pass "no-owner-record refusal gone"
# AC6: unused writers gone
H=$(git grep -n -w -E 'writeGroupAccess|writeGroupSpaceIndex|readGroupSpaceIndex|writeGroupAuthz|allowsMembershipWrite|rolesTouched|groupDeclared' -- src scripts || true)
[ -z "$H" ] && pass "unused writers deleted" || { fail "unused names remain ($(echo "$H" | wc -l) lines):"; echo "$H" | head -20; }
git grep -q -w POLICY_MEMBER_LIST -- src/lib/groups/server/event-writer.ts && fail "checkCalendarSpace still accepts memberListPolicy" || pass "checkCalendarSpace no longer accepts memberListPolicy"
# AC7: the e2e keeps its checks
B=$(git show $BASE:apps/web/scripts/groups-e2e.mjs | command grep -c -E '\brecord\(' ); Hn=$(command grep -c -E '\brecord\(' scripts/groups-e2e.mjs)
[ "$B" = "$Hn" ] && pass "groups-e2e keeps its $Hn record() checks" || fail "groups-e2e record() count $B -> $Hn"
git diff --quiet $BASE -- src/lib/groups/server/real-host.test.ts || echo "NOTE: real-host.test.ts changed (expected only for the owner rule; list each change in FIRED-RESULT)"
exit $FAILED

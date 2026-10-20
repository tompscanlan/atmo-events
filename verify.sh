#!/usr/bin/env bash
# om-3r2nx.23.3 gate. Run from the repo root.
set -u; FAILED=0; ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
BASE=85d86f9 . "$ROOT/verify-common.sh"
cd "$ROOT/apps/web"
[ ! -e src/lib/groups/server/member-list.ts ] && [ ! -e src/lib/groups/server/member-list.test.ts ] && pass "member-list.ts and its test deleted" || fail "member-list.ts or its test remains"
H=$(git grep -n 'Repair this group' -- src scripts || true)
[ -z "$H" ] && pass "no 'Repair this group' anywhere in src or scripts" || { fail "'Repair this group' remains:"; echo "$H"; }
H=$(git grep -n -E "member-list'|standInHost\b" -- src scripts || true)
[ -z "$H" ] && pass "no stand-in host adapter or member-list import" || { fail "stand-in host or member-list remains:"; echo "$H"; }
H=$(git grep -n -w -E 'joinGroup|admitFromRequest|admitMember|withdrawJoinRequest|rejectJoinRequest|promoteMember' -- src || true)
[ -z "$H" ] && pass "the stand-in roster acts are gone from src" || { fail "stand-in roster acts remain:"; echo "$H"; }
git grep -q -E 'class GroupNotAtHostError' -- src && pass "GroupNotAtHostError defined" || fail "GroupNotAtHostError not defined"
T=$(git grep -l GroupNotAtHostError -- 'src/**/*.test.ts' | head -1)
[ -n "$T" ] && pass "a test exercises GroupNotAtHostError ($T)" || fail "no test exercises GroupNotAtHostError"
exit $FAILED

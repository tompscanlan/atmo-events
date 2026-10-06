#!/usr/bin/env bash
# verify.sh for the group calendar space, phase 1: the type constant, a third provisioned space, and
# that space's access record and index entry (spec 002 T201, T202, T219). Frozen at fire.
# Run from anywhere; it cds into the worktree. Every check prints a positive artifact line and the
# last line is the tally. The e2e runs against the local atproto-devnet only (SKIP_E2E=1 skips it,
# and then the run cannot pass).
set -uo pipefail
WT=/workspaces/scratch/wt-atmo-events-mrimm1
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=0e1e475
TYPE=net.openmeet.space.calendar
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree"; exit 2; }

# 0. Built on the contract's base.
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# 1. The type is one constant, CALENDAR_SPACE_TYPE in types.ts (TS named it 2026-10-05; the old
#    name EVENTS_SPACE_TYPE must not appear), and its string appears nowhere else in
#    app source (tests and the e2e script may name it).
def=$(git grep -nE "^export const CALENDAR_SPACE_TYPE = '$TYPE';" -- $LIB/types.ts | wc -l)
lit=$(git grep -nF "'$TYPE'" -- src ':!**/*.test.ts' | wc -l)
old=$(git grep -n 'EVENTS_SPACE_TYPE' -- src scripts | wc -l)
[ "$def" -eq 1 ] && [ "$lit" -eq 1 ] && [ "$old" -eq 0 ] && ok "1 CALENDAR_SPACE_TYPE = '$TYPE' defined once in types.ts; the literal appears 1x in src; the old name EVENTS_SPACE_TYPE 0x" \
  || { no "1 definition in types.ts: $def, literal in src: $lit, old name EVENTS_SPACE_TYPE: $old (want 1, 1, 0)"; git grep -nF "'$TYPE'" -- src ':!**/*.test.ts'; }

# 2. No new record collection: the groups lib still defines 12 *_COLLECTION constants, and a group
#    event is still community.lexicon.calendar.event.
nc=$(git grep -c "_COLLECTION = '" -- $LIB ':!**/*.test.ts' | awk -F: '{s+=$2} END {print s+0}')
ev=$(git grep -cF "export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';" -- $LIB/server/event-writer.ts | awk -F: '{print $2+0}')
[ "$nc" -eq 12 ] && [ "$ev" -eq 1 ] && ok "2 12 collection constants (baseline 12); GROUP_EVENT_COLLECTION unchanged" \
  || no "2 $nc collection constants (baseline 12); GROUP_EVENT_COLLECTION line found $ev"

# 3. No D1 change: recordGroupSpaces and the schema are untouched, because the calendar space URI is
#    computed from the DID (FR-101a).
dl=$(git diff $BASE -- $LIB/server/repo.ts | wc -l)
mig=$(git diff --name-only $BASE -- 'migrations' '**/*.sql' | wc -l)
[ "$dl" -eq 0 ] && [ "$mig" -eq 0 ] && ok "3 repo.ts diff vs $BASE: 0 lines; migrations/sql changed: 0" \
  || no "3 repo.ts diff $dl lines, migration/sql files changed $mig (want 0 and 0)"

# 4. The plausible bug, pinned: the calendar space is provisioned with the member-list read policy and
#    never with aboutSpaceReadPolicy. Assert on the source of provisionGroupSpaces.
body=$(awk '/^export async function provisionGroupSpaces/,/^}/' $LIB/server/spaces.ts)
ne=$(printf '%s\n' "$body" | grep -c 'CALENDAR_SPACE_TYPE')
na=$(printf '%s\n' "$body" | grep -c 'aboutSpaceReadPolicy(')
[ "$ne" -ge 1 ] && [ "$na" -eq 1 ] && ok "4 provisionGroupSpaces names CALENDAR_SPACE_TYPE ${ne}x; aboutSpaceReadPolicy still called once (the about space only)" \
  || no "4 provisionGroupSpaces: CALENDAR_SPACE_TYPE ${ne}x, aboutSpaceReadPolicy( ${na}x (want >=1 and 1)"

# 5. Unit tests name the calendar space in the three suites that cover the change.
nt=0
for f in server/spaces.test.ts server/members-writer.test.ts create-group.test.ts; do
  git grep -qE "CALENDAR_SPACE_TYPE|$TYPE" -- "$LIB/$f" && nt=$((nt+1))
done
[ "$nt" -eq 3 ] && ok "5 spaces, members-writer and create-group tests all name the calendar space" \
  || no "5 only $nt of 3 suites (spaces, members-writer, create-group) name the calendar space"

# 6. The groups unit suites: more tests than the 616 baseline, all passing.
out=$(npx vitest run $LIB 2>&1)
line=$(printf '%s\n' "$out" | grep -E '^\s+Tests\s' | tail -1)
n=$(printf '%s\n' "$line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
if printf '%s\n' "$line" | grep -qE '^\s+Tests\s+[0-9]+ passed \([0-9]+\)$' && [ "${n:-0}" -gt 616 ]; then
  ok "6 vitest $LIB:$(echo "$line" | sed 's/^ *Tests//') (baseline 616)"
else
  no "6 vitest $LIB: '${line:-no summary line}' (want all passed and > 616)"; printf '%s\n' "$out" | grep -E 'FAIL|✗|×' | head -10
fi

# 7. Type check: 0 errors, warnings no worse than the 7 stamped at $BASE.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); w=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ "${w:-99}" -le 7 ] && ok "7 svelte-check: $e errors, $w warnings (baseline 0, 7)" \
  || no "7 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <=7 warnings)"

# 8. Formatting on every file this branch changed under apps/web (prettier was clean at $BASE).
changed=$(git diff --name-only --relative $BASE -- . | grep -E '\.(ts|mjs|js|svelte)$' || true)
if [ -n "$changed" ]; then
  if npx prettier --check $changed >/dev/null 2>&1; then ok "8 prettier clean on $(echo "$changed" | wc -l) changed file(s)"
  else no "8 prettier fails on: $(npx prettier --list-different $changed 2>/dev/null | tr '\n' ' ')"; fi
else no "8 no changed .ts/.mjs/.js/.svelte files under apps/web"; fi

# 9. The groups e2e on atproto-devnet. Baseline at $BASE: 30 passed, 2 failed, and the two failures
#    are the events index (checks 21-22), which cannot resolve devnet's http PDS. After this change:
#    no other failure, 13b indexes three spaces, and a new check reads the calendar space back.
if [ "${SKIP_E2E:-0}" = 1 ]; then no "9 e2e skipped (SKIP_E2E=1)"; else
  h=$(curl -s -m 5 http://localhost:3010/xrpc/_health)
  if ! echo "$h" | grep -q '"version"'; then no "9 devnet alpha PDS not answering on :3010 ($h)"; else
    log=$(mktemp)
    E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
    E2E_CREDENTIALS=/workspaces/scratch/atproto-devnet/data/accounts.env \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
      timeout 900 node scripts/groups-e2e.mjs >"$log" 2>&1
    sum=$(grep -E '^SUMMARY: ' "$log" | tail -1)
    p=$(echo "$sum" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+'); f=$(echo "$sum" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
    other=$(grep -E '^FAIL ' "$log" | grep -vE '^FAIL +(the events tab reads the group.s events from the index|an event written after the backfill is indexed)' | wc -l)
    three=$(grep -cE '^PASS +the members space indexes all three spaces, one entry each' "$log")
    evs=$(grep -cE '^PASS +the calendar space ' "$log")
    if [ -n "$sum" ] && [ "${p:-0}" -ge 31 ] && [ "${f:-99}" -le 2 ] && [ "$other" -eq 0 ] && [ "$three" -eq 1 ] && [ "$evs" -ge 1 ]; then
      ok "9 devnet e2e $sum (baseline 30/2); only the events-index checks fail; 13b indexes three spaces; calendar-space check(s): $evs"
    else
      no "9 devnet e2e '${sum:-no SUMMARY}', unexpected FAILs $other, 13b-three $three, calendar-space PASS $evs (log $log)"
      grep -E '^(FAIL|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

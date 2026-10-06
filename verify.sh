#!/usr/bin/env bash
# verify.sh for two read-side guards on the members-only slice of a group's events:
#  (1) a members-only event reaches the events page without its image, an interim guard until
#      members-only images are served through atmo's own members-only route (spec 002 FR-119);
#  (2) a calendar space the host says does not exist is a warning in the log, not a silent
#      empty slice, with no change to what the member is shown.
# Public events keep their images, and no notice text changes. Decisions (TS, 2026-10-06): the
# strip is in the server read, the warning names the group DID only, and one devnet e2e check
# (13q) reads a member's slice after 13p writes an event with an image.
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Check 14 needs the local atproto-devnet up
# (SKIP_E2E=1 skips it and counts it as a FAIL).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them.
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-mrimm23}
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=6d200c6
READ=$LIB/server/calendar-read.ts
READ_TEST=$LIB/server/calendar-read.test.ts
LOADER_TEST='src/routes/(app)/groups/[actor]/events/page.server.test.ts'
E2E=scripts/groups-e2e.mjs
E2E_BASE_PASSED=44       # devnet e2e at 6d200c6: 44 passed, 2 failed (checks 21-22, the events index)
GROUPS_BASELINE=718      # vitest src/lib/groups + groups routes at 6d200c6: 718 passed (718), 42 files
ALL_BASELINE=1115        # whole web suite at 6d200c6: 1115 passed | 4 skipped (1119), 88 + 1 skipped files
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check at 6d200c6: 0 errors, 7 warnings
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }

# 0. Built on the contract's base (unit A's head).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /* and * lines.
code_lines() { grep -nvE '^[[:space:]]*(//|/\*|\*)' "$1"; }
# The body of a top-level `export async function NAME`, as numbered code lines.
fn_body() { awk -v n="$2" '$0 ~ "^export async function " n "\\(" {on=1} on {print NR": "$0} on && /^}/ {exit}' "$1" \
  | grep -vE '^[0-9]+: [[:space:]]*(//|/\*|\*)'; }
# Lines this branch added to a path (diff vs BASE), without the +++ header.
added_to() { git diff $BASE -- "$@" | grep -E '^\+' | grep -vE '^\+\+\+ '; }

# 1. The roster gate still comes first: in readMembersOnlyEvents the first canSeeMembers( call is
#    above the first reader call and the first await. (Spec: FR-106.)
body=$(fn_body "$READ" readMembersOnlyEvents)
cs=$(printf '%s\n' "$body" | grep -E 'canSeeMembers\(' | head -1 | cut -d: -f1)
rd=$(printf '%s\n' "$body" | grep -E '\breader\.[a-zA-Z]+\(' | head -1 | cut -d: -f1)
aw=$(printf '%s\n' "$body" | grep -E '\bawait\b' | head -1 | cut -d: -f1)
if [ -n "$cs" ] && [ -n "$rd" ] && [ -n "$aw" ] && [ "$cs" -lt "$rd" ] && [ "$cs" -lt "$aw" ]; then
  ok "1 readMembersOnlyEvents: canSeeMembers at line $cs, first reader call at $rd, first await at $aw"
else no "1 readMembersOnlyEvents: canSeeMembers at ${cs:-none}, reader call at ${rd:-none}, await at ${aw:-none} (want the gate first)"; fi

# 2. The image is dropped in the server read, before the record leaves the server: calendar-read.ts
#    names `media` in code at least once (0 at the base).
m=$(code_lines "$READ" | grep -cE '\bmedia\b')
[ "$m" -ge 1 ] && ok "2 $READ names media in $m code line(s): $(code_lines "$READ" | grep -E '\bmedia\b' | head -2 | cut -d: -f1 | tr '\n' ' ')" \
  || no "2 $READ names media in $m code lines (want >=1; 0 at the base)"

# 3. The interim is said in the code: among the comment lines this branch added to calendar-read.ts,
#    at least one names the image, at least one says "until", and the FR id trails as (Spec: FR-119.).
ac=$(added_to "$READ" | grep -E '^\+[[:space:]]*(//|/\*|\*)')
ci=$(printf '%s\n' "$ac" | grep -ciE '\bimages?\b'); cu=$(printf '%s\n' "$ac" | grep -ciE '\buntil\b')
cf=$(added_to "$READ" | grep -cE '\(Spec: [^()]*FR-119[^()]*\)')
[ "$ci" -ge 1 ] && [ "$cu" -ge 1 ] && [ "$cf" -ge 1 ] \
  && ok "3 added comment lines in $READ: $(printf '%s\n' "$ac" | grep -c .) total, $ci name the image, $cu say until, $cf carry (Spec: ...FR-119...)" \
  || no "3 added comment lines in $READ: image $ci, until $cu, (Spec: FR-119) $cf (want each >=1)"

# 4. The swallowed SpaceNotFound is a warning: calendar-read.ts has exactly 1 console.warn( in code,
#    within 4 lines after the NO_SUCH_SPACE test, and still exactly 1 console.error( (the other
#    failures' line, unchanged). The warning's statement names group.group_did and never the
#    calendar space URI (no ${space}, no calendarSpaceUri, no bare `space` argument): decision D2.
nw=$(code_lines "$READ" | grep -cE 'console\.warn\(')
wl=$(code_lines "$READ" | grep -E 'console\.warn\(' | head -1 | cut -d: -f1)
tl=$(code_lines "$READ" | grep -E 'NO_SUCH_SPACE\.test\(' | head -1 | cut -d: -f1)
ne=$(code_lines "$READ" | grep -cE 'console\.error\(')
ws=""; [ -n "$wl" ] && ws=$(awk -v s="$wl" 'NR>=s+0 {print; if (/\);[[:space:]]*$/) exit}' "$READ")
wd=$(printf '%s\n' "$ws" | grep -c 'group\.group_did'); wu=$(printf '%s\n' "$ws" | grep -cE '\$\{space\}|calendarSpaceUri|[(,][[:space:]]*space[[:space:]]*[,)]')
if [ "$nw" -eq 1 ] && [ -n "$tl" ] && [ -n "$wl" ] && [ "$wl" -ge "$tl" ] && [ $((wl - tl)) -le 4 ] && [ "$ne" -eq 1 ] \
   && [ "$wd" -ge 1 ] && [ "$wu" -eq 0 ]; then
  ok "4 $READ: console.warn 1x at line $wl, the SpaceNotFound test at line $tl; it names group.group_did ${wd}x, the space URI ${wu}x; console.error ${ne}x"
else no "4 $READ: console.warn ${nw}x at line ${wl:-none} (want 1, within 4 lines after the SpaceNotFound test at ${tl:-none}); names group.group_did ${wd}x (want >=1), the space URI ${wu}x (want 0); console.error ${ne}x (want 1)"; fi

# 5. No notice changes: both member notices are in calendar-read.ts verbatim once each, and no added
#    or removed line touches them.
n1=$(grep -cF "Members-only events can't be shown until an organizer relinks the group." "$READ")
n2=$(grep -cF "Members-only events couldn't be loaded right now." "$READ")
nd=$(git diff $BASE -- "$READ" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---) ' | grep -cE "MEMBERS_ONLY_(UNLINKED|UNREADABLE)|can't be shown until|couldn't be loaded right now")
[ "$n1" -eq 1 ] && [ "$n2" -eq 1 ] && [ "$nd" -eq 0 ] && ok "5 notices verbatim in $READ (unlinked ${n1}x, unreadable ${n2}x); diff lines touching them: $nd" \
  || no "5 notices: unlinked ${n1}x, unreadable ${n2}x (want 1, 1); diff lines touching them $nd (want 0)"

# 6. Unchanged against the base: the writer, the reader, the index, the remote commands, the shared
#    UI package, the events tab's page and loader, every public event route, the e2e harness's
#    worker, OAuth stand-in, resolver and environment (only groups-e2e.mjs itself may change).
keep=(../../packages/ui $LIB/server/about-read.ts $LIB/server/event-writer.ts $LIB/server/events-index.ts
      $LIB/server/space-uris.ts $LIB/server/spaces.ts $LIB/access.ts $LIB/groups.remote.ts $LIB/editor-adapter.ts
      'src/routes/(app)/groups/[actor]/events/+page.svelte'
      'src/routes/(app)/groups/[actor]/events/+page.server.ts'
      'src/routes/(app)/groups/[actor]/events/new' 'src/routes/(app)/groups/[actor]/events/[rkey]'
      'src/routes/(app)/p' src/routes/embed src/lexicon-types migrations
      scripts/groups-e2e.worker.ts scripts/groups-e2e.oauth.ts scripts/groups-e2e.identity-resolver.ts
      scripts/groups-e2e.app-environment.js)
present=0; for p in "${keep[@]}"; do [ -n "$(git ls-files -- "$p" | head -1)" ] && present=$((present+1)); done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "6 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "6 $present of ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 7. The touch-set: every file this branch changed or added under apps/web is one of five, and the
#    three that carry the change (the read, its test, the e2e script) are among them.
allowed=$'src/lib/groups/server/calendar-read.ts\nsrc/lib/groups/server/calendar-read.test.ts\nsrc/routes/(app)/groups/[actor]/events/page.server.test.ts\nsrc/lib/groups/types.ts\nscripts/groups-e2e.mjs'
changed=$( { git diff --name-only --relative $BASE -- . ; git ls-files --others --exclude-standard -- . ; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed" | LC_ALL=C sort))
hasread=$(printf '%s\n' "$changed" | grep -cxF "$READ"); hastest=$(printf '%s\n' "$changed" | grep -cxF "$READ_TEST")
hase2e=$(printf '%s\n' "$changed" | grep -cxF "$E2E")
[ "$hasread" -eq 1 ] && [ "$hastest" -eq 1 ] && [ "$hase2e" -eq 1 ] && [ -z "$outside" ] \
  && ok "7 changed under apps/web: $(printf '%s\n' "$changed" | grep -c .) file(s): $(echo "$changed" | tr '\n' ' ')" \
  || no "7 changed under apps/web: [$(echo "$changed" | tr '\n' ' ')] (want calendar-read.ts, its test and $E2E, nothing outside the 5 allowed; outside: [$(echo "$outside" | tr '\n' ' ')])"

# 8. The groups suites: more than the 718 baseline, all passing, every file passing; the four new
#    titles and six guards each pass exactly once.
titles=(
  "a members-only event is read without its image"
  "a member's page drops a members-only event's image and keeps a public event's"
  "a calendar space the host says does not exist is a warning in the log, not a notice"
  "an empty calendar space is no warning"
  "a space the host never created is no members-only events and no notice"
  "a read that throws leaves the slice empty, says so, and logs the error"
  "keeps each event at its space-form URI and marks it with the calendar space"
  "hands back the public records as the same objects, with no new key"
  "no space read for an anonymous viewer"
  "no space read for a signed-in non-member"
)
out=$(npx vitest run --reporter=verbose $LIB 'src/routes/(app)/groups' 2>&1)
line=$(printf '%s\n' "$out" | grep -E '^\s+Tests\s' | tail -1)
files=$(printf '%s\n' "$out" | grep -E '^\s+Test Files\s' | tail -1)
n=$(printf '%s\n' "$line" | sed -nE 's/^\s+Tests\s+([0-9]+) passed \(([0-9]+)\)$/\1 \2/p')
tc=""; tbad=0
for t in "${titles[@]}"; do
  esc=$(printf '%s' "$t" | sed 's/[.[\*^$()+?{|]/\\&/g')
  c=$(printf '%s\n' "$out" | grep -cE "^\s+✓ .* > ${esc}( [0-9.]+m?s)?$")
  tc="$tc $c"; [ "$c" -eq 1 ] || tbad=$((tbad+1))
done
set -- $n
if [ -n "$n" ] && [ "$1" -eq "$2" ] && [ "$1" -gt $GROUPS_BASELINE ] && [ "$tbad" -eq 0 ] \
   && printf '%s\n' "$files" | grep -qE '^\s+Test Files\s+([0-9]+) passed \(\1\)$'; then
  ok "8 vitest groups:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $GROUPS_BASELINE); ${#titles[@]} fixed titles each passed 1x"
else
  no "8 vitest groups: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $GROUPS_BASELINE); fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 9. The whole web suite: nothing fails, no fewer passed than the 1115 baseline, no more skipped than 4.
aout=$(npx vitest run 2>&1)
aline=$(printf '%s\n' "$aout" | grep -E '^\s+Tests\s' | tail -1)
afiles=$(printf '%s\n' "$aout" | grep -E '^\s+Test Files\s' | tail -1)
ap=$(echo "$aline" | sed -nE 's/^\s+Tests\s+([0-9]+) passed.*/\1/p')
as=$(echo "$aline" | sed -nE 's/.* ([0-9]+) skipped.*/\1/p'); as=${as:-0}
at=$(echo "$aline" | sed -nE 's/.*\(([0-9]+)\)$/\1/p')
if [ -n "$ap" ] && [ -n "$at" ] && ! echo "$aline $afiles" | grep -q 'failed' && [ $((ap + as)) -eq "$at" ] \
   && [ "$ap" -ge $ALL_BASELINE ] && [ "$as" -le $ALL_SKIPPED ]; then
  ok "9 vitest web:$(echo "$aline" | sed 's/^ *Tests//'),$(echo "$afiles" | sed 's/^ *Test Files//') files (baseline $ALL_BASELINE passed, $ALL_SKIPPED skipped)"
else no "9 vitest web: '${aline:-no Tests line}' / '${afiles:-no Test Files line}' (want 0 failed, >= $ALL_BASELINE passed, <= $ALL_SKIPPED skipped)"; fi

# 10. Type check: 0 errors, warnings no worse than the 7 stamped at the base.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); w=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$w" ] && [ "$w" -le $SC_WARN_BASELINE ] && ok "10 svelte-check: $e errors, $w warnings (baseline 0, $SC_WARN_BASELINE)" \
  || no "10 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <= $SC_WARN_BASELINE warnings)"

# 11. Formatting: prettier --check over every changed .ts/.mjs/.svelte file plus the four touch-set files.
mapfile -t pf < <( { printf '%s\n' "$changed" | grep -E '\.(ts|mjs|svelte)$'; printf '%s\n' "$READ" "$READ_TEST" "$LOADER_TEST" "$E2E"; } | grep . | sort -u)
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!'; then
  ok "11 prettier clean on ${#pf[@]} file(s)"
else no "11 prettier on ${#pf[@]} file(s): $(printf '%s\n' "$pout" | grep -E '^\[warn\]' | tr '\n' ' ')"; fi

# 12. Hygiene over $BASE..HEAD: at least one commit changes apps/web; messages and added lines (this
#     script aside) carry no bead id, no Co-Authored-By and no openmeet name outside an NSID; every
#     added line naming an FR- or SC- id names it only in a trailing "(Spec: ...)".
cd "$WT"
nweb=$(git rev-list --count $BASE..HEAD -- apps/web)
msgs=$(git log --format=%B $BASE..HEAD)
added=$(git diff $BASE HEAD -- . ':!verify.sh' | grep -E '^\+' | grep -vE '^\+\+\+ ')
nadded=$(printf '%s' "$added" | grep -c .)
BEAD='\bom-[a-z0-9]{4,}(\.[0-9]+)*\b'
bm=$(printf '%s\n' "$msgs" | grep -cE "$BEAD"); ba=$(printf '%s\n' "$added" | grep -cE "$BEAD")
cm=$(printf '%s\n' "$msgs" | grep -ci 'co-authored-by'); ca=$(printf '%s\n' "$added" | grep -ci 'co-authored-by')
om=$(printf '%s\n%s\n' "$msgs" "$added" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]+//g' | grep -ci 'openmeet')
specl=$(printf '%s\n' "$added" | grep -E '\b(FR|SC)-[0-9]+')
nspec=$(printf '%s' "$specl" | grep -c .)
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
if [ "$nweb" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$ba" -eq 0 ] && [ "$cm" -eq 0 ] && [ "$ca" -eq 0 ] && [ "$om" -eq 0 ] && [ "$offform" -eq 0 ]; then
  ok "12 $nweb commit(s) changing apps/web, $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By, 0 openmeet names; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "12 $nweb commit(s) changing apps/web (want >=1); bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; openmeet names $om; $offform of $nspec spec-id line(s) off the trailing form (want all 0)"
  printf '%s\n' "$added" | grep -E "$BEAD|[Cc]o-[Aa]uthored-[Bb]y" | head -5
fi

# 13. The e2e script's header counts the new check: 47 numbered checks, 13b to 13q, and a clean run
#     ending SUMMARY: 47 passed, 0 failed (46 and 13p at the base).
cd "$WEB"
h1=$(grep -cF 'It runs 47 numbered checks' "$E2E"); h2=$(grep -cF '13b to 13q' "$E2E")
h3=$(grep -cF 'SUMMARY: 47 passed, 0 failed' "$E2E")
[ "$h1" -eq 1 ] && [ "$h2" -eq 1 ] && [ "$h3" -eq 1 ] && ok "13 $E2E header: 47 numbered checks ${h1}x, 13b to 13q ${h2}x, SUMMARY: 47 passed ${h3}x" \
  || no "13 $E2E header: '47 numbered checks' ${h1}x, '13b to 13q' ${h2}x, 'SUMMARY: 47 passed, 0 failed' ${h3}x (want 1 each)"

# 14. The groups e2e on atproto-devnet. Baseline at the base: 44 passed, 2 failed, and the two
#     failures are the events index (checks 21-22), which cannot resolve devnet's http PDS. After
#     this change: 45 passed, 2 failed; the new check 13q passes once under its exact label; 13p
#     (the image stays in the space) and 13d (a member reads the slice) still pass once each; the
#     only FAIL lines are 21 and 22; and no WARN line names a members-only event or the calendar.
L13Q="a members-only event reaches a member.s slice without its image, and the stored record keeps it"
L13P="a members-only event keeps its image in the calendar space: anonymous sync.getBlob answers BlobNotFound"
L13D="the members-only slice of a roster member holds the seed at its space-form URI, read live from the calendar space"
L21="the events tab reads the group.s events from the index, edits included"
L22="an event written after the backfill is indexed at once, and a deletion drops it"
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
if [ "${SKIP_E2E:-0}" = 1 ]; then no "14 e2e skipped (SKIP_E2E=1)"
elif [ ! -s "$CRED" ]; then no "14 no fixture credentials file at $CRED"
else
  hh=$(curl -s -m 5 http://localhost:3010/xrpc/_health)
  if ! echo "$hh" | grep -q '"version"'; then no "14 devnet alpha PDS not answering on :3010 ($hh)"; else
    log=$(mktemp -t groups-e2e.XXXXXX)
    E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
    E2E_CREDENTIALS="$CRED" \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
      timeout 900 node "$E2E" >"$log" 2>&1
    sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$log" | tail -1)
    p=$(echo "$sum" | sed -nE 's/^SUMMARY: ([0-9]+) passed.*/\1/p'); f=$(echo "$sum" | sed -nE 's/.* ([0-9]+) failed$/\1/p')
    q=$(grep -cE "^PASS +${L13Q}(: |$)" "$log"); cp=$(grep -cE "^PASS +${L13P}" "$log"); cd_=$(grep -cE "^PASS +${L13D}(: |$)" "$log")
    nfail=$(grep -cE '^FAIL ' "$log")
    f21=$(grep -cE "^FAIL +${L21}(: |$)" "$log"); f22=$(grep -cE "^FAIL +${L22}(: |$)" "$log")
    warn=$(grep -E '^WARN ' "$log" | grep -ciE 'members-only|calendar')
    if [ -n "$sum" ] && [ "$p" -eq $((E2E_BASE_PASSED + 1)) ] && [ "$f" -eq 2 ] && [ "$q" -eq 1 ] && [ "$cp" -eq 1 ] \
       && [ "$cd_" -eq 1 ] && [ "$nfail" -eq 2 ] && [ "$f21" -eq 1 ] && [ "$f22" -eq 1 ] && [ "$warn" -eq 0 ]; then
      ok "14 devnet e2e $sum (base $E2E_BASE_PASSED + 1); 13q, 13p, 13d PASS 1x each; the 2 FAILs are checks 21-22; 0 members-only WARN lines"
    else
      no "14 devnet e2e '${sum:-no SUMMARY}' (want $((E2E_BASE_PASSED + 1)) passed, 2 failed); 13q/13p/13d PASS $q/$cp/$cd_ (want 1 each); FAIL lines $nfail (21: $f21, 22: $f22; want 2, 1, 1); members-only WARN lines $warn (want 0) (log $log)"
      grep -E '^(FAIL|WARN|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

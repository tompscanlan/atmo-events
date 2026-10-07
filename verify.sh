#!/usr/bin/env bash
# verify.sh for the members-only event page: one members-only event, read by its rkey from the
# group's calendar space as the group, at /groups/<actor>/events/<rkey>, for a roster member only.
#  - A caller off the roster, a missing rkey, and a record the space does not hold all get the same
#    404, and a caller off the roster causes no request through the group's session past the
#    standing read that groupRouteContext already makes (no reader, no about read, no event read).
#  - No cache and nothing from the public event route: a failed read is a 503, never a stored copy.
#  - EventView gets the event's space-form URI and the calendar space; the page drops the image
#    for display only (the shared read keeps it, because the edit path saves what it loads).
#  - The RSVP button is inert until members-only RSVPs land: the page's adapter has no space write,
#    and EventRsvp then writes nothing and never falls back to a public RSVP.
#  - The invite flow renders only with both a space URI and a space key.
# Decisions (TS, 2026-10-07): split 17a/17b; RSVP state and the RSVP read-back move to the
# members-only RSVP bead; the route serves members-only events only; non-member and missing rkey
# share one 404, a member whose read fails gets a 503; membership before any group-session read;
# display-only image strip in the page loader; inert RSVP; the invite-flow guard; risk:high.
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Check 14 needs the local atproto-devnet up
# (SKIP_E2E=1 skips it and counts it as a FAIL).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them.
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-mrimm17}
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=c164c29
READ=$LIB/server/calendar-read.ts
READ_TEST=$LIB/server/calendar-read.test.ts
ROUTE='src/routes/(app)/groups/[actor]/events/[rkey]'
LOADER="$ROUTE/+page.server.ts"
PAGE="$ROUTE/+page.svelte"
LOADER_TEST="$ROUTE/page.server.test.ts"
ADAPTER=$LIB/event-page-adapter.ts
ADAPTER_TEST=$LIB/event-page-adapter.test.ts
VIEW=packages/ui/src/EventView.svelte
E2E=scripts/groups-e2e.mjs
E2E_WORKER=scripts/groups-e2e.worker.ts
E2E_BASE_PASSED=47       # devnet e2e at c164c29: 47 passed, 0 failed (scratch-7a, 2026-10-07)
GROUPS_BASELINE=743      # vitest src/lib/groups + groups routes at c164c29: 743 passed (743), 47 files
ALL_BASELINE=1140        # whole web suite at c164c29: 1140 passed | 4 skipped (1144), 93 + 1 skipped files
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check at c164c29: 0 errors, 7 warnings
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }

# 0. Built on the contract's base (the folded groups branch).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /* and * lines. Empty for a missing file.
code_lines() { [ -f "$1" ] && grep -nvE '^[[:space:]]*(//|/\*|\*)' "$1"; }
# The body of a top-level `export async function NAME`, as numbered code lines.
fn_body() { [ -f "$1" ] && awk -v n="$2" '$0 ~ "^export async function " n "\\(" {on=1} on {print NR": "$0} on && /^}/ {exit}' "$1" \
  | grep -vE '^[0-9]+: [[:space:]]*(//|/\*|\*)'; }
# First line number in the given numbered lines matching a regex, or empty.
first() { printf '%s\n' "$1" | grep -E "$2" | head -1 | cut -d: -f1; }
# Lines this branch added to a path (diff vs BASE), without the +++ header.
added_to() { git diff $BASE -- "$@" | grep -E '^\+' | grep -vE '^\+\+\+ '; }

# 1. The page's gate order. In the loader's code: groupRouteContext( comes first, then the
#    canSeeMembers( gate, and every group-session use (groupSpaceReader(, readMembersOnlyEvent(,
#    readGroupAbout() comes after the gate; an about read, if any, comes after the event read.
#    (Spec: FR-106, FR-117.)
lc=$(code_lines "$LOADER")
g=$(first "$lc" 'groupRouteContext\('); c=$(first "$lc" 'canSeeMembers\(')
s=$(first "$lc" 'groupSpaceReader\('); r=$(first "$lc" 'readMembersOnlyEvent\('); a=$(first "$lc" 'readGroupAbout\(')
if [ -n "$g" ] && [ -n "$c" ] && [ -n "$s" ] && [ -n "$r" ] && [ "$g" -lt "$c" ] && [ "$c" -lt "$s" ] && [ "$c" -lt "$r" ] \
   && { [ -z "$a" ] || [ "$a" -gt "$r" ]; }; then
  ok "1 $LOADER: groupRouteContext :$g, canSeeMembers :$c, groupSpaceReader :$s, readMembersOnlyEvent :$r, readGroupAbout :${a:-none}"
else no "1 $LOADER: groupRouteContext :${g:-none}, canSeeMembers :${c:-none}, groupSpaceReader :${s:-none}, readMembersOnlyEvent :${r:-none}, readGroupAbout :${a:-none} (want route context < gate < reader and event read; about after the event read)"; fi

# 2. No cache, no index, nothing from the public event route: the loader's code names none of
#    caches, cache.put/match, getEventRecordFromContrail, contrail, getViewerRsvp, or a /p/ route
#    import; and the 404 the loader throws carries the text 'Event not found' at least once.
nl=$(printf '%s\n' "$lc" | grep -c .)
fb=$(printf '%s\n' "$lc" | grep -cE 'caches|cache\.(put|match)|getEventRecordFromContrail|[Cc]ontrail|getViewerRsvp|/p/\[actor\]|routes/\(app\)/p/')
nf=$(printf '%s\n' "$lc" | grep -cF 'Event not found')
[ "$nl" -ge 1 ] && [ "$fb" -eq 0 ] && [ "$nf" -ge 1 ] && ok "2 $LOADER: $nl code lines, 0 cache/index/public-route refs, 'Event not found' ${nf}x" \
  || { no "2 $LOADER: $nl code lines (want >=1), $fb cache/index/public-route refs (want 0), 'Event not found' ${nf}x (want >=1)"; printf '%s\n' "$lc" | grep -E 'caches|cache\.|[Cc]ontrail|getViewerRsvp|/p/' | head -5; }

# 3. The shared read gates first: in readMembersOnlyEvent the first canSeeMembers( is above the
#    first reader call and the first await. (Spec: FR-106.)
body=$(fn_body "$READ" readMembersOnlyEvent)
cs=$(first "$body" 'canSeeMembers\('); rd=$(first "$body" '\breader\.[a-zA-Z]+\('); aw=$(first "$body" '\bawait\b')
if [ -n "$cs" ] && [ -n "$rd" ] && [ -n "$aw" ] && [ "$cs" -lt "$rd" ] && [ "$cs" -lt "$aw" ]; then
  ok "3 readMembersOnlyEvent: canSeeMembers at line $cs, first reader call at $rd, first await at $aw"
else no "3 readMembersOnlyEvent: canSeeMembers at ${cs:-none}, reader call at ${rd:-none}, await at ${aw:-none} (want the gate first)"; fi

# 4. The shared read keeps the image (the edit path saves what it loads): readMembersOnlyEvent's
#    body names media 0 times and is non-empty; and the display strip is its own export that the
#    loader calls.
bl=$(printf '%s\n' "$body" | grep -c .); bm=$(printf '%s\n' "$body" | grep -cE '\bmedia\b')
ds=$(code_lines "$READ" | grep -E '^[0-9]+:export (async )?function [A-Za-z]+' | grep -viE 'readMembersOnlyEvents?\(' | grep -iE 'display|media|image' | sed -nE 's/.*function ([A-Za-z]+).*/\1/p' | head -1)
dl=0; [ -n "$ds" ] && dl=$(printf '%s\n' "$lc" | grep -cE "\b$ds\(")
[ "$bl" -ge 3 ] && [ "$bm" -eq 0 ] && [ -n "$ds" ] && [ "$dl" -ge 1 ] \
  && ok "4 readMembersOnlyEvent: $bl code lines, media named 0x; display strip export '$ds' called by the loader ${dl}x" \
  || no "4 readMembersOnlyEvent: $bl code lines (want >=3), media named ${bm}x (want 0); display strip export '${ds:-none}' called by the loader ${dl}x (want >=1)"

# 5. EventView: added lines use data.eventUri at least once; the plain-form URI is still there
#    once (the fallback, exactly as today); the invite flow sits under one
#    {#if data.spaceUri && data.spaceKey}; and the file's diff is small (<= 16 changed lines).
cd "$WT"
ve=$(added_to "$VIEW" | grep -c 'data\.eventUri')
vp=$(grep -cF 'at://${did}/community.lexicon.calendar.event/${rkey}' "$VIEW")
vg=$(grep -cE '\{#if data\.spaceUri && data\.spaceKey\}' "$VIEW")
vn=$(git diff --numstat $BASE -- "$VIEW" | awk '{s+=$1+$2} END {print s+0}')
[ "$ve" -ge 1 ] && [ "$vp" -eq 1 ] && [ "$vg" -eq 1 ] && [ "$vn" -ge 1 ] && [ "$vn" -le 16 ] \
  && ok "5 $VIEW: data.eventUri in ${ve} added line(s), plain-form URI ${vp}x, invite guard ${vg}x, $vn changed lines" \
  || no "5 $VIEW: data.eventUri in ${ve} added lines (want >=1), plain-form URI ${vp}x (want 1), invite guard ${vg}x (want 1), $vn changed lines (want 1-16)"

# 6. Unchanged against the base: the rest of the shared UI package, the writer, the index, the
#    about read, the route context, access, credentials, the remote commands, the groups and in-app
#    editor adapters, the events tab's page and loader, the new-event and edit routes, every public
#    event route, embeds, lexicon types, migrations, and the e2e OAuth stand-in, resolver and
#    environment.
cd "$WEB"
keep=(../../packages/ui/src/EventCard.svelte ../../packages/ui/src/EventRsvp.svelte ../../packages/ui/src/contrail.ts
      ../../packages/ui/src/EventEditor.svelte ../../packages/ui/src/event-view ../../packages/ui/src/editor
      $LIB/server/about-read.ts $LIB/server/event-writer.ts $LIB/server/events-index.ts $LIB/server/route-context.ts
      $LIB/server/credentials.ts $LIB/server/space-uris.ts $LIB/server/spaces.ts $LIB/access.ts $LIB/types.ts
      $LIB/groups.remote.ts $LIB/editor-adapter.ts src/lib/components/editor/adapter.ts
      'src/routes/(app)/groups/[actor]/events/+page.svelte'
      'src/routes/(app)/groups/[actor]/events/+page.server.ts'
      'src/routes/(app)/groups/[actor]/events/new' "$ROUTE/edit"
      'src/routes/(app)/p' src/routes/embed src/lexicon-types migrations
      scripts/groups-e2e.oauth.ts scripts/groups-e2e.identity-resolver.ts scripts/groups-e2e.app-environment.js)
present=0; missing=""
for p in "${keep[@]}"; do if [ -n "$(git ls-files -- "$p" | head -1)" ]; then present=$((present+1)); else missing="$missing $p"; fi; done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "6 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "6 $present of ${#keep[@]} frozen paths present (missing:${missing:- none}); numstat vs $BASE totals $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 7. The touch-set: every file this branch changed or added under apps/web and packages is one of
#    the allowed ten, and the ones that carry the change are among them (the read and its test, the
#    loader, page and loader test, the adapter, EventView, and the e2e script and worker).
cd "$WT"
allowed=$(printf '%s\n' "apps/web/$READ" "apps/web/$READ_TEST" "apps/web/$LOADER" "apps/web/$PAGE" "apps/web/$LOADER_TEST" \
  "apps/web/$ADAPTER" "apps/web/$ADAPTER_TEST" "$VIEW" "apps/web/$E2E" "apps/web/$E2E_WORKER" | LC_ALL=C sort)
must=$(printf '%s\n' "apps/web/$READ" "apps/web/$READ_TEST" "apps/web/$LOADER" "apps/web/$PAGE" "apps/web/$LOADER_TEST" \
  "apps/web/$ADAPTER" "$VIEW" "apps/web/$E2E" "apps/web/$E2E_WORKER")
changed=$( { git diff --name-only $BASE -- apps/web packages ; git ls-files --others --exclude-standard -- apps/web packages ; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
lacking=$(comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$must" | LC_ALL=C sort))
[ -z "$outside" ] && [ -z "$lacking" ] \
  && ok "7 changed under apps/web and packages: $(printf '%s\n' "$changed" | grep -c .) file(s), all in the allowed set, all 9 required present" \
  || no "7 changed: [$(echo "$changed" | tr '\n' ' ')]; outside the allowed set: [$(echo "$outside" | tr '\n' ' ')]; required but unchanged: [$(echo "$lacking" | tr '\n' ' ')]"

# 8. The groups suites: more than the 743 baseline, all passing, every file passing; the nine new
#    titles each pass exactly once.
cd "$WEB"
titles=(
  "one members-only event: a roster member reads it at its space-form URI with its image"
  "one members-only event: a caller off the roster causes no space read"
  "one members-only event: a missing record is absent, and a failed read is unreadable"
  "the display copy of a members-only event drops its image and leaves the record's"
  "the event page: an absent rkey and a caller off the roster get the same 404"
  "the event page: a caller off the roster sends nothing through the group's session after standing"
  "the event page: a failed read is a 503 and never a cached copy"
  "the event page hands EventView the space-form URI and the calendar space, without the image"
  "the members-only event page's adapter has no space write"
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
if [ -n "$n" ]; then set -- $n; else set -- 0 1; fi
if [ -n "$n" ] && [ "$1" -eq "$2" ] && [ "$1" -gt $GROUPS_BASELINE ] && [ "$tbad" -eq 0 ] \
   && printf '%s\n' "$files" | grep -qE '^\s+Test Files\s+([0-9]+) passed \(\1\)$'; then
  ok "8 vitest groups:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $GROUPS_BASELINE); ${#titles[@]} fixed titles each passed 1x"
else
  no "8 vitest groups: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $GROUPS_BASELINE); fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 9. The whole web suite: nothing fails, no fewer passed than the 1140 baseline, no more skipped than 4.
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

# 11. Formatting: prettier --check over every changed .ts/.mjs/.svelte file under apps/web, plus
#     the loader, page and loader test. EventView is left out: it is upstream's file and is not
#     prettier-clean at the base, so formatting it would bury the change (check 5 caps its diff).
mapfile -t pf < <( { printf '%s\n' "$changed" | grep -E '^apps/web/.*\.(ts|mjs|svelte)$' | sed 's#^apps/web/##'; printf '%s\n' "$LOADER" "$PAGE" "$LOADER_TEST"; } | grep . | sort -u)
# prettier prints its all-clean line even for a path that does not exist, so count the files first.
pe=0; for f in "${pf[@]}"; do [ -f "$f" ] && pe=$((pe+1)); done
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if [ "$pe" -eq ${#pf[@]} ] && [ "$pe" -ge 3 ] && printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!' \
   && ! printf '%s\n' "$pout" | grep -qiE 'no (files|matching)|error'; then
  ok "11 prettier clean on $pe existing file(s)"
else no "11 prettier: $pe of ${#pf[@]} file(s) exist (want all, >=3); $(printf '%s\n' "$pout" | grep -E '^\[(warn|error)\]' | tr '\n' ' ')"; fi

# 12. Hygiene over $BASE..HEAD: at least one commit changes apps/web; messages and added lines (this
#     script aside) carry no bead id, no Co-Authored-By, no openmeet name outside an NSID, and no
#     "private" (members-only, never private: FR-108); every added line naming an FR- or SC- id
#     names it only in a trailing "(Spec: ...)".
cd "$WT"
nweb=$(git rev-list --count $BASE..HEAD -- apps/web)
msgs=$(git log --format=%B $BASE..HEAD)
added=$(git diff $BASE HEAD -- . ':!verify.sh' | grep -E '^\+' | grep -vE '^\+\+\+ ')
nadded=$(printf '%s' "$added" | grep -c .)
BEAD='\bom-[a-z0-9]{4,}(\.[0-9]+)*\b'
bm=$(printf '%s\n' "$msgs" | grep -cE "$BEAD"); ba=$(printf '%s\n' "$added" | grep -cE "$BEAD")
cm=$(printf '%s\n' "$msgs" | grep -ci 'co-authored-by'); ca=$(printf '%s\n' "$added" | grep -ci 'co-authored-by')
om=$(printf '%s\n%s\n' "$msgs" "$added" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]+//g' | grep -ci 'openmeet')
pv=$(printf '%s\n%s\n' "$msgs" "$added" | grep -ciE '\bprivate\b')
specl=$(printf '%s\n' "$added" | grep -E '\b(FR|SC)-[0-9]+')
nspec=$(printf '%s' "$specl" | grep -c .)
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
if [ "$nweb" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$ba" -eq 0 ] && [ "$cm" -eq 0 ] && [ "$ca" -eq 0 ] && [ "$om" -eq 0 ] && [ "$pv" -eq 0 ] && [ "$offform" -eq 0 ]; then
  ok "12 $nweb commit(s) changing apps/web, $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By, 0 openmeet names, 0 'private'; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "12 $nweb commit(s) changing apps/web (want >=1); bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; openmeet names $om; 'private' $pv; $offform of $nspec spec-id line(s) off the trailing form (want all 0)"
  printf '%s\n' "$added" | grep -iE "$BEAD|co-authored-by|\bprivate\b" | head -5
fi

# 13. The e2e script's header counts the new check: 48 numbered checks, 13b to 13r, and a clean run
#     ending SUMMARY: 48 passed, 0 failed (47 and 13q at the base).
cd "$WEB"
h1=$(grep -cF 'It runs 48 numbered checks' "$E2E"); h2=$(grep -cF '13b to 13r' "$E2E")
h3=$(grep -cF 'SUMMARY: 48 passed, 0 failed' "$E2E")
[ "$h1" -eq 1 ] && [ "$h2" -eq 1 ] && [ "$h3" -eq 1 ] && ok "13 $E2E header: 48 numbered checks ${h1}x, 13b to 13r ${h2}x, SUMMARY: 48 passed ${h3}x" \
  || no "13 $E2E header: '48 numbered checks' ${h1}x, '13b to 13r' ${h2}x, 'SUMMARY: 48 passed, 0 failed' ${h3}x (want 1 each)"

# 14. The groups e2e on atproto-devnet. Baseline at the base: 47 passed, 0 failed. After this
#     change: 48 passed, 0 failed; the new check 13r passes once under its exact label; 13q (a
#     member's slice drops the image) and 13d (a member reads the slice) still pass once each; no
#     FAIL line; and no WARN line names a members-only event or the calendar.
L13R="one members-only event is read by its rkey for a member, image kept, and a non-member and an anonymous caller send no read"
L13Q="a members-only event reaches a member.s slice without its image, and the stored record keeps it"
L13D="the members-only slice of a roster member holds the seed at its space-form URI, read live from the calendar space"
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
    q=$(grep -cE "^PASS +${L13R}(: |$)" "$log"); cq=$(grep -cE "^PASS +${L13Q}(: |$)" "$log"); cd_=$(grep -cE "^PASS +${L13D}(: |$)" "$log")
    nfail=$(grep -cE '^FAIL ' "$log")
    warn=$(grep -E '^WARN ' "$log" | grep -ciE 'members-only|calendar')
    if [ -n "$sum" ] && [ "$p" -eq $((E2E_BASE_PASSED + 1)) ] && [ "$f" -eq 0 ] && [ "$q" -eq 1 ] && [ "$cq" -eq 1 ] \
       && [ "$cd_" -eq 1 ] && [ "$nfail" -eq 0 ] && [ "$warn" -eq 0 ]; then
      ok "14 devnet e2e $sum (base $E2E_BASE_PASSED + 1); 13r, 13q, 13d PASS 1x each; 0 FAIL lines; 0 members-only WARN lines"
    else
      no "14 devnet e2e '${sum:-no SUMMARY}' (want $((E2E_BASE_PASSED + 1)) passed, 0 failed); 13r/13q/13d PASS $q/$cq/$cd_ (want 1 each); FAIL lines $nfail (want 0); members-only WARN lines $warn (want 0) (log $log)"
      grep -E '^(FAIL|WARN|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

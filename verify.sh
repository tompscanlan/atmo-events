#!/usr/bin/env bash
# verify.sh for editing a members-only event and linking to it: part 2 of the members-only event
# page, on top of part 1 (the page itself, verified at 8a338fe).
#  - The group edit page reads a members-only event from the group's calendar space when its link
#    says ?placement=members, keeps the image (the editor saves what it loads), and puts no `space`
#    key on the record it hands the editor; the page takes its space from data. Without the param
#    the edit page reads the public event from the index exactly as before. Any other value is the
#    same 404 with no read.
#  - A caller who may not edit gets the editor gate's 403, identical for every key and with or
#    without the param, and causes no group-session request past standing.
#  - Cards on the events tab link a members-only event to its page and say "Members only" on the
#    lock; contrail's own spaces keep "Private event". The tab's Edit link and the members-only
#    page's Edit link (for managers only) carry ?placement=members.
#  - The edit page builds no CDN image URL for a members-only event; the save still keeps the image.
#  - From the review of part 1: the page's render tests move to their own file and check the head
#    as well as the body for the image.
# Decisions (TS, 2026-10-07): ?placement=members, no param = public (D2a); EventCard href and
# lockLabel props (D7a); no CDN preview for members-only events (D11b); EventView shows Edit when
# data.editHref is set (D12b); keep the 403 and pin it (D13a). risk:med-high.
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Check 18 needs the local atproto-devnet up
# (SKIP_E2E=1 skips it and counts it as a FAIL).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them.
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-mrimm31}
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=8a338fe
EVENTS='src/routes/(app)/groups/[actor]/events'
ROUTE="$EVENTS/[rkey]"
EDIT="$ROUTE/edit"
EDIT_LOADER="$EDIT/+page.server.ts"
EDIT_PAGE="$EDIT/+page.svelte"
EDIT_PAGE_TEST="$EDIT/page.test.ts"
EDIT_LOADER_TEST="$EDIT/page.server.test.ts"
EDITOR_GATE=$LIB/server/editor-page.ts
READ=$LIB/server/calendar-read.ts
READ_TEST=$LIB/server/calendar-read.test.ts
TAB="$EVENTS/+page.svelte"
TAB_TEST="$EVENTS/page.test.ts"
NEW_LOADER_TEST="$EVENTS/new/page.server.test.ts"
LOADER="$ROUTE/+page.server.ts"
LOADER_TEST="$ROUTE/page.server.test.ts"
RENDER_TEST="$ROUTE/page.test.ts"
CARD=packages/ui/src/EventCard.svelte
VIEW=packages/ui/src/EventView.svelte
EDITOR=packages/ui/src/EventEditor.svelte
E2E=scripts/groups-e2e.mjs
E2E_WORKER=scripts/groups-e2e.worker.ts
E2E_BASE_PASSED=48       # devnet e2e at 8a338fe: 48 passed, 0 failed (part 1's verify, 2026-10-07)
GROUPS_BASELINE=756      # vitest src/lib/groups + groups routes at 8a338fe: 756 passed
ALL_BASELINE=1153        # whole web suite at 8a338fe: 1153 passed | 4 skipped
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check apps/web at 8a338fe: 0 errors, 7 warnings
UI_SC_WARN_BASELINE=2    # svelte-check packages/ui at 8a338fe: 0 errors, 2 warnings
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }

# 0. Built on the contract's base (part 1's tip).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /*, * and <!-- lines. Empty for a missing file.
code_lines() { [ -f "$1" ] && grep -nvE '^[[:space:]]*(//|/\*|\*|<!--)' "$1"; }
# First line number in the given numbered lines matching a regex, or empty.
first() { printf '%s\n' "$1" | grep -E "$2" | head -1 | cut -d: -f1; }
# How many of the given numbered lines match a regex.
count() { printf '%s\n' "$1" | grep -cE "$2"; }
# Lines this branch added to a path (diff vs BASE, run from the worktree root), without the +++ header.
added_to() { git -C "$WT" diff $BASE -- "$@" | grep -E '^\+' | grep -vE '^\+\+\+ '; }
# Changed lines (added + removed) of a path vs BASE, from the worktree root.
numstat() { git -C "$WT" diff --numstat $BASE -- "$@" | awk '{s+=$1+$2} END {print s+0}'; }

# 1. The edit loader. In its code: groupEditorPage( comes before the members-only read and the
#    index read; readMembersOnlyEvent( and getEventRecordFromContrail( appear once each;
#    flattenEventRecord( at most once (the public path, as today); no display strip, no cache;
#    the loader reads the placement param and throws 'Event not found'.
lc=$(code_lines "$EDIT_LOADER")
g=$(first "$lc" 'groupEditorPage\('); r=$(first "$lc" 'readMembersOnlyEvent\('); x=$(first "$lc" 'getEventRecordFromContrail\(')
nr=$(count "$lc" 'readMembersOnlyEvent\('); nx=$(count "$lc" 'getEventRecordFromContrail\(')
nfl=$(count "$lc" 'flattenEventRecord\('); nds=$(count "$lc" 'membersOnlyEventForDisplay')
nc=$(count "$lc" 'caches|cache\.(put|match)'); np=$(count "$lc" 'placement'); nf=$(printf '%s\n' "$lc" | grep -cF 'Event not found')
if [ -n "$g" ] && [ -n "$r" ] && [ -n "$x" ] && [ "$g" -lt "$r" ] && [ "$g" -lt "$x" ] && [ "$nr" -eq 1 ] && [ "$nx" -eq 1 ] \
   && [ "$nfl" -le 1 ] && [ "$nds" -eq 0 ] && [ "$nc" -eq 0 ] && [ "$np" -ge 1 ] && [ "$nf" -ge 1 ]; then
  ok "1 $EDIT_LOADER: groupEditorPage :$g, readMembersOnlyEvent :$r (1x), getEventRecordFromContrail :$x (1x), flattenEventRecord ${nfl}x, display strip 0x, cache 0x, placement ${np}x, 'Event not found' ${nf}x"
else no "1 $EDIT_LOADER: groupEditorPage :${g:-none}, readMembersOnlyEvent :${r:-none} (${nr}x, want 1), getEventRecordFromContrail :${x:-none} (${nx}x, want 1), flattenEventRecord ${nfl}x (want <=1), display strip ${nds}x (want 0), cache ${nc}x (want 0), placement ${np}x (want >=1), 'Event not found' ${nf}x (want >=1); want the gate first"; fi

# 2. The editor gate is unchanged in effect: in groupEditorPage the permission check and its 403
#    come before the reader and the about read, and the 403 is thrown once. (Spec: FR-117.)
gc=$(code_lines "$EDITOR_GATE")
pc=$(first "$gc" 'can\(membership\.permissions, permission\)'); e403=$(count "$gc" 'error\(403'); f403=$(first "$gc" 'error\(403')
gr=$(first "$gc" 'groupSpaceReader\('); ga=$(first "$gc" 'readGroupAbout\(')
if [ -n "$pc" ] && [ -n "$f403" ] && [ -n "$gr" ] && [ -n "$ga" ] && [ "$e403" -eq 1 ] && [ "$pc" -lt "$gr" ] && [ "$f403" -lt "$gr" ] && [ "$gr" -lt "$ga" ]; then
  ok "2 $EDITOR_GATE: permission check :$pc, 403 :$f403 (1x), groupSpaceReader :$gr, readGroupAbout :$ga"
else no "2 $EDITOR_GATE: permission check :${pc:-none}, 403 :${f403:-none} (${e403}x, want 1), groupSpaceReader :${gr:-none}, readGroupAbout :${ga:-none} (want check and 403 before the reader, reader before the about read)"; fi

# 3. The edit page takes its space from data, with no default, and hands the editor its image hook.
#    (Spec: FR-116.)
pl=$(code_lines "$EDIT_PAGE")
sn=$(count "$pl" 'const space: string \| null = null'); sd=$(count "$pl" 'data\.space\b'); sf=$(count "$pl" 'data\.space\s*(\?\?|\|\|)')
si=$(count "$pl" 'storedImageUrl')
[ "$sn" -eq 0 ] && [ "$sd" -ge 1 ] && [ "$sf" -eq 0 ] && [ "$si" -ge 1 ] \
  && ok "3 $EDIT_PAGE: null-space const 0x, data.space ${sd}x, data.space defaulted 0x, storedImageUrl ${si}x" \
  || no "3 $EDIT_PAGE: null-space const ${sn}x (want 0), data.space ${sd}x (want >=1), data.space defaulted ${sf}x (want 0), storedImageUrl ${si}x (want >=1)"

# 4. The events tab: Edit links name the placement, the card gets a lockLabel and the words
#    "Members only", and the tab itself never says "Private event". (Spec: FR-108.)
tl=$(code_lines "$TAB")
tp=$(count "$tl" 'placement=members'); tk=$(count "$tl" 'lockLabel'); tm=$(count "$tl" 'Members only'); tv=$(grep -ciE 'private' "$TAB")
[ "$tp" -ge 1 ] && [ "$tk" -ge 1 ] && [ "$tm" -ge 1 ] && [ "$tv" -eq 0 ] \
  && ok "4 $TAB: placement=members ${tp}x, lockLabel ${tk}x, 'Members only' ${tm}x, 'private' 0x" \
  || no "4 $TAB: placement=members ${tp}x, lockLabel ${tk}x, 'Members only' ${tm}x (want >=1 each), 'private' ${tv}x (want 0)"

cd "$WT"
# 5. EventCard: optional href and lockLabel, falling back to today's link and label; a small diff.
ck=$(grep -cF "lockLabel ?? 'Private event'" "$CARD"); ch=$(grep -cF 'href ?? eventUrl(event, actor)' "$CARD"); cn=$(numstat "$CARD")
[ "$ck" -eq 1 ] && [ "$ch" -eq 1 ] && [ "$cn" -ge 1 ] && [ "$cn" -le 8 ] \
  && ok "5 $CARD: lockLabel fallback ${ck}x, href fallback ${ch}x, $cn changed lines" \
  || no "5 $CARD: lockLabel fallback ${ck}x, href fallback ${ch}x (want 1 each), $cn changed lines (want 1-8)"

# 6. EventView: added lines name data.editHref; the owner's './{rkey}/edit' link is still there
#    once; part 1's data.eventUri and invite guard are still there once each; a small diff.
ve=$(added_to "$VIEW" | grep -c 'data\.editHref'); vo=$(grep -cE '\./(\{|\$\{)rkey\}/edit' "$VIEW")
vu=$(grep -cF 'data.eventUri ??' "$VIEW"); vg=$(grep -cE '\{#if data\.spaceUri && data\.spaceKey\}' "$VIEW"); vn=$(numstat "$VIEW")
[ "$ve" -ge 1 ] && [ "$vo" -eq 1 ] && [ "$vu" -eq 1 ] && [ "$vg" -eq 1 ] && [ "$vn" -ge 1 ] && [ "$vn" -le 6 ] \
  && ok "6 $VIEW: data.editHref in $ve added line(s), owner edit link ${vo}x, data.eventUri ${vu}x, invite guard ${vg}x, $vn changed lines" \
  || no "6 $VIEW: data.editHref in $ve added lines (want >=1), owner edit link ${vo}x (want 1), data.eventUri ${vu}x, invite guard ${vg}x (want 1 each), $vn changed lines (want 1-6)"

# 7. EventEditor: an optional storedImageUrl; the CDN path is still there for everyone else; a
#    small diff.
ee=$(added_to "$EDITOR" | grep -c 'storedImageUrl'); ec=$(grep -c 'getCDNImageBlobUrl' "$EDITOR"); en=$(numstat "$EDITOR")
[ "$ee" -ge 1 ] && [ "$ec" -ge 2 ] && [ "$en" -ge 1 ] && [ "$en" -le 8 ] \
  && ok "7 $EDITOR: storedImageUrl in $ee added line(s), getCDNImageBlobUrl ${ec}x, $en changed lines" \
  || no "7 $EDITOR: storedImageUrl in $ee added lines (want >=1), getCDNImageBlobUrl ${ec}x (want >=2), $en changed lines (want 1-8)"

# 8. The render tests have their own file: the loader test imports neither svelte/server nor the
#    page; the render test file does both and checks the head at least twice.
cd "$WEB"
ls_=$(grep -cE "from 'svelte/server'|from \"svelte/server\"" "$LOADER_TEST"); lp=$(grep -cE "from '\./\+page\.svelte'" "$LOADER_TEST")
rs=0; rp=0; rh=0
if [ -f "$RENDER_TEST" ]; then
  rs=$(grep -cE "from 'svelte/server'" "$RENDER_TEST"); rp=$(grep -cE "from '\./\+page\.svelte'" "$RENDER_TEST")
  rh=$(grep -cE '\bhead\b.*not\.toContain' "$RENDER_TEST")
fi
[ "$ls_" -eq 0 ] && [ "$lp" -eq 0 ] && [ "$rs" -eq 1 ] && [ "$rp" -eq 1 ] && [ "$rh" -ge 2 ] \
  && ok "8 $LOADER_TEST: svelte/server 0x, page 0x; $RENDER_TEST: svelte/server ${rs}x, page ${rp}x, head not.toContain ${rh}x" \
  || no "8 $LOADER_TEST: svelte/server ${ls_}x, page ${lp}x (want 0 each); $RENDER_TEST: svelte/server ${rs}x, page ${rp}x (want 1 each), head not.toContain ${rh}x (want >=2)"

# 9. Unchanged against the base: the shared UI package other than the three components, the
#    writer, the index, the about read, the route context, access, credentials, the remote
#    commands, the editor adapters, placement words, the app's contrail reads, the events tab's
#    loader and its test, the new-event page, the members-only page's markup and adapter, every
#    public event route, embeds, lexicon types, migrations, and the e2e OAuth stand-in, resolver
#    and environment.
keep=(../../packages/ui/src/EventRsvp.svelte ../../packages/ui/src/contrail.ts ../../packages/ui/src/event-view
      ../../packages/ui/src/editor ../../packages/ui/src/schedule
      $LIB/server/about-read.ts $LIB/server/event-writer.ts $LIB/server/events-index.ts $LIB/server/route-context.ts
      $LIB/server/credentials.ts $LIB/server/space-uris.ts $LIB/server/spaces.ts $LIB/access.ts $LIB/types.ts
      $LIB/groups.remote.ts $LIB/editor-adapter.ts $LIB/editor-adapter.test.ts $LIB/event-placement.ts
      $LIB/event-page-adapter.ts src/lib/components/editor/adapter.ts src/lib/contrail.ts
      "$EVENTS/+page.server.ts" "$EVENTS/page.server.test.ts"
      "$EVENTS/new/+page.server.ts" "$EVENTS/new/+page.svelte" "$EVENTS/new/page.test.ts" "$ROUTE/+page.svelte"
      'src/routes/(app)/p' src/routes/embed src/lexicon-types migrations
      scripts/groups-e2e.oauth.ts scripts/groups-e2e.identity-resolver.ts scripts/groups-e2e.app-environment.js)
present=0; missing=""
for p in "${keep[@]}"; do if [ -n "$(git ls-files -- "$p" | head -1)" ]; then present=$((present+1)); else missing="$missing $p"; fi; done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "9 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "9 $present of ${#keep[@]} frozen paths present (missing:${missing:- none}); numstat vs $BASE totals $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 10. The touch-set: every file changed or added under apps/web and packages is in the allowed set,
#     and the ones that carry the change are among them.
cd "$WT"
w() { printf 'apps/web/%s\n' "$@"; }
allowed=$( { w "$EDIT_LOADER" "$EDIT_PAGE" "$EDIT_PAGE_TEST" "$EDIT_LOADER_TEST" "$EDITOR_GATE" "$NEW_LOADER_TEST" \
  "$READ" "$READ_TEST" "$TAB" "$TAB_TEST" "$LOADER" "$LOADER_TEST" "$RENDER_TEST" "$E2E" "$E2E_WORKER"; \
  printf '%s\n' "$CARD" "$VIEW" "$EDITOR"; } | LC_ALL=C sort)
must=$( { w "$EDIT_LOADER" "$EDIT_PAGE" "$EDIT_LOADER_TEST" "$EDITOR_GATE" "$READ" "$TAB" "$LOADER" "$LOADER_TEST" \
  "$RENDER_TEST" "$E2E" "$E2E_WORKER"; printf '%s\n' "$CARD" "$VIEW" "$EDITOR"; } | LC_ALL=C sort)
nmust=$(printf '%s\n' "$must" | grep -c .)
changed=$( { git diff --name-only $BASE -- apps/web packages ; git ls-files --others --exclude-standard -- apps/web packages ; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
lacking=$(comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$must"))
[ -z "$outside" ] && [ -z "$lacking" ] \
  && ok "10 changed under apps/web and packages: $(printf '%s\n' "$changed" | grep -c .) file(s), all in the allowed set, all $nmust required present" \
  || no "10 changed: [$(echo "$changed" | tr '\n' ' ')]; outside the allowed set: [$(echo "$outside" | tr '\n' ' ')]; required but unchanged: [$(echo "$lacking" | tr '\n' ' ')]"

# 11. The groups suites: more than the baseline, all passing, every file passing; part 2's ten new
#     titles and part 1's nine each pass exactly once.
cd "$WEB"
titles=(
  "the edit read of a members-only event keeps its image and puts no space on the record"
  "a members-only edit, saved as the editor builds it, keeps the image and adds no field"
  "a public edit reads the index as before and names no space"
  "a members-only edit of a key the space does not hold is a 404, and a failed read is a 503"
  "the edit page: a caller who may not edit gets the same answer for any key, with nothing read past standing"
  "the edit page saves a members-only event into the calendar space"
  "the edit page builds no image URL for a members-only event"
  "the events tab links a members-only card to its page, and its lock says members only"
  "the events tab's Edit link names the placement of a members-only event only"
  "the members-only event page offers its Edit link to a manager only, with the placement"
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
  ok "11 vitest groups:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $GROUPS_BASELINE); ${#titles[@]} fixed titles each passed 1x"
else
  no "11 vitest groups: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $GROUPS_BASELINE); fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 12. The whole web suite: nothing fails, no fewer passed than the baseline, no more skipped.
aout=$(npx vitest run 2>&1)
aline=$(printf '%s\n' "$aout" | grep -E '^\s+Tests\s' | tail -1)
afiles=$(printf '%s\n' "$aout" | grep -E '^\s+Test Files\s' | tail -1)
ap=$(echo "$aline" | sed -nE 's/^\s+Tests\s+([0-9]+) passed.*/\1/p')
as=$(echo "$aline" | sed -nE 's/.* ([0-9]+) skipped.*/\1/p'); as=${as:-0}
at=$(echo "$aline" | sed -nE 's/.*\(([0-9]+)\)$/\1/p')
if [ -n "$ap" ] && [ -n "$at" ] && ! echo "$aline $afiles" | grep -q 'failed' && [ $((ap + as)) -eq "$at" ] \
   && [ "$ap" -gt $ALL_BASELINE ] && [ "$as" -le $ALL_SKIPPED ]; then
  ok "12 vitest web:$(echo "$aline" | sed 's/^ *Tests//'),$(echo "$afiles" | sed 's/^ *Test Files//') files (baseline $ALL_BASELINE passed, $ALL_SKIPPED skipped)"
else no "12 vitest web: '${aline:-no Tests line}' / '${afiles:-no Test Files line}' (want 0 failed, > $ALL_BASELINE passed, <= $ALL_SKIPPED skipped)"; fi

# 13. Type check, apps/web: 0 errors, warnings no worse than the base.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); wn=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$wn" ] && [ "$wn" -le $SC_WARN_BASELINE ] && ok "13 svelte-check apps/web: $e errors, $wn warnings (baseline 0, $SC_WARN_BASELINE)" \
  || no "13 svelte-check apps/web: '${sc:-no COMPLETED line}' (want 0 errors, <= $SC_WARN_BASELINE warnings)"

# 14. Type check, packages/ui (three of its components change): 0 errors, warnings no worse.
usc=$(cd "$WT/packages/ui" && npx svelte-kit sync >/dev/null 2>&1; npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
ue=$(echo "$usc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); uw=$(echo "$usc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$ue" ] && [ "$ue" -eq 0 ] && [ -n "$uw" ] && [ "$uw" -le $UI_SC_WARN_BASELINE ] && ok "14 svelte-check packages/ui: $ue errors, $uw warnings (baseline 0, $UI_SC_WARN_BASELINE)" \
  || no "14 svelte-check packages/ui: '${usc:-no COMPLETED line}' (want 0 errors, <= $UI_SC_WARN_BASELINE warnings)"

# 15. Formatting: prettier --check over every changed .ts/.mjs/.svelte file under apps/web, plus
#     the edit loader, the edit page and EventCard. EventView and EventEditor are left out: they
#     are not prettier-clean at the base, so formatting them would bury the change (checks 6-7 cap
#     their diffs).
mapfile -t pf < <( { printf '%s\n' "$changed" | grep -E '^apps/web/.*\.(ts|mjs|svelte)$' | sed 's#^apps/web/##'; \
  printf '%s\n' "$EDIT_LOADER" "$EDIT_PAGE" "../../$CARD"; } | grep . | sort -u)
# prettier prints its all-clean line even for a path that does not exist, so count the files first.
pe=0; for f in "${pf[@]}"; do [ -f "$f" ] && pe=$((pe+1)); done
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if [ "$pe" -eq ${#pf[@]} ] && [ "$pe" -ge 3 ] && printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!' \
   && ! printf '%s\n' "$pout" | grep -qiE 'no (files|matching)|error'; then
  ok "15 prettier clean on $pe existing file(s)"
else no "15 prettier: $pe of ${#pf[@]} file(s) exist (want all, >=3); $(printf '%s\n' "$pout" | grep -E '^\[(warn|error)\]' | tr '\n' ' ')"; fi

# 16. Hygiene over $BASE..HEAD: at least one commit changes apps/web; messages and added lines (this
#     script aside) carry no bead id, no Co-Authored-By, no openmeet name outside an NSID, and no
#     "private" (members-only, never private: FR-108) except two kinds of line: EventCard's
#     fallback for contrail's own spaces, `lockLabel ?? 'Private event'` (exactly once, and only in
#     EventCard), and a test asserting the words are absent (not.toContain). Every added line naming
#     an FR- or SC- id names it only in a trailing "(Spec: ...)".
cd "$WT"
nweb=$(git rev-list --count $BASE..HEAD -- apps/web)
msgs=$(git log --format=%B $BASE..HEAD)
added=$(git diff $BASE HEAD -- . ':!verify.sh' | grep -E '^\+' | grep -vE '^\+\+\+ ')
nadded=$(printf '%s' "$added" | grep -c .)
BEAD='\bom-[a-z0-9]{4,}(\.[0-9]+)*\b'
bm=$(printf '%s\n' "$msgs" | grep -cE "$BEAD"); ba=$(printf '%s\n' "$added" | grep -cE "$BEAD")
cm=$(printf '%s\n' "$msgs" | grep -ci 'co-authored-by'); ca=$(printf '%s\n' "$added" | grep -ci 'co-authored-by')
om=$(printf '%s\n%s\n' "$msgs" "$added" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]+//g' | grep -ci 'openmeet')
pm=$(printf '%s\n' "$msgs" | grep -ciE '\bprivate\b')
pa=$(printf '%s\n' "$added" | grep -iE '\bprivate\b' | grep -vF "lockLabel ?? 'Private event'" | grep -vE "not\.toContain\(['\"\`]Private event['\"\`]\)" | grep -c .)
pcard=$(added_to "$CARD" | grep -cF "lockLabel ?? 'Private event'")
pall=$(printf '%s\n' "$added" | grep -cF "lockLabel ?? 'Private event'")
specl=$(printf '%s\n' "$added" | grep -E '\b(FR|SC)-[0-9]+')
nspec=$(printf '%s' "$specl" | grep -c .)
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/|-->)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
if [ "$nweb" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$ba" -eq 0 ] && [ "$cm" -eq 0 ] && [ "$ca" -eq 0 ] && [ "$om" -eq 0 ] \
   && [ "$pm" -eq 0 ] && [ "$pa" -eq 0 ] && [ "$pcard" -eq 1 ] && [ "$pall" -eq 1 ] && [ "$offform" -eq 0 ]; then
  ok "16 $nweb commit(s) changing apps/web, $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By, 0 openmeet names, 0 'private' outside the EventCard fallback (1x, in EventCard) and absence asserts; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "16 $nweb commit(s) changing apps/web (want >=1); bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; openmeet names $om; 'private' $pm in messages, $pa in lines outside the exemptions; EventCard fallback ${pcard}x in EventCard, ${pall}x overall (want 1, 1); $offform of $nspec spec-id line(s) off the trailing form (want all others 0)"
  printf '%s\n' "$added" | grep -iE "$BEAD|co-authored-by|\bprivate\b" | head -5
fi

# 17. The e2e script's header counts the new check: 49 numbered checks, 13b to 13s, and a clean run
#     ending SUMMARY: 49 passed, 0 failed (48 and 13r at the base).
cd "$WEB"
h1=$(grep -cF 'It runs 49 numbered checks' "$E2E"); h2=$(grep -cF '13b to 13s' "$E2E")
h3=$(grep -cF 'SUMMARY: 49 passed, 0 failed' "$E2E")
[ "$h1" -eq 1 ] && [ "$h2" -eq 1 ] && [ "$h3" -eq 1 ] && ok "17 $E2E header: 49 numbered checks ${h1}x, 13b to 13s ${h2}x, SUMMARY: 49 passed ${h3}x" \
  || no "17 $E2E header: '49 numbered checks' ${h1}x, '13b to 13s' ${h2}x, 'SUMMARY: 49 passed, 0 failed' ${h3}x (want 1 each)"

# 18. The groups e2e on atproto-devnet. Baseline at the base: 48 passed, 0 failed. After this
#     change: 49 passed, 0 failed; the new check 13s passes once under its exact label; 13r (one
#     event by its key), 13q (a member's slice drops the image) and 13j (an edit stays in the space)
#     still pass once each; no FAIL line; and no WARN line names a members-only event or the calendar.
L13S="a manager.s edit read of a members-only event keeps its image, and saving it back keeps the image in the space with no field added"
L13R="one members-only event is read by its rkey for a member, image kept, and a non-member and an anonymous caller send no read"
L13Q="a members-only event reaches a member.s slice without its image, and the stored record keeps it"
L13J="a members-only event edit stays in the calendar space, and the public repo still misses it"
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
if [ "${SKIP_E2E:-0}" = 1 ]; then no "18 e2e skipped (SKIP_E2E=1)"
elif [ ! -s "$CRED" ]; then no "18 no fixture credentials file at $CRED"
else
  hh=$(curl -s -m 5 http://localhost:3010/xrpc/_health)
  if ! echo "$hh" | grep -q '"version"'; then no "18 devnet alpha PDS not answering on :3010 ($hh)"; else
    log=$(mktemp -t groups-e2e.XXXXXX)
    E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
    E2E_CREDENTIALS="$CRED" \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
      timeout 900 node "$E2E" >"$log" 2>&1
    sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$log" | tail -1)
    p=$(echo "$sum" | sed -nE 's/^SUMMARY: ([0-9]+) passed.*/\1/p'); f=$(echo "$sum" | sed -nE 's/.* ([0-9]+) failed$/\1/p')
    cs=$(grep -cE "^PASS +${L13S}(: |$)" "$log"); cr=$(grep -cE "^PASS +${L13R}(: |$)" "$log")
    cq=$(grep -cE "^PASS +${L13Q}(: |$)" "$log"); cj=$(grep -cE "^PASS +${L13J}(: |$)" "$log")
    nfail=$(grep -cE '^FAIL ' "$log")
    warn=$(grep -E '^WARN ' "$log" | grep -ciE 'members-only|calendar')
    if [ -n "$sum" ] && [ "$p" -eq $((E2E_BASE_PASSED + 1)) ] && [ "$f" -eq 0 ] && [ "$cs" -eq 1 ] && [ "$cr" -eq 1 ] \
       && [ "$cq" -eq 1 ] && [ "$cj" -eq 1 ] && [ "$nfail" -eq 0 ] && [ "$warn" -eq 0 ]; then
      ok "18 devnet e2e $sum (base $E2E_BASE_PASSED + 1); 13s, 13r, 13q, 13j PASS 1x each; 0 FAIL lines; 0 members-only WARN lines"
    else
      no "18 devnet e2e '${sum:-no SUMMARY}' (want $((E2E_BASE_PASSED + 1)) passed, 0 failed); 13s/13r/13q/13j PASS $cs/$cr/$cq/$cj (want 1 each); FAIL lines $nfail (want 0); members-only WARN lines $warn (want 0) (log $log)"
      grep -E '^(FAIL|WARN|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

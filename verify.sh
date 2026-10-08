#!/usr/bin/env bash
# verify.sh for members-only RSVPs: a member's RSVP to a members-only event is a standard
# community.lexicon.calendar.rsvp, written by the member from their own session into the group's
# calendar space, never into their public repo, with no fallback.
#  - The member grant gains the RSVP collection and read_self, so the member's session can write
#    the RSVP and read it back. A session without the grant is sent to re-authorize once; after a
#    re-authorization that asked for it, a session still without it gets a plain message that their
#    PDS can't RSVP to members-only events yet, and nothing is written. An invalid_scope refusal
#    says to try again shortly instead, and nothing loops.
#  - The RSVP's key is the event's key, its space is the group's calendar space and its subject is
#    the event's space-form URI, all chosen by the server, never by the browser.
#  - The page reads the viewer's own RSVP back through their session, after the event read.
#  - EventView opens no share prompt for a members-only RSVP; a public event's RSVP still opens it.
# Decisions (TS, 2026-10-08): the member's own session reads the RSVP back (read_self); the gate is
# this script with the devnet groups e2e, and the browser walk stays with the loopback-grants bead;
# the RSVP's key is the event's key. Amended 2026-10-08 after the first fire stopped on a
# contradiction: the grant keeps its name (check 1). Amended again for the fix-up round after the
# review: six more fixed titles (check 8), suite floors at run 1's counts, and e2e check 13v (53).
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Checks 14 and 15 need devnet-spaces up
# (SKIP_DEVNET=1 skips them and counts each as a FAIL).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them.
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-mrimm13}
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=9255b29
GRANTS=$LIB/server/member-grants.ts
GRANTS_TEST=$LIB/server/member-grants.test.ts
RSVP=$LIB/server/member-rsvp.ts
RSVP_TEST=$LIB/server/member-rsvp.test.ts
ACC_TEST=$LIB/server/acceptance.test.ts
REMOTE=$LIB/groups.remote.ts
REMOTE_TEST=$LIB/groups.remote.test.ts
ADAPTER=$LIB/event-page-adapter.ts
ADAPTER_TEST=$LIB/event-page-adapter.test.ts
ROUTE='src/routes/(app)/groups/[actor]/events/[rkey]'
LOADER="$ROUTE/+page.server.ts"
PAGE="$ROUTE/+page.svelte"
LOADER_TEST="$ROUTE/page.server.test.ts"
PAGE_TEST="$ROUTE/page.test.ts"
VIEW=packages/ui/src/EventView.svelte
E2E=scripts/groups-e2e.mjs
E2E_WORKER=scripts/groups-e2e.worker.ts
LOCK=/tmp/groups-e2e-devnet.lock
NOSPACES=did:plc:kfb7njkg4t7azuy7v5gxkjc2   # e2enospaces.regular.devnet.test on :3020 (seeded 10-07)
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
E2E_BASE_PASSED=50       # devnet e2e at 9255b29: 50 numbered checks (the script's header)
GROUPS_BASELINE=782      # vitest src/lib/groups + groups routes at 43f48b6 (run 1): 782 passed (782), 52 files; 766 at 9255b29
ALL_BASELINE=1197        # whole web suite at 43f48b6 (run 1): 1197 passed | 4 skipped (1201); 1181 at 9255b29
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check apps/web at 9255b29: 0 errors, 7 warnings
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }

# 0. Built on the contract's base (the groups branch after the members-only event page).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /* and * lines. Empty for a missing file.
code_lines() { [ -f "$1" ] && grep -nvE '^[[:space:]]*(//|/\*|\*)' "$1"; }
# The body of a top-level `export async function NAME(`, as numbered code lines.
fn_body() { [ -f "$1" ] && awk -v n="$2" '$0 ~ "^export async function " n "[(<]" {on=1} on {print NR": "$0} on && /^}/ {exit}' "$1" \
  | grep -vE '^[0-9]+: [[:space:]]*(//|/\*|\*)'; }
# First line number in the given numbered lines matching a regex, or empty.
first() { printf '%s\n' "$1" | grep -E "$2" | head -1 | cut -d: -f1; }
# Count of lines matching a regex in a string.
cnt() { printf '%s\n' "$1" | grep -cE "$2"; }

# 1. The member grant keeps its name, acceptanceGrant (amendment 2026-10-08: a rename would touch
#    two frozen test files, one of them an OAuth route's), and widens: its code names the RSVP
#    collection and read_self; holdsRsvpGrant is exported. (Spec: FR-113.)
gl=$(code_lines "$GRANTS")
mg=$(cnt "$gl" '^[0-9]+:export function acceptanceGrant\(')
hr=$(cnt "$gl" '^[0-9]+:export function holdsRsvpGrant\(')
rc=$(cnt "$gl" 'community\.lexicon\.calendar\.rsvp')
rs=$(cnt "$gl" 'read_self')
[ "$mg" -eq 1 ] && [ "$hr" -eq 1 ] && [ "$rc" -ge 1 ] && [ "$rs" -ge 1 ] \
  && ok "1 $GRANTS: acceptanceGrant ${mg}x, holdsRsvpGrant ${hr}x, RSVP collection ${rc}x, read_self ${rs}x" \
  || no "1 $GRANTS: acceptanceGrant ${mg}x, holdsRsvpGrant ${hr}x (want 1 each), RSVP collection ${rc}x, read_self ${rs}x (want >=1 each)"

# 2. No public fallback anywhere on the members-only RSVP path: member-rsvp.ts, the page's adapter
#    and the loader name no com.atproto.repo. method; member-rsvp.ts names the three space methods;
#    the adapter imports nothing from $lib/spaces (contrail's pair) and keeps its three public
#    refusals. (Spec: FR-113, FR-116.)
rl=$(code_lines "$RSVP"); al=$(code_lines "$ADAPTER"); ll=$(code_lines "$LOADER")
repo=$(printf '%s\n%s\n%s\n' "$rl" "$al" "$ll" | grep -cE 'com\.atproto\.repo\.')
sp=$(cnt "$rl" "'com\.atproto\.space\.putRecord'"); sd=$(cnt "$rl" "'com\.atproto\.space\.deleteRecord'")
sg=$(cnt "$rl" "'com\.atproto\.space\.getRecord'")
ai=$(cnt "$al" "from '\\\$lib/spaces")
rf=$(cnt "$al" '^[0-9]+:[[:space:]]+(putRecord|createRecord|deleteRecord): refuse,')
[ "$(printf '%s' "$rl" | grep -c .)" -ge 10 ] && [ "$repo" -eq 0 ] && [ "$sp" -ge 1 ] && [ "$sd" -ge 1 ] && [ "$sg" -ge 1 ] && [ "$ai" -eq 0 ] && [ "$rf" -eq 3 ] \
  && ok "2 RSVP path: com.atproto.repo. 0x; space putRecord ${sp}x, deleteRecord ${sd}x, getRecord ${sg}x in $RSVP; adapter \$lib/spaces imports 0, public refusals ${rf}" \
  || no "2 RSVP path: $RSVP $(printf '%s' "$rl" | grep -c .) code lines (want >=10); com.atproto.repo. ${repo}x (want 0); space put/delete/get ${sp}/${sd}/${sg} (want >=1 each); adapter \$lib/spaces imports ${ai} (want 0), public refusals ${rf} (want 3)"

# 3. The roster gate comes first: in each of putMembersOnlyRsvp, deleteMembersOnlyRsvp and
#    readOwnMembersOnlyRsvp, the first canSeeMembers( is above the first await and the first
#    .handle( or send( call. (Spec: FR-113, FR-117.)
gate3=""; bad3=0
for f in putMembersOnlyRsvp deleteMembersOnlyRsvp readOwnMembersOnlyRsvp; do
  b=$(fn_body "$RSVP" $f)
  cs=$(first "$b" 'canSeeMembers\('); aw=$(first "$b" '\bawait\b'); hd=$(first "$b" '(\.handle|\bsend)\(')
  if [ -n "$cs" ] && [ -n "$aw" ] && [ -n "$hd" ] && [ "$cs" -lt "$aw" ] && [ "$cs" -lt "$hd" ]; then gate3="$gate3 $f(gate $cs < await $aw, call $hd)"
  else gate3="$gate3 $f(gate ${cs:-none}, await ${aw:-none}, call ${hd:-none})"; bad3=$((bad3+1)); fi
done
[ "$bad3" -eq 0 ] && ok "3 gate first:$gate3" || no "3 gate first in $bad3 of 3 functions:$gate3"

# 4. The loader: groupRouteContext, then the canSeeMembers gate, then the event read, then the
#    viewer's own RSVP read (readOwnMembersOnlyRsvp); it marks the event members-only; and the
#    literal "viewerRsvpStatus: null" is gone. (Spec: FR-117.)
g=$(first "$ll" 'groupRouteContext\('); c=$(first "$ll" 'canSeeMembers\(')
r=$(first "$ll" 'readMembersOnlyEvent\('); o=$(first "$ll" 'readOwnMembersOnlyRsvp\(')
mo=$(cnt "$ll" '\bmembersOnly: true\b'); vn=$(cnt "$ll" 'viewerRsvpStatus: null')
if [ -n "$g" ] && [ -n "$c" ] && [ -n "$r" ] && [ -n "$o" ] && [ "$g" -lt "$c" ] && [ "$c" -lt "$r" ] && [ "$r" -lt "$o" ] \
   && [ "$mo" -eq 1 ] && [ "$vn" -eq 0 ]; then
  ok "4 $LOADER: groupRouteContext :$g < canSeeMembers :$c < readMembersOnlyEvent :$r < readOwnMembersOnlyRsvp :$o; membersOnly: true ${mo}x; 'viewerRsvpStatus: null' ${vn}x"
else no "4 $LOADER: groupRouteContext :${g:-none}, canSeeMembers :${c:-none}, readMembersOnlyEvent :${r:-none}, readOwnMembersOnlyRsvp :${o:-none} (want in that order); membersOnly: true ${mo}x (want 1); 'viewerRsvpStatus: null' ${vn}x (want 0)"; fi

# 5. EventView: added lines name data.membersOnly; the RSVP share prompt is still there for
#    everything else ("You're going!" once); the diff is 1 to 4 changed lines.
cd "$WT"
va=$(git diff $BASE -- "$VIEW" | grep -E '^\+' | grep -vE '^\+\+\+ ' | grep -c 'data\.membersOnly')
vg=$(grep -cF "shareModalTitle = \"You're going!\";" "$VIEW")
vn=$(git diff --numstat $BASE -- "$VIEW" | awk '{s+=$1+$2} END {print s+0}')
[ "$va" -ge 1 ] && [ "$vg" -eq 1 ] && [ "$vn" -ge 1 ] && [ "$vn" -le 4 ] \
  && ok "5 $VIEW: data.membersOnly in $va added line(s), RSVP share title ${vg}x, $vn changed lines" \
  || no "5 $VIEW: data.membersOnly in $va added lines (want >=1), RSVP share title ${vg}x (want 1), $vn changed lines (want 1-4)"

# 6. Unchanged against the base: the rest of the shared UI package, the in-app editor adapter and
#    every contrail space module, the calendar read, the writer, the about read, the route context,
#    access, permissions, types, space URIs, spaces, credentials, the acceptance module, the OAuth
#    routes (callback and client metadata), the edit route, every public event route, embeds,
#    lexicon types, migrations, the client auth helper, and the e2e OAuth stand-in, resolver,
#    network guard and environment.
cd "$WEB"
keep=(../../packages/ui/src/EventRsvp.svelte ../../packages/ui/src/EventCard.svelte ../../packages/ui/src/ShareModal.svelte
      ../../packages/ui/src/contrail.ts ../../packages/ui/src/EventEditor.svelte ../../packages/ui/src/event-view
      ../../packages/ui/src/editor src/lib/components/editor/adapter.ts src/lib/spaces
      $LIB/server/calendar-read.ts $LIB/server/event-writer.ts $LIB/server/about-read.ts $LIB/server/route-context.ts
      $LIB/access.ts $LIB/permissions.ts $LIB/types.ts $LIB/server/space-uris.ts $LIB/server/spaces.ts
      $LIB/server/credentials.ts $LIB/server/acceptance.ts src/lib/atproto/auth.svelte.ts
      'src/routes/(oauth)' "$ROUTE/edit" 'src/routes/(app)/p' src/routes/embed src/lexicon-types migrations
      scripts/groups-e2e.oauth.ts scripts/groups-e2e.identity-resolver.ts scripts/groups-e2e.network.mjs
      scripts/groups-e2e.app-environment.js)
present=0; missing=""
for p in "${keep[@]}"; do if [ -n "$(git ls-files -- "$p" | head -1)" ]; then present=$((present+1)); else missing="$missing $p"; fi; done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "6 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "6 $present of ${#keep[@]} frozen paths present (missing:${missing:- none}); numstat vs $BASE totals $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 7. The touch-set: every file this branch changed or added under apps/web and packages is in the
#    allowed set, and the ones that carry the change are among them.
cd "$WT"
allowed=$(printf 'apps/web/%s\n' "$GRANTS" "$GRANTS_TEST" "$RSVP" "$RSVP_TEST" "$ACC_TEST" "$REMOTE" "$REMOTE_TEST" \
  "$ADAPTER" "$ADAPTER_TEST" "$LOADER" "$PAGE" "$LOADER_TEST" "$PAGE_TEST" "$E2E" "$E2E_WORKER" | { cat; echo "$VIEW"; } | LC_ALL=C sort)
must=$(printf 'apps/web/%s\n' "$GRANTS" "$RSVP" "$RSVP_TEST" "$REMOTE" "$ADAPTER" "$LOADER" "$PAGE" "$LOADER_TEST" "$PAGE_TEST" \
  "$E2E" "$E2E_WORKER" | { cat; echo "$VIEW"; } | LC_ALL=C sort)
changed=$( { git diff --name-only $BASE -- apps/web packages ; git ls-files --others --exclude-standard -- apps/web packages ; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
lacking=$(comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$must"))
[ -n "$changed" ] && [ -z "$outside" ] && [ -z "$lacking" ] \
  && ok "7 changed under apps/web and packages: $(printf '%s\n' "$changed" | grep -c .) file(s), all in the allowed set, all $(printf '%s\n' "$must" | grep -c .) required present" \
  || no "7 changed: [$(echo "$changed" | tr '\n' ' ')]; outside the allowed set: [$(echo "$outside" | tr '\n' ' ')]; required but unchanged: [$(echo "$lacking" | tr '\n' ' ')]"

# 8. The groups suites: more than the 766 baseline, all passing, every file passing; each fixed
#    title passes exactly once.
cd "$WEB"
titles=(
  "the member grant lets a member write and read back their own RSVP in the group's spaces"
  "an RSVP grant is read by parameter, and an acceptance-only grant is not one"
  "a members-only RSVP is written from the member's session into the calendar space at the event's key"
  "a members-only RSVP names the event's space-form URI, whatever the browser sent"
  "a members-only RSVP cancel deletes that record, and no call names com.atproto.repo"
  "a caller off the roster sends no RSVP request"
  "a member whose session lacks the RSVP grant is sent to re-authorize"
  "after a re-authorization that asked for it, a session still without the grant gets the no-spaces message and sends nothing"
  "a re-authorization refused as invalid_scope says to try again shortly, never the no-spaces message"
  "a refused space write is reported, and nothing retries it as a public record"
  "the event page reads the viewer's own RSVP through their session, after the event read"
  "the event page reads no RSVP for a session without the read grant"
  "the members-only event page's adapter writes an RSVP only through the members-only RSVP command"
  "the members-only event page's adapter refuses a space write that is not an RSVP to its event"
  "a members-only RSVP opens no share prompt, and a public event's RSVP still does"
  # The fix-up round (2026-10-08, after the adversarial review).
  "the asked marker leaves the address after a successful RSVP or cancel"
  "an asked marker naming another member, or the session it was issued under, re-authorizes instead of the no-spaces message"
  "an asked marker with no member session says to try again, never the no-spaces message"
  "a members-only RSVP names the event's current cid, read as the group before the write"
  "an RSVP from a page showing an older version of the event, or none, writes nothing and says to reload"
  "an RSVP to a key the calendar space holds no event at writes nothing"
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

# 9. The whole web suite: nothing fails, no fewer passed than the 1181 baseline, no more skipped than 4.
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
#     the new module, its test and the loader. EventView is left out: it is upstream's file and is
#     not prettier-clean at the base, so formatting it would bury the change (check 5 caps its diff).
mapfile -t pf < <( { printf '%s\n' "$changed" | grep -E '^apps/web/.*\.(ts|mjs|svelte)$' | sed 's#^apps/web/##'; printf '%s\n' "$RSVP" "$RSVP_TEST" "$LOADER"; } | grep . | sort -u)
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

# 13. The e2e script's header counts the three new checks: 53 numbered checks, 13b to 13v, and a
#     clean run ending SUMMARY: 53 passed, 0 failed (50 and 13s at the base; 13v from the fix-up).
cd "$WEB"
h1=$(grep -cF 'It runs 53 numbered checks' "$E2E"); h2=$(grep -cF '13b to 13v' "$E2E")
h3=$(grep -cF 'SUMMARY: 53 passed, 0 failed' "$E2E")
[ "$h1" -eq 1 ] && [ "$h2" -eq 1 ] && [ "$h3" -eq 1 ] && ok "13 $E2E header: 53 numbered checks ${h1}x, 13b to 13v ${h2}x, SUMMARY: 53 passed ${h3}x" \
  || no "13 $E2E header: '53 numbered checks' ${h1}x, '13b to 13v' ${h2}x, 'SUMMARY: 53 passed, 0 failed' ${h3}x (want 1 each)"

# 14. devnet-spaces is the one the fixtures live on: the alpha PDS answers on :3010, the stock PDS
#     on :3020, the no-spaces member is hosted on :3020 per devnet PLC, and the credentials file is
#     there. A devnet reset changes these DIDs, and then this gate no longer describes the devnet.
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "14 devnet checks skipped (SKIP_DEVNET=1)"; else
  h10=$(curl -s -m 5 http://localhost:3010/xrpc/_health | grep -c '"version"')
  h20=$(curl -s -m 5 http://localhost:3020/xrpc/_health | grep -c '"version"')
  pd=$(curl -s -m 5 http://localhost:2592/$NOSPACES | grep -c '"http://localhost:3020"')
  cr=0; [ -s "$CRED" ] && cr=1
  [ "$h10" -eq 1 ] && [ "$h20" -eq 1 ] && [ "$pd" -eq 1 ] && [ "$cr" -eq 1 ] \
    && ok "14 devnet :3010 and :3020 answer; $NOSPACES is hosted at http://localhost:3020 per devnet PLC; credentials file present" \
    || no "14 :3010 health ${h10}x, :3020 health ${h20}x, $NOSPACES on :3020 ${pd}x, credentials file ${cr}x (want 1 each)"
fi

# 15. The live devnet e2e, serialized with every other run: 53 passed, 0 failed; 13t, 13u and 13v
#     pass once each under their exact labels; 13r (the event page's read) and 18e (the no-spaces
#     member) still pass; nothing left the machine; no FAIL, REFUSED or WARN line.
L13V="a members-only RSVP names the event's current cid as the group reads it, and one sent from a page showing an older version writes nothing"
L13T="a member's RSVP to a members-only event is written into the calendar space at the event's key from their own session, reads back for them and for the group, and a cancel removes it, with no repo call"
L13U="a caller off the roster and a member whose PDS serves no spaces send no RSVP request, and only the member asked before gets the no-spaces message"
L13R="one members-only event is read by its rkey for a member, image kept, and a non-member and an anonymous caller send no read"
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "15 e2e skipped (SKIP_DEVNET=1)"; else
  T=$(mktemp -d -t e2e-devnet.XXXXXX)
  env E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test E2E_CREDENTIALS=$CRED \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=$NOSPACES \
    flock -w 1800 $LOCK timeout 900 node "$E2E" >"$T/e2e.log" 2>&1
  sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$T/e2e.log" | tail -1)
  p=$(echo "$sum" | sed -nE 's/^SUMMARY: ([0-9]+) passed.*/\1/p'); f=$(echo "$sum" | sed -nE 's/.* ([0-9]+) failed$/\1/p')
  qt=$(grep -cE "^PASS +${L13T}(: |$)" "$T/e2e.log"); qu=$(grep -cE "^PASS +${L13U}(: |$)" "$T/e2e.log")
  qv=$(grep -cE "^PASS +${L13V}(: |$)" "$T/e2e.log")
  qr=$(grep -cE "^PASS +${L13R}(: |$)" "$T/e2e.log")
  e18=$(grep -cF "their PDS http://localhost:3020 answers the group's space read 400 InvalidToken" "$T/e2e.log")
  netl=$(grep -cE '^PASS +no request left this machine: public 0; ' "$T/e2e.log")
  nf=$(grep -cE '^FAIL ' "$T/e2e.log"); nr=$(grep -cE '^REFUSED ' "$T/e2e.log"); nw=$(grep -cE '^WARN ' "$T/e2e.log")
  if [ -n "$sum" ] && [ "$p" -eq $((E2E_BASE_PASSED + 3)) ] && [ "$f" -eq 0 ] && [ "$qt" -eq 1 ] && [ "$qu" -eq 1 ] && [ "$qv" -eq 1 ] && [ "$qr" -eq 1 ] \
     && [ "$e18" -eq 1 ] && [ "$netl" -eq 1 ] && [ "$nf" -eq 0 ] && [ "$nr" -eq 0 ] && [ "$nw" -eq 0 ]; then
    ok "15 devnet e2e $sum (base $E2E_BASE_PASSED + 3); 13t, 13u, 13v, 13r PASS 1x each; 18e on :3020; nothing left the machine; 0 FAIL, 0 REFUSED, 0 WARN"
  else
    no "15 devnet e2e '${sum:-no SUMMARY}' (want $((E2E_BASE_PASSED + 3)) passed, 0 failed); 13t/13u/13v/13r PASS $qt/$qu/$qv/$qr (want 1 each); 18e ${e18}x, network line ${netl}x (want 1 each); FAIL $nf, REFUSED $nr, WARN $nw (want 0 each) (log $T/e2e.log)"
    grep -E '^(FAIL|REFUSED|WARN|SUMMARY)' "$T/e2e.log" | cut -c1-200
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

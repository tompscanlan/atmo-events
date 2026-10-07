#!/usr/bin/env bash
# verify.sh for the members-only choice in the group event form (unit B):
#  - the group's new-event page asks "Who can see this event: Everyone / Members only" and hands the
#    shared editor an adapter whose placement is null (Everyone) or the group's calendar space
#    (Members only), computed by the page's loader from the group's DID;
#  - the edit page shows who can see the event, read-only;
#  - a members-only event offers no recurring copies (the adapter's features.recurring);
#  - a refusal from the group's commands reaches the page as its own message, beside the control.
# The image upload, the writer, the remote commands and packages/ui are unchanged. No devnet e2e:
# this change adds no write path and leaves every module the e2e reaches byte-identical (check 1).
# Decisions (TS, 2026-10-06): refusals surfaced on the page; nothing preselected; the editor's own
# Public/Unlisted switch left as it is; the events tab untouched; the drafted copy. The new-event
# page builds its adapter with $derived from the current choice, so a save sends the choice shown
# at that moment (check 6). Frozen at fire. Run from anywhere; it cds into the worktree. Every check
# prints a positive artifact line and the last line is the tally.
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them.
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-mrimm26}
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=4def656
NP='src/routes/(app)/groups/[actor]/events/new'
EP='src/routes/(app)/groups/[actor]/events/[rkey]/edit'
ADAPTER=$LIB/editor-adapter.ts
PLACE=$LIB/event-placement.ts
GROUPS_BASELINE=722      # vitest src/lib/groups + groups routes at 4def656: 722 passed (722), 42 files
ALL_BASELINE=1119        # whole web suite at 4def656: 1119 passed | 4 skipped (1123), 88 + 1 skipped files
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check at 4def656: 0 errors, 7 warnings
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }

# 0. Built on the contract's base (the read-side guards' head, itself on unit A).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /* and * lines.
code_lines() { [ -f "$1" ] && grep -nvE '^[[:space:]]*(//|/\*|\*)' "$1"; }
# Lines this branch added to a path (diff vs BASE, untracked files included), without headers.
added_to() {
  { git diff $BASE -- "$@"; git ls-files --others --exclude-standard -- "$@" | while read -r f; do sed 's/^/+/' "$f"; done; } \
    | grep -E '^\+' | grep -vE '^\+\+\+ '
}
cnt() { if [ -f "$2" ]; then grep -cE "$1" "$2"; else echo 0; fi; }

# 1. Unchanged against the base: the shared UI package, every server module under src/lib/groups
#    (the writer, the readers, the space URIs), the remote commands and their tests, the form error
#    mapping, the in-app editor adapter, the events tab, the edit loader (the members-only edit
#    loader is a later change), every public event route, the lexicons, the migrations and the e2e
#    harness. This is also what makes the devnet e2e result at the base still hold.
keep=(../../packages/ui $LIB/server $LIB/groups.remote.ts $LIB/groups.remote.test.ts $LIB/form-error.ts
      $LIB/form-result.ts $LIB/types.ts $LIB/access.ts $LIB/permissions.ts src/lib/components/editor
      'src/routes/(app)/groups/[actor]/events/+page.svelte'
      'src/routes/(app)/groups/[actor]/events/+page.server.ts'
      'src/routes/(app)/groups/[actor]/events/page.server.test.ts'
      "$EP/+page.server.ts" 'src/routes/(app)/p' src/routes/embed src/lexicon-types migrations scripts)
present=0; for p in "${keep[@]}"; do [ -n "$(git ls-files -- "$p" | head -1)" ] && present=$((present+1)); done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
unt=$(git ls-files --others --exclude-standard -- "${keep[@]}" | grep -c .)
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && [ "$unt" -eq 0 ] \
  && ok "1 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines; $unt new files under them" \
  || { no "1 $present of ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines, $unt new files (want ${#keep[@]}, 0, 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 2. The touch-set: every file changed or added anywhere in the repo (this script aside) is one of the
#    ten below, and the seven that carry the change are among them.
allowed=(apps/web/$PLACE apps/web/$LIB/event-placement.test.ts apps/web/$ADAPTER apps/web/$LIB/editor-adapter.test.ts
         "apps/web/$NP/+page.svelte" "apps/web/$NP/+page.server.ts" "apps/web/$NP/page.server.test.ts" "apps/web/$NP/page.test.ts"
         "apps/web/$EP/+page.svelte" "apps/web/$EP/page.test.ts")
required=(apps/web/$PLACE apps/web/$LIB/event-placement.test.ts apps/web/$ADAPTER apps/web/$LIB/editor-adapter.test.ts
          "apps/web/$NP/+page.svelte" "apps/web/$NP/+page.server.ts" "apps/web/$EP/+page.svelte")
changed=$(cd "$WT" && { git diff --name-only $BASE -- . ':!verify.sh'; git ls-files --others --exclude-standard -- . ':!verify.sh'; } | grep . | LC_ALL=C sort -u)
outside=$(LC_ALL=C comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "${allowed[@]}" | LC_ALL=C sort))
missing=$(LC_ALL=C comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "${required[@]}" | LC_ALL=C sort))
[ -n "$changed" ] && [ -z "$outside" ] && [ -z "$missing" ] \
  && ok "2 changed: $(printf '%s\n' "$changed" | grep -c .) file(s), all in the touch-set, the ${#required[@]} required ones among them" \
  || no "2 changed: $(printf '%s\n' "$changed" | grep -c .) file(s); outside the touch-set: [$(echo "$outside" | tr '\n' ' ')]; required but unchanged: [$(echo "$missing" | tr '\n' ' ')]"

# 3. The choice lives in one pure module: event-placement.ts exists, exports something, and imports
#    nothing from SvelteKit, the server modules, the remote commands, Svelte or the shared UI package,
#    so its test runs with no stubs.
if [ -f "$PLACE" ]; then
  ne=$(grep -cE '^export ' "$PLACE"); bad=$(grep -E '^\s*import ' "$PLACE" | grep -cE "\\\$app|/server/|\.remote|@atmo-dev|from 'svelte")
  [ "$ne" -ge 1 ] && [ "$bad" -eq 0 ] && ok "3 $PLACE: $ne export line(s), $bad import(s) from \$app, server, remote, svelte or the UI package" \
    || no "3 $PLACE: $ne export line(s) (want >=1), $bad forbidden import(s) (want 0)"
else no "3 $PLACE does not exist"; fi

# 4. The adapter: recurring copies only for a public event (recurring: space === null, exactly once),
#    the stale comment gone, placement still required (space?: 0x, space: string | null >= 1, as unit A
#    left it), and a refusal handed to the page through a required onRefusal option (>= 2 mentions:
#    the option and its use).
rc=$(code_lines "$ADAPTER" | grep -cE 'recurring:[[:space:]]*space[[:space:]]*===[[:space:]]*null')
stale=$(cnt 'need a space of their own' "$ADAPTER")
opt=$(cnt '\bspace\?:' "$ADAPTER"); req=$(cnt '\bspace: string \| null' "$ADAPTER")
orf=$(code_lines "$ADAPTER" | grep -cE '\bonRefusal\b'); orq=$(cnt '\bonRefusal\?:' "$ADAPTER")
[ "$rc" -eq 1 ] && [ "$stale" -eq 0 ] && [ "$opt" -eq 0 ] && [ "$req" -ge 1 ] && [ "$orf" -ge 2 ] && [ "$orq" -eq 0 ] \
  && ok "4 $ADAPTER: recurring: space === null ${rc}x, stale comment ${stale}x, space?: ${opt}x, space: string | null ${req}x, onRefusal ${orf} code line(s), optional ${orq}x" \
  || no "4 $ADAPTER: recurring: space === null ${rc}x (want 1), stale comment ${stale}x (want 0), space?: ${opt}x (want 0), space: string | null ${req}x (want >=1), onRefusal ${orf} code line(s) (want >=2), onRefusal?: ${orq}x (want 0)"

# 5. The new-event loader computes the calendar space from the group's DID and makes no new call:
#    it names groupSpaceUris( and calendarSpaceUri, and still has exactly one await (groupEditorPage).
L="$NP/+page.server.ts"
gs=$(code_lines "$L" | grep -cE 'groupSpaceUris\('); cu=$(code_lines "$L" | grep -cE '\bcalendarSpaceUri\b')
aw=$(code_lines "$L" | grep -cE '\bawait\b')
[ "$gs" -ge 1 ] && [ "$cu" -ge 1 ] && [ "$aw" -eq 1 ] && ok "5 $L: groupSpaceUris( ${gs}x, calendarSpaceUri ${cu}x, await ${aw}x" \
  || no "5 $L: groupSpaceUris( ${gs}x (want >=1), calendarSpaceUri ${cu}x (want >=1), await ${aw}x (want 1)"

# 6. The new-event page: no hard-coded public placement left (space: null 0x), it uses the placement
#    module and the loader's calendarSpaceUri, passes onRefusal, has a role="alert" for the refusal,
#    and renders the one <EventEditor only inside an {#if} opened within the 3 lines above it, so the
#    editor appears after a choice is made (nothing preselected). Its one createGroupEditorAdapter(
#    call sits inside a $derived( opened on the same line or the 2 above, so the adapter follows the
#    choice shown and is never built once, before a choice exists.
P="$NP/+page.svelte"
sn=$(cnt 'space:[[:space:]]*null' "$P"); im=$(cnt 'event-placement' "$P"); pc=$(cnt '\bcalendarSpaceUri\b' "$P")
po=$(cnt '\bonRefusal\b' "$P"); al=$(cnt 'role="alert"' "$P"); ee=$(cnt '<EventEditor' "$P")
el=$(grep -nE '<EventEditor' "$P" 2>/dev/null | head -1 | cut -d: -f1); gi=0
[ -n "$el" ] && gi=$(awk -v e="$el" 'NR>=e-3 && NR<e' "$P" | grep -cE '\{#if ')
ca=$(cnt 'createGroupEditorAdapter\(' "$P"); cl=$(grep -nE 'createGroupEditorAdapter\(' "$P" 2>/dev/null | head -1 | cut -d: -f1); dv=0
[ -n "$cl" ] && dv=$(awk -v e="$cl" 'NR>=e-2 && NR<=e' "$P" | grep -cE '\$derived(\.by)?\(')
[ "$sn" -eq 0 ] && [ "$im" -ge 1 ] && [ "$pc" -ge 1 ] && [ "$po" -ge 1 ] && [ "$al" -ge 1 ] && [ "$ee" -eq 1 ] && [ "$gi" -ge 1 ] \
   && [ "$ca" -eq 1 ] && [ "$dv" -ge 1 ] \
  && ok "6 $P: space: null ${sn}x, placement module ${im}x, calendarSpaceUri ${pc}x, onRefusal ${po}x, role=alert ${al}x, <EventEditor ${ee}x at line $el under an {#if}, createGroupEditorAdapter( ${ca}x at line $cl inside a \$derived(" \
  || no "6 $P: space: null ${sn}x (want 0), placement module ${im}x, calendarSpaceUri ${pc}x, onRefusal ${po}x, role=alert ${al}x (want >=1 each), <EventEditor ${ee}x (want 1), {#if} within 3 lines above it ${gi}x (want >=1), createGroupEditorAdapter( ${ca}x (want 1), \$derived( within 2 lines above it ${dv}x (want >=1)"

# 7. The edit page: shows placement from the placement module, offers no control to change it (no
#    input, select, radio, toggle or button), cannot name the calendar space (its loader reads only
#    public events until the members-only edit loader lands), passes onRefusal and has a role="alert".
E="$EP/+page.svelte"
ei=$(cnt 'event-placement' "$E"); ec=$(cnt '<input|<select|type="radio"|ToggleGroup|<button|<Button' "$E")
es=$(cnt '\bcalendarSpaceUri\b' "$E"); eo=$(cnt '\bonRefusal\b' "$E"); ea=$(cnt 'role="alert"' "$E")
[ "$ei" -ge 1 ] && [ "$ec" -eq 0 ] && [ "$es" -eq 0 ] && [ "$eo" -ge 1 ] && [ "$ea" -ge 1 ] \
  && ok "7 $E: placement module ${ei}x, controls ${ec}x, calendarSpaceUri ${es}x, onRefusal ${eo}x, role=alert ${ea}x" \
  || no "7 $E: placement module ${ei}x (want >=1), controls ${ec}x (want 0), calendarSpaceUri ${es}x (want 0), onRefusal ${eo}x, role=alert ${ea}x (want >=1 each)"

# 8. The words: among the lines this branch added to the pages, the placement module and the adapter,
#    "Who can see this event", "Everyone" and "Members only" each appear, and "private" never does as
#    a word (an event is members-only, never private; the identifier privateMode is not the word).
mapfile -t cf < <(printf '%s\n' "$P" "$E" "$PLACE" "$ADAPTER")
aw8=$(added_to "${cf[@]}")
q=$(printf '%s\n' "$aw8" | grep -c 'Who can see this event'); ev=$(printf '%s\n' "$aw8" | grep -c 'Everyone')
mo=$(printf '%s\n' "$aw8" | grep -c 'Members only'); pv=$(printf '%s\n' "$aw8" | grep -ciE '\bprivate\b')
[ "$q" -ge 1 ] && [ "$ev" -ge 1 ] && [ "$mo" -ge 1 ] && [ "$pv" -eq 0 ] \
  && ok "8 added lines in the pages, placement module and adapter: 'Who can see this event' ${q}x, 'Everyone' ${ev}x, 'Members only' ${mo}x, 'private' ${pv}x" \
  || { no "8 added lines: 'Who can see this event' ${q}x, 'Everyone' ${ev}x, 'Members only' ${mo}x (want >=1 each), 'private' ${pv}x (want 0)"; printf '%s\n' "$aw8" | grep -iE '\bprivate\b' | head -3; }

# 9. The groups suites: more than the 722 baseline, all passing, every file passing; the nine new
#    titles and seven guards (unit A's write path and the read-side image guard) each pass exactly once.
titles=(
  "Everyone is the group's public repo and Members only is its calendar space"
  "a members-only event offers no recurring copies"
  "a public event keeps its recurring copies"
  "a members-only save sends the calendar space on every write and delete"
  "a public save sends no space, as before"
  "the image upload is the same for either placement"
  "a refusal from the group's commands reaches the page as its own message"
  "the new-event page loader hands the page the group's calendar space, computed from its DID"
  "the new-event page asks who can see the event before it shows the editor"
  "the edit page shows who can see the event and offers no way to change it"
  "a members-only create goes to space.createRecord and never to a repo method"
  "a public write sends the same request as before"
  "a space other than the group's calendar space is refused before any PDS call"
  "a write with no placement is refused before any PDS call"
  "each placement refusal reaches the form as a message, not a 500"
  "a members-only event keeps its image inside the calendar space"
  "a member's page drops a members-only event's image and keeps a public event's"
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
  ok "9 vitest groups:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $GROUPS_BASELINE); ${#titles[@]} fixed titles each passed 1x"
else
  no "9 vitest groups: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $GROUPS_BASELINE); fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 10. The whole web suite: nothing fails, no fewer passed than the 1119 baseline, no more skipped than 4.
aout=$(npx vitest run 2>&1)
aline=$(printf '%s\n' "$aout" | grep -E '^\s+Tests\s' | tail -1)
afiles=$(printf '%s\n' "$aout" | grep -E '^\s+Test Files\s' | tail -1)
ap=$(echo "$aline" | sed -nE 's/^\s+Tests\s+([0-9]+) passed.*/\1/p')
as=$(echo "$aline" | sed -nE 's/.* ([0-9]+) skipped.*/\1/p'); as=${as:-0}
at=$(echo "$aline" | sed -nE 's/.*\(([0-9]+)\)$/\1/p')
if [ -n "$ap" ] && [ -n "$at" ] && ! echo "$aline $afiles" | grep -q 'failed' && [ $((ap + as)) -eq "$at" ] \
   && [ "$ap" -ge $ALL_BASELINE ] && [ "$as" -le $ALL_SKIPPED ]; then
  ok "10 vitest web:$(echo "$aline" | sed 's/^ *Tests//'),$(echo "$afiles" | sed 's/^ *Test Files//') files (baseline $ALL_BASELINE passed, $ALL_SKIPPED skipped)"
else no "10 vitest web: '${aline:-no Tests line}' / '${afiles:-no Test Files line}' (want 0 failed, >= $ALL_BASELINE passed, <= $ALL_SKIPPED skipped)"; fi

# 11. Type check, graded against the base: 0 errors and no more than the 7 warnings stamped at 4def656.
#     svelte-kit sync first, as `npm run check` does, so a fresh worktree has its generated types.
npx svelte-kit sync >/dev/null 2>&1
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); w=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$w" ] && [ "$w" -le $SC_WARN_BASELINE ] && ok "11 svelte-check: $e errors, $w warnings (baseline 0, $SC_WARN_BASELINE)" \
  || no "11 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <= $SC_WARN_BASELINE warnings)"

# 12. Formatting: prettier --check over every changed .ts/.svelte file plus the touch-set files that exist.
mapfile -t pf < <( { printf '%s\n' "$changed" | sed -n 's#^apps/web/##p' | grep -E '\.(ts|svelte)$';
                     printf '%s\n' "${allowed[@]}" | sed 's#^apps/web/##'; } | grep . | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!'; then
  ok "12 prettier clean on ${#pf[@]} file(s)"
else no "12 prettier on ${#pf[@]} file(s): $(printf '%s\n' "$pout" | grep -E '^\[warn\]' | tr '\n' ' ')"; fi

# 13. Hygiene over $BASE..HEAD: at least one commit changes apps/web; messages and added lines (this
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
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/|-->)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
if [ "$nweb" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$ba" -eq 0 ] && [ "$cm" -eq 0 ] && [ "$ca" -eq 0 ] && [ "$om" -eq 0 ] && [ "$offform" -eq 0 ]; then
  ok "13 $nweb commit(s) changing apps/web, $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By, 0 openmeet names; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "13 $nweb commit(s) changing apps/web (want >=1); bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; openmeet names $om; $offform of $nspec spec-id line(s) off the trailing form (want all 0)"
  printf '%s\n' "$added" | grep -E "$BEAD|[Cc]o-[Aa]uthored-[Bb]y" | head -5
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

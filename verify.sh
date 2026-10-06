#!/usr/bin/env bash
# verify.sh for members-only events on the write path, phase 2 unit A: placement is a required
# input at every hop, a members-only event is written, edited and deleted only in the group's
# calendar space after a check that the space exists and is member-list, a placement change is
# refused, and public events behave exactly as before (spec 002 T204, T206, T207, T220). Frozen at
# fire.
# Run from anywhere; it cds into the worktree. Every check prints a positive artifact line and the
# last line is the tally. The e2e runs against the local atproto-devnet only (SKIP_E2E=1 skips it,
# and then the run cannot pass).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them: the checks use back-references.
unset -f grep sed awk 2>/dev/null || true
# Plain output for the parsers below: no color codes around vitest's summary.
export NO_COLOR=1
WT=/workspaces/scratch/wt-atmo-events-mrimm3
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=80bb19a
WRITER=$LIB/server/event-writer.ts
REMOTE=$LIB/groups.remote.ts
ADAPTER=$LIB/editor-adapter.ts
VITEST_BASELINE=697
E2E_BASE_PASSED=36
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree"; exit 2; }

# 0. Built on the contract's base.
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

cd "$WEB" || { echo "ABORT no apps/web"; exit 2; }

# Lines of a file that are code, not comment: drops //, /* and * lines.
code_lines() { grep -nvE '^[[:space:]]*(//|/\*|\*)' "$1"; }
# The body of a top-level `export async function NAME` in a file, as numbered code lines.
fn_body() { awk -v n="$2" '$0 ~ "^export async function " n "\\(" {on=1} on {print NR": "$0} on && /^}/ {exit}' "$1" \
  | grep -vE '^[0-9]+: [[:space:]]*(//|/\*|\*)'; }

# 1. One writer: the non-test files under src that name a space write NSID are exactly the three
#    they were at the base, and the event writer names each of the six write NSIDs exactly once, so
#    placement is a choice at the call site and not a second transport. (Spec: FR-103.)
want1=$'src/lib/groups/server/__fixtures__/stub-pds.ts\nsrc/lib/groups/server/acceptance.ts\nsrc/lib/groups/server/event-writer.ts'
got1=$(git grep -lE --untracked 'com\.atproto\.space\.(createRecord|putRecord|deleteRecord)' -- src ':!**/*.test.*' | LC_ALL=C sort)
counts=""; bad1=0
for n in space.createRecord space.putRecord space.deleteRecord repo.createRecord repo.putRecord repo.deleteRecord; do
  c=$(grep -cF "com.atproto.$n" "$WRITER"); counts="$counts $n=$c"; [ "$c" -eq 1 ] || bad1=1
done
[ "$got1" = "$want1" ] && [ "$bad1" -eq 0 ] \
  && ok "1 space write NSIDs in the 3 base files ($(echo "$got1" | tr '\n' ' ')); event-writer.ts:$counts" \
  || no "1 space write NSIDs in: $(echo "$got1" | tr '\n' ' ') (want stub-pds, acceptance, event-writer); event-writer.ts:$counts (want each 1)"

# 2. The gate comes first: in writeGroupEvent and in deleteGroupEvent the first awaited call is
#    `await authorize(`, so no space check, record read or write can run before the permission
#    check. Placement validation that makes no call may sit above it. (Constitution IV.)
r2=""; bad2=0
for f in writeGroupEvent deleteGroupEvent; do
  body=$(fn_body "$WRITER" "$f")
  first=$(printf '%s\n' "$body" | grep -E '\bawait\b' | head -1)
  auth=$(printf '%s\n' "$body" | grep -E 'await authorize\(' | head -1 | cut -d: -f1)
  if [ -n "$auth" ] && [ "$(echo "$first" | cut -d: -f1)" = "$auth" ]; then r2="$r2 $f: authorize at line $auth is the first await;"
  else r2="$r2 $f: first await '$(echo "$first" | sed 's/^[0-9]*: *//' | cut -c1-60)' at line $(echo "$first" | cut -d: -f1), authorize at ${auth:-none};"; bad2=1; fi
done
[ "$bad2" -eq 0 ] && ok "2$r2" || no "2$r2 (want authorize first in both)"

# 3. Placement is required, never optional, at every hop: the two remote commands take
#    `space: v.nullable(` (2x) and no optional or nullish space; the writer keeps exactly the one
#    optional `space?:` it had (GroupRepoWrite, the transport's own field) and gains a required
#    `space: string | null`; the editor adapter takes no optional space. (Spec: FR-116.)
rn=$(grep -cE 'space: v\.nullable\(' "$REMOTE"); ro=$(grep -cE 'space: v\.(optional|nullish|exactOptional)\(' "$REMOTE")
wo=$(grep -cE '\bspace\?:' "$WRITER"); wr=$(grep -cE '\bspace: string \| null\b' "$WRITER")
ao=$(grep -cE '\bspace\?:' "$ADAPTER"); ar=$(grep -cE '\bspace: string \| null\b' "$ADAPTER")
[ "$rn" -eq 2 ] && [ "$ro" -eq 0 ] && [ "$wo" -eq 1 ] && [ "$wr" -ge 1 ] && [ "$ao" -eq 0 ] && [ "$ar" -ge 1 ] \
  && ok "3 groups.remote.ts: space v.nullable ${rn}x, optional ${ro}x; event-writer.ts: space?: ${wo}x, space: string | null ${wr}x; editor-adapter.ts: space?: ${ao}x, space: string | null ${ar}x" \
  || no "3 groups.remote.ts: space v.nullable ${rn}x (want 2), optional/nullish ${ro}x (want 0); event-writer.ts: space?: ${wo}x (want 1), space: string | null ${wr}x (want >=1); editor-adapter.ts: space?: ${ao}x (want 0), space: string | null ${ar}x (want >=1)"

# 4. No visibility field on the record: the lexicon types are untouched, and no added non-test line
#    under the groups lib assigns a visibility, privacy or audience key. (Spec: FR-104.)
lt=$(git diff --numstat $BASE -- src/lexicon-types | awk '{s+=$1+$2} END {print s+0}')
vk=$(git diff $BASE -- $LIB ':!**/*.test.*' | grep -E '^\+' | grep -vE '^\+\+\+ ' | grep -cE '\b(visibility|privacy|audience|isPrivate)\s*[:=]')
[ "$lt" -eq 0 ] && [ "$vk" -eq 0 ] && ok "4 src/lexicon-types numstat vs $BASE: $lt lines; added visibility/privacy/audience keys under $LIB: $vk" \
  || no "4 src/lexicon-types numstat $lt (want 0); added visibility/privacy/audience keys $vk (want 0)"

# 5. Unchanged against the base: the fourteen paths of AC 13. Each must still exist, and the
#    numstat over all of them totals 0 lines.
keep=($LIB/server/about-read.ts $LIB/server/calendar-read.ts $LIB/server/events-index.ts
      $LIB/server/route-context.ts $LIB/access.ts $LIB/server/repo.ts $LIB/server/members-writer.ts
      $LIB/create-group.ts migrations ../../packages/ui src/lexicon-types
      'src/routes/(app)/groups/[actor]/events/+page.svelte'
      'src/routes/(app)/groups/[actor]/events/+page.server.ts'
      'src/routes/(app)/groups/[actor]/events/[rkey]/edit/+page.server.ts')
present=0; for p in "${keep[@]}"; do [ -n "$(git ls-files -- "$p" | head -1)" ] && present=$((present+1)); done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq 14 ] && [ "$tot" -eq 0 ] && ok "5 all 14 AC-13 paths present; numstat vs $BASE totals $tot lines" \
  || { no "5 $present of 14 AC-13 paths present; numstat vs $BASE totals $tot lines (want 14 and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 6. The groups suites, lib plus routes: more tests than the 697 baseline, all passing, and each
#    fixed AC-14 title passes exactly once.
titles=(
  "a members-only create goes to space.createRecord and never to a repo method"
  "a members-only edit goes to space.putRecord in the calendar space"
  "a members-only delete goes to space.deleteRecord and never to repo.deleteRecord"
  "a members-only write and delete never notify the index"
  "an edit that changes placement is refused with no write"
  "a delete at the wrong placement is refused with no write"
  "a members-only write to a group with no calendar space is refused with no write"
  "a members-only write into a calendar space that is not member-list is refused with no write"
  "a members-only write is refused when the calendar space cannot be checked"
  "a space other than the group's calendar space is refused before any PDS call"
  "a write with no placement is refused before any PDS call"
  "a public write sends the same request as before"
  "the event record is the same in either container"
  "a members-only event keeps its image inside the calendar space"
  "a caller without the permission is refused before any PDS read or write"
  "each placement refusal reaches the form as a message, not a 500"
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
if [ -n "$n" ] && [ "$1" -eq "$2" ] && [ "$1" -gt $VITEST_BASELINE ] && [ "$tbad" -eq 0 ] \
   && printf '%s\n' "$files" | grep -qE '^\s+Test Files\s+([0-9]+) passed \(\1\)$'; then
  ok "6 vitest:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $VITEST_BASELINE); ${#titles[@]} fixed titles each passed 1x"
else
  no "6 vitest: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $VITEST_BASELINE); fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 7. Type check: 0 errors, warnings no worse than the 7 stamped at the base.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); w=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$w" ] && [ "$w" -le 7 ] && ok "7 svelte-check: $e errors, $w warnings (baseline 0, 7)" \
  || no "7 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <=7 warnings)"

# 8. Formatting: prettier --check over every .ts/.mjs/.js/.svelte file this branch changed or added
#    under apps/web, plus the touch-set files that exist, so the check always has files to read.
changed=$( { git diff --name-only --diff-filter=d --relative $BASE -- . ; git ls-files --others --exclude-standard -- . ; } | grep -E '\.(ts|mjs|js|svelte)$')
touch=$(for f in "$WRITER" "$REMOTE" "$ADAPTER" $LIB/server/spaces.ts \
          'src/routes/(app)/groups/[actor]/events/new/+page.svelte' \
          'src/routes/(app)/groups/[actor]/events/[rkey]/edit/+page.svelte' \
          scripts/groups-e2e.mjs scripts/groups-e2e.worker.ts; do [ -f "$f" ] && echo "$f"; done)
mapfile -t pf < <(printf '%s\n%s\n' "$changed" "$touch" | grep . | sort -u)
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!'; then
  ok "8 prettier clean on ${#pf[@]} file(s), $(echo "$changed" | grep -c .) of them changed vs $BASE"
else no "8 prettier on ${#pf[@]} file(s): $(printf '%s\n' "$pout" | grep -E '^\[warn\]' | tr '\n' ' ')"; fi

# 9. The groups e2e on atproto-devnet. Baseline at the base: 36 passed, 2 failed, and the two
#    failures are the events index (checks 21-22), which cannot resolve devnet's http PDS. After
#    this change: k >= 8 new PASS lines whose label starts "a members-only event", passed = 36 + k,
#    failed = 2 and exactly the two events-index labels, checks 4, 5, 6 and 9 still pass once each
#    (public writes unchanged), and no WARN line about a members-only event or the calendar space.
L21="the events tab reads the group.s events from the index, edits included"
L22="an event written after the backfill is indexed at once, and a deletion drops it"
P4="owner.s event is authored by the GROUP DID, not by the owner"
P5="admin edits an event they did not create; the author is still the GROUP DID"
P6="non-member.s identical edit is refused"
P9="an event.s cover image is uploaded into the GROUP repo, and its record cites it"
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
if [ "${SKIP_E2E:-0}" = 1 ]; then no "9 e2e skipped (SKIP_E2E=1)"
elif [ ! -s "$CRED" ]; then no "9 no fixture credentials file at $CRED"
else
  h=$(curl -s -m 5 http://localhost:3010/xrpc/_health)
  if ! echo "$h" | grep -q '"version"'; then no "9 devnet alpha PDS not answering on :3010 ($h)"; else
    log=$(mktemp -t groups-e2e.XXXXXX)
    E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
    E2E_CREDENTIALS="$CRED" \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
      timeout 900 node scripts/groups-e2e.mjs >"$log" 2>&1
    sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$log" | tail -1)
    p=$(echo "$sum" | sed -nE 's/^SUMMARY: ([0-9]+) passed.*/\1/p'); f=$(echo "$sum" | sed -nE 's/.* ([0-9]+) failed$/\1/p')
    k=$(grep -cE '^PASS +a members-only event\b' "$log")
    nfail=$(grep -cE '^FAIL ' "$log")
    f21=$(grep -cE "^FAIL +${L21}(: |$)" "$log"); f22=$(grep -cE "^FAIL +${L22}(: |$)" "$log")
    c4=$(grep -cE "^PASS +${P4}(: |$)" "$log"); c5=$(grep -cE "^PASS +${P5}(: |$)" "$log")
    c6=$(grep -cE "^PASS +${P6}(: |$)" "$log"); c9=$(grep -cE "^PASS +${P9}(: |$)" "$log")
    warn=$(grep -E '^WARN ' "$log" | grep -ciE 'members-only|calendar')
    if [ -n "$sum" ] && [ "$k" -ge 8 ] && [ "$p" -eq $((E2E_BASE_PASSED + k)) ] && [ "$f" -eq 2 ] \
       && [ "$nfail" -eq 2 ] && [ "$f21" -eq 1 ] && [ "$f22" -eq 1 ] \
       && [ "$c4" -eq 1 ] && [ "$c5" -eq 1 ] && [ "$c6" -eq 1 ] && [ "$c9" -eq 1 ] && [ "$warn" -eq 0 ]; then
      ok "9 devnet e2e $sum = $E2E_BASE_PASSED + k with k=$k members-only event checks; the 2 FAILs are checks 21-22; checks 4, 5, 6, 9 PASS 1x each; 0 members-only WARN lines"
    else
      no "9 devnet e2e '${sum:-no SUMMARY}': k=$k members-only event PASS (want >=8, passed = $E2E_BASE_PASSED + k), FAIL lines $nfail (21: $f21, 22: $f22; want 2, 1, 1), checks 4/5/6/9 PASS $c4/$c5/$c6/$c9 (want 1 each), members-only WARN lines $warn (want 0) (log $log)"
      grep -E '^(FAIL|WARN|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

# 10. Hygiene over $BASE..HEAD: commit messages and added lines (this script aside) carry no bead id
#     and no Co-Authored-By, and every added line that names an FR- or SC- id names it only in a
#     trailing "(Spec: ...)" parenthetical.
cd "$WT"
ncommits=$(git rev-list --count $BASE..HEAD)
msgs=$(git log --format=%B $BASE..HEAD)
added=$(git diff $BASE HEAD -- . ':!verify.sh' | grep -E '^\+' | grep -vE '^\+\+\+ ')
nadded=$(printf '%s' "$added" | grep -c .)
BEAD='\bom-[a-z0-9]{4,}(\.[0-9]+)*\b'
bm=$(printf '%s\n' "$msgs" | grep -cE "$BEAD"); ba=$(printf '%s\n' "$added" | grep -cE "$BEAD")
cm=$(printf '%s\n' "$msgs" | grep -ci 'co-authored-by'); ca=$(printf '%s\n' "$added" | grep -ci 'co-authored-by')
specl=$(printf '%s\n' "$added" | grep -E '\b(FR|SC)-[0-9]+')
nspec=$(printf '%s' "$specl" | grep -c .)
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
if [ "$ncommits" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$ba" -eq 0 ] && [ "$cm" -eq 0 ] && [ "$ca" -eq 0 ] && [ "$offform" -eq 0 ]; then
  ok "10 $ncommits commit(s), $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "10 $ncommits commit(s), $nadded added line(s): bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; $offform of $nspec spec-id line(s) not in the trailing (Spec: ...) form (want >=1 commit, then all 0)"
  printf '%s\n' "$added" | grep -E "$BEAD|[Cc]o-[Aa]uthored-[Bb]y" | head -5
  printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -E '\b(FR|SC)-[0-9]+' | head -5
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

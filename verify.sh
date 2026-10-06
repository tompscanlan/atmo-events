#!/usr/bin/env bash
# verify.sh for the members-only slice read, phase 3: the events list reads the group's calendar
# space for roster members only, unions it with the public slice, and costs a non-member nothing
# (spec 002 T208-T211, T227). Frozen at fire.
# Run from anywhere; it cds into the worktree. Every check prints a positive artifact line and the
# last line is the tally. The e2e runs against the local atproto-devnet only (SKIP_E2E=1 skips it,
# and then the run cannot pass).
set -uo pipefail
# GNU grep and sed, never a shell function standing in for them: the checks use back-references.
unset -f grep sed awk 2>/dev/null || true
# Plain output for the parsers below: no color codes around vitest's summary.
export NO_COLOR=1
WT=/workspaces/scratch/wt-atmo-events-mrimm4
WEB=$WT/apps/web
LIB=src/lib/groups
BASE=0d2e000
MOD=$LIB/server/calendar-read.ts
LOADER='src/routes/(app)/groups/[actor]/events/+page.server.ts'
VITEST_BASELINE=658
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

# 1. The slice is read only through reader.list: the files under src (tests aside) that hold the
#    literal com.atproto.space.listRecords are exactly about-read.ts and the stub PDS fixture, as at
#    the base.
want1=$'src/lib/groups/server/__fixtures__/stub-pds.ts\nsrc/lib/groups/server/about-read.ts'
got1=$(git grep -lF --untracked 'com.atproto.space.listRecords' -- src ':!**/*.test.*' | LC_ALL=C sort)
[ "$got1" = "$want1" ] && ok "1 listRecords literal in 2 non-test files: $(echo "$got1" | tr '\n' ' ')" \
  || no "1 listRecords literal in $(echo "$got1" | grep -c .) non-test file(s): $(echo "$got1" | tr '\n' ' ') (want about-read.ts and __fixtures__/stub-pds.ts)"

# 2. The new module exists, and its only importer under src (tests aside) is the events loader, so
#    no other route can reach the slice. (Spec: FR-117.)
if [ -s "$MOD" ]; then
  imp=$(git grep -lE --untracked "['\"][^'\"]*/calendar-read(\.(ts|js))?['\"]" -- src ':!**/*.test.*' ":!$MOD" | LC_ALL=C sort)
  [ "$imp" = "$LOADER" ] && ok "2 $MOD exists ($(wc -l <"$MOD") lines); its 1 non-test importer: $imp" \
    || no "2 $MOD importers outside tests: $(echo "$imp" | grep -c .) [$(echo "$imp" | tr '\n' ' ')] (want exactly the events loader)"
else no "2 $MOD does not exist (not built yet)"; fi

# 3. The gate comes before the read: in the new module, the first code line that calls
#    canSeeMembers( sits above the first code line that calls the reader (list, get or getSpace).
if [ -s "$MOD" ]; then
  g=$(code_lines "$MOD" | grep -vE '^[0-9]+:[[:space:]]*import\b' | grep -E 'canSeeMembers\(' | head -1 | cut -d: -f1)
  r=$(code_lines "$MOD" | grep -E '[Rr]eader[?!]?\.(list|get|getSpace)\(' | head -1 | cut -d: -f1)
  if [ -n "$g" ] && [ -n "$r" ] && [ "$g" -lt "$r" ]; then ok "3 first canSeeMembers( call at line $g, first reader call at line $r"
  else no "3 first canSeeMembers( call at line ${g:-none}, first reader call at line ${r:-none} (want both, gate first)"; fi
else no "3 $MOD does not exist (not built yet)"; fi

# 4. No cache: zero matches in the new module and the events loader, and caches.default is still
#    used in exactly the 2 files it was at the base. (Spec: FR-117.) A missing module is V2's failure,
#    so this check scans the files that exist and names them.
scan=("$LOADER"); [ -f "$MOD" ] && scan+=("$MOD")
if [ -s "$LOADER" ]; then
  nc=$(cat "${scan[@]}" | grep -cEi 'caches|cachedRead|edge-cache|cache-control|setHeaders')
  want4=$'src/lib/server/edge-cache.ts\nsrc/routes/(app)/p/[actor]/e/[rkey]/+page.server.ts'
  cd4=$(git grep -lF --untracked 'caches.default' -- src | LC_ALL=C sort)
  [ "$nc" -eq 0 ] && [ "$cd4" = "$want4" ] \
    && ok "4 cache matches 0 in ${#scan[@]} file(s) [${scan[*]}]; caches.default in 2 files: $(echo "$cd4" | tr '\n' ' ')" \
    || { no "4 cache matches $nc in [${scan[*]}]; caches.default in $(echo "$cd4" | grep -c .) file(s): $(echo "$cd4" | tr '\n' ' ') (want 0, and the 2 base files)"
         cat "${scan[@]}" | grep -nEi 'caches|cachedRead|edge-cache|cache-control|setHeaders' | head -5; }
else no "4 the events loader is missing"; fi

# 5. Never through contrail: of the new module's import specifiers, none names contrail or
#    events-index. (Spec: FR-117.)
if [ -s "$MOD" ]; then
  specs=$(code_lines "$MOD" | grep -oE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"")
  ns=$(echo "$specs" | grep -c .); bad=$(echo "$specs" | grep -cE 'contrail|events-index')
  [ "$ns" -ge 1 ] && [ "$bad" -eq 0 ] && ok "5 $ns import specifier(s) in the module, 0 from contrail or events-index: $(echo "$specs" | tr '\n' ' ')" \
    || no "5 $ns import specifier(s), $bad from contrail or events-index: $(echo "$specs" | tr '\n' ' ') (want >=1 and 0)"
else no "5 $MOD does not exist (not built yet)"; fi

# 6. Unchanged against the base: the eleven paths of AC 11. Each must still exist, and the
#    numstat over all of them totals 0 lines.
keep=($LIB/server/about-read.ts $LIB/server/spaces.ts $LIB/server/members-writer.ts
      $LIB/server/event-writer.ts $LIB/create-group.ts $LIB/server/route-context.ts $LIB/access.ts
      $LIB/server/repo.ts $LIB/server/events-index.ts migrations ../../packages/ui)
present=0; for p in "${keep[@]}"; do [ -n "$(git ls-files -- "$p" | head -1)" ] && present=$((present+1)); done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq 11 ] && [ "$tot" -eq 0 ] && ok "6 all 11 AC-11 paths present; numstat vs $BASE totals $tot lines" \
  || { no "6 $present of 11 AC-11 paths present; numstat vs $BASE totals $tot lines (want 11 and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 7. The groups suites, lib plus routes: more tests than the 658 baseline, all passing, and each of
#    the two fixed AC-12 titles passes exactly once in a test file of the events route.
out=$(npx vitest run --reporter=verbose $LIB 'src/routes/(app)/groups' 2>&1)
line=$(printf '%s\n' "$out" | grep -E '^\s+Tests\s' | tail -1)
files=$(printf '%s\n' "$out" | grep -E '^\s+Test Files\s' | tail -1)
n=$(printf '%s\n' "$line" | sed -nE 's/^\s+Tests\s+([0-9]+) passed \(([0-9]+)\)$/\1 \2/p')
t1="no space read for an anonymous viewer"; t2="no space read for a signed-in non-member"
EVT='src/routes/.*/groups/.*/events/[^ >]*\.test\.ts > (.* > )?'
c1=$(printf '%s\n' "$out" | grep -cE "^\s+✓ $EVT$t1( [0-9.]+m?s)?$")
c2=$(printf '%s\n' "$out" | grep -cE "^\s+✓ $EVT$t2( [0-9.]+m?s)?$")
set -- $n
if [ -n "$n" ] && [ "$1" -eq "$2" ] && [ "$1" -gt $VITEST_BASELINE ] && [ "$c1" -eq 1 ] && [ "$c2" -eq 1 ] \
   && printf '%s\n' "$files" | grep -qE '^\s+Test Files\s+([0-9]+) passed \(\1\)$'; then
  ok "7 vitest:$(echo "$line" | sed 's/^ *Tests//'),$(echo "$files" | sed 's/^ *Test Files//') files (baseline $VITEST_BASELINE); '$t1' 1x, '$t2' 1x"
else
  no "7 vitest: '${line:-no Tests line}' / '${files:-no Test Files line}' (want all passed and > $VITEST_BASELINE); '$t1' passed ${c1}x, '$t2' passed ${c2}x (want 1, 1)"
  printf '%s\n' "$out" | grep -E '^\s+(×|✗)|FAIL ' | head -10
fi

# 8. Type check: 0 errors, warnings no worse than the 7 stamped at the base.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); w=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$w" ] && [ "$w" -le 7 ] && ok "8 svelte-check: $e errors, $w warnings (baseline 0, 7)" \
  || no "8 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <=7 warnings)"

# 9. Formatting: prettier --check over every .ts/.mjs/.js/.svelte file this branch changed or added
#    under apps/web, plus the touch-set files that exist, so the check always has files to read
#    (prettier was clean on all of them at the base).
changed=$( { git diff --name-only --diff-filter=d --relative $BASE -- . ; git ls-files --others --exclude-standard -- . ; } | grep -E '\.(ts|mjs|js|svelte)$')
touch=$(for f in $LIB/types.ts "$LOADER" 'src/routes/(app)/groups/[actor]/events/+page.svelte' \
          scripts/groups-e2e.mjs scripts/groups-e2e.worker.ts scripts/groups-e2e.oauth.ts; do [ -f "$f" ] && echo "$f"; done)
mapfile -t pf < <(printf '%s\n%s\n' "$changed" "$touch" | grep . | sort -u)
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!'; then
  ok "9 prettier clean on ${#pf[@]} file(s), $(echo "$changed" | grep -c .) of them changed vs $BASE"
else no "9 prettier on ${#pf[@]} file(s): $(printf '%s\n' "$pout" | grep -E '^\[warn\]' | tr '\n' ' ')"; fi

# 10. The groups e2e on atproto-devnet. Baseline at the base: 31 passed, 2 failed, and the two
#     failures are the events index (checks 21-22), which cannot resolve devnet's http PDS. After
#     this change: k >= 3 new PASS lines labeled "the members-only slice ...", passed = 31 + k,
#     failed = 2 and exactly the two events-index labels, and a line reporting the seed created or
#     found.
L21="the events tab reads the group.s events from the index, edits included"
L22="an event written after the backfill is indexed at once, and a deletion drops it"
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
if [ "${SKIP_E2E:-0}" = 1 ]; then no "10 e2e skipped (SKIP_E2E=1)"
elif [ ! -s "$CRED" ]; then no "10 no fixture credentials file at $CRED"
else
  h=$(curl -s -m 5 http://localhost:3010/xrpc/_health)
  if ! echo "$h" | grep -q '"version"'; then no "10 devnet alpha PDS not answering on :3010 ($h)"; else
    log=$(mktemp -t groups-e2e.XXXXXX)
    E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
    E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
    E2E_CREDENTIALS="$CRED" \
    E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
    E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
      timeout 900 node scripts/groups-e2e.mjs >"$log" 2>&1
    sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$log" | tail -1)
    p=$(echo "$sum" | sed -nE 's/^SUMMARY: ([0-9]+) passed.*/\1/p'); f=$(echo "$sum" | sed -nE 's/.* ([0-9]+) failed$/\1/p')
    k=$(grep -cE '^PASS +the members-only slice ' "$log")
    nfail=$(grep -cE '^FAIL ' "$log")
    f21=$(grep -cE "^FAIL +${L21}(: |$)" "$log"); f22=$(grep -cE "^FAIL +${L22}(: |$)" "$log")
    seed=$(grep -iE '\bseed' "$log" | grep -iE '\b(created|found)\b' | head -1 | sed 's/^ *//')
    if [ -n "$sum" ] && [ "$k" -ge 3 ] && [ "$p" -eq $((31 + k)) ] && [ "$f" -eq 2 ] \
       && [ "$nfail" -eq 2 ] && [ "$f21" -eq 1 ] && [ "$f22" -eq 1 ] && [ -n "$seed" ]; then
      ok "10 devnet e2e $sum = 31 + k with k=$k members-only slice checks; the 2 FAILs are checks 21-22; seed: $seed"
    else
      no "10 devnet e2e '${sum:-no SUMMARY}': k=$k members-only slice PASS (want >=3, passed = 31 + k), FAIL lines $nfail (21: $f21, 22: $f22; want 2, 1, 1), seed line: '${seed:-none}' (log $log)"
      grep -E '^(FAIL|SUMMARY)' "$log" | cut -c1-200
    fi
  fi
fi

# 11. Hygiene over $BASE..HEAD: commit messages and added lines (this script aside) carry no bead id
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
  ok "11 $ncommits commit(s), $nadded added line(s) scanned: 0 bead ids, 0 Co-Authored-By; $nspec spec-id line(s), all in the trailing (Spec: ...) form"
else
  no "11 $ncommits commit(s), $nadded added line(s): bead ids $bm in messages, $ba in lines; Co-Authored-By $cm, $ca; $offform of $nspec spec-id line(s) not in the trailing (Spec: ...) form (want >=1 commit, then all 0)"
  printf '%s\n' "$added" | grep -E "$BEAD|[Cc]o-[Aa]uthored-[Bb]y" | head -5
  printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -E '\b(FR|SC)-[0-9]+' | head -5
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

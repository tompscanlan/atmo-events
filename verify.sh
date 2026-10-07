#!/usr/bin/env bash
# verify.sh for devnet mode, unit 1: sign in to atmo on the local atproto devnet from a browser,
# through atproto's loopback OAuth client, with devnet-only identity, and none of it in any other
# build.
#  - `pnpm dev:devnet` (vite dev, mode devnet) serves http://127.0.0.1:5454, reads
#    devnet/wrangler.jsonc (never the worktree's wrangler.jsonc), and logs the devnet marker line.
#  - A devnet account signs in by handle and by DID; the PDS's authorize page is devnet's
#    http://localhost:3010. A real-network handle is refused before any redirect, and no navigation
#    leaves 127.0.0.1:5454 or localhost:3010.
#  - A production `vite build` holds none of it: the marker, the devnet URLs, devnet.test,
#    allowHttp and the resolver field names all count 0, as at the base. A devnet build carries the
#    marker (the positive control).
#  - Devnet mode is upstream-droppable: every commit after this gate is scoped `(devnet)` and stays
#    inside the touch-set; the hooks in shared files are small and the logic lives in devnet.ts.
# Decisions (TS, 2026-10-07): five units (D1); a define'd import.meta.env.DEVNET gate (D2); devnet
# accounts only (D3); devnet/wrangler.jsonc through svelte.config.js platformProxy (D4); devnet
# seeded once by the dispatcher (D5: two permission sets, walkowner/walkmember/walkoutsider); devnet
# mode in its own droppable commits, never sent upstream (D6). risk:high.
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Checks 13-15 need the local atproto-devnet up
# (SKIP_DEVNET=1 skips them and counts each as a FAIL).
set -uo pipefail
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-devnet-signin}
WEB=$WT/apps/web
BASE=9d07415
GATE_SUBJECT='test(devnet): gate for signing in to atmo on devnet'
MARK='atmo devnet build'
OAUTH=src/lib/atproto/server/oauth.ts
DEVNET_TS=src/lib/atproto/server/devnet.ts
DEVNET_TEST=src/lib/atproto/server/devnet.test.ts
WALK=scripts/devnet-signin-walk.mjs
DEVNET_CFG=devnet/wrangler.jsonc
PLC=http://localhost:2592
PDS=http://localhost:3010
AUTHORITY=did:plc:ohgyubfn4wzdpb6vtl2mhb3m
WALKOWNER_DID=did:plc:icutzbcjbp7cefk3qx2wgezl
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
PLAYWRIGHT_MODULE=${PLAYWRIGHT_MODULE:-/home/node/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs}
ALL_BASELINE=1163        # whole web suite at 9d07415: 1163 passed | 4 skipped
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check apps/web at 9d07415: 0 errors, 7 warnings
OAUTH_BASE_TESTS=10      # oauth.test.ts + group-link/server.test.ts at 9d07415: 10 passed
PROD_DEVNET_WORD=1       # 'devnet' (any case) in a production build at 9d07415: 1 hit
E2E_BASE_PASSED=49       # devnet groups e2e at 9d07415: 49 passed, 0 failed (re-run after seeding)
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }
T=$(mktemp -d -t devnet-u1.XXXXXX)

# 0. Built on the contract's base (feat/groups-opensocial with both members-only parts folded).
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

# 1. Droppable from the upstream PR: at least one commit after the gate, and every commit subject
#    after the base other than the gate's is scoped (devnet).
subjects=$(git log --format=%s $BASE..HEAD | grep -vF "$GATE_SUBJECT")
nsub=$(printf '%s' "$subjects" | grep -c .)
offscope=$(printf '%s\n' "$subjects" | grep . | grep -cvE '^(feat|fix|test|chore|refactor|docs)\(devnet\): ')
[ "$nsub" -ge 1 ] && [ "$offscope" -eq 0 ] && ok "1 $nsub commit(s) after the gate, all scoped (devnet)" \
  || { no "1 $nsub commit(s) after the gate (want >=1), $offscope not scoped (devnet) (want 0)"; printf '%s\n' "$subjects" | grep -vE '\(devnet\): ' | head -5; }

# 2. The touch-set: every file changed or added under apps/web and packages is in the allowed set,
#    and all nine are changed.
w() { printf 'apps/web/%s\n' "$@"; }
allowed=$(w vite.config.ts svelte.config.js package.json $DEVNET_CFG src/app.d.ts $OAUTH $DEVNET_TS $DEVNET_TEST $WALK | LC_ALL=C sort)
changed=$( { git diff --name-only $BASE -- apps/web packages; git ls-files --others --exclude-standard -- apps/web packages; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
lacking=$(comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
[ -z "$outside" ] && [ -z "$lacking" ] && ok "2 changed under apps/web and packages: $(printf '%s\n' "$changed" | grep -c .) file(s), exactly the allowed nine" \
  || no "2 outside the allowed set: [$(echo "$outside" | tr '\n' ' ')]; allowed but unchanged: [$(echo "$lacking" | tr '\n' ' ')]"

# 3. Unchanged against the base: the committed wrangler.jsonc, the sign-in scopes, the port, the
#    base OAuth tests, the group-link routes and credentials, the e2e build and its stand-ins, and
#    the lockfile.
cd "$WEB"
keep=(wrangler.jsonc src/lib/atproto/settings.ts src/lib/atproto/port.ts src/lib/atproto/server/oauth.test.ts
      src/lib/atproto/server/oauth.remote.ts src/lib/atproto/server/session.ts src/lib/atproto/server/signed-cookie.ts
      'src/routes/(oauth)' src/lib/groups/server/credentials.ts src/lib/groups/server/linked-session.ts
      src/lib/groups/server/group-link.ts src/lib/groups/server/mint.ts src/lib/groups/create-group.ts
      scripts/groups-e2e.mjs scripts/groups-e2e.worker.ts scripts/groups-e2e.oauth.ts
      scripts/groups-e2e.identity-resolver.ts scripts/groups-e2e.app-environment.js ../../pnpm-lock.yaml)
present=0; missing=""
for p in "${keep[@]}"; do if [ -n "$(git ls-files -- "$p" | head -1)" ]; then present=$((present+1)); else missing="$missing $p"; fi; done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "3 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "3 $present of ${#keep[@]} frozen paths present (missing:${missing:- none}); numstat vs $BASE totals $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 4. Small hooks in shared files, the logic in devnet.ts: capped diffs; oauth.ts names the build
#    flag; devnet.ts carries the marker exactly once; the devnet config names no OAUTH_PUBLIC_URL and
#    nothing on the real network.
ns() { git diff --numstat $BASE -- "$1" | awk '{s+=$1+$2} END {print s+0}'; }
no_=$(ns $OAUTH); nv=$(ns vite.config.ts); nsv=$(ns svelte.config.js); na=$(ns src/app.d.ts); np=$(ns package.json)
fo=$(grep -c 'import\.meta\.env\.DEVNET\b' $OAUTH); mk=$( [ -f $DEVNET_TS ] && grep -cF "$MARK" $DEVNET_TS || echo 0)
cu=0; cr=0; if [ -f $DEVNET_CFG ]; then cu=$(grep -c 'OAUTH_PUBLIC_URL' $DEVNET_CFG); cr=$(grep -ciE 'opnmt|bsky\.social|plc\.directory|https://' $DEVNET_CFG); fi
if [ "$no_" -ge 1 ] && [ "$no_" -le 30 ] && [ "$nv" -ge 1 ] && [ "$nv" -le 40 ] && [ "$nsv" -ge 1 ] && [ "$nsv" -le 15 ] \
   && [ "$na" -ge 1 ] && [ "$na" -le 12 ] && [ "$np" -ge 1 ] && [ "$np" -le 2 ] && [ "$fo" -ge 1 ] && [ "$mk" -eq 1 ] \
   && [ -f $DEVNET_CFG ] && [ "$cu" -eq 0 ] && [ "$cr" -eq 0 ]; then
  ok "4 changed lines: oauth.ts $no_, vite.config.ts $nv, svelte.config.js $nsv, app.d.ts $na, package.json $np; oauth.ts names import.meta.env.DEVNET ${fo}x; marker in devnet.ts 1x; $DEVNET_CFG: OAUTH_PUBLIC_URL 0x, real-network names 0x"
else no "4 changed lines: oauth.ts $no_ (1-30), vite.config.ts $nv (1-40), svelte.config.js $nsv (1-15), app.d.ts $na (1-12), package.json $np (1-2); oauth.ts import.meta.env.DEVNET ${fo}x (>=1); marker in devnet.ts ${mk}x (1); $DEVNET_CFG present: $([ -f $DEVNET_CFG ] && echo yes || echo no), OAUTH_PUBLIC_URL ${cu}x (0), real-network names ${cr}x (0)"; fi

# 5. The new tests, each passing exactly once under its fixed title, and the base OAuth tests
#    unchanged in count.
titles=(
  "devnet: allowHttp is set on both resolvers of a real OAuth client"
  "devnet: a client missing the resolver fields is refused by name"
  "devnet: the actor resolver asks only the devnet PLC and PDS"
  "devnet: a real-network handle is refused before any request leaves for it"
  "devnet: an https OAUTH_PUBLIC_URL is refused"
  "outside devnet mode, the OAuth client keeps allowHttp off and its confidential metadata unchanged"
)
out=$(npx vitest run --reporter=verbose src/lib/atproto/server 2>&1)
tc=""; tbad=0
for t in "${titles[@]}"; do
  esc=$(printf '%s' "$t" | sed 's/[.[\*^$()+?{|]/\\&/g')
  c=$(printf '%s\n' "$out" | grep -cE "^\s+✓ .*> ${esc}( [0-9.]+m?s)?$")
  tc="$tc $c"; [ "$c" -eq 1 ] || tbad=$((tbad+1))
done
bout=$(npx vitest run src/lib/atproto/server/oauth.test.ts 'src/routes/(oauth)/oauth/group-link/server.test.ts' 2>&1)
bl=$(printf '%s\n' "$bout" | grep -E '^\s+Tests\s' | tail -1); bn=$(echo "$bl" | sed -nE 's/^\s+Tests\s+([0-9]+) passed \(([0-9]+)\)$/\1/p')
[ "$tbad" -eq 0 ] && [ "${bn:-0}" -eq $OAUTH_BASE_TESTS ] && ok "5 ${#titles[@]} fixed titles each passed 1x; base OAuth tests:$(echo "$bl" | sed 's/^ *Tests//')" \
  || no "5 fixed titles passed [${tc# }] ($tbad of ${#titles[@]} not exactly 1x); base OAuth tests '${bl:-no Tests line}' (want $OAUTH_BASE_TESTS passed)"

# 6. The whole web suite: nothing fails, more passed than the baseline, no more skipped.
aout=$(npx vitest run 2>&1)
aline=$(printf '%s\n' "$aout" | grep -E '^\s+Tests\s' | tail -1); afiles=$(printf '%s\n' "$aout" | grep -E '^\s+Test Files\s' | tail -1)
ap=$(echo "$aline" | sed -nE 's/^\s+Tests\s+([0-9]+) passed.*/\1/p'); as=$(echo "$aline" | sed -nE 's/.* ([0-9]+) skipped.*/\1/p'); as=${as:-0}
at=$(echo "$aline" | sed -nE 's/.*\(([0-9]+)\)$/\1/p')
if [ -n "$ap" ] && [ -n "$at" ] && ! echo "$aline $afiles" | grep -q 'failed' && [ $((ap + as)) -eq "$at" ] && [ "$ap" -gt $ALL_BASELINE ] && [ "$as" -le $ALL_SKIPPED ]; then
  ok "6 vitest web:$(echo "$aline" | sed 's/^ *Tests//'),$(echo "$afiles" | sed 's/^ *Test Files//') files (baseline $ALL_BASELINE passed, $ALL_SKIPPED skipped)"
else no "6 vitest web: '${aline:-no Tests line}' / '${afiles:-no Test Files line}' (want 0 failed, > $ALL_BASELINE passed, <= $ALL_SKIPPED skipped)"; fi

# 7. Type check: 0 errors, warnings no worse than the base.
sc=$(npx svelte-kit sync >/dev/null 2>&1; npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); wn=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$wn" ] && [ "$wn" -le $SC_WARN_BASELINE ] && ok "7 svelte-check: $e errors, $wn warnings (baseline 0, $SC_WARN_BASELINE)" \
  || no "7 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <= $SC_WARN_BASELINE warnings)"

# 8. Formatting: prettier --check over every changed .ts/.js/.mjs/.json under apps/web (it prints its
#    all-clean line even for a missing path, so count the files first).
mapfile -t pf < <(printf '%s\n' "$changed" | grep -E '^apps/web/.*\.(ts|js|mjs|json)$' | sed 's#^apps/web/##' | sort -u)
pe=0; for f in "${pf[@]}"; do [ -f "$f" ] && pe=$((pe+1)); done
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if [ "$pe" -eq ${#pf[@]} ] && [ "$pe" -ge 6 ] && printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!' && ! printf '%s\n' "$pout" | grep -qiE 'no (files|matching)|error'; then
  ok "8 prettier clean on $pe existing file(s)"
else no "8 prettier: $pe of ${#pf[@]} file(s) exist (want all, >=6); $(printf '%s\n' "$pout" | grep -E '^\[(warn|error)\]' | tr '\n' ' ')"; fi

# 9. Hygiene over $BASE..HEAD (messages and added lines, this script aside): no bead id, no agent
#    attribution, no openmeet name outside an NSID, no "private", no British spelling; spec ids only
#    in a trailing "(Spec: ...)".
cd "$WT"
msgs=$(git log --format=%B $BASE..HEAD)
added=$(git diff $BASE HEAD -- . ':!verify.sh' | grep -E '^\+' | grep -vE '^\+\+\+ ')
nadded=$(printf '%s' "$added" | grep -c .)
BEAD='\bom-[a-z0-9]{4,}(\.[0-9]+)*\b'
bm=$(printf '%s\n%s\n' "$msgs" "$added" | grep -cE "$BEAD")
at_=$(printf '%s\n' "$msgs" | grep -ciE 'co-authored-by|generated with|on behalf of')
om=$(printf '%s\n%s\n' "$msgs" "$added" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]+//g' | grep -ci 'openmeet')
pv=$(printf '%s\n%s\n' "$msgs" "$added" | grep -ciE '\bprivate\b')
br=$(printf '%s\n%s\n' "$msgs" "$added" | grep -ciE 'behaviour|colour|initialis|authoris|organis|recognis|licence|favour')
specl=$(printf '%s\n' "$added" | grep -E '\b(FR|SC)-[0-9]+'); nspec=$(printf '%s' "$specl" | grep -c .)
offform=$(printf '%s\n' "$specl" | sed -E 's/\(Spec: [^()]*\)[[:space:]]*(\*\/)?[[:space:]]*$//' | grep -cE '\b(FR|SC)-[0-9]+')
[ "$nadded" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$at_" -eq 0 ] && [ "$om" -eq 0 ] && [ "$pv" -eq 0 ] && [ "$br" -eq 0 ] && [ "$offform" -eq 0 ] \
  && ok "9 $nadded added line(s) scanned: 0 bead ids, 0 attribution, 0 openmeet names, 0 'private', 0 British spellings; $nspec spec-id line(s), all trailing" \
  || { no "9 added lines $nadded; bead ids $bm, attribution $at_, openmeet $om, 'private' $pv, British $br, spec ids off-form $offform of $nspec (want all 0)"; printf '%s\n' "$added" | grep -iE "$BEAD|openmeet|\bprivate\b|behaviour|colour|authoris|organis" | head -5; }

# 10. The positive control: a devnet build carries the marker.
cd "$WEB"
DEVNET_PLC_URL=$PLC DEVNET_PDS_URL=$PDS timeout 600 npx vite build --mode devnet >"$T/build-devnet.log" 2>&1; bd_=$?
dm=$(grep -rlF "$MARK" .svelte-kit/output 2>/dev/null | wc -l)
[ "$bd_" -eq 0 ] && [ "$dm" -ge 1 ] && ok "10 vite build --mode devnet: exit 0, marker in $dm output file(s)" \
  || { no "10 vite build --mode devnet: exit $bd_ (want 0), marker in $dm output file(s) (want >=1)"; tail -5 "$T/build-devnet.log"; }

# 11. Production safety: a default build holds none of devnet mode.
rm -rf .svelte-kit/output .svelte-kit/cloudflare
timeout 600 npx vite build >"$T/build-prod.log" 2>&1; bp=$?
hits=""; hbad=0
for s in "$MARK" localhost:2592 localhost:3010 devnet.test protectedResourceResolver allowHttp DEVNET_PLC_URL DEVNET_PDS_URL; do
  h=$(grep -roF "$s" .svelte-kit/output .svelte-kit/cloudflare 2>/dev/null | wc -l); hits="$hits $s=$h"; [ "$h" -eq 0 ] || hbad=$((hbad+1)); done
dw=$(grep -roiF devnet .svelte-kit/output .svelte-kit/cloudflare 2>/dev/null | wc -l)
[ "$bp" -eq 0 ] && [ -d .svelte-kit/output/server ] && [ -d .svelte-kit/cloudflare ] && [ "$hbad" -eq 0 ] && [ "$dw" -le $PROD_DEVNET_WORD ] \
  && ok "11 vite build: exit 0, output present; hits:$hits; 'devnet' (any case) $dw (base $PROD_DEVNET_WORD)" \
  || no "11 vite build: exit $bp, output $([ -d .svelte-kit/output/server ] && echo present || echo missing); hits:$hits (want all 0); 'devnet' $dw (want <= $PROD_DEVNET_WORD)"

# 12. Devnet is seeded as the walk needs: both permission sets in the lexicon authority, and the
#     walk owner's handle resolves to its DID on devnet.
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "12 devnet checks skipped (SKIP_DEVNET=1)"; else
  s1=$(curl -s "$PDS/xrpc/com.atproto.repo.getRecord?repo=$AUTHORITY&collection=com.atproto.lexicon.schema&rkey=rsvp.atmo.permissionSet" | grep -c '"permission-set"')
  s2=$(curl -s "$PDS/xrpc/com.atproto.repo.getRecord?repo=$AUTHORITY&collection=com.atproto.lexicon.schema&rkey=app.bsky.authCreatePosts" | grep -c '"permission-set"')
  rh=$(curl -s "$PDS/xrpc/com.atproto.identity.resolveHandle?handle=walkowner.devnet.test" | grep -c "\"$WALKOWNER_DID\"")
  [ "$s1" -eq 1 ] && [ "$s2" -eq 1 ] && [ "$rh" -eq 1 ] && ok "12 devnet seeded: rsvp.atmo.permissionSet, app.bsky.authCreatePosts, walkowner.devnet.test -> $WALKOWNER_DID" \
    || no "12 devnet seeded: permissionSet $s1, authCreatePosts $s2, walkowner resolves $rh (want 1 each)"
fi

# 13-14. The dev server in devnet mode, and the sign-in walk against it from the pod.
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "13 dev server skipped (SKIP_DEVNET=1)"; no "14 walk skipped (SKIP_DEVNET=1)"; else
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:5454/; then no "13 port 5454 already in use before the run"; no "14 walk not run"; else
    DEVNET_PLC_URL=$PLC DEVNET_PDS_URL=$PDS setsid pnpm dev:devnet >"$T/dev.log" 2>&1 & DP=$!
    up=0; for i in $(seq 90); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:5454/ && { up=1; break; }; sleep 2; done
    curl -s -o /dev/null http://127.0.0.1:5454/ ; sleep 2
    lm=$(grep -cF "$MARK" "$T/dev.log"); lo=$(grep -ciE 'opnmt|plc\.directory' "$T/dev.log"); lc=$(grep -cF "$DEVNET_CFG" "$T/dev.log")
    [ "$up" -eq 1 ] && [ "$lm" -ge 1 ] && [ "$lo" -eq 0 ] && [ "$lc" -ge 1 ] \
      && ok "13 dev:devnet serves 127.0.0.1:5454; marker line ${lm}x naming $DEVNET_CFG; opnmt/plc.directory 0x in its log" \
      || { no "13 dev:devnet up=$up (want 1); marker ${lm}x (>=1), $DEVNET_CFG named ${lc}x (>=1), opnmt/plc.directory ${lo}x (0)"; tail -5 "$T/dev.log"; }
    DEVNET_CREDENTIALS=$CRED PLAYWRIGHT_MODULE=$PLAYWRIGHT_MODULE timeout 300 node $WALK >"$T/walk.log" 2>&1
    wh=$(grep -cxF "SIGNED IN $WALKOWNER_DID by handle" "$T/walk.log"); wd=$(grep -cxF "SIGNED IN $WALKOWNER_DID by DID" "$T/walk.log")
    wr=$(grep -cx 'REFUSED real-network handle' "$T/walk.log"); wn_=$(grep -cE '^NAVIGATIONS [1-9][0-9]*, 0 off-site$' "$T/walk.log")
    wpw=$(grep -ciE 'password' "$T/walk.log")
    [ "$wh" -eq 1 ] && [ "$wd" -eq 1 ] && [ "$wr" -eq 1 ] && [ "$wn_" -eq 1 ] && [ "$wpw" -eq 0 ] \
      && ok "14 walk: signed in by handle and by DID as $WALKOWNER_DID, real-network handle refused, $(grep -E '^NAVIGATIONS' "$T/walk.log"), 'password' 0x in its output" \
      || { no "14 walk: by handle ${wh}x, by DID ${wd}x, refused ${wr}x, navigation line ${wn_}x (want 1 each); 'password' ${wpw}x (want 0) (log $T/walk.log)"; grep -vi password "$T/walk.log" | tail -8; }
    kill -TERM -- -$DP 2>/dev/null; sleep 2; kill -KILL -- -$DP 2>/dev/null; wait $DP 2>/dev/null
  fi
fi

# 15. The groups e2e on devnet still passes in full (its build takes no devnet define).
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "15 e2e skipped (SKIP_DEVNET=1)"; else
  E2E_PDS=$PDS E2E_PLC_URL=$PLC E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test \
  E2E_CREDENTIALS=$CRED E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
  E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=did:plc:piobscs63j5o53wzbgqidgj6 \
    timeout 900 node scripts/groups-e2e.mjs >"$T/e2e.log" 2>&1
  sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$T/e2e.log" | tail -1)
  [ "$sum" = "SUMMARY: $E2E_BASE_PASSED passed, 0 failed" ] && [ "$(grep -cE '^FAIL ' "$T/e2e.log")" -eq 0 ] && ok "15 devnet groups e2e $sum" \
    || { no "15 devnet groups e2e '${sum:-no SUMMARY}' (want $E2E_BASE_PASSED passed, 0 failed) (log $T/e2e.log)"; grep -E '^(FAIL|SUMMARY)' "$T/e2e.log" | cut -c1-200; }
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

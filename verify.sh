#!/usr/bin/env bash
# verify.sh for the groups e2e fully on devnet: no request leaves this machine.
#  - The no-spaces member is a devnet account on :3020 (e2enospaces.regular.devnet.test), not a
#    real bsky.social account; the e2e's PLC resolver asks devnet's PLC only, with no plc.directory
#    fallback; E2E_PLC_URL is required and E2E_PDS and E2E_PLC_URL must be on loopback.
#  - Every request the worker sends passes a Miniflare outboundService that forwards loopback hosts
#    and refuses the rest (never with a 4xx, so check 18e can't pass on a refused public read); the
#    driver's own fetch is wrapped the same way. Numbered check 24 reports the ledger, so a clean
#    run ends SUMMARY: 50 passed, 0 failed.
#  - Bad config is refused before any request: no E2E_PLC_URL, a public E2E_PDS, a fixture DID that
#    devnet's PLC doesn't know.
# Decisions (TS, 2026-10-07): the new :3020 member (D1); devnet only, always (D2); count and refuse
# in a Miniflare outboundService (D3); check 24 (D4); one flock around every live run (D5); commits
# scoped test(devnet), dropped from the upstream PR with devnet mode (D6). risk:med.
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line and the last line is the tally. Checks 14-15 need the local atproto-devnet up
# (SKIP_DEVNET=1 skips them and counts each as a FAIL). Check 15 takes /tmp/groups-e2e-devnet.lock.
set -uo pipefail
unset -f grep sed awk 2>/dev/null || true
export NO_COLOR=1
WT=${VERIFY_WT:-/workspaces/scratch/wt-atmo-events-e2e-devnet}
WEB=$WT/apps/web
BASE=9d07415
E2E=scripts/groups-e2e.mjs
RES=scripts/groups-e2e.identity-resolver.ts
NET=scripts/groups-e2e.network.mjs
NET_TEST=scripts/groups-e2e.network.test.ts
LOCK=/tmp/groups-e2e-devnet.lock
NOSPACES=did:plc:kfb7njkg4t7azuy7v5gxkjc2   # e2enospaces.regular.devnet.test on :3020 (seeded 10-07)
OLD_NOSPACES=did:plc:piobscs63j5o53wzbgqidgj6 # the real bsky.social member this replaces
CRED=/workspaces/scratch/atproto-devnet/data/accounts.env
ALL_BASELINE=1163        # whole web suite at 9d07415: 1163 passed | 4 skipped
ALL_SKIPPED=4
SC_WARN_BASELINE=7       # svelte-check apps/web at 9d07415: 0 errors, 7 warnings
E2E_WARN_BASELINE=0      # WARN lines in the base run with the :3020 member: 0 (49 passed, 0 failed)
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree $WT"; exit 2; }
T=$(mktemp -d -t e2e-devnet.XXXXXX)
# The fixture environment, valid in every respect; a refusal case changes exactly one thing.
e2e() { env E2E_PDS=http://localhost:3010 E2E_PLC_URL=http://localhost:2592 \
  E2E_GROUP_DID=did:plc:yaqibeok2ndjg3msydda7hew E2E_GROUP_HANDLE=groups-e2e.devnet.test E2E_CREDENTIALS=$CRED \
  E2E_OWNER_DID=did:plc:qvhmv24soxqc6p43vi2zlfyk E2E_ADMIN_DID=did:plc:m3hbgtxcvzaoa62cvpptkqhu \
  E2E_OUTSIDER_DID=did:plc:ab24vlobxgdb5ohjpiy4pjml E2E_NOSPACES_DID=$NOSPACES "$@"; }

# 0. Built on the contract's base.
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT HEAD does not contain $BASE"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains $BASE"

# 1. Droppable from the upstream PR: at least two commits (the gate and the work), every subject
#    after the base scoped (devnet).
nsub=$(git rev-list --count $BASE..HEAD); off=$(git log --format=%s $BASE..HEAD | grep -cvE '^[a-z]+\(devnet\): ')
[ "$nsub" -ge 2 ] && [ "$off" -eq 0 ] && ok "1 $nsub commit(s) after the base, all scoped (devnet)" \
  || no "1 $nsub commit(s) after the base (want >=2), $off not scoped (devnet) (want 0)"

# 2. The touch-set: under apps/web and packages, exactly the e2e script, its resolver, and the new
#    guard module and its test.
allowed=$(printf 'apps/web/%s\n' $E2E $RES $NET $NET_TEST | LC_ALL=C sort)
changed=$( { git diff --name-only $BASE -- apps/web packages; git ls-files --others --exclude-standard -- apps/web packages; } | grep . | LC_ALL=C sort -u)
outside=$(comm -23 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
lacking=$(comm -13 <(printf '%s\n' "$changed" | grep .) <(printf '%s\n' "$allowed"))
[ -z "$outside" ] && [ -z "$lacking" ] && ok "2 changed under apps/web and packages: exactly the allowed $(printf '%s\n' "$changed" | grep -c .) file(s)" \
  || no "2 outside the allowed set: [$(echo "$outside" | tr '\n' ' ')]; allowed but unchanged: [$(echo "$lacking" | tr '\n' ' ')]"

# 3. Unchanged against the base: the worker entry and the other e2e stand-ins, all app source,
#    the configs, the manifest and the lockfile.
cd "$WEB"
keep=(scripts/groups-e2e.worker.ts scripts/groups-e2e.oauth.ts scripts/groups-e2e.app-environment.js src
      wrangler.jsonc vite.config.ts svelte.config.js package.json ../../pnpm-lock.yaml ../../packages)
present=0; missing=""
for p in "${keep[@]}"; do if [ -n "$(git ls-files -- "$p" | head -1)" ]; then present=$((present+1)); else missing="$missing $p"; fi; done
tot=$(git diff --numstat $BASE -- "${keep[@]}" | awk '{s+=$1+$2} END {print s+0}')
[ "$present" -eq ${#keep[@]} ] && [ "$tot" -eq 0 ] && ok "3 all ${#keep[@]} frozen paths present; numstat vs $BASE totals $tot lines" \
  || { no "3 $present of ${#keep[@]} frozen paths present (missing:${missing:- none}); numstat $tot lines (want ${#keep[@]} and 0)"; git diff --numstat $BASE -- "${keep[@]}" | head; }

# 4. A devnet-only resolver: the network fallback is gone and the PLC is still the build's define.
fb=$(grep -cE '#network|DocumentNotFoundError|new PackagePlcResolver\(options\)' $RES); df=$(grep -c 'apiUrl: __E2E_PLC_URL__' $RES)
[ "$fb" -eq 0 ] && [ "$df" -eq 1 ] && ok "4 $RES: fallback tokens 0x, apiUrl: __E2E_PLC_URL__ 1x" \
  || no "4 $RES: fallback tokens ${fb}x (want 0), apiUrl: __E2E_PLC_URL__ ${df}x (want 1)"

# 5. The script says what it does now: 50 numbered checks, a clean run's summary line, the
#    outbound hook, and no real-network fixture or fallback named in either file.
h1=$(grep -cF 'It runs 50 numbered checks' $E2E); h2=$(grep -cF 'SUMMARY: 50 passed, 0 failed' $E2E)
ob=$(grep -c 'outboundService' $E2E); rn=$(cat $E2E $RES | grep -cE 'bsky\.social|then plc\.directory')
[ "$h1" -eq 1 ] && [ "$h2" -eq 1 ] && [ "$ob" -ge 1 ] && [ "$rn" -eq 0 ] \
  && ok "5 $E2E: '50 numbered checks' 1x, 'SUMMARY: 50 passed, 0 failed' 1x, outboundService ${ob}x; bsky.social / 'then plc.directory' 0x" \
  || no "5 '50 numbered checks' ${h1}x, 'SUMMARY: 50 passed' ${h2}x (want 1 each), outboundService ${ob}x (want >=1), real-network names ${rn}x (want 0)"

# 6. The guard's own tests: at least six, all passing, in the new test file.
nout=$(npx vitest run $NET_TEST 2>&1)
nl=$(printf '%s\n' "$nout" | grep -E '^\s+Tests\s' | tail -1); nn=$(echo "$nl" | sed -nE 's/^\s+Tests\s+([0-9]+) passed \(([0-9]+)\)$/\1 \2/p')
if [ -n "$nn" ]; then set -- $nn; else set -- 0 1; fi
[ -n "$nn" ] && [ "$1" -eq "$2" ] && [ "$1" -ge 6 ] && ok "6 $NET_TEST:$(echo "$nl" | sed 's/^ *Tests//')" \
  || no "6 $NET_TEST: '${nl:-no Tests line}' (want >=6, all passed)"

# 7. The whole web suite: nothing fails, more passed than the baseline (the guard's tests are in
#    it), no more skipped.
aout=$(npx vitest run 2>&1)
aline=$(printf '%s\n' "$aout" | grep -E '^\s+Tests\s' | tail -1); afiles=$(printf '%s\n' "$aout" | grep -E '^\s+Test Files\s' | tail -1)
ap=$(echo "$aline" | sed -nE 's/^\s+Tests\s+([0-9]+) passed.*/\1/p'); as=$(echo "$aline" | sed -nE 's/.* ([0-9]+) skipped.*/\1/p'); as=${as:-0}
at=$(echo "$aline" | sed -nE 's/.*\(([0-9]+)\)$/\1/p')
if [ -n "$ap" ] && [ -n "$at" ] && ! echo "$aline $afiles" | grep -q 'failed' && [ $((ap + as)) -eq "$at" ] && [ "$ap" -gt $ALL_BASELINE ] && [ "$as" -le $ALL_SKIPPED ]; then
  ok "7 vitest web:$(echo "$aline" | sed 's/^ *Tests//'),$(echo "$afiles" | sed 's/^ *Test Files//') files (baseline $ALL_BASELINE passed, $ALL_SKIPPED skipped)"
else no "7 vitest web: '${aline:-no Tests line}' / '${afiles:-no Test Files line}' (want 0 failed, > $ALL_BASELINE passed, <= $ALL_SKIPPED skipped)"; fi

# 8. Type check: 0 errors, warnings no worse than the base.
sc=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep -E ' COMPLETED ' | tail -1)
e=$(echo "$sc" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+'); wn=$(echo "$sc" | grep -oE '[0-9]+ WARNINGS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && [ -n "$wn" ] && [ "$wn" -le $SC_WARN_BASELINE ] && ok "8 svelte-check: $e errors, $wn warnings (baseline 0, $SC_WARN_BASELINE)" \
  || no "8 svelte-check: '${sc:-no COMPLETED line}' (want 0 errors, <= $SC_WARN_BASELINE warnings)"

# 9. Formatting: prettier --check over the four files (it prints its all-clean line even for a
#    missing path, so count the files first).
pf=($E2E $RES $NET $NET_TEST); pe=0; for f in "${pf[@]}"; do [ -f "$f" ] && pe=$((pe+1)); done
pout=$(npx prettier --check "${pf[@]}" 2>&1)
if [ "$pe" -eq 4 ] && printf '%s\n' "$pout" | grep -qx 'All matched files use Prettier code style!' && ! printf '%s\n' "$pout" | grep -qiE 'no (files|matching)|error'; then
  ok "9 prettier clean on $pe existing file(s)"
else no "9 prettier: $pe of 4 file(s) exist; $(printf '%s\n' "$pout" | grep -E '^\[(warn|error)\]' | tr '\n' ' ')"; fi

# 10. Hygiene over $BASE..HEAD (messages and added lines, this script aside).
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
[ "$nadded" -ge 1 ] && [ "$bm" -eq 0 ] && [ "$at_" -eq 0 ] && [ "$om" -eq 0 ] && [ "$pv" -eq 0 ] && [ "$br" -eq 0 ] \
  && ok "10 $nadded added line(s) scanned: 0 bead ids, 0 attribution, 0 openmeet names, 0 'private', 0 British spellings" \
  || { no "10 added lines $nadded; bead ids $bm, attribution $at_, openmeet $om, 'private' $pv, British $br (want all 0)"; printf '%s\n' "$added" | grep -iE "$BEAD|openmeet|\bprivate\b" | head -5; }

# 11-13. Refused before any request (these write nothing, so they take no lock): each exits
#        nonzero, prints its refusal, and never gets as far as the fixture note or a login.
cd "$WEB"
refused() { local n=$1 want=$2; shift 2; "$@" >"$T/r$n.log" 2>&1; local rc=$?
  local w; w=$(grep -cF "$want" "$T/r$n.log"); local a; a=$(grep -cE 'authenticates|fixtures on devnet' "$T/r$n.log")
  [ "$rc" -ne 0 ] && [ "$w" -ge 1 ] && [ "$a" -eq 0 ] && ok "$n refused before any request (exit $rc): '$want'" \
    || { no "$n exit $rc (want nonzero), '$want' ${w}x (want >=1), login/fixture lines ${a}x (want 0) (log $T/r$n.log)"; tail -3 "$T/r$n.log"; }; }
# Without the guard module these cases would run for real (a public login, an unlocked live run),
# so they run only once it exists. The public PDS is a .invalid name, which never resolves, so even
# a broken guard sends nothing anywhere; the live-fixture case still takes the lock.
if [ ! -f $NET ]; then
  no "11 not run: no $NET"; no "12 not run: no $NET"; no "13 not run: no $NET"
else
  refused 11 'E2E_PLC_URL is not set' e2e env -u E2E_PLC_URL timeout 120 node $E2E
  refused 12 'REFUSED E2E_PDS https://e2e-refusal.invalid: not on this machine' e2e E2E_PDS=https://e2e-refusal.invalid timeout 120 node $E2E
  refused 13 "REFUSED fixture E2E_NOSPACES_DID $OLD_NOSPACES: not on the devnet PLC" e2e E2E_NOSPACES_DID=$OLD_NOSPACES flock -w 1800 $LOCK timeout 120 node $E2E
fi

# 14. Devnet is up, and the no-spaces member lives on :3020, as devnet's PLC says.
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "14 devnet checks skipped (SKIP_DEVNET=1)"; else
  h20=$(curl -s -m 5 http://localhost:3020/xrpc/_health | grep -c '"version"')
  pd=$(curl -s -m 5 http://localhost:2592/$NOSPACES | grep -c '"http://localhost:3020"')
  [ "$h20" -eq 1 ] && [ "$pd" -eq 1 ] && ok "14 devnet :3020 answers; $NOSPACES is hosted at http://localhost:3020 per devnet PLC" \
    || no "14 :3020 health ${h20}x, $NOSPACES on :3020 per devnet PLC ${pd}x (want 1 each)"
fi

# 15. The live devnet e2e, serialized with every other run: 50 passed, nothing left the machine,
#     18e read the no-spaces member's devnet PDS, and every fixture sits on devnet.
if [ "${SKIP_DEVNET:-0}" = 1 ]; then no "15 e2e skipped (SKIP_DEVNET=1)"; else
  e2e flock -w 1800 $LOCK timeout 900 node $E2E >"$T/e2e.log" 2>&1
  sum=$(grep -E '^SUMMARY: [0-9]+ passed, [0-9]+ failed$' "$T/e2e.log" | tail -1)
  nf=$(grep -cE '^FAIL ' "$T/e2e.log"); nr=$(grep -cE '^REFUSED ' "$T/e2e.log"); nw=$(grep -cE '^WARN ' "$T/e2e.log")
  netl=$(grep -cE '^PASS +no request left this machine: public 0; local [0-9]+ \(driver [1-9][0-9]*, worker [1-9][0-9]*\) to localhost:2592, localhost:3010, localhost:3020$' "$T/e2e.log")
  e18=$(grep -cF "their PDS http://localhost:3020 answers the group's space read 400 InvalidToken" "$T/e2e.log")
  fx=$(grep -cF 'fixtures on devnet: 5 DIDs on http://localhost:2592; PDS http://localhost:3010 x4, http://localhost:3020 x1' "$T/e2e.log")
  if [ "$sum" = "SUMMARY: 50 passed, 0 failed" ] && [ "$nf" -eq 0 ] && [ "$nr" -eq 0 ] && [ "$netl" -eq 1 ] && [ "$e18" -eq 1 ] && [ "$fx" -eq 1 ] && [ "$nw" -le $E2E_WARN_BASELINE ]; then
    ok "15 devnet e2e $sum; $(grep -oE 'no request left this machine: public 0; local [0-9]+ \(driver [0-9]+, worker [0-9]+\)' "$T/e2e.log"); 18e on :3020; fixtures on devnet; 0 FAIL, 0 REFUSED, $nw WARN"
  else
    no "15 devnet e2e '${sum:-no SUMMARY}' (want 50 passed, 0 failed); FAIL $nf, REFUSED $nr (want 0); network line ${netl}x, 18e on :3020 ${e18}x, fixture note ${fx}x (want 1 each); WARN $nw (want <= $E2E_WARN_BASELINE) (log $T/e2e.log)"
    grep -E '^(FAIL|REFUSED|WARN|SUMMARY)' "$T/e2e.log" | cut -c1-200
  fi
fi

echo "TALLY $pass passed, $fail failed"
[ "$fail" -eq 0 ]

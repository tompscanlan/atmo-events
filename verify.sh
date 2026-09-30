#!/usr/bin/env bash
# verify.sh for the move of group records and space types to group.opensocial.* (proposal d2c89a9).
# Frozen at fire. Run from anywhere; it cds into the worktree. Every check prints a positive
# artifact line; the last line is the tally. LIVE=1 also runs the alpha e2e (needs creds).
set -uo pipefail
WT=/workspaces/scratch/wt-atmo-events-opensocial
WEB=$WT/apps/web
PROP=/workspaces/scratch/opensocial-proposal
REF=$WEB/lexicons/reference/group/opensocial
SHIM=$WEB/lexicons/custom/group/opensocial/declaration.json
LIB=$WEB/src/lib/groups
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
cd "$WT" || { echo "ABORT no worktree"; exit 2; }

# 0. Built on the contract's base.
git merge-base --is-ancestor d2ec958 HEAD || { echo "ABORT HEAD does not contain d2ec958"; exit 2; }
ok "0 HEAD $(git rev-parse --short HEAD) contains d2ec958"

# 1. No old group or space NSID outside eventPermissions, tests and docs.
n=$(git grep -nE 'net\.openmeet\.(group|space)\.' -- apps/web ':!**/*.md' ':!**/*.test.ts' | grep -v eventPermissions | wc -l)
[ "$n" -eq 0 ] && ok "1 0 net.openmeet.{group,space} references outside eventPermissions" \
  || { no "1 $n net.openmeet.{group,space} references remain"; git grep -nE 'net\.openmeet\.(group|space)\.' -- apps/web ':!**/*.md' ':!**/*.test.ts' | grep -v eventPermissions | head -5; }

# 2. Every new NSID the groups code needs is a literal in the groups lib.
found=0
for id in meta members declaration profile rule role permissions membership access; do
  git grep -qF "'group.opensocial.$id'" -- 'apps/web/src/lib/groups' ':!**/*.test.ts' && found=$((found+1))
done
[ "$found" -eq 9 ] && ok "2 9/9 group.opensocial NSID literals in src/lib/groups" || no "2 $found/9 group.opensocial NSID literals"

# 3. Reference copies of the proposal lexicons, byte-identical to d2c89a9, outside codegen.
same=0
for f in declaration profile rule role permissions membership access defs; do
  [ -f "$REF/$f.json" ] && cmp -s "$REF/$f.json" <(git -C "$PROP" show "d2c89a9:lexicons/group/opensocial/$f.json") && same=$((same+1))
done
[ "$same" -eq 8 ] && ok "3 8/8 reference lexicons identical to d2c89a9" || no "3 $same/8 reference lexicons identical to d2c89a9"

# 4. The codegen shim differs from the reference only in meta.format (space-ref -> uri).
if [ -f "$SHIM" ] && [ -f "$REF/declaration.json" ]; then
  a=$(jq -S 'del(.defs.main.record.properties.meta.format)' "$SHIM" 2>/dev/null)
  b=$(jq -S 'del(.defs.main.record.properties.meta.format)' "$REF/declaration.json")
  fmt=$(jq -r '.defs.main.record.properties.meta.format' "$SHIM" 2>/dev/null)
  [ "$a" = "$b" ] && [ "$fmt" = "uri" ] && ok "4 shim equals reference except meta.format=uri" || no "4 shim differs beyond meta.format (format=$fmt)"
else
  no "4 missing $SHIM or reference declaration"
fi

# 5. A lexicon validation test exists and passes, one case or more per record builder.
vt=$(git grep -lF 'lexicons/reference/group/opensocial' -- 'apps/web/src/**/*.test.ts' | head -1)
if [ -n "$vt" ]; then
  out=$(cd "$WEB" && pnpm vitest run "${vt#apps/web/}" 2>&1 | grep -E '^\s+Tests\s')
  np=$(echo "$out" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+'); nf=$(echo "$out" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
  [ -n "$np" ] && [ "$np" -ge 7 ] && [ -z "$nf" ] && ok "5 $vt:$out" || no "5 $vt:${out:- no Tests line}"
else
  no "5 no test file reads lexicons/reference/group/opensocial"
fi

# 6. Full unit suite: no failures, and no fewer passing tests than the 857 baseline.
out=$(cd "$WEB" && pnpm vitest run 2>&1 | grep -E '^\s+(Test Files|Tests)\s')
np=$(echo "$out" | grep -E '^\s+Tests' | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+'); nf=$(echo "$out" | grep -oE '[0-9]+ failed' | head -1)
[ -n "$np" ] && [ "$np" -ge 857 ] && [ -z "$nf" ] && ok "6 vitest $(echo $out)" || no "6 vitest ${out:- no summary}"

# 7. svelte-check: 0 errors (the baseline at d2ec958 is 0 errors, 7 warnings).
line=$(cd "$WEB" && pnpm check 2>&1 | grep -E 'COMPLETED' | tail -1)
e=$(echo "$line" | grep -oE '[0-9]+ ERRORS' | grep -oE '[0-9]+')
[ -n "$e" ] && [ "$e" -eq 0 ] && ok "7 svelte-check: $(echo "$line" | grep -oE 'COMPLETED.*')" || no "7 svelte-check: ${line:- no COMPLETED line}"

# 8. Must not change: no migration touched; visibility is still a simplespace read policy.
m=$(git diff --name-only d2ec958 HEAD -- apps/web/migrations | wc -l)
p=$(grep -c 'simplespace.defs#publicPolicy' "$LIB/server/spaces.ts")
[ "$m" -eq 0 ] && [ "$p" -ge 1 ] && ok "8 $m migration files changed; publicPolicy still in spaces.ts ($p)" || no "8 migrations changed=$m publicPolicy refs=$p"

# 9. Docs follow the code.
r1=$(grep -c 'group.opensocial.meta' "$LIB/README.md"); r2=$(grep -c 'net.openmeet.space' "$LIB/README.md")
c=$(grep -c 'prefix change' "$LIB/about-record.ts" "$LIB/members-record.ts" | awk -F: '{s+=$2} END{print s}')
[ "$r1" -ge 1 ] && [ "$r2" -eq 0 ] && [ "$c" -eq 0 ] && ok "9 README names group.opensocial.meta ($r1), 0 old space names, 0 'prefix change' comments" \
  || no "9 README meta=$r1 old=$r2 prefix-change comments=$c"

# 10. The action rename landed.
g=$(grep -c "'group.configure'" "$LIB/permissions.ts"); k=$(grep -c "community.configure" "$LIB/permissions.ts")
[ "$g" -ge 1 ] && [ "$k" -eq 0 ] && ok "10 permissions.ts publishes group.configure ($g), community.configure 0" || no "10 group.configure=$g community.configure=$k"

# 11. Live e2e on the alpha PDS (only with LIVE=1; needs the e2e-fixture exports).
if [ "${LIVE:-0}" = "1" ]; then
  # Stamped baseline at d2ec958 on 2026-09-30: 24 passed, 2 failed. Both failures are fixture
  # drift: the fixture group's public repo keeps a third, deliberately kept event, and
  # checks 21-22 count exactly two. Any failure outside these two labels is new.
  log=$(node apps/web/scripts/groups-e2e.mjs 2>&1)
  s=$(echo "$log" | grep -E '^SUMMARY:' | tail -1)
  np=$(echo "$s" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
  new=$(echo "$log" | grep -E '^FAIL  ' | sed -E 's/^FAIL  ([^:]*).*/\1/' \
    | grep -vxF -e "the events tab reads the group's events from the index, edits included" \
                -e "an event written after the backfill is indexed at once, and a deletion drops it" | wc -l)
  [ -n "$np" ] && [ "$np" -ge 24 ] && [ "$new" -eq 0 ] && ok "11 e2e $s (0 failures outside the 2 baseline fixture-drift labels)" \
    || { no "11 e2e ${s:- no SUMMARY line}; $new failure(s) outside the baseline"; echo "$log" | grep -E '^FAIL  ' | head -5; }
else
  echo "SKIP 11 e2e (set LIVE=1 with the e2e-fixture exports)"
fi

echo "TALLY pass=$pass fail=$fail"

# Shared gates for om-3r2nx.23 units. Sourced by verify.sh; run from the repo root.
BASE=f4987af
fail() { echo "FAIL: $*"; FAILED=1; }
pass() { echo "PASS: $*"; }
git merge-base --is-ancestor $BASE HEAD || { echo "ABORT: $BASE is not an ancestor of HEAD"; exit 2; }
cd apps/web
npx svelte-kit sync >/dev/null 2>&1
SC=$(npx svelte-check --tsconfig ./tsconfig.json --output machine 2>&1 | grep COMPLETED)
echo "svelte-check: $SC"
E=$(echo "$SC" | sed -E 's/.* ([0-9]+) ERRORS .*/\1/'); W=$(echo "$SC" | sed -E 's/.* ([0-9]+) WARNINGS .*/\1/')
[ -n "$SC" ] && [ "$E" = 0 ] && [ "$W" -le 7 ] && pass "svelte-check 0 errors, $W warnings (<=7)" || fail "svelte-check: $SC"
VT=$(npx vitest run 2>&1 | grep -E '^\s+Tests ')
echo "vitest: $VT"
echo "$VT" | grep -q -E 'Tests +[0-9]+ passed' && ! echo "$VT" | grep -q failed && pass "vitest all passed" || fail "vitest: $VT"
CE=$(npm run -s check:e2e 2>&1 | tail -1); echo "check:e2e: $CE"
[ "$CE" = "groups e2e worker: bundles" ] && pass "check:e2e bundles" || fail "check:e2e: $CE"
CHANGED=$(git diff --name-only --diff-filter=AM $BASE -- . | sed 's#^apps/web/##' | grep -E '\.(ts|svelte|mjs|js)$' || true)
if [ -n "$CHANGED" ]; then
  npx prettier --check $CHANGED >/dev/null 2>&1 && pass "prettier on $(echo $CHANGED | wc -w) changed files" || fail "prettier"
  npx eslint $CHANGED >/dev/null 2>&1 && pass "eslint on changed files" || fail "eslint"
else echo "no changed source files"; fi

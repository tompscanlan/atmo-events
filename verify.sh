#!/usr/bin/env bash
# Frozen verification recipe for this branch. Committed first, deleted before the merge request.
# Every check asserts on a positive artifact (a count, a summary line), never on a bare exit code.
set -uo pipefail
BASE=f28529aff6a9a7a3c715a27d5e2bd72d9deb5307
ROOT=$(git rev-parse --show-toplevel)
WEB="$ROOT/apps/web"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
count() { grep -cE "$1" "$2" 2>/dev/null || true; }

# 0. The tree this contract describes.
if ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
	echo "ABORT base $BASE is not an ancestor of HEAD"; exit 2
fi
pass "base ${BASE:0:7} is an ancestor of HEAD $(git -C "$ROOT" rev-parse --short HEAD)"

# 1. Groups suite: zero failures, and the contract's cases exist in the files it names.
(cd "$WEB" && npx vitest run src/lib/groups --reporter=json --outputFile="$TMP/v.json" >/dev/null 2>&1)
if [ -s "$TMP/v.json" ]; then
	python3 - "$TMP/v.json" > "$TMP/v.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
per = {}
for r in d["testResults"]:
    name = r["name"].split("apps/web/")[-1]
    per[name] = sum(1 for a in r["assertionResults"] if a["status"] == "passed")
def total(pred):
    return sum(n for f, n in per.items() if pred(f))
checks = [
    ("suite failures == 0", d["numFailedTests"] == 0 and d["numFailedTestSuites"] == 0,
     f"{d['numFailedTests']} failed tests, {d['numFailedTestSuites']} failed files"),
    ("suite passed >= 350 (345 base - repo.test.ts:314 + B1-B3, N1, N2, declare-never-notifies)",
     d["numPassedTests"] >= 350,
     f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(per)} files"),
    ("repo.test.ts passed >= 24 (22 base - :314 + B1, B2, B3)",
     total(lambda f: f.endswith("server/repo.test.ts")) >= 24,
     f"{total(lambda f: f.endswith('server/repo.test.ts'))} passed"),
    ("declaration*.test.ts passed >= 13 (10 base + N1, N2, declare-never-notifies)",
     total(lambda f: "/declaration" in f and f.endswith(".test.ts")) >= 13,
     f"{total(lambda f: '/declaration' in f and f.endswith('.test.ts'))} passed"),
]
for label, ok, detail in checks:
    print(("PASS  " if ok else "FAIL  ") + f"{label} -- {detail}")
PY
	cat "$TMP/v.out"
	FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/v.out")))
else
	fail "vitest produced no JSON report"
fi

# 2. Structure the contract names.
RP="$WEB/src/lib/groups/server/repo.ts"
DW="$WEB/src/lib/groups/server/declaration-writer.ts"
n=$(count "row\.visibility !== 'private'" "$RP"); m=$(count 'export async function listGroups' "$RP")
[ "${m:-0}" = 1 ] && [ "$n" = 0 ] && pass "listGroups exists and carries no visibility guard (0 hits)" || fail "listGroups guard still present ($n hits) or listGroups missing ($m)"
n=$(count 'notifyOfUpdate' "$DW"); [ "${n:-0}" -ge 1 ] && pass "declaration-writer.ts notifies the index ($n)" || fail "declaration-writer.ts never names notifyOfUpdate"

# 3. Typecheck: the COMPLETED line must say 0 ERRORS (baseline at BASE: 0 errors, 6 warnings).
(cd "$WEB" && npx svelte-kit sync >/dev/null 2>&1; npx svelte-check --tsconfig ./tsconfig.json --output machine > "$TMP/sc.out" 2>&1)
line=$(grep ' COMPLETED ' "$TMP/sc.out" | tail -1)
echo "$line" | grep -q ' 0 ERRORS' && pass "svelte-check: ${line#* COMPLETED }" || fail "svelte-check: ${line:-no COMPLETED line}"

# 4. Upstream hygiene: no tracker ids, AC labels or branding outside NSIDs.
git -C "$ROOT" diff "$BASE"...HEAD -- . ':!verify.sh' | grep '^+' | grep -v '^+++' > "$TMP/added"
git -C "$ROOT" log --format=%B "$BASE"..HEAD > "$TMP/msgs"
git -C "$ROOT" rev-parse --abbrev-ref HEAD > "$TMP/branch"
added=$(wc -l < "$TMP/added")
hits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]*//g' \
	| grep -ciE '\bom-[a-z0-9]{4,5}\b|openmeet|claude-session|co-authored-by' || true)
achits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | grep -cE '\bAC[0-9]' || true)
[ "$added" -gt 0 ] && [ "$hits" = 0 ] && [ "$achits" = 0 ] \
	&& pass "hygiene: $added added lines + $(git -C "$ROOT" rev-list --count "$BASE"..HEAD) commit messages + branch scanned, 0 hits" \
	|| fail "hygiene: $added added lines scanned, $hits id/branding hits, $achits AC-label hits"

echo
if [ "$FAILS" = 0 ]; then echo "VERIFY RESULT: ALL PASS"; exit 0; fi
echo "VERIFY RESULT: $FAILS FAIL(S)"; exit 1

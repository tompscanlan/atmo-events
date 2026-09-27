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
    ("suite passed >= 354 (345 base + 9 contract cases)", d["numPassedTests"] >= 354,
     f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(per)} files"),
    ("create-group.test.ts passed >= 28 (24 base + S1a, S1b, S2 x2)",
     total(lambda f: f.endswith("groups/create-group.test.ts")) >= 28,
     f"{total(lambda f: f.endswith('groups/create-group.test.ts'))} passed"),
    ("spaces.test.ts passed >= 7 (base; :65 rewritten, not dropped)",
     total(lambda f: f.endswith("server/spaces.test.ts")) >= 7,
     f"{total(lambda f: f.endswith('server/spaces.test.ts'))} passed"),
    ("update-group.test.ts passed >= 5 (S3 x2, S4, S5, S6)",
     total(lambda f: f.endswith("update-group.test.ts")) >= 5,
     f"{total(lambda f: f.endswith('update-group.test.ts'))} passed"),
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
S="$WEB/src/lib/groups/server/spaces.ts"
U="$WEB/src/lib/groups/update-group.ts"
R="$WEB/src/lib/groups/groups.remote.ts"
n=$(count 'publicRead: true' "$S"); [ -f "$S" ] && [ "$n" = 0 ] && pass "spaces.ts no longer hard-codes publicRead: true (0 hits)" || fail "spaces.ts still hard-codes publicRead: true ($n hits)"
n=$(count 'export (async )?function runUpdateGroup' "$U"); [ "${n:-0}" -ge 1 ] && pass "update-group.ts exports runUpdateGroup ($n)" || fail "update-group.ts does not export runUpdateGroup"
n=$(count 'runUpdateGroup' "$R"); [ "${n:-0}" -ge 1 ] && pass "groups.remote.ts delegates to runUpdateGroup ($n)" || fail "groups.remote.ts does not call runUpdateGroup"
n=$(git -C "$ROOT" grep -c 'simplespace.updateSpace' -- 'apps/web/src/*.ts' ':!*.test.ts' | awk -F: '{s+=$2} END {print s+0}')
[ "$n" -ge 1 ] && pass "non-test code calls simplespace.updateSpace ($n)" || fail "no non-test call to simplespace.updateSpace"

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

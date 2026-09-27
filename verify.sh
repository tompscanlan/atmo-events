#!/usr/bin/env bash
# Frozen verification recipe for this branch (off feat/groups; anchored on that base so a back-merge keeps it valid). Committed first, deleted before the merge request.
# Every check asserts on a positive artifact (a count, a summary line), never on a bare exit code.
set -uo pipefail
BASE=fd4d252f3bd64ef2048cae90abfe35f03b305282
ROOT=$(git rev-parse --show-toplevel)
WEB="$ROOT/apps/web"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
# Matches in non-test, non-fixture code under apps/web/src (optionally one file), summed.
src_count() {
	local pat=$1 path=${2:-'apps/web/src/*.ts'}
	git -C "$ROOT" grep -cE "$pat" -- "$path" ':!*.test.ts' ':!*__fixtures__*' | awk -F: '{s+=$NF} END {print s+0}'
}

# 0. The tree this contract describes.
if ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
	echo "ABORT base $BASE is not an ancestor of HEAD"; exit 2
fi
pass "base ${BASE:0:7} is an ancestor of HEAD $(git -C "$ROOT" rev-parse --short HEAD)"

# 1. Groups + routes suites: zero failures, and the contract's cases exist in the files it names.
#    Base fd4d252: 476 passed in 40 files. Floors = base + the 15 contract cases, less the one
#    row-driven invite-only case the contract says is rewritten.
(cd "$WEB" && npx vitest run src/lib/groups src/routes --reporter=json --outputFile="$TMP/v.json" >/dev/null 2>&1)
if [ -s "$TMP/v.json" ]; then
	python3 - "$TMP/v.json" > "$TMP/v.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
per = {}
for r in d["testResults"]:
    name = r["name"].split("apps/web/")[-1]
    per[name] = sum(1 for a in r["assertionResults"] if a["status"] == "passed")
def total(suffix):
    return sum(n for f, n in per.items() if f.endswith(suffix))
checks = [
    ("suite failures == 0", d["numFailedTests"] == 0 and d["numFailedTestSuites"] == 0,
     f"{d['numFailedTests']} failed tests, {d['numFailedTestSuites']} failed files"),
    ("suite passed >= 490 (476 at base + 15 contract cases - 1 rewritten)", d["numPassedTests"] >= 490,
     f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(per)} files"),
    ("route-context.test.ts passed >= 12 (7 + page gate G1-G5)",
     total("server/route-context.test.ts") >= 12, f"{total('server/route-context.test.ts')} passed"),
    ("access.test.ts passed >= 5 (5 rewritten to the new signature, covering M1-M2)",
     total("groups/access.test.ts") >= 5, f"{total('groups/access.test.ts')} passed"),
    ("repo.test.ts passed >= 29 (27 - 1 row-driven invite-only + join refusal J1-J3)",
     total("server/repo.test.ts") >= 29, f"{total('server/repo.test.ts')} passed"),
    ("update-group.test.ts passed >= 11 (9 + host-first order H1, failed updateSpace H2)",
     total("groups/update-group.test.ts") >= 11, f"{total('groups/update-group.test.ts')} passed"),
    ("repair.test.ts passed >= 17 (14 + Repair aligns to the host P1-P3)",
     total("server/repair.test.ts") >= 17, f"{total('server/repair.test.ts')} passed"),
    ("roster.test.ts passed >= 27 (no regression)",
     total("server/roster.test.ts") >= 27, f"{total('server/roster.test.ts')} passed"),
    ("create-group.test.ts passed >= 31 (no regression)",
     total("groups/create-group.test.ts") >= 31, f"{total('groups/create-group.test.ts')} passed"),
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
# 2a. The host is asked: non-test code calls simplespace.getSpace, through the reader seam.
n=$(src_count "xrpc/com\.atproto\.simplespace\.getSpace['\"\`]")
[ "$n" -ge 1 ] && pass "non-test code calls simplespace.getSpace ($n)" || fail "no non-test call to simplespace.getSpace"
n=$(src_count 'getSpace\(' 'apps/web/src/lib/groups/server/about-read.ts')
[ "$n" -ge 2 ] && pass "about-read.ts declares and implements getSpace ($n)" || fail "about-read.ts getSpace seam: $n hits, want >= 2"
# 2b. The row no longer gates (R9): no group.visibility comparison in the gate, the route or the join refusal.
n=0
for f in access.ts server/route-context.ts server/repo.ts; do
	n=$((n + $(src_count 'group\.visibility\s*(===|!==)' "apps/web/src/lib/groups/$f")))
done
[ "$n" = 0 ] && pass "no group.visibility comparison in access.ts, route-context.ts or repo.ts" \
	|| fail "$n group.visibility comparison(s) left in access.ts / route-context.ts / repo.ts"
echo "      R9 listing now:"; git -C "$ROOT" grep -nE '\.visibility\s*(===|!==)' -- apps/web/src ':!*.test.ts' ':!*.svelte' | sed 's/^/        /'
# 2c. A failed host read is a 503 with the contract's words (R2).
n=$(src_count 'visibility could not be checked')
[ "$n" -ge 1 ] && pass "non-test code says 'visibility could not be checked' ($n)" || fail "no 'visibility could not be checked' in non-test code"
# 2d. Repair and the route never write the host's read policy (R8).
n=$(( $(src_count 'updateSpace|setAboutSpaceReadPolicy' 'apps/web/src/lib/groups/server/repair.ts') + $(src_count 'updateSpace|setAboutSpaceReadPolicy' 'apps/web/src/lib/groups/server/route-context.ts') ))
[ "$n" = 0 ] && pass "repair.ts and route-context.ts make no updateSpace call" || fail "$n updateSpace reference(s) in repair.ts / route-context.ts"
# 2e. The row-restore stop-gap is deleted, not layered on (carry-in): no write of the old visibility back.
n=$(src_count 'visibility:\s*group\.visibility' 'apps/web/src/lib/groups/update-group.ts')
[ "$n" = 0 ] && pass "update-group.ts no longer puts the previous visibility back" || fail "update-group.ts still restores group.visibility ($n)"

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

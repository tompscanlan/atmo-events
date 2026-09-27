#!/usr/bin/env bash
# Frozen verification recipe for this branch (off feat/groups; anchored on that base so a back-merge keeps it valid). Committed first, deleted before the merge request.
# Every check asserts on a positive artifact (a count, a summary line, a named passing test), never on a bare exit code.
set -uo pipefail
BASE=9d6c60181621f4e7770a7587375544452e3aa125
ROOT=$(git rev-parse --show-toplevel)
WEB="$ROOT/apps/web"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
# Matches in non-test, non-fixture code (optionally one path), summed.
src_count() {
	local pat=$1 path=${2:-'apps/web/src/*.ts'}
	git -C "$ROOT" grep -cE "$pat" -- "$path" ':!*.test.ts' ':!*__fixtures__*' | awk -F: '{s+=$NF} END {print s+0}'
}

# 0. The tree this contract describes.
if ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
	echo "ABORT base $BASE is not an ancestor of HEAD"; exit 2
fi
pass "base ${BASE:0:7} is an ancestor of HEAD $(git -C "$ROOT" rev-parse --short HEAD)"
dirty=$(git -C "$ROOT" status --porcelain --untracked-files=normal | grep -c . || true)
[ "$dirty" = 0 ] && pass "clean tree at $(git -C "$ROOT" rev-parse HEAD): 0 uncommitted paths, so every check below grades the committed HEAD" \
	|| fail "$dirty uncommitted path(s): commit first, because the diff checks and the working-file checks would grade different trees"

# 1. Groups + routes suites: zero failures, no mass deletion, and every contract case present BY NAME and passing.
#    Base 9d6c601: 495 passed in 40 files. The floor allows the rewrites the contract names
#    (the two trigger cases, the unknown-visibility case, rebuild's placement cases, the stale-form refusal).
(cd "$WEB" && npx vitest run src/lib/groups src/routes --reporter=json --outputFile="$TMP/v.json" >/dev/null 2>&1)
if [ -s "$TMP/v.json" ]; then
	python3 - "$TMP/v.json" > "$TMP/v.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
passed = {}
for r in d["testResults"]:
    for a in r["assertionResults"]:
        if a["status"] == "passed":
            passed.setdefault(a["title"], r["name"].split("apps/web/")[-1])
checks = [
    ("suite failures == 0", d["numFailedTests"] == 0 and d["numFailedTestSuites"] == 0,
     f"{d['numFailedTests']} failed tests, {d['numFailedTestSuites']} failed files"),
    ("suite passed >= 485 (495 at base, less the named rewrites, plus the contract cases)",
     d["numPassedTests"] >= 485, f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(d['testResults'])} files"),
]
NAMED = [
    "the groups table has no visibility column",
    "no trigger ties approval to visibility",
    "the browse index does not key on visibility",
    "a rebuild does not derive visibility",
    "whether to declare is decided from the visibility choice",
    "create refuses a private group that is open to join before any write",
    "a settings save refuses a private group that is open to join before any write",
    "a settings save writes the host, the declaration, the profile and the rules in that order, and no row visibility",
    "repair writes no visibility to the row",
    "the group page loads the visibility its host reports",
    "browse marks a group private when the caller sees it only through their own undeclared groups",
    # Fix round: a private group's join policy is derived from the host, never stored.
    "a private group shows invite-only whatever its profile says",
    "a group whose visibility is unknown shows invite-only",
    "the group cache follows the profile join policy, with no private override",
    "a private group refuses a join whatever its cached approval says",
    # Fix round: the page loader, per caller class.
    "a stranger's page reuses the gate's answer and asks the host once",
    "a member's page loads with no visibility when the host cannot say",
    "an owner's page loads with no visibility when the deployment holds no credential",
]
for t in NAMED:
    checks.append((f"case passes: '{t}'", t in passed, passed.get(t, "not found or not passing")))
for label, ok, detail in checks:
    print(("PASS  " if ok else "FAIL  ") + f"{label} -- {detail}")
PY
	cat "$TMP/v.out"
	FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/v.out")))
else
	fail "vitest produced no JSON report"
fi

# 2. The reset, rehearsed. Old schema (BASE) seeded with a group, a member, a join request, a
#    permission and a credential, beside stand-ins for contrail's tables. Then the live reset's two
#    statements, then THIS tree's schema applied twice (it runs on every cold isolate), then a new group.
mkdir -p "$TMP/base"
for f in 0001_groups.sql 0002_group_credentials.sql; do
	git -C "$ROOT" show "$BASE:apps/web/migrations/$f" > "$TMP/base/$f"
done
cat > "$TMP/rehearse.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const [baseDir, headDir] = process.argv.slice(2);
const FILES = ['0001_groups.sql', '0002_group_credentials.sql'];
// The same split rule as src/lib/groups/server/schema.ts.
const split = (sql) => sql.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m).map((s) => s.trim())
	.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s));
const apply = (db, dir) => { for (const f of FILES) for (const s of split(readFileSync(`${dir}/${f}`, 'utf8'))) db.exec(s); };
const out = (ok, msg) => console.log(`${ok ? 'PASS' : 'FAIL'}  reset rehearsal: ${msg}`);
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec('CREATE TABLE identities (did TEXT PRIMARY KEY)');
db.exec("INSERT INTO identities VALUES ('did:plc:someone')");
db.exec('CREATE TABLE records (uri TEXT PRIMARY KEY)');
db.exec("INSERT INTO records VALUES ('at://did:plc:someone/community.lexicon.calendar.event/1')");
apply(db, baseDir);
const now = Date.now();
const newGroup = (id, did) => db.prepare(
	'INSERT INTO groups (id, group_did, owner_did, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
).run(id, did, 'did:plc:owner', 'G', now, now);
newGroup('g1', 'did:plc:group1');
const owner = db.prepare("SELECT id FROM roles WHERE group_id = 'g1' AND is_owner = 1").get().id;
db.prepare("INSERT INTO roles (id, group_id, name, is_owner) VALUES ('r-member', 'g1', 'member', 0)").run();
db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('r-member', 'post')").run();
db.prepare('INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
	.run('m-owner', 'g1', 'did:plc:owner', owner, now, now);
db.prepare('INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
	.run('m-member', 'g1', 'did:plc:member', 'r-member', now, now);
db.prepare('INSERT INTO join_requests (id, group_id, did, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
	.run('j1', 'g1', 'did:plc:asker', now, now);
db.prepare('INSERT INTO group_credentials (group_did, service, identifier, secret, iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
	.run('did:plc:group1', 'https://pds.example', 'group1', 'x', 'y', now, now);
const seeded = ['roles', 'role_permissions', 'memberships', 'join_requests'].map((t) => `${t}=${count(db, t)}`).join(' ');
out(seeded === 'roles=2 role_permissions=1 memberships=2 join_requests=1', `seeded old schema: ${seeded}`);
try {
	db.exec('DROP TABLE groups');
	db.exec('DROP TABLE group_credentials');
	out(true, 'DROP TABLE groups; DROP TABLE group_credentials ran clean');
} catch (e) {
	out(false, `the reset statements threw: ${e.message}`);
	process.exit(0);
}
const left = ['roles', 'role_permissions', 'memberships', 'join_requests'].map((t) => `${t}=${count(db, t)}`).join(' ');
out(left === 'roles=0 role_permissions=0 memberships=0 join_requests=0', `the cascade emptied the child tables: ${left}`);
const kept = `identities=${count(db, 'identities')} records=${count(db, 'records')}`;
out(kept === 'identities=1 records=1', `contrail's tables untouched: ${kept}`);
apply(db, headDir);
apply(db, headDir);
out(true, "this tree's schema applied twice over the reset database");
const cols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
out(cols.length > 0 && !cols.includes('visibility'), `groups columns (${cols.length}): ${cols.join(', ')}`);
const trig = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'groups_private_requires_approval%'").all();
const allTrig = count(db, "sqlite_master WHERE type = 'trigger'");
out(allTrig > 0 && trig.length === 0, `${allTrig} triggers, ${trig.length} named groups_private_requires_approval_*`);
const idx = db.prepare("PRAGMA index_info('groups_browse')").all().map((c) => c.name);
out(idx.length > 0 && !idx.includes('visibility'), `groups_browse keys on: ${idx.join(', ') || '(no such index)'}`);
newGroup('g2', 'did:plc:group2');
const seededOwner = count(db, "roles WHERE group_id = 'g2' AND is_owner = 1");
out(seededOwner === 1, `a group created after the reset gets its owner role (${seededOwner})`);
console.log('REHEARSAL COMPLETE');
JS
(cd "$WEB" && node "$TMP/rehearse.mjs" "$TMP/base" "$WEB/migrations" 2>"$TMP/r.err") > "$TMP/r.out"
rc=$?
grep 'reset rehearsal' "$TMP/r.out"
FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/r.out")))
# A rehearsal that crashes part-way prints early PASS lines and no FAIL, so success needs all three:
# a clean exit, the completion marker, and every one of its 9 assertions reported.
n=$(grep -c 'reset rehearsal' "$TMP/r.out" || true)
if [ "$rc" = 0 ] && grep -q '^REHEARSAL COMPLETE$' "$TMP/r.out" && [ "$n" = 9 ]; then
	pass "reset rehearsal ran to completion: exit 0, marker present, $n of 9 assertions reported"
else
	fail "reset rehearsal did not complete: exit $rc, $n of 9 assertions reported, stderr: $(head -c 300 "$TMP/r.err")"
fi

# 3. Structure the contract names.
# 3a. The DDL no longer mentions visibility, and still defines the table.
n=$(git -C "$ROOT" grep -cE 'visibility|private_requires_approval' -- apps/web/migrations | awk -F: '{s+=$NF} END {print s+0}')
t=$(git -C "$ROOT" grep -c 'CREATE TABLE IF NOT EXISTS groups (' -- apps/web/migrations/0001_groups.sql | awk -F: '{s+=$NF} END {print s+0}')
[ "$t" = 1 ] && [ "$n" = 0 ] && pass "migrations define groups ($t) and mention visibility 0 times" \
	|| fail "migrations: groups defined $t time(s), $n visibility/private_requires_approval mention(s)"
# 3b. GroupRow carries no visibility property.
body=$(awk '/(interface|type) GroupRow[ {=<]/{on=1} on{print} on&&/^}/{exit}' "$WEB/src/lib/groups/types.ts")
lines=$(printf '%s\n' "$body" | grep -c .)
v=$(printf '%s\n' "$body" | grep -cE '^\s*(readonly\s+)?visibility\??:' || true)
[ "$lines" -gt 3 ] && [ "$v" = 0 ] && pass "GroupRow ($lines lines) has no visibility property" \
	|| fail "GroupRow: $lines lines read, $v visibility propert(ies)"
# 3c. The placement guess is gone from code and scripts.
n=$(git -C "$ROOT" grep -c visibilityFromPlacement -- apps/web | awk -F: '{s+=$NF} END {print s+0}')
[ -f "$WEB/src/lib/groups/server/rebuild.ts" ] && [ "$n" = 0 ] && pass "rebuild.ts present; visibilityFromPlacement appears 0 times" \
	|| fail "visibilityFromPlacement appears $n time(s)"
# 3d. No row write of visibility, and the stale-form refusal left with the column.
n=$(( $(src_count "push\('visibility'" 'apps/web/src/lib/groups/server/repo.ts') + $(src_count 'rowBehindHost' 'apps/web/src/lib/groups/update-group.ts') ))
[ -f "$WEB/src/lib/groups/update-group.ts" ] && [ "$n" = 0 ] && pass "repo.ts writes no visibility column; update-group.ts has no rowBehindHost" \
	|| fail "$n row-visibility write / rowBehindHost reference(s) left"
# 3e. The e2e scripts no longer read the row's visibility, and still parse.
n=$(git -C "$ROOT" grep -cE '\b(row|group)\.visibility\b' -- apps/web/scripts | awk -F: '{s+=$NF} END {print s+0}')
parsed=$(cd "$WEB" && node --check scripts/groups-e2e.mjs 2>&1 && echo PARSED)
[ "$n" = 0 ] && [ "$parsed" = PARSED ] && pass "groups-e2e.mjs parses; scripts read row/group .visibility 0 times" \
	|| fail "scripts: $n row/group .visibility read(s); parse: ${parsed:-no output}"
# 3f. Event-level visibility in the contrail layer is untouched.
n=$(git -C "$ROOT" diff --name-only "$BASE"...HEAD -- apps/web/src/lib/contrail | grep -c . || true)
m=$(git -C "$ROOT" ls-files apps/web/src/lib/contrail | grep -c .)
[ "$m" -gt 0 ] && [ "$n" = 0 ] && pass "src/lib/contrail: $m files, 0 changed" || fail "src/lib/contrail: $n of $m files changed"
# 3g. Nothing still says a private group's cached approval is forced (the clamp is gone, the policy is derived).
n=$(git -C "$ROOT" grep -ciE 'keeps requiring approval|whatever join policy the profile|private group must require approval.{0,40}(schema|trigger)' -- apps/web/src apps/web/scripts ':!*.test.ts' | awk -F: '{s+=$NF} END {print s+0}')
c=$(src_count 'export async function applyGroupCache' 'apps/web/src/lib/groups/server/repo.ts')
[ "$c" = 1 ] && [ "$n" = 0 ] && pass "applyGroupCache present; 0 comments claim a forced private approval" \
	|| fail "applyGroupCache defined $c time(s); $n comment(s) still claim a forced private approval"
# 3h. The e2e puts a PRIVATE read policy on the host, and proves absence by the not-found answer, not by any non-200.
e=$WEB/scripts/groups-e2e.mjs
m=$(grep -c 'memberListPolicy' "$e" || true)
nf=$(grep -c 'RecordNotFound' "$e" || true)
bad=$(grep -cE '\.status !== 200' "$e" || true)
[ "$m" -ge 1 ] && [ "$nf" -ge 1 ] && [ "$bad" = 0 ] && pass "groups-e2e: memberListPolicy $m, RecordNotFound $nf, bare '.status !== 200' absence checks 0" \
	|| fail "groups-e2e: memberListPolicy $m (want >= 1), RecordNotFound $nf (want >= 1), bare '.status !== 200' $bad (want 0)"
echo "      R9 listing now (information, not a gate):"
git -C "$ROOT" grep -nE '\w\.visibility\s*(===|!==)' -- apps/web/src ':!*.test.ts' ':!*.svelte' ':!apps/web/src/lib/contrail' | sed 's/^/        /'

# 4. Typecheck: the COMPLETED line must say 0 ERRORS (baseline at BASE: 0 errors, 6 warnings).
(cd "$WEB" && npx svelte-kit sync >/dev/null 2>&1; npx svelte-check --tsconfig ./tsconfig.json --output machine > "$TMP/sc.out" 2>&1)
line=$(grep ' COMPLETED ' "$TMP/sc.out" | tail -1)
echo "$line" | grep -q ' 0 ERRORS' && pass "svelte-check: ${line#* COMPLETED }" || fail "svelte-check: ${line:-no COMPLETED line}"

# 5. Upstream hygiene: no tracker ids, AC or case labels, or branding outside NSIDs.
git -C "$ROOT" diff "$BASE"...HEAD -- . ':!verify.sh' | grep '^+' | grep -v '^+++' > "$TMP/added"
git -C "$ROOT" log --format=%B "$BASE"..HEAD > "$TMP/msgs"
git -C "$ROOT" rev-parse --abbrev-ref HEAD > "$TMP/branch"
added=$(wc -l < "$TMP/added")
hits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]*//g' \
	| grep -ciE '\bom-[a-z0-9]{4,5}\b|openmeet|claude-session|co-authored-by' || true)
achits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | grep -cE '\b(AC|R|X)[0-9]{1,2}\b' || true)
[ "$added" -gt 0 ] && [ "$hits" = 0 ] && [ "$achits" = 0 ] \
	&& pass "hygiene: $added added lines + $(git -C "$ROOT" rev-list --count "$BASE"..HEAD) commit messages + branch scanned, 0 hits" \
	|| fail "hygiene: $added added lines scanned, $hits id/branding hits, $achits AC/case-label hits"

echo
if [ "$FAILS" = 0 ]; then echo "VERIFY RESULT: ALL PASS"; exit 0; fi
echo "VERIFY RESULT: $FAILS FAIL(S)"; exit 1

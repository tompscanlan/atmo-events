#!/usr/bin/env bash
# Frozen verification recipe for this branch (off feat/groups). Committed first, deleted before the merge request.
# Every check asserts on a positive artifact (a count, a summary line, a named passing test), never on a bare exit code.
set -uo pipefail
BASE=99fdcf222f1d450dc971bac3492ae7fa5f7e52d4
ROOT=$(git rev-parse --show-toplevel)
WEB="$ROOT/apps/web"
PAGE_GATE="$WEB/src/routes/(app)/groups/[actor]/page.gate.test.ts"
BROWSE_GATE="$WEB/src/routes/(app)/groups/browse.gate.test.ts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$PAGE_GATE" "$BROWSE_GATE"' EXIT
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

# 0. The tree this contract describes.
if ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
	echo "ABORT base $BASE is not an ancestor of HEAD"; exit 2
fi
pass "base ${BASE:0:7} is an ancestor of HEAD $(git -C "$ROOT" rev-parse --short HEAD)"

# 1. Groups + routes suites: zero failures, the new cases added, and the one intended rewrite made.
#    Base 99fdcf2: 515 passed of 515 in 42 files.
(cd "$WEB" && npx vitest run src/lib/groups src/routes --reporter=json --outputFile="$TMP/v.json" >/dev/null 2>&1)
if [ -s "$TMP/v.json" ]; then
	python3 - "$TMP/v.json" > "$TMP/v.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
titles = {a["title"]: a["status"] for r in d["testResults"] for a in r["assertionResults"]}
checks = [
    ("suite failures == 0", d["numFailedTests"] == 0 and d["numFailedTestSuites"] == 0,
     f"{d['numFailedTests']} failed tests, {d['numFailedTestSuites']} failed files"),
    ("suite passed >= 520 (515 at base, plus the new cases)",
     d["numPassedTests"] >= 520, f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(d['testResults'])} files"),
]
OLD = "answers from the row when the members space errors, and grants nothing"
checks.append(("the row-fallback case is rewritten, not kept", OLD not in titles,
               "absent" if OLD not in titles else f"still present ({titles[OLD]})"))
KEPT = "marks the standing as unread, with the read error, so a form can say so"
checks.append((f"kept case passes: '{KEPT}'", titles.get(KEPT) == "passed", titles.get(KEPT, "absent")))
for label, ok, detail in checks:
    print(("PASS  " if ok else "FAIL  ") + f"{label} -- {detail}")
PY
	cat "$TMP/v.out"
	FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/v.out")))
else
	fail "vitest produced no JSON report"
fi

# 2. The frozen gate: the contract's behavior, asserted independently of the branch's own tests.
#    At base 99fdcf2: 6 failed (the defect) and 5 passed (the guards). DONE = 11 passed.
cat > "$PAGE_GATE" <<'GATE_EOF'
// Frozen gate for this branch, written by the recipe and deleted after the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/groups/server/handles', () => ({
	refreshGroupHandle: vi.fn(async () => null)
}));
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { groupSpaceReader, type GroupSpaceReader } from '$lib/groups/server/about-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupSpaceUris } from '$lib/groups/server/spaces';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { notAllowed } from '$lib/groups/form-error';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const REMOVED = 'did:plc:removed';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
const PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
const PRIVATE = 'com.atproto.simplespace.defs#memberListPolicy';

let harness: SqliteD1;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	harness = sqliteD1();
	const row = await createGroup(harness.db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await recordGroupSpaces(harness.db, row.id, groupSpaceUris(GROUP_DID));
	await addMember(harness.db, row.id, MEMBER, 'member');
	// A removal whose row delete failed: a row, and no record anywhere.
	await addMember(harness.db, row.id, REMOVED, 'member');
	logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	logged.mockRestore();
	vi.clearAllMocks();
});

/** A host whose members space fails every read while its about space answers,
 *  and whose read policy is `policy`, or fails with it. */
function membersDown(policy: string | Error) {
	const aboutReads: string[] = [];
	const asked: string[] = [];
	const reader: GroupSpaceReader = {
		async get(q) {
			if (q.space !== ABOUT) throw new Error('getRecord failed: 502');
			aboutReads.push(q.collection);
			return {
				uri: `${ABOUT}/${q.collection}/${q.rkey}`,
				cid: 'x',
				collection: q.collection,
				rkey: q.rkey,
				value: { displayName: 'PRIVATE SECRET', joinPolicy: 'invite' }
			};
		},
		async list(q) {
			if (q.space !== ABOUT) throw new Error('listRecords failed: 502');
			aboutReads.push(q.collection);
			return [];
		},
		async getSpace(space) {
			asked.push(space);
			if (policy instanceof Error) throw policy;
			return { readPolicy: policy };
		}
	};
	return { reader, aboutReads, asked };
}

async function openAs(did: string | null) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did },
		platform: { env: { DB: harness.db } }
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown> & {
		visibility: string | null;
		membership: { onRoster: boolean; unreadable?: string; role: string | null; permissions: Set<string> };
	};
}

const context = (did: string | null) =>
	groupRouteContext({ DB: harness.db } as never, harness.db, GROUP_DID, did);

describe('gate', () => {
	it('gate stale row private 404 and no profile read', async () => {
		const host = membersDown(PRIVATE);
		vi.mocked(groupSpaceReader).mockResolvedValue(host.reader);
		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 404,
			body: { message: 'Group not found' }
		});
		expect(host.aboutReads).toEqual([]);
	});

	it('gate stale row private 404 at the route context', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(membersDown(PRIVATE).reader);
		await expect(context(REMOVED)).rejects.toMatchObject({
			status: 404,
			body: { message: 'Group not found' }
		});
	});

	it('gate stale row unknown visibility 503', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(
			membersDown(new Error('getSpace failed: 502')).reader
		);
		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 503,
			body: { message: 'Group visibility could not be checked' }
		});
	});

	it('gate member of a public group reads as a stranger', async () => {
		const host = membersDown(PUBLIC);
		vi.mocked(groupSpaceReader).mockResolvedValue(host.reader);
		const data = await openAs(MEMBER);
		expect(data.visibility).toBe('public');
		expect(host.asked).toEqual([ABOUT]);
		expect(data.membership.onRoster).toBe(false);
		expect(data.membership.unreadable).toMatch(/502/);
		expect(data.membership.role).toBe('member');
		expect(data.membership.permissions.size).toBe(0);
		expect(data.canSeeMembers).toBe(false);
		expect(data.canManageGroup).toBe(false);
		expect(data.canAdmitMembers).toBe(false);
		expect(data.canCreateEvent).toBe(false);
		const refused = notAllowed(data.membership, 'MANAGE_GROUP');
		expect(!refused.ok && refused.error).toContain('could not be checked');
	});

	it('gate stranger private 404', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(membersDown(PRIVATE).reader);
		await expect(openAs(STRANGER)).rejects.toMatchObject({ status: 404 });
	});

	it('gate stranger unknown visibility 503', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(
			membersDown(new Error('getSpace failed: 502')).reader
		);
		await expect(openAs(STRANGER)).rejects.toMatchObject({ status: 503 });
	});

	it('gate stranger public 200', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(membersDown(PUBLIC).reader);
		expect((await openAs(STRANGER)).visibility).toBe('public');
	});

	it('gate no credential keeps the row answer', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(null);
		const ctx = await context(REMOVED);
		expect(ctx.membership.onRoster).toBe(true);
		await expect(context(STRANGER)).rejects.toMatchObject({ status: 404 });
	});
});
GATE_EOF

cat > "$BROWSE_GATE" <<'GATE_EOF'
// Frozen gate for this branch, written by the recipe and deleted after the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/groups/server/declaration-index', () => ({
	listDeclaredGroups: vi.fn(async () => [])
}));
vi.mock('$lib/groups/server/handles', () => ({
	knownHandles: vi.fn(async () => new Map())
}));
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { groupSpaceReader, type GroupSpaceReader } from '$lib/groups/server/about-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { spaceUri } from '$lib/groups/server/spaces';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '$lib/groups/types';

const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';

let harness: SqliteD1;
let db: D1Database;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
	logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	logged.mockRestore();
	vi.clearAllMocks();
});

async function withSpaces(name: string, groupDid: string, ownerDid: string) {
	const group = await createGroup(db, { groupDid, ownerDid, name });
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self'),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, 'self')
	});
	return group;
}

const down: GroupSpaceReader = {
	async get() {
		throw new Error('getRecord failed: 502');
	},
	async list() {
		throw new Error('listRecords failed: 502');
	},
	async getSpace() {
		throw new Error('getSpace failed: 502');
	}
};

async function browse() {
	return (await load({
		locals: { did: ALICE },
		platform: { env: { DB: db } }
	} as unknown as Parameters<typeof load>[0])) as {
		groups: { name: string | null; visibility: string | null }[];
	};
}

describe('gate', () => {
	it('gate browse leaves out a stale row when the members space errors', async () => {
		const g = await withSpaces('Stale', 'did:plc:stale', OWNER);
		await addMember(db, g.id, ALICE, 'member');
		await withSpaces('Mine', 'did:plc:mine', ALICE);
		vi.mocked(groupSpaceReader).mockResolvedValue(down);
		const names = (await browse()).groups.map((x) => x.name);
		expect(names).not.toContain('Stale');
		expect(names).toContain('Mine');
	});

	it('gate browse leaves out a stale row when the reader cannot be built', async () => {
		const g = await withSpaces('Stale', 'did:plc:stale', OWNER);
		await addMember(db, g.id, ALICE, 'member');
		await withSpaces('Mine', 'did:plc:mine', ALICE);
		vi.mocked(groupSpaceReader).mockRejectedValue(new Error('session login failed'));
		const names = (await browse()).groups.map((x) => x.name);
		expect(names).not.toContain('Stale');
		expect(names).toContain('Mine');
	});

	it('gate browse lists the owner own undeclared group without a check', async () => {
		await withSpaces('Mine', 'did:plc:mine', ALICE);
		vi.mocked(groupSpaceReader).mockResolvedValue(down);
		const data = await browse();
		expect(data.groups).toEqual([expect.objectContaining({ name: 'Mine', visibility: 'private' })]);
		expect(groupSpaceReader).not.toHaveBeenCalled();
	});
});
GATE_EOF
(cd "$WEB" && npx vitest run "src/routes/(app)/groups/[actor]/page.gate.test.ts" "src/routes/(app)/groups/browse.gate.test.ts" --reporter=json --outputFile="$TMP/g.json" >/dev/null 2>&1)
rm -f "$PAGE_GATE" "$BROWSE_GATE"
if [ -s "$TMP/g.json" ]; then
	python3 - "$TMP/g.json" > "$TMP/g.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
res = {a["title"]: a["status"] for r in d["testResults"] for a in r["assertionResults"]}
EXPECT = ["gate stale row private 404 and no profile read", "gate stale row private 404 at the route context",
          "gate stale row unknown visibility 503", "gate member of a public group reads as a stranger",
          "gate stranger private 404", "gate stranger unknown visibility 503", "gate stranger public 200",
          "gate no credential keeps the row answer",
          "gate browse leaves out a stale row when the members space errors",
          "gate browse leaves out a stale row when the reader cannot be built",
          "gate browse lists the owner own undeclared group without a check"]
for t in EXPECT:
    s = res.get(t, "absent")
    print(("PASS  " if s == "passed" else "FAIL  ") + f"{t} -- {s}")
PY
	cat "$TMP/g.out"
	n=$(grep -c '^PASS' "$TMP/g.out")
	[ "$n" = 11 ] && pass "frozen gate: $n/11 passed" || fail "frozen gate: $n/11 passed"
else
	fail "the frozen gate produced no JSON report"
fi

# 3. Structure the contract names.
# 3a. The comments that called the fallback intended are gone.
for spec in "src/lib/groups/server/route-context.ts|PDS blip" \
	"src/lib/groups/server/route-context.ts|roster row answers" \
	"src/lib/groups/types.ts|the row answered instead" \
	"src/routes/(app)/groups/+page.server.ts|is a read that failed, and the row"; do
	f="${spec%%|*}"; phrase="${spec#*|}"
	[ -f "$WEB/$f" ] || { fail "stale phrase check: $f missing"; continue; }
	k=$(grep -c "$phrase" "$WEB/$f" || true)
	[ "$k" = 0 ] && pass "stale phrase gone: '$phrase' in $f" || fail "stale phrase still present ($k): '$phrase' in $f"
done
# 3b. getCallerMembership and repo.ts: comment lines only.
code=$(git -C "$ROOT" diff -U0 "$BASE"...HEAD -- apps/web/src/lib/groups/server/repo.ts | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
	| grep -vE '^[+-][[:space:]]*(//|\*|/\*\*|\*/)' | grep -vE '^[+-][[:space:]]*$' | grep -c . || true)
[ "$code" = 0 ] && pass "repo.ts: comment lines only ($(git -C "$ROOT" diff --numstat "$BASE"...HEAD -- apps/web/src/lib/groups/server/repo.ts | awk '{print $1"+/"$2"-"}' | tr -d '\n' || true))" \
	|| fail "repo.ts: $code non-comment line(s) changed"
# 3c. Out of scope: the write gate, the form messages, the forms, the members and events loaders, access, roster, migrations, contrail.
for p in apps/web/src/lib/groups/server/event-writer.ts apps/web/src/lib/groups/form-error.ts \
	apps/web/src/lib/groups/groups.remote.ts "apps/web/src/routes/(app)/groups/[actor]/members/+page.server.ts" \
	"apps/web/src/routes/(app)/groups/[actor]/events/+page.server.ts" apps/web/src/lib/groups/access.ts \
	apps/web/src/lib/groups/server/roster.ts apps/web/migrations apps/web/src/lib/contrail; do
	m=$(git -C "$ROOT" ls-files "$p" | grep -c .)
	n=$(git -C "$ROOT" diff --name-only "$BASE"...HEAD -- "$p" | grep -c . || true)
	[ "$m" -gt 0 ] && [ "$n" = 0 ] && pass "$p: $m file(s), 0 changed" || fail "$p: $n of $m file(s) changed"
done

# 4. Typecheck: the COMPLETED line must say 0 ERRORS and no more than 6 warnings (baseline: 2372 files, 0 errors, 6 warnings).
(cd "$WEB" && npx svelte-kit sync >/dev/null 2>&1; npx svelte-check --tsconfig ./tsconfig.json --output machine > "$TMP/sc.out" 2>&1)
line=$(grep ' COMPLETED ' "$TMP/sc.out" | tail -1)
w=$(echo "$line" | sed -nE 's/.* ([0-9]+) WARNINGS.*/\1/p')
echo "$line" | grep -q ' 0 ERRORS' && [ -n "$w" ] && [ "$w" -le 6 ] \
	&& pass "svelte-check: ${line#* COMPLETED }" || fail "svelte-check: ${line:-no COMPLETED line} (want 0 errors, <= 6 warnings)"

# 5. Upstream hygiene: no tracker ids, AC or case labels, or branding outside NSIDs.
git -C "$ROOT" diff "$BASE"...HEAD -- . ':!verify.sh' | grep '^+' | grep -v '^+++' > "$TMP/added"
git -C "$ROOT" log --format=%B "$BASE"..HEAD > "$TMP/msgs"
git -C "$ROOT" rev-parse --abbrev-ref HEAD > "$TMP/branch"
added=$(wc -l < "$TMP/added")
hits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | sed -E 's/net\.openmeet\.[A-Za-z0-9.]*//g' \
	| grep -ciE '\bom-[a-z0-9]{4,5}\b|openmeet|claude-session|co-authored-by' || true)
achits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | grep -cE '\b(AC|R|X|N)[0-9]{1,2}\b' || true)
[ "$added" -gt 0 ] && [ "$hits" = 0 ] && [ "$achits" = 0 ] \
	&& pass "hygiene: $added added lines + $(git -C "$ROOT" rev-list --count "$BASE"..HEAD) commit messages + branch scanned, 0 hits" \
	|| fail "hygiene: $added added lines scanned, $hits id/branding hits, $achits AC/case-label hits"

echo
if [ "$FAILS" = 0 ]; then echo "VERIFY RESULT: ALL PASS"; exit 0; fi
echo "VERIFY RESULT: $FAILS FAIL(S)"; exit 1

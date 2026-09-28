#!/usr/bin/env bash
# Frozen verification recipe for this branch (off feat/groups). Committed first, deleted before the merge request.
# Every check asserts on a positive artifact (a count, a summary line, a named passing test), never on a bare exit code.
set -uo pipefail
BASE=f84a6e06b6cef2264720032e0e08ebca119b2cdc
ROOT=$(git rev-parse --show-toplevel)
WEB="$ROOT/apps/web"
GATE="$WEB/src/lib/groups/update-group.gate.test.ts"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$GATE"' EXIT
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

# 0. The tree this contract describes.
if ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
	echo "ABORT base $BASE is not an ancestor of HEAD"; exit 2
fi
pass "base ${BASE:0:7} is an ancestor of HEAD $(git -C "$ROOT" rev-parse --short HEAD)"

# 1. Groups + routes suites: zero failures, no mass deletion, and every named case present and passing.
#    Base f84a6e0: 500 passed in 42 files, 16 of them in update-group.test.ts.
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
    ("suite passed >= 505 (500 at base, plus the named cases, less rewrites)",
     d["numPassedTests"] >= 505, f"{d['numPassedTests']} passed of {d['numTotalTests']} in {len(d['testResults'])} files"),
]
NAMED = [
    "a stale form saved with its visibility untouched keeps the visibility its host has since taken",
    "a save that read public before a concurrent switch to private does not declare the group",
    "a switch to private whose withdrawal fails leaves the row as it was, and saving again finishes it",
    "a switch to private writes the host, withdraws the declaration, then writes the row, the profile and the rules",
    "a switch to public writes the row, reads the host again, then declares",
    "a form that could not show the visibility is refused when its choice differs from the host",
    "a form that could not show the visibility saves when its choice matches the host",
    "a changed choice that the host already holds makes no host write",
    "a group the host already reads as private, saved as private, withdraws its declaration without calling updateSpace",
]
for t in NAMED:
    where = passed.get(t)
    ok = where is not None and where.endswith("src/lib/groups/update-group.test.ts")
    checks.append((f"case passes in update-group.test.ts: '{t}'", ok, where or "not found or not passing"))
for label, ok, detail in checks:
    print(("PASS  " if ok else "FAIL  ") + f"{label} -- {detail}")
PY
	cat "$TMP/v.out"
	FAILS=$((FAILS + $(grep -c '^FAIL' "$TMP/v.out")))
else
	fail "vitest produced no JSON report"
fi

# 2. The frozen gate: the contract's behavior, asserted independently of the branch's own tests.
#    At base f84a6e0 it gave 6 failed (the defects) and 5 passed (the guards). DONE = 11 passed.
cat > "$GATE" <<'GATE_EOF'
// Frozen gate for this branch, written by the recipe and deleted after the run.
// It asserts the behavior the contract describes, independently of the
// branch's own tests. Its harness is a copy of update-group.test.ts at the base.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './server/__fixtures__/stub-pds';
import { storeGroupCredential, type GroupCredential } from './server/credentials';
import { createGroup, recordGroupSpaces } from './server/repo';
import { clearGroupSessions } from './server/session';
import { pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';
import { runUpdateGroup, type UpdateGroupData } from './update-group';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:settingsgroupaaaaaaaaaaa';
const HANDLE = 'kona.group.stub.test';
const KEY = btoa('0123456789abcdef0123456789abcdef');
const CRED: GroupCredential = {
	service: 'https://pds.stub.test',
	identifier: HANDLE,
	password: 'app-pass-1234'
};
const ABOUT = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
const DECL = 'net.openmeet.group.declaration';
const policy = (name: string) => ({ $type: `com.atproto.simplespace.defs#${name}` });
const pdsDown = () => Response.json({ error: 'InternalServerError' }, { status: 500 });

let harness: SqliteD1;
const env = { GROUP_CREDENTIAL_KEY: KEY };
beforeEach(() => {
	harness = sqliteD1();
	clearGroupSessions();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearGroupSessions();
	harness.close();
});

type Host = ReturnType<typeof stubPds>;
const host = (fail?: StubPdsOptions['fail']): Host =>
	stubPds({ did: GROUP_DID, handle: HANDLE, fail });

async function givenGroup(visibility: GroupVisibility, pds: Host, requireApproval = true) {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Trail Runners',
		requireApproval
	});
	await storeGroupCredential(env, harness.db, GROUP_DID, CRED);
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), visibility);
	await recordGroupSpaces(harness.db, row.id, uris);
	pds.clearLog();
	return {
		...row,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	} as GroupRow;
}

/** The form as the contract defines it: the chosen visibility and the one the
 *  page showed. `shown: null` is a page that could not show one. */
function save(
	group: GroupRow,
	visibility: GroupVisibility,
	shown: GroupVisibility | null,
	extra: Partial<UpdateGroupData> = {}
) {
	return runUpdateGroup(env, harness.db, group, OWNER, {
		name: 'Kona Trail Runners',
		visibility,
		...(shown === null ? {} : { shownVisibility: shown }),
		requireApproval: true,
		...extra
	} as UpdateGroupData);
}

async function declaredNow(): Promise<boolean> {
	const q = new URLSearchParams({ repo: GROUP_DID, collection: DECL, rkey: 'self' });
	return (await fetch(`${CRED.service}/xrpc/com.atproto.repo.getRecord?${q}`)).ok;
}

/** Another client moving the host's read policy, outside this app. */
async function moveHost(visibility: GroupVisibility, pds: Host) {
	const res = await fetch(`${CRED.service}/xrpc/com.atproto.simplespace.updateSpace`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space: ABOUT,
			readPolicy: policy(visibility === 'public' ? 'publicPolicy' : 'memberListPolicy')
		})
	});
	expect(res.ok).toBe(true);
	pds.clearLog();
}

const row = () =>
	harness.raw
		.prepare('SELECT name, description, updated_at FROM groups WHERE group_did = ?')
		.get(GROUP_DID) as { name: string; description: string | null; updated_at: number };
const updateSpaces = (pds: Host) =>
	pds.requests.filter((r) => r.nsid === 'com.atproto.simplespace.updateSpace');

/** Every host call in order, with the row's name at the moment it arrived. */
function tracing() {
	const seen: string[] = [];
	const observe: StubPdsOptions['fail'] = (nsid, init) => {
		const r = harness.raw.prepare('SELECT name FROM groups WHERE group_did = ?').get(GROUP_DID) as
			| { name: string }
			| undefined;
		let what = nsid.replace('com.atproto.', '');
		if (init?.body && typeof init.body === 'string') {
			try {
				const b = JSON.parse(init.body) as { collection?: string };
				if (b.collection) what += ` ${b.collection}`;
			} catch {
				/* not JSON */
			}
		}
		seen.push(`${what} (row ${r?.name})`);
		return undefined;
	};
	return { seen, observe };
}

describe('gate', () => {
	it('gate stale untouched', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', 'public')).toEqual({ ok: true });
		expect(await save(group, 'private', 'public')).toEqual({ ok: true });
		pds.clearLog();
		const result = await save(group, 'public', 'public', { description: 'typo fixed' });
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(false);
		expect(row().description).toBe('typo fixed');
	});

	it('gate race', async () => {
		const pds = host();
		const group = await givenGroup('public', pds, false);
		expect(await save(group, 'public', 'public', { requireApproval: false })).toEqual({ ok: true });
		expect(await declaredNow()).toBe(true);
		const originalFetch = globalThis.fetch;
		let release!: () => void;
		let captured!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const reached = new Promise<void>((r) => (captured = r));
		let intercept = true;
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const response = await originalFetch(input, init);
			if (intercept && String(input).includes('/com.atproto.simplespace.getSpace?')) {
				intercept = false;
				captured();
				await held;
			}
			return response;
		});
		const older = save(group, 'public', 'public', {
			requireApproval: false,
			description: 'NEW PRIVATE DESCRIPTION'
		});
		await reached;
		expect(await save(group, 'private', 'public')).toEqual({ ok: true });
		release();
		expect(await older).toEqual({ ok: true });
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(false);
	});

	it('gate failed withdrawal', async () => {
		let failDelete = false;
		const pds = host((nsid) =>
			failDelete && nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', 'public')).toEqual({ ok: true });
		const before = row().description;
		failDelete = true;
		const failed = await save(group, 'private', 'public', {
			description: 'Never previously public'
		});
		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.error).toContain('still listed in browse');
		expect(!failed.ok && failed.error).toMatch(/saving (the settings )?again/i);
		expect(row().description).toBe(before);
		expect(await declaredNow()).toBe(true);
		const { listGroups } = await import('./server/repo');
		const browse = await listGroups(harness.db, {
			declared: [{ did: GROUP_DID, createdAt: null }]
		});
		expect(browse[0].row?.description).toBe(before);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));

		failDelete = false;
		pds.clearLog();
		const again = await save(group, 'private', 'private', {
			description: 'Never previously public'
		});
		expect(again).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
		expect(row().description).toBe('Never previously public');
	});

	it('gate private order', async () => {
		const t = tracing();
		const pds = host(t.observe);
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', 'public')).toEqual({ ok: true });
		t.seen.length = 0;
		const result = await save(group, 'private', 'public', { name: 'Kona Night Runners' });
		expect(result).toEqual({ ok: true });
		const writes = t.seen.filter((s) => /updateSpace|deleteRecord|putRecord|createRecord/.test(s));
		expect(writes[0]).toBe('simplespace.updateSpace (row Kona Trail Runners)');
		expect(writes[1]).toBe(`repo.deleteRecord ${DECL} (row Kona Trail Runners)`);
		expect(writes.slice(2).every((s) => s.endsWith('(row Kona Night Runners)'))).toBe(true);
		expect(await declaredNow()).toBe(false);
	});

	it('gate public order', async () => {
		const t = tracing();
		const pds = host(t.observe);
		const group = await givenGroup('private', pds);
		t.seen.length = 0;
		const result = await save(group, 'public', 'private', { name: 'Kona Night Runners' });
		expect(result).toEqual({ ok: true });
		const decl = t.seen.findIndex((s) => s.startsWith(`repo.putRecord ${DECL}`));
		expect(decl).toBeGreaterThan(-1);
		expect(t.seen[decl]).toBe(`repo.putRecord ${DECL} (row Kona Night Runners)`);
		const flip = t.seen.findIndex((s) => s.startsWith('simplespace.updateSpace'));
		expect(t.seen[flip]).toBe('simplespace.updateSpace (row Kona Trail Runners)');
		// A host read after the row took the new name, and before the declaration.
		const reread = t.seen
			.slice(flip + 1, decl)
			.filter((s) => s === 'simplespace.getSpace (row Kona Night Runners)');
		expect(reread.length).toBeGreaterThan(0);
		expect(await declaredNow()).toBe(true);
	});

	it('gate unknown shown refused', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const before = row();
		const result = await save(group, 'private', null, { description: 'x' });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/reload/i);
		expect(pds.writes()).toEqual([]);
		expect(row()).toEqual(before);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
	});

	it('gate unknown shown matching', async () => {
		const pds = host();
		const group = await givenGroup('private', pds);
		const result = await save(group, 'private', null, { description: 'x' });
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(row().description).toBe('x');
	});

	it('gate changed choice already held', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', 'public')).toEqual({ ok: true });
		await moveHost('private', pds);
		const result = await save(group, 'private', 'public', { description: 'y' });
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
		expect(row().description).toBe('y');
	});

	it('gate untouched save finishes a host-first failure', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', 'public')).toEqual({ ok: true });
		expect(await declaredNow()).toBe(true);
		await moveHost('private', pds);
		const result = await save(group, 'private', 'private');
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
	});

	it('gate plain flip to public', async () => {
		const pds = host();
		const group = await givenGroup('private', pds);
		const result = await save(group, 'public', 'private');
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds).map((r) => r.body)).toEqual([
			{ space: ABOUT, readPolicy: policy('publicPolicy') }
		]);
		expect(await declaredNow()).toBe(true);
	});

	it('gate untouched public save keeps the host alone', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const result = await save(group, 'public', 'public', { description: 'z' });
		expect(result).toEqual({ ok: true });
		expect(updateSpaces(pds)).toEqual([]);
		expect(await declaredNow()).toBe(true);
	});
});
GATE_EOF
(cd "$WEB" && npx vitest run src/lib/groups/update-group.gate.test.ts --reporter=json --outputFile="$TMP/g.json" >/dev/null 2>&1)
rm -f "$GATE"
if [ -s "$TMP/g.json" ]; then
	python3 - "$TMP/g.json" > "$TMP/g.out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
res = {a["title"]: a["status"] for r in d["testResults"] for a in r["assertionResults"]}
EXPECT = ["gate stale untouched", "gate race", "gate failed withdrawal", "gate private order",
          "gate public order", "gate unknown shown refused", "gate unknown shown matching",
          "gate changed choice already held", "gate untouched save finishes a host-first failure",
          "gate plain flip to public", "gate untouched public save keeps the host alone"]
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
# 3a. The form carries the visibility it showed, end to end.
a=$(grep -c 'shownVisibility' "$WEB/src/lib/groups/update-group.ts" || true)
b=$(grep -c 'shownVisibility' "$WEB/src/lib/groups/groups.remote.ts" || true)
c=$(grep -c 'name="shownVisibility"' "$WEB/src/routes/(app)/groups/[actor]/+page.svelte" || true)
[ "$a" -ge 2 ] && [ "$b" -ge 1 ] && [ "$c" = 1 ] \
	&& pass "shownVisibility: update-group.ts $a, groups.remote.ts $b, settings form input $c" \
	|| fail "shownVisibility: update-group.ts $a (want >=2), groups.remote.ts $b (want >=1), settings form input $c (want 1)"
# 3b. No lock and no schema change: the migrations are untouched.
m=$(git -C "$ROOT" ls-files apps/web/migrations | grep -c .)
n=$(git -C "$ROOT" diff --name-only "$BASE"...HEAD -- apps/web/migrations | grep -c . || true)
[ "$m" -gt 0 ] && [ "$n" = 0 ] && pass "migrations: $m files, 0 changed" || fail "migrations: $n of $m files changed"
# 3c. Repair and the contrail layer are out of scope.
for p in apps/web/src/lib/groups/server/repair.ts apps/web/src/lib/contrail; do
	m=$(git -C "$ROOT" ls-files "$p" | grep -c .)
	n=$(git -C "$ROOT" diff --name-only "$BASE"...HEAD -- "$p" | grep -c . || true)
	[ "$m" -gt 0 ] && [ "$n" = 0 ] && pass "$p: $m file(s), 0 changed" || fail "$p: $n of $m file(s) changed"
done

# 4. Typecheck: the COMPLETED line must say 0 ERRORS (baseline at BASE: 2372 files, 0 errors, 6 warnings).
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
achits=$(cat "$TMP/added" "$TMP/msgs" "$TMP/branch" | grep -cE '\b(AC|R|X|N)[0-9]{1,2}\b' || true)
[ "$added" -gt 0 ] && [ "$hits" = 0 ] && [ "$achits" = 0 ] \
	&& pass "hygiene: $added added lines + $(git -C "$ROOT" rev-list --count "$BASE"..HEAD) commit messages + branch scanned, 0 hits" \
	|| fail "hygiene: $added added lines scanned, $hits id/branding hits, $achits AC/case-label hits"

echo
if [ "$FAILS" = 0 ]; then echo "VERIFY RESULT: ALL PASS"; exit 0; fi
echo "VERIFY RESULT: $FAILS FAIL(S)"; exit 1

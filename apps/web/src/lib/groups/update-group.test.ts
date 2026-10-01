// The settings save, tested against the fake group PDS and the real schema.
//
// A group's about space is readable by exactly the audience its visibility
// names, and the host is what enforces that. The create sets the about space's
// read policy from the choice made then (./create-group.test.ts). These cases
// cover the other half: a save that changes the visibility afterwards has to
// move that policy with `com.atproto.simplespace.updateSpace`, and a save that
// does not change it must leave the host alone.
//
// They also pin the order the save writes in, because each failure between two
// writes leaves a different half-state behind. The host goes first, and only
// when the owner changed the visibility, because it is the only place that
// holds it. After that the order depends on where the group ends up. A group
// that ends up private withdraws its declaration, then writes the row, the
// profile and the rules: browse shows a declared group's name and description
// from the row, so new text must not reach the row while the group is still
// declared. A group that ends up public writes the row, reads the host again,
// and declares only when that read still says public, then writes the profile
// and the rules. The row holds no visibility at all.
//
// The form sends the visibility it showed as well as the one chosen, and a save
// changes the visibility only when the two differ. A tab opened before someone
// else changed the host still shows the old value, and saving it untouched must
// not put that value back.
//
// The host is the same fake the create is tested against
// (./server/__fixtures__/stub-pds.ts), reached through the real transports, so
// the bodies asserted here are the bodies a PDS would receive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRowWrite, sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './server/__fixtures__/stub-pds';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from './members-record';
import { pdsWriter } from './server/event-writer';
import { pdsSpaceReader } from './server/about-read';
import { storeGroupCredential, type GroupCredential } from './server/credentials';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/repo';
import { clearGroupSessions } from './server/session';
import { pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';
import { runUpdateGroup, type UpdateGroupData } from './update-group';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:settingsgroupaaaaaaaaaaa';
const HANDLE = 'kona.group.stub.test';
/** 32 bytes, base64: the credential store accepts nothing shorter. */
const KEY = btoa('0123456789abcdef0123456789abcdef');
const CRED: GroupCredential = {
	service: 'https://pds.stub.test',
	identifier: HANDLE,
	password: 'app-pass-1234'
};
const ABOUT = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
const MEMBERS = `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`;

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

function host(fail?: StubPdsOptions['fail']): Host {
	return stubPds({ did: GROUP_DID, handle: HANDLE, fail });
}

/** The background and the scenario's "given": a group whose credential is
 *  stored, whose two spaces the host provisioned for `visibility`, the choice
 *  made at create, and whose about space's access record says that choice, as
 *  a create leaves it. The host's log is cleared afterwards, so a case asserts
 *  on the save alone. */
async function givenGroup(
	visibility: GroupVisibility,
	pds: Host,
	requireApproval = true
): Promise<GroupRow> {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Trail Runners',
		requireApproval
	});
	await storeGroupCredential(env, harness.db, GROUP_DID, CRED);
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), visibility);
	await recordGroupSpaces(harness.db, row.id, uris);
	const group = {
		...row,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	// Through the transport and past the gate, whose own reads a case may have
	// broken at the host already.
	await pdsWriter(
		CRED,
		GROUP_DID
	)({
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record: {
			...groupAccessRecord({ roles: ABOUT_SPACE_READER_ROLES, public: visibility === 'public' }),
			$type: GROUP_ACCESS_COLLECTION
		},
		intent: 'update',
		space: uris.aboutSpaceUri
	});
	pds.clearLog();
	return group;
}

/** The owner saving the settings form. `shownVisibility`, what the form showed
 *  when it opened, defaults to the chosen visibility: a select left alone. A
 *  case that changes the visibility says what the form showed, because without
 *  it the save is an untouched one and changes nothing at the host. */
function save(group: GroupRow, visibility: GroupVisibility, extra: Partial<UpdateGroupData> = {}) {
	return runUpdateGroup(env, harness.db, group, OWNER, {
		name: 'Kona Trail Runners',
		visibility,
		shownVisibility: visibility,
		requireApproval: true,
		...extra
	});
}

/** A form whose page could not read the host when it opened, so it showed no
 *  visibility and sends none. */
const NOT_SHOWN: Partial<UpdateGroupData> = { shownVisibility: undefined };

/** Whether the group's public repo holds a declaration, asked the way an
 *  anonymous peer would. */
async function declaredNow(): Promise<boolean> {
	const q = new URLSearchParams({
		repo: GROUP_DID,
		collection: 'group.opensocial.declaration',
		rkey: 'self'
	});
	return (await fetch(`${CRED.service}/xrpc/com.atproto.repo.getRecord?${q}`)).ok;
}

/** The about space's access record as the host holds it, read with the group's
 *  own session, or null. */
async function aboutAccessNow(): Promise<Record<string, unknown> | null> {
	const found = await pdsSpaceReader(CRED, GROUP_DID).get({
		space: ABOUT,
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});
	return found?.value ?? null;
}

/** Moves the about space's read policy at the host, the way another client, or
 *  a save that failed after its host write, leaves it. */
async function hostSays(visibility: GroupVisibility, pds: Host) {
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

/** Every write the host received, in order, named by method and by what it
 *  wrote: the read policy for an `updateSpace`, the collection otherwise. */
function traced(pds: Host): string[] {
	return pds.writes().map((w) => {
		const method = w.nsid.replace('com.atproto.', '');
		if (w.nsid === 'com.atproto.simplespace.updateSpace') {
			const readPolicy = w.body?.readPolicy as { $type?: string } | undefined;
			return `${method} ${readPolicy?.$type?.split('#')[1]}`;
		}
		return `${method} ${w.body?.collection}`;
	});
}

/** The row's approval, read straight from D1. */
function approvalNow(): number {
	return (
		harness.raw
			.prepare('SELECT require_approval FROM groups WHERE group_did = ?')
			.get(GROUP_DID) as {
			require_approval: number;
		}
	).require_approval;
}

/** Every column a save can write, and the time of the last write, so "no row
 *  write" can be asserted rather than inferred from one column. */
function rowWhole(): Record<string, unknown> {
	return harness.raw
		.prepare(
			'SELECT name, description, require_approval, updated_at FROM groups WHERE group_did = ?'
		)
		.get(GROUP_DID) as Record<string, unknown>;
}

const updateSpaceCalls = (pds: Host) =>
	pds.requests.filter((r) => r.nsid === 'com.atproto.simplespace.updateSpace');

/** A write to a space, a space's configuration or the public repo. The fake
 *  host sees every call before it answers, so this is the moment it arrives. */
const isHostWrite = (nsid: string, init?: RequestInit) =>
	init?.method?.toUpperCase() === 'POST' && /^com\.atproto\.(simplespace|space|repo)\./.test(nsid);

describe('a settings flip moves the about space’s read policy', () => {
	it.each([
		['public', 'private', 'memberListPolicy', 'deleteRecord'],
		['private', 'public', 'publicPolicy', 'putRecord']
	] as const)(
		'a group its host reads as %s, saved as %s, calls updateSpace once on the about space with %s',
		async (from, to, name, declarationWrite) => {
			const pds = host();
			const group = await givenGroup(from, pds);

			const result = await save(group, to, { shownVisibility: from, rules: 'Be kind' });

			expect(result).toEqual({ ok: true });
			// Once, and with exactly the space and the read policy. Leaving the
			// write policy and the app access out is what leaves them as
			// provisioned: `updateSpace` replaces only the fields it is sent.
			expect(updateSpaceCalls(pds).map((r) => r.body)).toEqual([
				{ space: ABOUT, readPolicy: policy(name) }
			]);
			expect(pds.spaces.get(ABOUT)).toEqual({
				readPolicy: policy(name),
				writePolicy: policy('memberListPolicy'),
				appAccess: policy('open')
			});
			// The members space is not part of this: neither its policy nor its
			// own member list is touched.
			expect(pds.spaces.get(MEMBERS)?.readPolicy).toEqual(policy('memberListPolicy'));
			expect(pds.requests.some((r) => r.nsid.startsWith('com.atproto.simplespace.putMember'))).toBe(
				false
			);
			// The host's writes in order: the read policy first, then the access
			// record and the declaration, then the profile and the rules. A
			// declared group's access says public, so the access record goes
			// before a declaration is published and after one is withdrawn. Where
			// the row falls among them depends on the direction, and the order
			// cases below pin it.
			const access = 'space.putRecord group.opensocial.access';
			const declaration = `repo.${declarationWrite} group.opensocial.declaration`;
			expect(traced(pds)).toEqual([
				`simplespace.updateSpace ${name}`,
				...(to === 'public' ? [access, declaration] : [declaration, access]),
				'space.putRecord group.opensocial.profile',
				'space.createRecord group.opensocial.rule'
			]);
			// The same save leaves the access record saying what the read policy says.
			expect(await aboutAccessNow()).toEqual({
				$type: 'group.opensocial.access',
				public: to === 'public',
				readRoles: ['owner', 'admin', 'member'],
				grants: []
			});
		}
	);
});

describe('a save that keeps the visibility leaves the host alone', () => {
	it('a public group saved as public makes no updateSpace call', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);

		const result = await save(group, 'public');

		expect(result).toEqual({ ok: true });
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
	});
});

describe('a private switch withdraws the declaration before profile and rules', () => {
	it('a public group saved as private, whose profile write fails, runs updateSpace, then the declaration delete, then the profile write, and reports failure', async () => {
		const pds = host((nsid, init) =>
			nsid === 'com.atproto.space.putRecord' &&
			(JSON.parse(String(init?.body)) as { collection: string }).collection ===
				'group.opensocial.profile'
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private', { shownVisibility: 'public', rules: 'Be kind' });

		expect(result.ok).toBe(false);
		// The group is no longer announced even though the profile failed, and
		// the rules were never reached.
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.profile'
		]);
	});
});

// A private group is invite-only, so it cannot also be open to join. The pair
// is two fields of this form, and visibility is the host's read policy, which
// no trigger on our tables can see. So the save refuses it in app code, before
// the host, the row or any record is written.
describe('a private group must require approval', () => {
	it('a settings save refuses a private group that is open to join before any write', async () => {
		const pds = host();
		const group = await givenGroup('public', pds, false);
		harness.statements.length = 0;

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			requireApproval: false,
			rules: 'Be kind'
		});

		expect(result).toEqual({
			ok: false,
			error: 'A private group must require approval to join. Invite members instead.'
		});
		expect(pds.writes()).toEqual([]);
		expect(harness.statements.filter(isRowWrite)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
	});
});

describe('a failed updateSpace stops the save', () => {
	it('a public group saved as private, whose updateSpace answers 500, makes no declaration, profile or rules write, and reports failure', async () => {
		const pds = host((nsid) =>
			nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private', { shownVisibility: 'public', rules: 'Be kind' });

		expect(result.ok).toBe(false);
		// Not "the records were not updated": what failed is the visibility
		// change itself, and the message has to say so.
		expect(!result.ok && result.error).toContain("did not reach the group's PDS");
		expect(!result.ok && result.error).not.toContain('records were not updated');
		expect(traced(pds)).toEqual(['simplespace.updateSpace memberListPolicy']);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
	});
});

// A visibility change that fails before the host has taken it must leave the
// row where it was, and it does so by never writing it: the host goes first.
// The next save then finds the same change to make and retries it, rather than
// reporting success while the about space keeps the old read policy.
describe('a visibility change that does not reach the host leaves the row where it was', () => {
	it('a public open group saved as private, whose updateSpace answers 500, is still public at its host and open on its row', async () => {
		const pds = host((nsid) =>
			nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds, false);

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			requireApproval: true
		});

		expect(result.ok).toBe(false);
		// Neither half of the pair moved, though the approval change was only
		// there because private requires it.
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
		expect(approvalNow()).toBe(0);
		expect(!result.ok && result.error).toContain("did not reach the group's PDS");
		expect(!result.ok && result.error).toContain('visibility was not changed');
		expect(!result.ok && result.error).toContain('saving again will retry');
	});

	it('saving the same values again with the PDS healthy calls updateSpace, returns ok, and leaves the about space member-list read', async () => {
		let hostDown = true;
		const pds = host((nsid) =>
			hostDown && nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		const failed = await save(group, 'private', { shownVisibility: 'public' });
		expect(failed.ok).toBe(false);

		hostDown = false;
		pds.clearLog();
		// The settings form resolves the group from the row on every save. The
		// host never took the change, so the page still shows public.
		const again = await save((await getGroupByDid(harness.db, GROUP_DID))!, 'private', {
			shownVisibility: 'public'
		});

		expect(again).toEqual({ ok: true });
		expect(updateSpaceCalls(pds).map((r) => r.body)).toEqual([
			{ space: ABOUT, readPolicy: policy('memberListPolicy') }
		]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
	});

	it('a public group saved as private, whose about space cannot be read before the host write, leaves the host and the row as they were', async () => {
		const pds = host((nsid) => (nsid === 'com.atproto.space.getRecord' ? pdsDown() : undefined));
		const group = await givenGroup('public', pds);
		const before = rowWhole();

		const result = await save(group, 'private', { shownVisibility: 'public' });

		expect(result.ok).toBe(false);
		expect(rowWhole()).toEqual(before);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
		expect(updateSpaceCalls(pds)).toEqual([]);
		// The host never refused anything: the message names the read that failed.
		expect(!result.ok && result.error).toContain('Nothing was saved');
		expect(!result.ok && result.error).toContain('profile and rules could not be read');
		expect(!result.ok && result.error).toContain('getRecord failed: 500');
		expect(!result.ok && result.error).not.toContain("did not reach the group's PDS");
	});
});

/** Every host write, and every read of the about space's read policy, in the
 *  order the host sees them, each with the row's name at that moment. The row
 *  write falls where the name changes. */
function rowAtEachCall() {
	const sequence: string[] = [];
	const observe: StubPdsOptions['fail'] = (nsid, init) => {
		if (isHostWrite(nsid, init) || nsid === 'com.atproto.simplespace.getSpace') {
			const { name } = harness.raw
				.prepare('SELECT name FROM groups WHERE group_did = ?')
				.get(GROUP_DID) as { name: string };
			sequence.push(`${nsid.replace('com.atproto.', '')} (row ${name})`);
		}
		return undefined;
	};
	return { sequence, observe };
}

// The host is written first, so a visibility change reaches the host before
// the row. A save stopped by the host has written nothing at all, and a save
// the host took is never taken back: a later failure leaves the host ahead of
// the rest, and the message says which writes landed.
//
// After the host, the order follows where the group ends up. Browse shows a
// declared group's name and description from the row, so a group going
// private withdraws its declaration before the row takes the new text, and a
// group going public writes the row before it declares. Declaring also needs a
// fresh answer: the host is read again just before it, and only a public
// answer publishes.
describe('a visibility change reaches the host before the row', () => {
	// The row keeps the profile's columns and no visibility: the host is the
	// only place that holds it. The row's name at each host call shows where
	// the row write fell, and that nothing reads the host a second time.
	it('a switch to private writes the host, withdraws the declaration, then writes the row, the profile and the rules', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = host(observe);
		const group = await givenGroup('public', pds);
		sequence.length = 0;
		harness.statements.length = 0;

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			name: 'Kona Night Runners',
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		expect(sequence).toEqual([
			'simplespace.getSpace (row Kona Trail Runners)',
			'simplespace.updateSpace (row Kona Trail Runners)',
			'repo.deleteRecord (row Kona Trail Runners)',
			'space.putRecord (row Kona Night Runners)',
			'space.putRecord (row Kona Night Runners)',
			'space.createRecord (row Kona Night Runners)'
		]);
		const rowWrites = harness.statements.filter(isRowWrite);
		expect(rowWrites.length).toBeGreaterThan(0);
		expect(rowWrites.filter((sql) => /visibility/.test(sql))).toEqual([]);
	});

	it('a switch to public writes the row, reads the host again, then declares', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = host(observe);
		const group = await givenGroup('private', pds);
		sequence.length = 0;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			name: 'Kona Night Runners',
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace publicPolicy',
			'space.putRecord group.opensocial.access',
			'repo.putRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		expect(sequence).toEqual([
			'simplespace.getSpace (row Kona Trail Runners)',
			'simplespace.updateSpace (row Kona Trail Runners)',
			'simplespace.getSpace (row Kona Night Runners)',
			'space.putRecord (row Kona Night Runners)',
			'repo.putRecord (row Kona Night Runners)',
			'space.putRecord (row Kona Night Runners)',
			'space.createRecord (row Kona Night Runners)'
		]);
		expect(await declaredNow()).toBe(true);
	});

	it('a switch to public whose host reads private again before the declaration withdraws it instead, and the profile follows that read', async () => {
		let reads = 0;
		const pds: Host = host((nsid) => {
			// Another client takes the group private between this save's host
			// write and its declaration.
			if (nsid === 'com.atproto.simplespace.getSpace' && ++reads === 2) {
				pds.spaces.get(ABOUT)!.readPolicy = policy('memberListPolicy');
			}
			return undefined;
		});
		const group = await givenGroup('private', pds);
		reads = 0;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			description: 'Trail runs at dawn'
		});

		// The owner's own fields were saved, and the visibility is someone
		// else's change, so the save succeeded.
		expect(result).toEqual({ ok: true });
		expect(rowWhole().description).toBe('Trail runs at dawn');
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace publicPolicy',
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile'
		]);
		expect(await declaredNow()).toBe(false);
		const profile = pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile');
		expect(profile?.record.joinPolicy).toBe('invite');
	});

	it('a switch to public whose host does not answer the second read saves the row, leaves the declaration alone, and says so', async () => {
		let reads = 0;
		let hostSilent = true;
		const pds = host((nsid) =>
			hostSilent && nsid === 'com.atproto.simplespace.getSpace' && ++reads === 2
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('private', pds);
		reads = 0;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			description: 'Trail runs at dawn',
			rules: 'Be kind'
		});

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('saved the settings');
		// True whether or not the group was declared before this save.
		expect(!result.ok && result.error).toContain(
			"neither published nor withdrew the group's declaration"
		);
		expect(!result.ok && result.error).toContain('as it was before this save');
		expect(!result.ok && result.error).toContain('getSpace failed: 500');
		expect(!result.ok && result.error).toContain('Saving the settings again finishes it');
		expect(rowWhole().description).toBe('Trail runs at dawn');
		// Neither a declaration nor a withdrawal, and nothing after them.
		expect(traced(pds)).toEqual(['simplespace.updateSpace publicPolicy']);
		expect(await declaredNow()).toBe(false);

		// The page now shows public, so saving again is an untouched save that
		// declares the group. The access record still says private, so it is
		// rewritten first.
		hostSilent = false;
		pds.clearLog();
		const again = await save(group, 'public', {
			description: 'Trail runs at dawn',
			rules: 'Be kind'
		});
		expect(again).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'space.putRecord group.opensocial.access',
			'repo.putRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		expect(await declaredNow()).toBe(true);
	});

	it('a public group saved as private, whose updateSpace answers 500, leaves the whole row as it was and makes no declaration, profile or rules write', async () => {
		const pds = host((nsid) =>
			nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		const before = rowWhole();

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			name: 'Kona Night Runners',
			description: 'After dark',
			rules: 'Be kind'
		});

		expect(result.ok).toBe(false);
		// The name and the description too: the host goes first, so nothing of
		// this save reached the row.
		expect(rowWhole()).toEqual(before);
		expect(traced(pds)).toEqual(['simplespace.updateSpace memberListPolicy']);
		expect(!result.ok && result.error).toContain('Nothing was saved');
	});

	it('a public group saved as private, whose profile write fails after the host took the change, keeps the host private and puts nothing back', async () => {
		const pds = host((nsid, init) =>
			nsid === 'com.atproto.space.putRecord' &&
			(JSON.parse(String(init?.body)) as { collection: string }).collection ===
				'group.opensocial.profile'
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private', { shownVisibility: 'public' });

		expect(result.ok).toBe(false);
		expect(approvalNow()).toBe(1);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		// One call: nothing moved the host back after the failure.
		expect(updateSpaceCalls(pds).map((r) => r.body)).toEqual([
			{ space: ABOUT, readPolicy: policy('memberListPolicy') }
		]);
		// And the message says what landed: the host and the row, not the records.
		// The declaration went before the profile, so the group is not listed.
		expect(!result.ok && result.error).toContain('now reads it as private');
		expect(!result.ok && result.error).toContain('records were not updated');
		expect(!result.ok && result.error).not.toContain('still listed');
		expect(!result.ok && result.error).toContain('Saving the settings again finishes it');
	});

	it('a public group saved as private, whose row write fails after the host took the change, says the host has it and this site does not', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		harness.raw.exec(
			`CREATE TRIGGER refuse_save BEFORE UPDATE ON groups
			 BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
		);

		const before = rowWhole();

		const result = await save(group, 'private', { shownVisibility: 'public', rules: 'Be kind' });

		expect(result.ok).toBe(false);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(rowWhole()).toEqual(before);
		// The withdrawal comes before the row, so it landed; the profile and the
		// rules come after it, so they were never reached.
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord group.opensocial.declaration'
		]);
		expect(!result.ok && result.error).toContain('now reads it as private');
		expect(!result.ok && result.error).toContain('disk I/O error');
		expect(!result.ok && result.error).toContain('were not updated either');
		// The declaration is gone, so browse no longer lists the group. The form
		// shows what the host enforces, so saving again has no host change to
		// make and finishes it.
		expect(!result.ok && result.error).toContain('browse does not list it');
		expect(!result.ok && result.error).not.toContain('still listed');
		expect(!result.ok && result.error).toContain('Saving the settings again finishes it');
	});

	it('a public group saved as private, whose declaration delete fails, says the group is still listed in browse', async () => {
		const pds = host((nsid) => (nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined));
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private', { shownVisibility: 'public', rules: 'Be kind' });

		expect(result.ok).toBe(false);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		// Nothing after the withdrawal was attempted.
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord group.opensocial.declaration'
		]);
		expect(!result.ok && result.error).toContain('now reads it as private');
		expect(!result.ok && result.error).toContain('still listed in browse');
		// Everything the row holds is in the list of what was not saved.
		expect(!result.ok && result.error).toContain(
			'name, description, approval setting, profile and rules were not saved'
		);
		expect(!result.ok && result.error).toContain('Saving the settings again finishes it');
	});

	it('a switch to public whose declaration write fails says the settings were saved, and saving again finishes it', async () => {
		let failPut = true;
		const pds = host((nsid, init) =>
			failPut &&
			nsid === 'com.atproto.repo.putRecord' &&
			(JSON.parse(String(init?.body)) as { collection: string }).collection ===
				'group.opensocial.declaration'
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('private', pds);

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			description: 'Trail runs at dawn'
		});

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('now reads it as public');
		expect(!result.ok && result.error).toContain('records were not updated');
		expect(!result.ok && result.error).not.toContain('still listed');
		expect(!result.ok && result.error).toContain('Saving the settings again finishes it');
		expect(await declaredNow()).toBe(false);

		// The page now shows public, so saving again is an untouched save that
		// declares the group.
		failPut = false;
		pds.clearLog();
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(await declaredNow()).toBe(true);
	});

	it('a switch to private whose withdrawal fails leaves the row as it was, and saving again finishes it', async () => {
		let failDelete = false;
		const pds = host((nsid) =>
			failDelete && nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		expect(await declaredNow()).toBe(true);
		const before = rowWhole();

		failDelete = true;
		const failed = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Never previously public'
		});

		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.error).toContain('still listed in browse');
		expect(!failed.ok && failed.error).toContain('Saving the settings again finishes it');
		// The host took the change and the declaration survived, but the row
		// never took the new text, so browse, which joins the surviving
		// declaration to the row, keeps showing what strangers already saw.
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(true);
		expect(rowWhole()).toEqual(before);
		const { listGroups } = await import('./server/repo');
		const browse = await listGroups(harness.db, {
			declared: [{ did: GROUP_DID, createdAt: null }]
		});
		expect(browse.map((entry) => entry.row?.description)).toEqual(['Trail runs at dawn']);

		// The page now shows private, which is what the host holds.
		failDelete = false;
		pds.clearLog();
		const again = await save(group, 'private', { description: 'Never previously public' });

		expect(again).toEqual({ ok: true });
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Never previously public');
	});
});

// A save that keeps the visibility never touches the host, including when it
// fails. Every read comes before the first write, so a read that fails leaves
// nothing half-saved behind it either.
describe('a save that keeps the visibility and fails', () => {
	it('a public group saved as public, whose about space cannot be read, saves nothing, never calls updateSpace, and says so', async () => {
		const pds = host((nsid) => (nsid === 'com.atproto.space.getRecord' ? pdsDown() : undefined));
		const group = await givenGroup('public', pds);
		const before = rowWhole();

		const result = await save(group, 'public', { name: 'Kona Night Runners' });

		expect(result.ok).toBe(false);
		expect(rowWhole()).toEqual(before);
		expect(pds.writes()).toEqual([]);
		expect(!result.ok && result.error).toContain('Nothing was saved');
		expect(!result.ok && result.error).not.toContain("did not reach the group's PDS");
	});
});

// A failed save can leave the host ahead of the records. The settings form
// shows what the host enforces, so saving again asks for that same value: no
// host write, and the declaration, the profile and the rules catch up.
describe('a save after one that the host took and the records did not', () => {
	it('a group the host already reads as private, saved as private, withdraws its declaration without calling updateSpace', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		await hostSays('private', pds);

		const result = await save(group, 'private', { rules: 'Be kind' });

		expect(result).toEqual({ ok: true });
		// The access record still says public, as the earlier save left it.
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		expect((await aboutAccessNow())?.public).toBe(false);
	});
});

// The form sends the visibility it showed as well as the one chosen, and only
// a difference between the two is a change the owner asked for. Anything else
// takes the host's value as it stands: a tab opened before someone else moved
// the host still shows the old value, and saving it must not move the host
// back. There is no lock, so the host is also read again just before a
// declaration, and only a public answer publishes one.
describe('a save changes the visibility only when the owner changed it', () => {
	it('a stale form saved with its visibility untouched keeps the visibility its host has since taken', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		// The stale tab opens here, showing public.
		expect(await save(group, 'public')).toEqual({ ok: true });
		// Another tab takes the group private.
		expect(await save(group, 'private', { shownVisibility: 'public' })).toEqual({ ok: true });
		pds.clearLog();

		const result = await save(group, 'public', { description: 'Typo fixed' });

		expect(result).toEqual({ ok: true });
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Typo fixed');
		// The profile follows the host too.
		const profile = pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile');
		expect(profile?.record.joinPolicy).toBe('invite');
	});

	it('a save that read public before a concurrent switch to private does not declare the group', async () => {
		const pds = host();
		const group = await givenGroup('public', pds, false);
		expect(await save(group, 'public', { requireApproval: false })).toEqual({ ok: true });
		expect(await declaredNow()).toBe(true);

		// Hold the first save just after its host read, which answers public.
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
		const older = save(group, 'public', {
			requireApproval: false,
			description: 'Written while going private'
		});
		await reached;

		// A second save takes the group private and completes.
		expect(await save(group, 'private', { shownVisibility: 'public' })).toEqual({ ok: true });
		pds.clearLog();
		release();

		expect(await older).toEqual({ ok: true });
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(false);
		const repoWrites = pds.writes().filter((w) => w.nsid.startsWith('com.atproto.repo.'));
		expect(repoWrites.at(-1)?.nsid).not.toBe('com.atproto.repo.putRecord');
		expect(updateSpaceCalls(pds)).toEqual([]);
	});

	it('a form that could not show the visibility is refused when its choice differs from the host', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const before = rowWhole();
		harness.statements.length = 0;

		const result = await save(group, 'private', { ...NOT_SHOWN, description: 'Members only' });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('cannot tell which visibility the page showed');
		expect(!result.ok && result.error).toContain('Nothing was saved');
		expect(!result.ok && result.error).toMatch(/reload/i);
		expect(pds.writes()).toEqual([]);
		expect(harness.statements.filter(isRowWrite)).toEqual([]);
		expect(rowWhole()).toEqual(before);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
	});

	it('a form that could not show the visibility saves when its choice matches the host', async () => {
		const pds = host();
		const group = await givenGroup('private', pds);

		const result = await save(group, 'private', { ...NOT_SHOWN, description: 'Members only' });

		expect(result).toEqual({ ok: true });
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(rowWhole().description).toBe('Members only');
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile'
		]);
	});

	// With two visibilities, a changed choice from a view the host has since
	// left is the value the host already holds, so there is nothing to change
	// and nothing to refuse.
	it('a changed choice that the host already holds makes no host write', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public')).toEqual({ ok: true });
		await hostSays('private', pds);

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Members only'
		});

		expect(result).toEqual({ ok: true });
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Members only');
	});
});

// The approval control is drawn for the visibility the form has chosen: a
// private choice fixes it on. A stale form whose save ends up with the other
// visibility therefore sends an approval nobody chose for the group it will
// be, so the row's approval stands, and the profile's join policy follows it.
describe('a stale form and the approval setting', () => {
	/** An empty database and a new host, so one case can set up a second group
	 *  under the same DID. */
	function startOver(): Host {
		harness.close();
		harness = sqliteD1();
		clearGroupSessions();
		vi.unstubAllGlobals();
		return host();
	}

	/** The settings form resolves the group from the row on every save. */
	const rowGroup = async () => (await getGroupByDid(harness.db, GROUP_DID))!;

	const profileJoinPolicy = (pds: Host) =>
		pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile')?.record.joinPolicy;

	it('a stale form keeps the saved approval when the visibility it ends up with is not the one it chose', async () => {
		// A private group, whose stale tab shows private with approval fixed on.
		let pds = host();
		await givenGroup('private', pds);
		// Elsewhere it is made public and open to join.
		expect(
			await save(await rowGroup(), 'public', { shownVisibility: 'private', requireApproval: false })
		).toEqual({ ok: true });
		expect(approvalNow()).toBe(0);
		pds.clearLog();

		const opened = await save(await rowGroup(), 'private', {
			requireApproval: true,
			description: 'Typo fixed'
		});

		expect(opened).toEqual({ ok: true });
		expect(approvalNow()).toBe(0);
		expect(profileJoinPolicy(pds)).toBe('open');
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('publicPolicy'));
		expect(await declaredNow()).toBe(true);
		expect(rowWhole().description).toBe('Typo fixed');

		// A public group open to join, whose stale tab shows public with
		// approval off.
		pds = startOver();
		await givenGroup('public', pds, false);
		expect(await save(await rowGroup(), 'public', { requireApproval: false })).toEqual({
			ok: true
		});
		// Elsewhere it is made private, which requires approval.
		expect(
			await save(await rowGroup(), 'private', { shownVisibility: 'public', requireApproval: true })
		).toEqual({ ok: true });
		expect(approvalNow()).toBe(1);
		pds.clearLog();

		const closed = await save(await rowGroup(), 'public', {
			requireApproval: false,
			description: 'Typo fixed'
		});

		expect(closed).toEqual({ ok: true });
		expect(approvalNow()).toBe(1);
		expect(profileJoinPolicy(pds)).toBe('invite');
		expect(updateSpaceCalls(pds)).toEqual([]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Typo fixed');
	});
});

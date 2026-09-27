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
// writes leaves a different half-state behind: the host, then the row, then the
// declaration, then the profile, then the rules. The host goes first because
// it is what the group's pages read the visibility from, and a group that has
// just gone private stops announcing itself before anything else can fail.
//
// The host is the same fake the create is tested against
// (./server/__fixtures__/stub-pds.ts), reached through the real transports, so
// the bodies asserted here are the bodies a PDS would receive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRowWrite, sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './server/__fixtures__/stub-pds';
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

/** The background and the scenario's "given": a group whose row says
 *  `visibility`, whose credential is stored, and whose two spaces the host
 *  provisioned for that choice. The host's log is cleared afterwards, so a case
 *  asserts on the save alone. */
async function givenGroup(
	visibility: GroupVisibility,
	pds: Host,
	requireApproval = true
): Promise<GroupRow> {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Trail Runners',
		visibility,
		requireApproval
	});
	await storeGroupCredential(env, harness.db, GROUP_DID, CRED);
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), visibility);
	await recordGroupSpaces(harness.db, row.id, uris);
	pds.clearLog();
	return { ...row, about_space_uri: uris.aboutSpaceUri, members_space_uri: uris.membersSpaceUri };
}

/** The owner saving the settings form. */
function save(group: GroupRow, visibility: GroupVisibility, extra: Partial<UpdateGroupData> = {}) {
	return runUpdateGroup(env, harness.db, group, OWNER, {
		name: 'Kona Trail Runners',
		visibility,
		requireApproval: true,
		...extra
	});
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

/** The row's visibility and approval, read straight from D1. */
function rowNow(): { visibility: string; require_approval: number } {
	return harness.raw
		.prepare('SELECT visibility, require_approval FROM groups WHERE group_did = ?')
		.get(GROUP_DID) as { visibility: string; require_approval: number };
}

/** Every column a save can write, and the time of the last write, so "no row
 *  write" can be asserted rather than inferred from one column. */
function rowWhole(): Record<string, unknown> {
	return harness.raw
		.prepare(
			'SELECT name, description, visibility, require_approval, updated_at FROM groups WHERE group_did = ?'
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
		'a group whose row says %s, saved as %s, calls updateSpace once on the about space with %s',
		async (from, to, name, declarationWrite) => {
			// The row as the host found it: read at the moment updateSpace arrives.
			const rowWhenHostChanged: unknown[] = [];
			const pds = host((nsid) => {
				if (nsid === 'com.atproto.simplespace.updateSpace') {
					rowWhenHostChanged.push(
						(
							harness.raw
								.prepare('SELECT visibility FROM groups WHERE group_did = ?')
								.get(GROUP_DID) as { visibility: string }
						).visibility
					);
				}
				return undefined;
			});
			const group = await givenGroup(from, pds);

			const result = await save(group, to, { rules: 'Be kind' });

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
			// The order: the host first, while the row still says what it said,
			// then the row, the declaration, the profile and the rules.
			expect(rowWhenHostChanged).toEqual([from]);
			expect(traced(pds)).toEqual([
				`simplespace.updateSpace ${name}`,
				`repo.${declarationWrite} net.openmeet.group.declaration`,
				'space.putRecord net.openmeet.group.profile',
				'space.createRecord net.openmeet.group.rule'
			]);
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
				'net.openmeet.group.profile'
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private', { rules: 'Be kind' });

		expect(result.ok).toBe(false);
		// The group is no longer announced even though the profile failed, and
		// the rules were never reached.
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord net.openmeet.group.declaration',
			'space.putRecord net.openmeet.group.profile'
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

		const result = await save(group, 'private', { requireApproval: false, rules: 'Be kind' });

		expect(result).toEqual({
			ok: false,
			error: 'A private group must require approval to join — invite members instead'
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

		const result = await save(group, 'private', { rules: 'Be kind' });

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
	it('a public open group saved as private, whose updateSpace answers 500, still says public and open on its row', async () => {
		const pds = host((nsid) =>
			nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds, false);

		const result = await save(group, 'private', { requireApproval: true });

		expect(result.ok).toBe(false);
		// Neither half of the pair moved, though the approval change was only
		// there because private requires it.
		expect(rowNow()).toEqual({ visibility: 'public', require_approval: 0 });
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
		const failed = await save(group, 'private');
		expect(failed.ok).toBe(false);

		hostDown = false;
		pds.clearLog();
		// The settings form resolves the group from the row on every save.
		const again = await save((await getGroupByDid(harness.db, GROUP_DID))!, 'private');

		expect(again).toEqual({ ok: true });
		expect(updateSpaceCalls(pds).map((r) => r.body)).toEqual([
			{ space: ABOUT, readPolicy: policy('memberListPolicy') }
		]);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(rowNow().visibility).toBe('private');
	});

	it('a public group saved as private, whose about space cannot be read before the host write, still says public on its row', async () => {
		const pds = host((nsid) => (nsid === 'com.atproto.space.getRecord' ? pdsDown() : undefined));
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private');

		expect(result.ok).toBe(false);
		expect(rowNow()).toEqual({ visibility: 'public', require_approval: 1 });
		expect(updateSpaceCalls(pds)).toEqual([]);
		// The host never refused anything: the message names the read that failed.
		expect(!result.ok && result.error).toContain('Nothing was saved');
		expect(!result.ok && result.error).toContain('profile and rules could not be read');
		expect(!result.ok && result.error).toContain('getRecord failed: 500');
		expect(!result.ok && result.error).not.toContain("did not reach the group's PDS");
	});
});

// The host is written first, so a visibility change reaches the host before
// the row. A save stopped by the host has written nothing at all, and a save
// the host took is never taken back: a later failure leaves the host ahead of
// the rest, and the message says which writes landed.
describe('a visibility change reaches the host before the row', () => {
	it('a public group saved as private calls updateSpace, then writes the row, then deletes the declaration, then writes the profile and the rules', async () => {
		// The row as each host write found it, so the row write shows up in the
		// sequence: after updateSpace, before the declaration.
		const sequence: string[] = [];
		const pds = host((nsid, init) => {
			if (isHostWrite(nsid, init)) {
				sequence.push(`${nsid.replace('com.atproto.', '')} (row ${rowNow().visibility})`);
			}
			return undefined;
		});
		const group = await givenGroup('public', pds);
		sequence.length = 0;

		const result = await save(group, 'private', { rules: 'Be kind' });

		expect(result).toEqual({ ok: true });
		expect(sequence).toEqual([
			'simplespace.updateSpace (row public)',
			'repo.deleteRecord (row private)',
			'space.putRecord (row private)',
			'space.createRecord (row private)'
		]);
		expect(traced(pds)).toEqual([
			'simplespace.updateSpace memberListPolicy',
			'repo.deleteRecord net.openmeet.group.declaration',
			'space.putRecord net.openmeet.group.profile',
			'space.createRecord net.openmeet.group.rule'
		]);
	});

	it('a public group saved as private, whose updateSpace answers 500, leaves the whole row as it was and makes no declaration, profile or rules write', async () => {
		const pds = host((nsid) =>
			nsid === 'com.atproto.simplespace.updateSpace' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		const before = rowWhole();

		const result = await save(group, 'private', {
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

	it('a public group saved as private, whose profile write fails after the host took the change, keeps the host and the row private and puts nothing back', async () => {
		const pds = host((nsid, init) =>
			nsid === 'com.atproto.space.putRecord' &&
			(JSON.parse(String(init?.body)) as { collection: string }).collection ===
				'net.openmeet.group.profile'
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private');

		expect(result.ok).toBe(false);
		expect(rowNow()).toEqual({ visibility: 'private', require_approval: 1 });
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
	});

	it('a public group saved as private, whose row write fails after the host took the change, says the host has it and this site does not', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		harness.raw.exec(
			`CREATE TRIGGER refuse_save BEFORE UPDATE ON groups
			 BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
		);

		const result = await save(group, 'private', { rules: 'Be kind' });

		expect(result.ok).toBe(false);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy('memberListPolicy'));
		expect(rowNow().visibility).toBe('public');
		expect(traced(pds)).toEqual(['simplespace.updateSpace memberListPolicy']);
		expect(!result.ok && result.error).toContain('now reads it as private');
		expect(!result.ok && result.error).toContain('disk I/O error');
		expect(!result.ok && result.error).toContain('were not updated either');
		// The declaration was never withdrawn, and saving again from a form that
		// still shows the row's visibility would move the host back.
		expect(!result.ok && result.error).toContain('still listed in browse');
		expect(!result.ok && result.error).toContain('Repair this group');
		expect(!result.ok && result.error).not.toContain('Saving again');
	});

	it('a public group saved as private, whose declaration delete fails, says the group is still listed in browse', async () => {
		const pds = host((nsid) => (nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined));
		const group = await givenGroup('public', pds);

		const result = await save(group, 'private');

		expect(result.ok).toBe(false);
		expect(rowNow().visibility).toBe('private');
		expect(!result.ok && result.error).toContain('now reads it as private');
		expect(!result.ok && result.error).toContain('records were not updated');
		expect(!result.ok && result.error).toContain('still listed in browse');
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

// A failed save can leave the host ahead of the row, and the settings form
// preselects the row's visibility. Saved as it stands, that stale default would
// move the host back and report success. So a save whose visibility is the
// row's, while the host says otherwise, is refused before anything is written,
// and the owner is sent to Repair, which brings the row to the host. A save
// that asks for what the host already enforces goes through.
describe('a save from a form that shows the row, while the host says otherwise', () => {
	/** Moves the about space's read policy at the host, the way a save that
	 *  failed after its host write leaves it. */
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

	it.each([
		['private', 'public'],
		['public', 'private']
	] as const)(
		'a group the host reads as %s, whose row says %s, saved as the row says, writes nothing and points to Repair',
		async (hostVisibility, rowVisibility) => {
			const pds = host();
			const group = await givenGroup(rowVisibility, pds);
			await hostSays(hostVisibility, pds);
			const before = rowWhole();

			const result = await save(group, rowVisibility, {
				name: 'Kona Night Runners',
				rules: 'Be kind'
			});

			expect(result.ok).toBe(false);
			expect(pds.writes()).toEqual([]);
			expect(rowWhole()).toEqual(before);
			expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(
				policy(hostVisibility === 'public' ? 'publicPolicy' : 'memberListPolicy')
			);
			expect(!result.ok && result.error).toContain(`PDS enforces ${hostVisibility}`);
			expect(!result.ok && result.error).toContain(`copy says ${rowVisibility}`);
			expect(!result.ok && result.error).toContain('Repair this group');
			expect(!result.ok && result.error).toContain('Nothing was saved');
		}
	);

	it('a group the host reads as private, whose row says public, saved as private, brings the row and the declaration in line without calling updateSpace', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		await hostSays('private', pds);

		const result = await save(group, 'private', { rules: 'Be kind' });

		expect(result).toEqual({ ok: true });
		expect(rowNow().visibility).toBe('private');
		expect(traced(pds)).toEqual([
			'repo.deleteRecord net.openmeet.group.declaration',
			'space.putRecord net.openmeet.group.profile',
			'space.createRecord net.openmeet.group.rule'
		]);
	});
});

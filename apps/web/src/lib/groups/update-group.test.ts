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
// writes leaves a different half-state behind: the row, then the host, then the
// declaration, then the profile, then the rules. A group that has just gone
// private stops announcing itself before anything else can fail.
//
// The host is the same fake the create is tested against
// (./server/__fixtures__/stub-pds.ts), reached through the real transports, so
// the bodies asserted here are the bodies a PDS would receive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './server/__fixtures__/stub-pds';
import { storeGroupCredential, type GroupCredential } from './server/credentials';
import { createGroup, recordGroupSpaces } from './server/repo';
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
async function givenGroup(visibility: GroupVisibility, pds: Host): Promise<GroupRow> {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Trail Runners',
		visibility,
		requireApproval: true
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

const updateSpaceCalls = (pds: Host) =>
	pds.requests.filter((r) => r.nsid === 'com.atproto.simplespace.updateSpace');

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
			// The order: the row first (the schema has already accepted the new
			// visibility when the host hears of it), then the host, the
			// declaration, the profile and the rules.
			expect(rowWhenHostChanged).toEqual([to]);
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

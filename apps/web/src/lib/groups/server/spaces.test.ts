// Space provisioning and the write target.
//
// The mistake these cases guard against mirrors the write gate's. The gate
// stops a group's events being authored by an admin; this stops a group's
// control plane being written to the group's public repo. A members record in
// the public repo is anonymously readable and indexable, which is the leak the
// two-space split exists to prevent. It would also pass every permission check,
// because the permission is not what is wrong. Only the target is.
//
// These use `pdsProvisioner` / `pdsWriter` rather than an injected seam,
// because the policy triple and the method choice are made inside them. An
// injected provisioner would only assert the test's own fixture.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';

import {
	GroupSpaceError,
	SpacesUnsupportedError,
	aboutSpaceReadPolicy,
	groupSpaceUpdater,
	pdsProvisioner,
	provisionGroupSpaces,
	readGroupVisibility,
	readPolicyFor,
	setAboutSpaceReadPolicy
} from './spaces';

import { groupSpaceUris, POLICY_MEMBER_LIST, POLICY_PUBLIC, spaceUri } from '../ids';
import { GroupPermissionError, pdsWriter } from './group-write';
import { didSpaceHosts } from './space-credential';
import { seedGroup, type SeededGroup } from './__fixtures__/seed-group';
import { authzReader } from './__fixtures__/members-space';
import { hostDown, spaceReader, type FakeSpaceReader } from './__fixtures__/space-reader';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord,
	parseGroupAccess
} from '../members-record';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CRED = linkedCredential(GROUP_DID, 'https://pds.example.com');

interface Sent {
	nsid: string;
	body: Record<string, unknown>;
}

let sent: Sent[];
/** Per-NSID responses. A missing entry answers `{}` with 200, so a case only
 *  states the responses it cares about. */
let replies: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
	linkedCredential(GROUP_DID, 'https://pds.example.com');
	sent = [];
	replies = {};
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const nsid = url.pathname.replace('/xrpc/', '');
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		sent.push({ nsid, body });

		const reply = replies[nsid];
		if (reply) {
			return Response.json(reply.body, { status: reply.status });
		}
		return Response.json({});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
});

const writes = () => sent.filter((s) => !s.nsid.startsWith('com.atproto.server.'));

describe('provisionGroupSpaces', () => {
	// Every space starts member-list, a public group's about space included: it
	// holds no `access` record yet, and a space is never more open than its
	// record says, so it opens only once one says public. The space types are written out, so a rename of a
	// constant cannot pass by agreeing with itself: the about and members types
	// are the standard's, and the calendar type is ours, which a calendar space
	// URI carries, so a rename strands every record already written under the
	// old one.
	it('creates about, members and calendar as member-list-read, all app-open, under the group DID', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 200,
			body: { uri: 'at://did:plc:jcwgw6fcnb5vyoid7nz7sl26/space/placeholder/self' }
		};

		await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID));

		const calls = writes();
		expect(calls.map((c) => c.nsid)).toEqual([
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace'
		]);

		// The about space is the group's face. It starts closed to everyone but its
		// member list, whatever the group will be. The host names the field
		// `spaceType`, not `type`.
		expect(calls[0].body).toEqual({
			spaceType: 'group.opensocial.meta',
			skey: 'self',
			readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			appAccess: { $type: 'com.atproto.simplespace.defs#open' }
		});

		// The members space is the gated half, whatever the visibility.
		// `publicPolicy` here would publish the roster, which is the failure this
		// assertion exists for.
		expect(calls[1].body).toEqual({
			spaceType: 'group.opensocial.members',
			skey: 'self',
			readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			appAccess: { $type: 'com.atproto.simplespace.defs#open' }
		});

		// The calendar space holds members-only events, so it is member-list read
		// whatever the visibility. `publicPolicy` here, the about space's policy
		// copied for a public group, would let any signed-in account read every
		// members-only event.
		expect(calls[2].body).toEqual({
			spaceType: 'rsvp.atmo.group.calendar',
			skey: 'self',
			readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			appAccess: { $type: 'com.atproto.simplespace.defs#open' }
		});
	});

	it('treats SpaceAlreadyExists as success, so a half-finished create can be retried', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'SpaceAlreadyExists', message: 'already' }
		};

		const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID));

		// Deterministic from owner + type + skey. The host does no lookup, so this
		// is derivation, not a guess. With skey `self` it is a function of the DID
		// alone: nothing the caller supplies can move a group's space URI.
		expect(uris.aboutSpaceUri).toBe(spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self'));
		expect(uris.membersSpaceUri).toBe(spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self'));
		expect(uris.calendarSpaceUri).toBe(spaceUri(GROUP_DID, CALENDAR_SPACE_TYPE, 'self'));
		// And the same three a cache rebuild computes from the DID alone, which is
		// why the calendar space needs no column.
		expect(uris).toEqual(groupSpaceUris(GROUP_DID));
	});

	it('does not attempt the members space when the about space fails', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'UnsupportedPolicy', message: 'no' }
		};

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID))).rejects.toThrow(
			GroupSpaceError
		);
		expect(writes()).toHaveLength(1);
	});

	it('does not attempt the calendar space when the members space fails', async () => {
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			sent.push({ nsid: new URL(String(input)).pathname.replace('/xrpc/', ''), body });
			if (body.spaceType === MEMBERS_SPACE_TYPE) {
				return Response.json({ error: 'UnsupportedPolicy', message: 'no' }, { status: 400 });
			}
			return Response.json({ uri: `at://${GROUP_DID}/space/${body.spaceType}/${body.skey}` });
		});

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID))).rejects.toThrow(
			GroupSpaceError
		);
		expect(writes().map((w) => w.body.spaceType)).toEqual([ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE]);
	});

	// One of the three answers a stock PDS gives (pds:0.4): the one that differs
	// from a Spaces host's refusal, below, only by its message.
	it('reports a host without Spaces when createSpace answers that no service is configured', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: {
				error: 'InvalidRequest',
				message: 'No service configured for com.atproto.simplespace.createSpace'
			}
		};

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID))).rejects.toThrow(
			SpacesUnsupportedError
		);
	});

	it('does not report a Spaces host refusing a request as a host without Spaces', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'InvalidRequest', message: 'Invalid readPolicy' }
		};

		const failure = provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID));

		await expect(failure).rejects.toThrow(GroupSpaceError);
		await expect(failure).rejects.not.toThrow(SpacesUnsupportedError);
	});
});

describe('pdsWriter target', () => {
	const record = { $type: 'com.example.test', value: 1 };

	it('sends a space write to com.atproto.space.putRecord carrying both space and repo', async () => {
		const space = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'kona');
		replies['com.atproto.space.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record,
			intent: 'update',
			space
		});

		expect(writes()).toHaveLength(1);
		expect(writes()[0].nsid).toBe('com.atproto.space.putRecord');
		// `repo` stays the group: the space scopes access, it does not reparent.
		expect(writes()[0].body).toEqual({
			space,
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record
		});
	});

	it('sends a repo write to com.atproto.repo.putRecord with no space field', async () => {
		replies['com.atproto.repo.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record,
			intent: 'update'
		});

		expect(writes()[0].nsid).toBe('com.atproto.repo.putRecord');
		expect(writes()[0].body).not.toHaveProperty('space');
	});

	it('routes create and delete by target too', async () => {
		const space = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'kona');
		replies['com.atproto.space.createRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/new`, cid: 'bafy' }
		};
		const write = pdsWriter(CRED, GROUP_DID);

		await write({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'new',
			record,
			intent: 'create',
			space
		});
		await write({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'new',
			record: {},
			intent: 'delete',
			space
		});

		expect(writes().map((w) => w.nsid)).toEqual([
			'com.atproto.space.createRecord',
			'com.atproto.space.deleteRecord'
		]);
	});
});

// The visibility flip is gated twice: by the settings form, and here, at the
// write itself, so a caller that reaches it some other way still needs
// The scope that writes the about space's access, which the policy follows. The
// members space holds the records a create leaves.
describe('setAboutSpaceReadPolicy', () => {
	const OWNER = 'did:plc:owner';
	const MEMBER = 'did:plc:member';

	let seeded: SeededGroup;
	let reader: FakeSpaceReader;
	let updated: { space: string; readPolicy: string }[];

	beforeEach(async () => {
		seeded = await seedGroup({
			groupDid: GROUP_DID,
			ownerDid: OWNER,
			name: 'Kona',
			members: { [MEMBER]: 'member' }
		});
		reader = authzReader(GROUP_DID, { [OWNER]: 'owner', [MEMBER]: 'member' });
		updated = [];
	});

	afterEach(() => seeded.harness.close());

	function flip(callerDid: string | null) {
		return setAboutSpaceReadPolicy({
			db: seeded.db,
			env: {},
			group: seeded.group,
			callerDid,
			reader,
			visibility: 'private',
			updater: async (update) => {
				updated.push(update);
			}
		});
	}

	it("moves an owner's about space to the member-list policy", async () => {
		await flip(OWNER);

		expect(updated).toEqual([
			{ space: seeded.spaces.aboutSpaceUri, readPolicy: aboutSpaceReadPolicy('private') }
		]);
	});

	it('refuses a member without MANAGE_GROUP, and changes no policy', async () => {
		await expect(flip(MEMBER)).rejects.toBeInstanceOf(GroupPermissionError);
		expect(updated).toEqual([]);
	});

	it('refuses an anonymous caller before reading anything', async () => {
		await expect(flip(null)).rejects.toBeInstanceOf(GroupPermissionError);
		expect(reader.calls).toEqual([]);
		expect(updated).toEqual([]);
	});
});

// The group's visibility is its about space's `access.public`, the record that is
// the policy, not the read policy the host holds, which follows it. Reading it is
// one record read with the group's session. (Spec: FR-214.)
describe('readGroupVisibility', () => {
	const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
	const group = { group_did: GROUP_DID, about_space_uri: ABOUT };

	const aboutAccess = (value: Record<string, unknown>) => ({
		space: ABOUT,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		value: { ...value, $type: GROUP_ACCESS_COLLECTION }
	});
	const saying = (isPublic: boolean) =>
		aboutAccess(
			groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: isPublic
			})
		);

	it.each([
		[true, 'public'],
		[false, 'private']
	] as const)(
		'an about space access record with public: %s reads as %s, whatever the host holds',
		async (isPublic, visibility) => {
			// The host's policy says the opposite: the record decides, and the host
			// is not asked.
			const reader = spaceReader(GROUP_DID, {
				records: [saying(isPublic)],
				policies: { [ABOUT]: isPublic ? POLICY_MEMBER_LIST : POLICY_PUBLIC }
			});

			expect(await readGroupVisibility(reader, group)).toBe(visibility);
			expect(reader.calls).toEqual([
				`get ${ABOUT} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`
			]);
		}
	);

	it('a group with no about space access record reads as private, even with a public host', async () => {
		const reader = spaceReader(GROUP_DID, { policies: { [ABOUT]: POLICY_PUBLIC } });

		expect(await readGroupVisibility(reader, group)).toBe('private');
	});

	it('a record with no grants list is not an access record, so it reads as private', async () => {
		const reader = spaceReader(GROUP_DID, { records: [aboutAccess({ public: true })] });

		expect(await readGroupVisibility(reader, group)).toBe('private');
	});

	it('throws when the record cannot be read, so "could not ask" is neither answer', async () => {
		const reader = spaceReader(GROUP_DID, { records: [saying(true)], fail: hostDown(502) });

		await expect(readGroupVisibility(reader, group)).rejects.toThrow('502');
	});

	it('throws for a group with no about space yet, before reading anything', async () => {
		const reader = spaceReader(GROUP_DID);

		await expect(
			readGroupVisibility(reader, { group_did: GROUP_DID, about_space_uri: null })
		).rejects.toThrow(GroupSpaceError);
		expect(reader.calls).toEqual([]);
	});
});

describe('readPolicyFor', () => {
	const access = (isPublic: boolean) =>
		parseGroupAccess(
			groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: isPublic
			})
		);

	it('is public exactly when the access record says public', () => {
		expect(readPolicyFor(access(true))).toBe(POLICY_PUBLIC);
		expect(readPolicyFor(access(false))).toBe(POLICY_MEMBER_LIST);
	});

	it('is member-list for a missing record, which grants no one', () => {
		expect(readPolicyFor(null)).toBe(POLICY_MEMBER_LIST);
	});
});

describe('groupSpaceUpdater', () => {
	it('at a group host, moves nothing: the host keeps each policy from its access record', async () => {
		const hosts = vi.spyOn(didSpaceHosts, 'repoHost').mockResolvedValue('https://grouphost.test');
		const group = { group_did: GROUP_DID } as Parameters<typeof groupSpaceUpdater>[0]['group'];

		const updater = await groupSpaceUpdater({
			env: { GROUP_HOST_URL: 'https://grouphost.test' },
			group
		});
		await updater({
			space: spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self'),
			readPolicy: POLICY_PUBLIC
		});
		hosts.mockRestore();

		expect(sent).toEqual([]);
	});
});

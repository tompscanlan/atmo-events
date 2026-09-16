// Space provisioning and the write target.
//
// The mistake these cases defend against is the mirror of the write gate's: the
// gate stops a group's events being authored by an admin, and this stops a
// group's CONTROL PLANE being written to the group's PUBLIC repo. A members
// record that lands in the public repo is anonymously readable and indexable —
// the exact leak the two-space split exists to prevent — and it would pass every
// permission check on the way, because permission is not the thing that is
// wrong. Only the target is.
//
// These exercise `pdsProvisioner` / `pdsWriter` rather than an injected seam,
// because the policy triple and the method choice are made INSIDE them. An
// injected provisioner would assert the test's own fixture.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { clearGroupSessions } from './session';
import { pdsWriter } from './event-writer';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces, spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CRED = {
	service: 'https://pds.opnmt.net',
	identifier: 'kona.opnmt.net',
	password: 'app-password'
};

interface Sent {
	nsid: string;
	body: Record<string, unknown>;
}

let sent: Sent[];
/** Per-NSID responses. A missing entry answers `{}` with 200, so a case only
 *  states the responses it cares about. */
let replies: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
	clearGroupSessions();
	sent = [];
	replies = {};
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const nsid = url.pathname.replace('/xrpc/', '');
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		sent.push({ nsid, body });

		if (nsid === 'com.atproto.server.createSession') {
			return Response.json({ did: GROUP_DID, accessJwt: 'access', refreshJwt: 'refresh' });
		}
		const reply = replies[nsid];
		if (reply) {
			return Response.json(reply.body, { status: reply.status });
		}
		return Response.json({});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearGroupSessions();
});

const writes = () => sent.filter((s) => !s.nsid.startsWith('com.atproto.server.'));

describe('provisionGroupSpaces', () => {
	it('creates about as public-read and members as member-list-read, both app-open, under the group DID', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 200,
			body: { uri: 'at://did:plc:jcwgw6fcnb5vyoid7nz7sl26/space/placeholder/kona' }
		};

		await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'kona');

		const calls = writes();
		expect(calls.map((c) => c.nsid)).toEqual([
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace'
		]);

		// The about space is the group's public face.
		expect(calls[0].body).toEqual({
			type: ABOUT_SPACE_TYPE,
			skey: 'kona',
			readPolicy: { $type: 'com.atproto.simplespace.defs#publicPolicy' },
			writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			appAccess: { $type: 'com.atproto.simplespace.defs#open' }
		});

		// The members space is the gated half. `publicPolicy` here would publish
		// the roster, which is the failure this assertion exists for.
		expect(calls[1].body).toEqual({
			type: MEMBERS_SPACE_TYPE,
			skey: 'kona',
			readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
			appAccess: { $type: 'com.atproto.simplespace.defs#open' }
		});
	});

	it('returns the two URIs the host confirmed, keyed by space', async () => {
		const provisioner = pdsProvisioner(CRED, GROUP_DID);
		let call = 0;
		replies['com.atproto.simplespace.createSpace'] = { status: 200, body: {} };
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const nsid = new URL(String(input)).pathname.replace('/xrpc/', '');
			if (nsid === 'com.atproto.server.createSession') {
				return Response.json({ did: GROUP_DID, accessJwt: 'a', refreshJwt: 'r' });
			}
			const body = JSON.parse(String(init!.body));
			call += 1;
			return Response.json({ uri: `at://${GROUP_DID}/space/${body.type}/${body.skey}#${call}` });
		});

		const uris = await provisionGroupSpaces(provisioner, 'kona');

		expect(uris).toEqual({
			aboutSpaceUri: `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/kona#1`,
			membersSpaceUri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/kona#2`
		});
	});

	it('treats SpaceAlreadyExists as success, so a half-finished create can be retried', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'SpaceAlreadyExists', message: 'already' }
		};

		const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'kona');

		// Deterministic from owner + type + skey — the host does no lookup, so this
		// is derivation, not a guess.
		expect(uris.aboutSpaceUri).toBe(spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'kona'));
		expect(uris.membersSpaceUri).toBe(spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'kona'));
	});

	it('does not attempt the members space when the about space fails', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'UnsupportedPolicy', message: 'no' }
		};

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'kona')).rejects.toThrow(
			GroupSpaceError
		);
		expect(writes()).toHaveLength(1);
	});
});

describe('pdsWriter target', () => {
	const record = { $type: 'net.openmeet.test', value: 1 };

	it('sends a space write to com.atproto.space.putRecord carrying both space and repo', async () => {
		const space = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'kona');
		replies['com.atproto.space.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/net.openmeet.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'net.openmeet.test',
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
			collection: 'net.openmeet.test',
			rkey: 'self',
			record
		});
	});

	it('sends a repo write to com.atproto.repo.putRecord with no space field', async () => {
		replies['com.atproto.repo.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/net.openmeet.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'net.openmeet.test',
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
			body: { uri: `at://${GROUP_DID}/net.openmeet.test/new`, cid: 'bafy' }
		};
		const write = pdsWriter(CRED, GROUP_DID);

		await write({
			repo: GROUP_DID,
			collection: 'net.openmeet.test',
			rkey: 'new',
			record,
			intent: 'create',
			space
		});
		await write({
			repo: GROUP_DID,
			collection: 'net.openmeet.test',
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

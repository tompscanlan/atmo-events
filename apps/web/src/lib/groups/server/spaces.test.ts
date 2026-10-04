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
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import { pdsWriter } from './event-writer';
import {
	GroupSpaceError,
	SpacesUnsupportedError,
	pdsProvisioner,
	provisionGroupSpaces,
	spaceUri
} from './spaces';

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
	// The about space is the standard's meta space. Its type is written out here
	// so a rename of the constant cannot pass by agreeing with itself.
	it('provisions the group.opensocial meta and members space types', () => {
		expect(ABOUT_SPACE_TYPE).toBe('group.opensocial.meta');
		expect(MEMBERS_SPACE_TYPE).toBe('group.opensocial.members');
	});

	// The about space's read policy is the group's visibility, as the host
	// enforces it. The members space's is not a choice at all.
	it.each([
		['public', 'publicPolicy'],
		['private', 'memberListPolicy']
	] as const)(
		'creates about with the read policy a %s group names (%s) and members as member-list-read, both app-open, under the group DID',
		async (visibility, policy) => {
			replies['com.atproto.simplespace.createSpace'] = {
				status: 200,
				body: { uri: 'at://did:plc:jcwgw6fcnb5vyoid7nz7sl26/space/placeholder/self' }
			};

			await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), visibility);

			const calls = writes();
			expect(calls.map((c) => c.nsid)).toEqual([
				'com.atproto.simplespace.createSpace',
				'com.atproto.simplespace.createSpace'
			]);

			// The about space is the group's face: readable by anyone signed in for a
			// public group, and only by its member list for a private one. The field is
			// `spaceType`, not `type`, since the spaces alpha of 2026-10-01.
			expect(calls[0].body).toEqual({
				spaceType: ABOUT_SPACE_TYPE,
				skey: 'self',
				readPolicy: { $type: `com.atproto.simplespace.defs#${policy}` },
				writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
				appAccess: { $type: 'com.atproto.simplespace.defs#open' }
			});

			// The members space is the gated half, whatever the visibility.
			// `publicPolicy` here would publish the roster, which is the failure this
			// assertion exists for.
			expect(calls[1].body).toEqual({
				spaceType: MEMBERS_SPACE_TYPE,
				skey: 'self',
				readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
				writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
				appAccess: { $type: 'com.atproto.simplespace.defs#open' }
			});
		}
	);

	it('returns the two URIs the host confirmed, keyed by space', async () => {
		const provisioner = pdsProvisioner(CRED, GROUP_DID);
		let call = 0;
		replies['com.atproto.simplespace.createSpace'] = { status: 200, body: {} };
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const body = JSON.parse(String(init!.body));
			call += 1;
			return Response.json({
				uri: `at://${GROUP_DID}/space/${body.spaceType}/${body.skey}#${call}`
			});
		});

		const uris = await provisionGroupSpaces(provisioner, 'public');

		expect(uris).toEqual({
			aboutSpaceUri: `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self#1`,
			membersSpaceUri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self#2`
		});
	});

	it('treats SpaceAlreadyExists as success, so a half-finished create can be retried', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'SpaceAlreadyExists', message: 'already' }
		};

		const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public');

		// Deterministic from owner + type + skey. The host does no lookup, so this
		// is derivation, not a guess. With skey `self` it is a function of the DID
		// alone: nothing the caller supplies can move a group's space URI.
		expect(uris.aboutSpaceUri).toBe(spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self'));
		expect(uris.membersSpaceUri).toBe(spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self'));
	});

	it('does not attempt the members space when the about space fails', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'UnsupportedPolicy', message: 'no' }
		};

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public')).rejects.toThrow(
			GroupSpaceError
		);
		expect(writes()).toHaveLength(1);
	});

	// The three answers a stock PDS gives, measured against pds:0.4.
	it.each([
		[501, { error: 'MethodNotImplemented', message: 'Method Not Implemented' }],
		[
			400,
			{
				error: 'InvalidRequest',
				message: 'No service configured for com.atproto.simplespace.createSpace'
			}
		],
		[502, { error: 'UpstreamFailure', message: 'Upstream service unreachable' }]
	])('reports a host without Spaces when createSpace answers %i', async (status, body) => {
		replies['com.atproto.simplespace.createSpace'] = { status, body };

		await expect(provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public')).rejects.toThrow(
			SpacesUnsupportedError
		);
	});

	it('does not report a Spaces host refusing a request as a host without Spaces', async () => {
		replies['com.atproto.simplespace.createSpace'] = {
			status: 400,
			body: { error: 'InvalidRequest', message: 'Invalid readPolicy' }
		};

		const failure = provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public');

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

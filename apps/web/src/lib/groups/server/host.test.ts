// The host binding's one choice of its own: whether the group is at the group
// host this deployment is set up with. One that is reaches the host's own
// methods (./real-host.ts, whose tests cover what each one sends); any other is
// refused before anything is sent, because this site changes a group only
// through its host.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { SPACE_SKEY } from '../ids';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';

import { GroupNotAtHostError, groupHost, pendingRequestsFor, type GroupHost } from './host';
import { didSpaceHosts } from './space-credential';
import type { SpaceProvision } from './spaces';

const HOST = 'https://grouphost.test';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GROUP = { id: 'g1', group_did: GROUP_DID } as GroupRow;
const CALLER = { callerDid: 'did:plc:calleraaaaaaaaaaaaaaaaaa' };
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
const SPACE: SpaceProvision = {
	type: MEMBERS_SPACE_TYPE,
	skey: SPACE_SKEY,
	access: { grants: [{ role: 'member', scopes: ['read'] }] }
};

/** Every method, called once. */
const METHODS: [string, (host: GroupHost) => Promise<unknown>][] = [
	['createSpace', (host) => host.createSpace(CALLER, SPACE)],
	['listJoinRequests', (host) => host.listJoinRequests(CALLER)],
	['denyJoinRequest', (host) => host.denyJoinRequest(CALLER, MEMBER)],
	['requestJoin', (host) => host.requestJoin(CALLER, null)],
	['cancelJoinRequest', (host) => host.cancelJoinRequest(CALLER)],
	['leaveGroup', (host) => host.leaveGroup(CALLER)],
	['approveJoinRequest', (host) => host.approveJoinRequest(CALLER, MEMBER, 'member')],
	['addMember', (host) => host.addMember(CALLER, MEMBER, 'member')],
	['ejectMember', (host) => host.ejectMember(CALLER, MEMBER)],
	['setMemberRole', (host) => host.setMemberRole(CALLER, MEMBER, 'admin')]
];

let sent: URL[];

beforeEach(() => {
	sent = [];
	vi.stubGlobal('fetch', async (input: URL | string) => {
		sent.push(new URL(String(input)));
		return Response.json({ space: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self` });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
});

/** The group's DID document names `pds` as its PDS. */
function groupAt(pds: string) {
	return vi.spyOn(didSpaceHosts, 'repoHost').mockResolvedValue(pds);
}

describe('a group at no host this site is set up with', () => {
	it.each(METHODS)('%s is refused before any request, with no host set up', async (_, call) => {
		const host = groupHost({ db: {} as D1Database, env: linkGroups([GROUP_DID]), group: GROUP });

		await expect(call(host)).rejects.toBeInstanceOf(GroupNotAtHostError);
		expect(sent).toEqual([]);
	});

	it.each(METHODS)(
		'%s is refused before any XRPC request, for a group whose PDS is elsewhere',
		async (_, call) => {
			const resolve = groupAt(STUB_PDS_SERVICE);
			const host = groupHost({
				db: {} as D1Database,
				env: { ...linkGroups([GROUP_DID]), GROUP_HOST_URL: HOST },
				group: GROUP,
				credential: linkedCredential(GROUP_DID)
			});

			await expect(call(host)).rejects.toMatchObject({
				name: 'GroupNotAtHostError',
				groupDid: GROUP_DID
			});
			expect(resolve).toHaveBeenCalledWith(GROUP_DID);
			expect(sent).toEqual([]);
		}
	);

	it('lists no pending requests, and asks nobody', async () => {
		const binding = { db: {} as D1Database, env: linkGroups([GROUP_DID]), group: GROUP };

		await expect(pendingRequestsFor(binding, CALLER)).resolves.toEqual([]);
		expect(sent).toEqual([]);
	});
});

describe('a group at this site’s host', () => {
	it('reaches the host’s own method, on the session the binding was handed', async () => {
		groupAt(HOST);
		const credential = linkedCredential(GROUP_DID, HOST);
		unlinkAllGroups();
		const host = groupHost({
			db: {} as D1Database,
			env: { ...linkGroups([]), GROUP_HOST_URL: HOST },
			group: GROUP,
			credential
		});

		await expect(host.createSpace(CALLER, SPACE)).resolves.toEqual({
			uri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`
		});
		expect(sent.map((url) => `${url.origin}${url.pathname}`)).toEqual([
			`${HOST}/xrpc/group.opensocial.createSpace`
		]);
	});
});

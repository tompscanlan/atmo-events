// The host binding's one choice of its own: whose session creates a space. A
// create runs before anyone has linked the group, on the session the mint
// returned, so a host handed that session must not ask the store, which would
// refuse the group as unlinked. Every other method passes straight to the roster
// acts and D1, which their own tests cover.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { POLICY_MEMBER_LIST, SPACE_SKEY } from '../ids';
import { linkGroups, linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';

import { groupHost } from './host';
import { GroupCredentialError } from './session';
import type { SpaceProvision } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GROUP = { id: 'g1', group_did: GROUP_DID } as GroupRow;
const SPACE: SpaceProvision = {
	type: MEMBERS_SPACE_TYPE,
	skey: SPACE_SKEY,
	readPolicy: POLICY_MEMBER_LIST
};

let sent: string[];

beforeEach(() => {
	sent = [];
	vi.stubGlobal('fetch', async (input: URL | string) => {
		const nsid = new URL(String(input)).pathname.replace('/xrpc/', '');
		sent.push(nsid);
		return Response.json({ uri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self` });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
});

describe('groupHost createSpace', () => {
	it('creates on the session it was handed, with the group linked to nobody', async () => {
		const credential = linkedCredential(GROUP_DID);
		unlinkAllGroups();
		const host = groupHost({
			db: {} as D1Database,
			env: linkGroups([]),
			group: GROUP,
			credential
		});

		await expect(host.createSpace(SPACE)).resolves.toEqual({
			uri: `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`
		});
		expect(sent).toContain('com.atproto.simplespace.createSpace');
	});

	it('without one, refuses a group nobody linked before sending anything', async () => {
		const host = groupHost({ db: {} as D1Database, env: linkGroups([]), group: GROUP });

		await expect(host.createSpace(SPACE)).rejects.toBeInstanceOf(GroupCredentialError);
		expect(sent).toEqual([]);
	});
});

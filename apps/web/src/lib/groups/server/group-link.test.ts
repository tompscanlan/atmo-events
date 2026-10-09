// Who may link a group's account, and which account a link may hold. A link
// started by anyone but the owner, finished in another browser, or authorized by
// any account but the group's must store nothing: the refusals before the code
// exchange never reach the PDS, and a token issued to the wrong account is revoked.
//
// The OAuth client is the I/O boundary (it talks to the group's PDS), so it is a
// recording stub. The state store is a Map, as the client's own would be.
import { describe, it, expect, beforeEach } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';
import {
	GroupLinkRefused,
	finishGroupLink,
	startGroupLink,
	type GroupLinkState
} from './group-link';

import { GROUP_SESSION_SCOPE } from './session';
const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
const REDIRECT = 'https://atmo.test/oauth/group-link/callback';
const STATE_ID = 'state-1';

const group = { group_did: GROUP, owner_did: OWNER };

let authorized: unknown[];
let exchanged: number;
let revoked: string[];
let authorizedAs: string;
let callbackError: Error | null;
let states: Map<string, StoredState>;

const client = {
	authorize: async (options: unknown) => {
		authorized.push(options);
		return { url: new URL('https://pds.test/oauth/authorize?request_uri=x'), stateId: STATE_ID };
	},
	callback: async () => {
		exchanged++;
		if (callbackError) throw callbackError;
		return { session: { did: authorizedAs }, state: undefined };
	},
	revoke: async (did: string) => {
		revoked.push(did);
	}
} as unknown as Parameters<typeof startGroupLink>[0]['client'];

const store = {
	get: async (key: string) => states.get(key),
	delete: async (key: string) => {
		states.delete(key);
	}
};

function pending(userState: GroupLinkState) {
	states.set(STATE_ID, { userState } as unknown as StoredState);
}

function finish(signedInDid: string | null, owner = OWNER) {
	return finishGroupLink({
		client,
		states: store,
		params: new URLSearchParams({ state: STATE_ID, code: 'c', iss: 'https://pds.test' }),
		signedInDid,
		findGroup: async (did) => (did === GROUP ? { group_did: GROUP, owner_did: owner } : null)
	});
}

beforeEach(() => {
	authorized = [];
	exchanged = 0;
	revoked = [];
	authorizedAs = GROUP;
	callbackError = null;
	states = new Map();
});

describe('starting a link', () => {
	it('sends the owner to authorize as the group, for the group scope, back to the link callback', async () => {
		await startGroupLink({ client, group, signedInDid: OWNER, redirectUri: REDIRECT });
		expect(authorized).toEqual([
			{
				// An account target makes the client resolve the group's DID now and
				// refuse a token issued to anyone else at the callback.
				target: { type: 'account', identifier: GROUP },
				scope: GROUP_SESSION_SCOPE,
				redirectUri: REDIRECT,
				state: { groupDid: GROUP, by: OWNER }
			}
		]);
	});

	it('refuses a member who is not the owner, and a caller who is signed out', async () => {
		for (const did of [MEMBER, null]) {
			await expect(
				startGroupLink({ client, group, signedInDid: did, redirectUri: REDIRECT })
			).rejects.toBeInstanceOf(GroupLinkRefused);
		}
		expect(authorized).toEqual([]);
	});
});

describe('finishing a link', () => {
	it('links when the owner who started it finishes it and the group authorized', async () => {
		pending({ groupDid: GROUP, by: OWNER });
		expect(await finish(OWNER)).toEqual({ ok: true, groupDid: GROUP });
		expect(exchanged).toBe(1);
		expect(revoked).toEqual([]);
	});

	it('refuses a link the owner authorized as themselves, and revokes that token', async () => {
		pending({ groupDid: GROUP, by: OWNER });
		authorizedAs = OWNER;
		const result = await finish(OWNER);
		expect(result).toMatchObject({ ok: false, groupDid: GROUP });
		expect(revoked).toEqual([OWNER]);
	});

	it('reports the client refusing a token issued to another account', async () => {
		pending({ groupDid: GROUP, by: OWNER });
		callbackError = new Error('sub mismatch');
		expect(await finish(OWNER)).toEqual({ ok: false, groupDid: GROUP, reason: 'sub mismatch' });
	});

	it('refuses a browser signed in as anyone but the owner who started it, before any exchange', async () => {
		for (const did of [MEMBER, null]) {
			pending({ groupDid: GROUP, by: OWNER });
			expect(await finish(did)).toMatchObject({ ok: false, groupDid: GROUP });
			expect(states.has(STATE_ID)).toBe(false);
		}
		expect(exchanged).toBe(0);
	});

	it('refuses a link whose starter no longer owns the group, before any exchange', async () => {
		pending({ groupDid: GROUP, by: OWNER });
		expect(await finish(OWNER, MEMBER)).toMatchObject({ ok: false, groupDid: GROUP });
		expect(exchanged).toBe(0);
	});

	it('refuses a state it did not start', async () => {
		expect(await finish(OWNER)).toMatchObject({ ok: false, groupDid: null });
		states.set(STATE_ID, { userState: undefined } as unknown as StoredState);
		expect(await finish(OWNER)).toMatchObject({ ok: false, groupDid: null });
		expect(exchanged).toBe(0);
	});
});

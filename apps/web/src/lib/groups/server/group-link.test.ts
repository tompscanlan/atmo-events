import { describe, it, expect, beforeEach } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';
import {
	GroupLinkRefused,
	finishGroupLink,
	startGroupLink,
	type GroupLinkState
} from './group-link';

import { groupSessionScope } from './session';
const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
const REDIRECT = 'https://atmo.test/oauth/group-link/callback';
const STATE_ID = 'state-1';

const group = { group_did: GROUP };

let authorized: unknown[];
let exchanged: number;
let revoked: string[];
let authorizedAs: string;
let callbackError: Error | null;
let states: Map<string, StoredState>;
let clientsUsed: string[];
let stillMayConnect: boolean;

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

function finish(signedInDid: string | null) {
	return finishGroupLink({
		clientFor: (personDid) => {
			clientsUsed.push(personDid);
			return client;
		},
		states: store,
		params: new URLSearchParams({ state: STATE_ID, code: 'c', iss: 'https://pds.test' }),
		signedInDid,
		findGroup: async (did) => (did === GROUP ? group : null),
		mayConnect: async () => stillMayConnect
	});
}

function start(
	signedInDid: string | null,
	mayConnect = true,
	atGroupHost: () => Promise<boolean> = async () => true
) {
	return startGroupLink({
		client,
		group,
		signedInDid,
		mayConnect,
		atGroupHost,
		redirectUri: REDIRECT
	});
}

beforeEach(() => {
	authorized = [];
	exchanged = 0;
	revoked = [];
	authorizedAs = GROUP;
	callbackError = null;
	states = new Map();
	clientsUsed = [];
	stillMayConnect = true;
});

describe('starting a link', () => {
	it('sends a member whose roles grant writes to authorize as the group, back to the link callback', async () => {
		await start(MEMBER);
		expect(authorized).toEqual([
			{
				target: { type: 'account', identifier: GROUP },
				scope: groupSessionScope(),
				redirectUri: REDIRECT,
				state: { groupDid: GROUP, by: MEMBER }
			}
		]);
	});

	it('asks the creator for the same scope as anyone else', async () => {
		await start(OWNER);
		await start(MEMBER);
		const [owner, member] = authorized.map((a) => (a as { scope: string }).scope);
		expect(owner).toBe(member);
	});

	it('refuses a member whose roles grant no writes, and a caller who is signed out', async () => {
		await expect(start(MEMBER, false)).rejects.toBeInstanceOf(GroupLinkRefused);
		await expect(start(null)).rejects.toBeInstanceOf(GroupLinkRefused);
		expect(authorized).toEqual([]);
	});
});

describe('the hint a group host reads off the link', () => {
	it('names the person, and never a group name, to a group at the group host, and adds nothing to the request', async () => {
		const url = await start(MEMBER, true, async () => true);

		expect(url.searchParams.get('gh_person')).toBe(MEMBER);
		expect(url.searchParams.get('gh_name')).toBeNull();
		expect(url.searchParams.get('request_uri')).toBe('x');
		expect(authorized).toEqual([
			{
				target: { type: 'account', identifier: GROUP },
				scope: groupSessionScope(),
				redirectUri: REDIRECT,
				state: { groupDid: GROUP, by: MEMBER }
			}
		]);
	});

	it('refuses a group elsewhere, or one the check cannot place, before any request', async () => {
		await expect(start(MEMBER, true, async () => false)).rejects.toBeInstanceOf(GroupLinkRefused);
		await expect(
			start(MEMBER, true, async () => {
				throw new Error('the group did not resolve');
			})
		).rejects.toBeInstanceOf(GroupLinkRefused);
		expect(authorized).toEqual([]);
	});
});

describe('finishing a link', () => {
	it('links through the starter’s own client when they finish it and the group authorized', async () => {
		pending({ groupDid: GROUP, by: MEMBER });
		expect(await finish(MEMBER)).toEqual({ ok: true, groupDid: GROUP });
		expect(exchanged).toBe(1);
		expect(clientsUsed).toEqual([MEMBER]);
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

	it('refuses a browser signed in as anyone but the person who started it, before any exchange', async () => {
		for (const did of [MEMBER, null]) {
			pending({ groupDid: GROUP, by: OWNER });
			expect(await finish(did)).toMatchObject({ ok: false, groupDid: GROUP });
			expect(states.has(STATE_ID)).toBe(false);
		}
		expect(exchanged).toBe(0);
	});

	it('refuses a link whose starter’s roles no longer grant writes, before any exchange', async () => {
		pending({ groupDid: GROUP, by: MEMBER });
		stillMayConnect = false;
		expect(await finish(MEMBER)).toMatchObject({ ok: false, groupDid: GROUP });
		expect(exchanged).toBe(0);
	});

	it('refuses a state it did not start', async () => {
		expect(await finish(OWNER)).toMatchObject({ ok: false, groupDid: null });
		states.set(STATE_ID, { userState: undefined } as unknown as StoredState);
		expect(await finish(OWNER)).toMatchObject({ ok: false, groupDid: null });
		expect(exchanged).toBe(0);
	});
});

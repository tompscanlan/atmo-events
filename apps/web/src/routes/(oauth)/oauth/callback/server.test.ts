// The sign-in callback, as far as groups reach into it: one call that writes the
// member's missing acceptance in each group they are in or asked to join, from
// the session just granted (groups spec FR-205). That covers the group's
// creator and a member added directly, neither of whom was present to write one.
//
// The OAuth client, the signed cookies and the feed pre-warm are stubbed; the
// groups tables are the real SQL, and the member's PDS is the session's own
// `handle`, which records what it was asked.
import { describe, expect, it, vi } from 'vitest';

const signedIn = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('$lib/atproto/server/oauth', () => ({
	createOAuthClient: () => ({ callback: async () => ({ session: signedIn.session }) })
}));
vi.mock('$lib/atproto/server/signed-cookie', () => ({ setSignedCookie: vi.fn() }));
vi.mock('$lib/contrail', () => ({ getServerClient: () => ({ get: async () => ({}) }) }));

import { GET } from './+server';
import { sqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { memberGrant } from '$lib/groups/server/member-grants';

const GROUP = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBERS = `at://${GROUP}/space/group.opensocial.members/self`;

describe('/oauth/callback', () => {
	it('a member added while away writes their acceptance at sign-in, and lands where they were going', async () => {
		const { db } = sqliteD1();
		const row = await createGroup(db, { groupDid: GROUP, ownerDid: 'did:plc:owner', name: 'Kona' });
		await recordGroupSpaces(db, row.id, {
			aboutSpaceUri: `at://${GROUP}/space/group.opensocial.about/self`,
			membersSpaceUri: MEMBERS
		});
		await addMember(db, row.id, MEMBER, 'member');
		const asked: { pathname: string; body: Record<string, unknown> }[] = [];
		signedIn.session = {
			did: MEMBER,
			getTokenInfo: async () => ({ scope: `atproto ${memberGrant(GROUP)}` }),
			handle: async (pathname: string, init: RequestInit) => {
				asked.push({ pathname, body: JSON.parse(String(init.body)) });
				return Response.json({
					uri: `${MEMBERS}/${MEMBER}/group.opensocial.acceptance/self`,
					cid: 'bafy'
				});
			}
		};

		const answer = await Promise.resolve()
			.then(() =>
				GET({
					url: new URL('https://atmo.test/oauth/callback?code=c&state=s'),
					platform: { env: { DB: db }, ctx: { waitUntil: () => {} } },
					cookies: { get: () => undefined, delete: () => {} }
				} as unknown as Parameters<typeof GET>[0])
			)
			.catch((e: unknown) => e);

		expect(answer).toMatchObject({ status: 303, location: '/' });
		expect(asked).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.space.createRecord',
				body: {
					space: MEMBERS,
					repo: MEMBER,
					collection: 'group.opensocial.acceptance',
					rkey: 'self'
				}
			}
		]);
	});
});

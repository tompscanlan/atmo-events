// The member's acceptance, written from their own session. The PDS here answers as the
// spaces PDS does: a create refuses a record that exists with 400 `RecordAlreadyExists`,
// and a delete succeeds whether or not the record was there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { acceptOnSignIn, deleteAcceptance, writeAcceptance } from './acceptance';
import type { CallerSession } from './caller';
import { addMember, noteJoinRequest } from './db/roster';
import { holdsAcceptanceGrant } from './member-grants';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY } from '../members-record';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';

const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const MEMBERS = `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`;
const BASE_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=*';
/** The `participate` set's acceptance grant as a PDS hands it back. */
const GRANT = `space:${MEMBERS_SPACE_TYPE}?authority=*&skey=self&collection=${GROUP_ACCEPTANCE_COLLECTION}&action=read&action=create&action=update&action=delete`;
const granted = `${BASE_SCOPE} ${GRANT}`;

interface MemberPds {
	session(scope: string): CallerSession;
	calls: { nsid: string; body: Record<string, unknown> }[];
	/** The acceptances in the member's repo, by space. */
	records: Map<string, Record<string, unknown>>;
	/** Spaces whose calls fail with a 500. */
	failFor: Set<string>;
}

function memberPds(): MemberPds {
	const pds: MemberPds = {
		calls: [],
		records: new Map(),
		failFor: new Set(),
		session(scope) {
			return {
				did: MEMBER,
				scope,
				async handle(pathname, init) {
					const nsid = pathname.replace(/^\/xrpc\//, '');
					const body = JSON.parse(String(init.body)) as Record<string, unknown>;
					pds.calls.push({ nsid, body });
					const space = String(body.space);
					if (pds.failFor.has(space)) {
						return Response.json({ error: 'InternalServerError' }, { status: 500 });
					}
					if (nsid === 'com.atproto.space.createRecord') {
						if (pds.records.has(space)) {
							return Response.json(
								{ error: 'RecordAlreadyExists', message: 'Record already exists' },
								{ status: 400 }
							);
						}
						pds.records.set(space, body.record as Record<string, unknown>);
						return Response.json({
							uri: `${space}/${MEMBER}/${body.collection}/self`,
							cid: 'bafy'
						});
					}
					if (nsid === 'com.atproto.space.deleteRecord') {
						pds.records.delete(space);
						return Response.json({});
					}
					return Response.json({ error: 'MethodNotImplemented' }, { status: 501 });
				}
			};
		}
	};
	return pds;
}

const group = { group_did: GROUP_DID, members_space_uri: MEMBERS } as GroupRow;

let pds: MemberPds;

beforeEach(() => {
	pds = memberPds();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('holdsAcceptanceGrant', () => {
	it("takes the participate set's grant for any group", () => {
		expect(holdsAcceptanceGrant(granted, GROUP_DID, 'create')).toBe(true);
		expect(holdsAcceptanceGrant(granted, GROUP_DID, 'delete')).toBe(true);
		expect(holdsAcceptanceGrant(granted, '*', 'create')).toBe(true);
	});

	// The spaces PDS drops every parameter left at its default when it hands a grant back.
	it('reads a grant as the PDS writes it, defaults dropped', () => {
		const asGranted = `space:${MEMBERS_SPACE_TYPE}?authority=*&skey=self&collection=${GROUP_ACCEPTANCE_COLLECTION}`;
		expect(holdsAcceptanceGrant(asGranted, GROUP_DID, 'create')).toBe(true);
		expect(holdsAcceptanceGrant(asGranted, GROUP_DID, 'delete')).toBe(true);
		// No collection: reads only. No authority: the signer's own repo, never a group's.
		expect(
			holdsAcceptanceGrant(`space:${MEMBERS_SPACE_TYPE}?authority=*`, GROUP_DID, 'create')
		).toBe(false);
		const own = `space:${MEMBERS_SPACE_TYPE}?collection=${GROUP_ACCEPTANCE_COLLECTION}`;
		expect(holdsAcceptanceGrant(own, GROUP_DID, 'create')).toBe(false);
	});

	it('needs the acceptance collection and the action asked for', () => {
		const roles = `space:*?authority=${GROUP_DID}&collection=group.opensocial.membership&action=create`;
		expect(holdsAcceptanceGrant(roles, GROUP_DID, 'create')).toBe(false);
		const createOnly = `space:*?authority=${GROUP_DID}&collection=${GROUP_ACCEPTANCE_COLLECTION}&action=create`;
		expect(holdsAcceptanceGrant(createOnly, GROUP_DID, 'create')).toBe(true);
		expect(holdsAcceptanceGrant(createOnly, GROUP_DID, 'delete')).toBe(false);
		expect(holdsAcceptanceGrant(createOnly, 'did:plc:other', 'create')).toBe(false);
	});
});

describe('writeAcceptance', () => {
	it("creates acceptance/self in the members space, in the member's own repo", async () => {
		const now = new Date('2026-10-04T12:00:00.000Z');

		expect(await writeAcceptance(pds.session(granted), group, now)).toBe('written');

		expect(pds.calls).toEqual([
			{
				nsid: 'com.atproto.space.createRecord',
				body: {
					space: MEMBERS,
					repo: MEMBER,
					collection: GROUP_ACCEPTANCE_COLLECTION,
					rkey: GROUP_ACCEPTANCE_RKEY,
					record: { $type: GROUP_ACCEPTANCE_COLLECTION, createdAt: now.toISOString() }
				}
			}
		]);
	});

	it('leaves an acceptance that exists as it is', async () => {
		await writeAcceptance(pds.session(granted), group, new Date('2026-10-01T00:00:00.000Z'));

		expect(await writeAcceptance(pds.session(granted), group, new Date())).toBe('present');

		expect(pds.records.get(MEMBERS)).toEqual({
			$type: GROUP_ACCEPTANCE_COLLECTION,
			createdAt: '2026-10-01T00:00:00.000Z'
		});
	});

	it('asks nothing of the PDS when the session does not hold the grant', async () => {
		expect(await writeAcceptance(pds.session(BASE_SCOPE), group)).toBe('skipped');
		expect(pds.calls).toEqual([]);
	});

	it('throws any other refusal', async () => {
		pds.failFor.add(MEMBERS);
		await expect(writeAcceptance(pds.session(granted), group)).rejects.toThrow(/500/);
	});
});

describe('deleteAcceptance', () => {
	it('deletes acceptance/self from the members space', async () => {
		await writeAcceptance(pds.session(granted), group);
		pds.calls.length = 0;

		expect(await deleteAcceptance(pds.session(granted), group)).toBe('deleted');

		expect(pds.calls).toEqual([
			{
				nsid: 'com.atproto.space.deleteRecord',
				body: {
					space: MEMBERS,
					repo: MEMBER,
					collection: GROUP_ACCEPTANCE_COLLECTION,
					rkey: GROUP_ACCEPTANCE_RKEY
				}
			}
		]);
		expect(pds.records.has(MEMBERS)).toBe(false);
	});
});

describe('acceptOnSignIn', () => {
	/** A database that fails the case if it is asked anything. */
	const untouchable = new Proxy({} as D1Database, {
		get() {
			throw new Error('the database was asked');
		}
	});

	function oauthSession(scope: string | Error): OAuthSession {
		const member = pds.session(typeof scope === 'string' ? scope : '');
		return {
			did: MEMBER,
			getTokenInfo: async () => {
				if (scope instanceof Error) throw scope;
				return { scope };
			},
			handle: member.handle
		} as unknown as OAuthSession;
	}

	it('asks nothing of the database for a sign-in without the grant', async () => {
		await expect(acceptOnSignIn(untouchable, oauthSession(BASE_SCOPE))).resolves.toBeUndefined();
	});

	it('goes on when the session scope cannot be read', async () => {
		await expect(
			acceptOnSignIn(untouchable, oauthSession(new Error('session gone')))
		).resolves.toBeUndefined();
		expect(console.warn).toHaveBeenCalled();
	});

	describe('with groups', () => {
		let harness: SqliteD1;

		beforeEach(() => {
			harness = sqliteD1();
		});

		afterEach(() => harness.close());

		async function aGroup(did: string, spaces = true): Promise<GroupRow> {
			return (
				await seedGroup({ harness, groupDid: did, creatorDid: 'did:plc:owner', name: did, spaces })
			).group;
		}

		const spaceOf = (did: string) => `at://${did}/space/${MEMBERS_SPACE_TYPE}/self`;

		it('writes one for each group the member is in, none for a request or a group without spaces', async () => {
			const joined = await aGroup('did:plc:joinedaaaaaaaaaaaaaaaaaa');
			const asked = await aGroup('did:plc:askedaaaaaaaaaaaaaaaaaaa');
			const bare = await aGroup('did:plc:bareaaaaaaaaaaaaaaaaaaaaa', false);
			await aGroup('did:plc:strangeraaaaaaaaaaaaaaaaa');
			await addMember(harness.db, joined.id, MEMBER, 'member');
			await noteJoinRequest(harness.db, asked.id, MEMBER, null);
			await addMember(harness.db, bare.id, MEMBER, 'member');

			await acceptOnSignIn(harness.db, oauthSession(granted));

			expect([...pds.records.keys()]).toEqual([spaceOf(joined.group_did)]);
		});

		it('carries on past a group whose write fails, and never throws', async () => {
			const first = await aGroup('did:plc:firstaaaaaaaaaaaaaaaaaaa');
			const second = await aGroup('did:plc:secondaaaaaaaaaaaaaaaaaa');
			await addMember(harness.db, first.id, MEMBER, 'member');
			await addMember(harness.db, second.id, MEMBER, 'member');
			pds.failFor.add(spaceOf(first.group_did));

			await expect(acceptOnSignIn(harness.db, oauthSession(granted))).resolves.toBeUndefined();

			expect([...pds.records.keys()]).toEqual([spaceOf(second.group_did)]);
			expect(console.warn).toHaveBeenCalled();
		});
	});
});

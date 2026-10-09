// The member's own half of a membership: the acceptance they write, from their
// own session, into their repo in the group's members space (spec FR-205, FR-209).
//
// The member's PDS is a fake that answers the way the spaces PDS does at the
// revision atmo targets: a create refuses a record that exists, with 400
// `RecordAlreadyExists`, and a delete succeeds whether or not the record was
// there. Each case asserts the request the PDS received, and what is in the
// member's repo afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces, requestJoin } from './repo';
import { memberGrant, holdsAcceptanceGrant } from './member-grants';
import {
	acceptOnSignIn,
	deleteAcceptance,
	writeAcceptance,
	writeMissingAcceptances,
	type MemberSession
} from './acceptance';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY } from '../members-record';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';

const MEMBER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OTHER_GROUP = 'did:plc:othergroupaaaaaaaaaaaaaa';
const MEMBERS = `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`;
const BASE_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=*';

interface MemberPds {
	session(scope: string): MemberSession;
	/** Every call, as the PDS saw it. */
	calls: { nsid: string; body: Record<string, unknown> }[];
	/** The acceptances in the member's repo, by space. */
	records: Map<string, Record<string, unknown>>;
	/** Answers a call with this status instead, for the spaces it names. */
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
							uri: `${space}/${MEMBER}/${body.collection}/${body.rkey}`,
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
const granted = `${BASE_SCOPE} ${memberGrant(GROUP_DID)}`;

let pds: MemberPds;

beforeEach(() => {
	pds = memberPds();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('holdsAcceptanceGrant', () => {
	// The scope is what the member's PDS granted. A stock PDS drops a space
	// grant it does not know, so a missing grant also means "no spaces here".
	it('reads the group’s grant out of a granted scope, and nothing broader or narrower', () => {
		expect(holdsAcceptanceGrant(granted, GROUP_DID, 'create')).toBe(true);
		expect(holdsAcceptanceGrant(granted, GROUP_DID, 'delete')).toBe(true);
		expect(holdsAcceptanceGrant(BASE_SCOPE, GROUP_DID, 'create')).toBe(false);
		expect(holdsAcceptanceGrant(granted, OTHER_GROUP, 'create')).toBe(false);
		// The same grant with its parameters in another order is the same grant.
		const reordered = `space:*?action=delete&collection=${GROUP_ACCEPTANCE_COLLECTION}&action=create&authority=${GROUP_DID}`;
		expect(holdsAcceptanceGrant(reordered, GROUP_DID, 'create')).toBe(true);
		// A grant for another collection, or without the action, is not this one.
		const roles = `space:*?authority=${GROUP_DID}&collection=group.opensocial.membership&action=create`;
		expect(holdsAcceptanceGrant(roles, GROUP_DID, 'create')).toBe(false);
		const createOnly = `space:*?authority=${GROUP_DID}&collection=${GROUP_ACCEPTANCE_COLLECTION}&action=create`;
		expect(holdsAcceptanceGrant(createOnly, GROUP_DID, 'delete')).toBe(false);
	});
});

describe('writeAcceptance', () => {
	it('creates acceptance/self in the members space, in the member’s own repo', async () => {
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

	// A create, never a put: the acceptance the member already wrote keeps its
	// date, and the space's writer set does not move on every sign-in.
	it('leaves an acceptance that exists as it is', async () => {
		await writeAcceptance(pds.session(granted), group, new Date('2026-10-01T00:00:00.000Z'));

		expect(await writeAcceptance(pds.session(granted), group, new Date())).toBe('present');

		expect(pds.records.get(MEMBERS)).toEqual({
			$type: GROUP_ACCEPTANCE_COLLECTION,
			createdAt: '2026-10-01T00:00:00.000Z'
		});
	});

	it('asks nothing of the PDS when the session does not hold the group’s grant', async () => {
		expect(await writeAcceptance(pds.session(BASE_SCOPE), group)).toBe('skipped');
		expect(pds.calls).toEqual([]);
	});

	it('asks nothing of the PDS for a group with no members space', async () => {
		const bare = { ...group, members_space_uri: null } as GroupRow;
		expect(await writeAcceptance(pds.session(granted), bare)).toBe('skipped');
		expect(pds.calls).toEqual([]);
	});

	it('throws any other refusal, so the caller decides what it costs', async () => {
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

	it('asks nothing of the PDS when the session does not hold the group’s grant', async () => {
		expect(await deleteAcceptance(pds.session(BASE_SCOPE), group)).toBe('skipped');
		expect(pds.calls).toEqual([]);
	});
});

// At sign-in (FR-205's last case): the creator, a direct admit, and any write
// that could not happen at its first moment.
describe('writeMissingAcceptances', () => {
	let harness: SqliteD1;

	beforeEach(() => {
		harness = sqliteD1();
	});

	afterEach(() => harness.close());

	/** A group with a members space, unless `spaces` is false. */
	async function aGroup(did: string, spaces = true): Promise<GroupRow> {
		const row = await createGroup(harness.db, {
			groupDid: did,
			ownerDid: 'did:plc:owner',
			name: did
		});
		if (!spaces) return row;
		const membersSpaceUri = `at://${did}/space/${MEMBERS_SPACE_TYPE}/self`;
		await recordGroupSpaces(harness.db, row.id, {
			aboutSpaceUri: `at://${did}/space/group.opensocial.about/self`,
			membersSpaceUri
		});
		return { ...row, members_space_uri: membersSpaceUri };
	}

	const spaceOf = (did: string) => `at://${did}/space/${MEMBERS_SPACE_TYPE}/self`;

	it('writes one for each group the member is in or asked to join, where they hold its grant', async () => {
		const joined = await aGroup('did:plc:joinedaaaaaaaaaaaaaaaaaa');
		const asked = await aGroup('did:plc:askedaaaaaaaaaaaaaaaaaaa');
		const ungranted = await aGroup('did:plc:ungrantedaaaaaaaaaaaaaaa');
		const bare = await aGroup('did:plc:bareaaaaaaaaaaaaaaaaaaaaa', false);
		const stranger = await aGroup('did:plc:strangeraaaaaaaaaaaaaaaaa');
		await addMember(harness.db, joined.id, MEMBER, 'member');
		await requestJoin(harness.db, asked, MEMBER, null, 'public');
		await addMember(harness.db, ungranted.id, MEMBER, 'member');
		await addMember(harness.db, bare.id, MEMBER, 'member');
		const scope = [
			BASE_SCOPE,
			...[joined, asked, bare, stranger].map((g) => memberGrant(g.group_did))
		].join(' ');

		await writeMissingAcceptances(harness.db, pds.session(scope));

		expect([...pds.records.keys()].sort()).toEqual(
			[spaceOf(joined.group_did), spaceOf(asked.group_did)].sort()
		);
	});

	// A sign-in never fails on the groups half: the member stays unconfirmed for
	// that group, and the next sign-in tries again.
	it('carries on past a group whose write fails, and never throws', async () => {
		const first = await aGroup('did:plc:firstaaaaaaaaaaaaaaaaaaa');
		const second = await aGroup('did:plc:secondaaaaaaaaaaaaaaaaaa');
		await addMember(harness.db, first.id, MEMBER, 'member');
		await addMember(harness.db, second.id, MEMBER, 'member');
		pds.failFor.add(spaceOf(first.group_did));
		const scope = [first, second].map((g) => memberGrant(g.group_did)).join(' ');

		await expect(writeMissingAcceptances(harness.db, pds.session(scope))).resolves.toBeUndefined();

		expect([...pds.records.keys()]).toEqual([spaceOf(second.group_did)]);
		expect(console.warn).toHaveBeenCalled();
	});
});

// The sign-in callback's one call. It is upstream's route, so whatever can go
// wrong is held here: nothing in it may fail a sign-in.
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

	it('asks nothing of the database for a member who holds no group grant', async () => {
		await expect(acceptOnSignIn(untouchable, oauthSession(BASE_SCOPE))).resolves.toBeUndefined();
	});

	it('goes on when the session’s scope cannot be read', async () => {
		await expect(
			acceptOnSignIn(untouchable, oauthSession(new Error('session gone')))
		).resolves.toBeUndefined();
		expect(console.warn).toHaveBeenCalled();
	});

	it('writes the missing acceptances for a member who holds a grant', async () => {
		const harness = sqliteD1();
		try {
			const row = await createGroup(harness.db, {
				groupDid: GROUP_DID,
				ownerDid: 'did:plc:owner',
				name: 'Kona'
			});
			await recordGroupSpaces(harness.db, row.id, {
				aboutSpaceUri: `at://${GROUP_DID}/space/group.opensocial.about/self`,
				membersSpaceUri: MEMBERS
			});
			await addMember(harness.db, row.id, MEMBER, 'member');

			await acceptOnSignIn(harness.db, oauthSession(granted));

			expect([...pds.records.keys()]).toEqual([MEMBERS]);
		} finally {
			harness.close();
		}
	});
});

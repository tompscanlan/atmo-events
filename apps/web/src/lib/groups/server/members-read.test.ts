import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { authzRecords, HOST_PERMISSIONS } from './__fixtures__/members-space';
import { hostDown, spaceReader, type SpaceRecordInput } from './__fixtures__/space-reader';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import { pdsSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	hasMemberRecords,
	readCallerAuthz,
	readGroupMembers,
	resolveActor,
	rolePermissionsFromRecords,
	rosterFromRecords,
	rosterFromRows
} from './members-read';
import {
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupMembershipRecord
} from '../members-record';
import { GROUP_PERMISSIONS } from '../permissions';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { spaceUri } from '../ids';
import { listMembers } from './db/roster';
import { getCallerMembership } from './standing';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const ALL = [...GROUP_PERMISSIONS].sort();
const AUTHZ = authzRecords(GROUP_DID, {});

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

const readerOver = (records: SpaceRecordInput[]) =>
	spaceReader(GROUP_DID, { space: MEMBERS, records });

function membership(did: string, roles: string[], createdAt = '2026-09-01T10:00:00.000Z') {
	return {
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did,
		value: {
			...groupMembershipRecord({ subject: did, roles, createdAt }),
			$type: GROUP_MEMBERSHIP_COLLECTION
		}
	};
}

const permissions = (grants: unknown[]) => ({
	collection: GROUP_PERMISSIONS_COLLECTION,
	rkey: GROUP_PERMISSIONS_RKEY,
	value: { $type: GROUP_PERMISSIONS_COLLECTION, grants }
});

const sorted = (set: ReadonlySet<string>) => [...set].sort();

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	}));
});

afterEach(() => harness.close());

describe('readGroupMembers', () => {
	it('reads the memberships, the role ids known first, the grants as written, and the access', async () => {
		const members = await readGroupMembers(
			readerOver([
				...AUTHZ,
				{ collection: GROUP_ROLE_COLLECTION, rkey: 'greeter', value: {} },
				membership(OWNER, ['admin'])
			]),
			group
		);

		expect(members.memberships).toEqual([
			expect.objectContaining({
				subject: OWNER,
				roles: ['admin'],
				uri: `${MEMBERS}/${GROUP_DID}/${GROUP_MEMBERSHIP_COLLECTION}/${OWNER}`
			})
		]);
		expect(members.roles).toEqual(['admin', 'member', 'greeter']);
		expect(members.permissions).toEqual(HOST_PERMISSIONS.grants);
		expect(members.access?.public).toBe(false);
	});

	it('is empty, not an error, for a space that holds nothing', async () => {
		const members = await readGroupMembers(readerOver([]), group);
		expect(members).toEqual(NO_MEMBER_RECORDS);
		expect(hasMemberRecords(members)).toBe(false);
	});

	it('reads one membership by key for the gate, not the roster', async () => {
		const members = await readCallerAuthz(
			readerOver([...AUTHZ, membership(OWNER, ['admin']), membership(ADMIN, ['admin'])]),
			group,
			ADMIN
		);
		expect(members.memberships.map((m) => m.subject)).toEqual([ADMIN]);
	});
});

describe('what the records grant', () => {
	it('gives the host’s admin every permission and its member none', async () => {
		const members = await readGroupMembers(
			readerOver([...AUTHZ, membership(ADMIN, ['admin']), membership(MEMBER, ['member'])]),
			group
		);
		expect(sorted(resolveActor(members, ADMIN, GROUP_DID).permissions)).toEqual(ALL);
		for (const did of [MEMBER, STRANGER, null]) {
			expect(resolveActor(members, did, GROUP_DID).permissions.size, String(did)).toBe(0);
		}
		expect(rolePermissionsFromRecords(members, GROUP_DID)).toEqual({
			admin: [...GROUP_PERMISSIONS],
			member: []
		});
	});

	it('takes the event permissions from repo scopes, and nothing from an unknown scope', async () => {
		const members = await readGroupMembers(
			readerOver([
				permissions([
					{
						role: 'member',
						scopes: ['takedown', 'repo:community.lexicon.calendar.event?action=create']
					}
				]),
				membership(MEMBER, ['member'])
			]),
			group
		);
		expect(sorted(resolveActor(members, MEMBER, GROUP_DID).permissions)).toEqual(['CREATE_EVENT']);
	});
});

describe('rosterFromRecords', () => {
	it('orders by join time as the rows do, and keeps a role atmo does not know', async () => {
		const joined = {
			[MEMBER]: '2026-09-03T10:00:00.000Z',
			[OWNER]: '2026-09-05T10:00:00.000Z',
			[ADMIN]: '2026-09-02T10:00:00.000Z'
		};
		const members = await readGroupMembers(
			readerOver([
				membership(MEMBER, ['member'], joined[MEMBER]),
				membership(OWNER, ['greeter'], joined[OWNER]),
				membership(ADMIN, ['member', 'admin'], joined[ADMIN])
			]),
			group
		);
		for (const [did, at] of Object.entries(joined)) {
			harness.raw
				.prepare('UPDATE memberships SET created_at = ? WHERE did = ?')
				.run(Date.parse(at), did);
		}

		expect(rosterFromRecords(members).map((e) => [e.did, e.role])).toEqual([
			[ADMIN, 'admin'],
			[MEMBER, 'member'],
			[OWNER, 'greeter']
		]);
		expect(rosterFromRows(await listMembers(db, group.id)).map((e) => e.did)).toEqual([
			ADMIN,
			MEMBER,
			OWNER
		]);
	});
});

describe('the gate, from records', () => {
	it('grants nothing, and no roster place, to a row with no membership record', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, readerOver(AUTHZ));
		expect(admin.role).toBe('admin');
		expect(admin.permissions.size).toBe(0);
		expect(admin.onRoster).toBe(false);
	});

	it('puts a DID with a membership record on the roster, whatever the rows say', async () => {
		const joined = await getCallerMembership(
			db,
			group,
			STRANGER,
			readerOver([...AUTHZ, membership(STRANGER, ['member'])])
		);
		expect(joined.role).toBeNull();
		expect(joined.onRoster).toBe(true);
	});

	it('never puts anyone on the roster without a reader, whatever the rows say', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, null);
		expect(admin.onRoster).toBe(false);
		expect(admin.permissions.size).toBe(0);
	});

	it('changes the next decision when the permissions record changes, with no D1 write', async () => {
		const record = membership(MEMBER, ['member']);
		const before = await getCallerMembership(db, group, MEMBER, readerOver([...AUTHZ, record]));
		expect(before.permissions.size).toBe(0);

		const edited = [
			...AUTHZ.filter((r) => r.collection !== GROUP_PERMISSIONS_COLLECTION),
			permissions([{ role: 'member', scopes: ['repo:*'] }]),
			record
		];
		const after = await getCallerMembership(db, group, MEMBER, readerOver(edited));
		expect(sorted(after.permissions)).toEqual(['CREATE_EVENT', 'MANAGE_EVENTS']);
	});

	it('gives the group DID itself every permission, with nothing read', async () => {
		const reader = readerOver([]);
		const itself = await getCallerMembership(db, group, GROUP_DID, reader);
		expect(sorted(itself.permissions)).toEqual(ALL);
		expect(itself.onRoster).toBe(true);
		expect(reader.calls).toEqual([]);
	});

	it('reads nothing for an anonymous caller', async () => {
		const reader = readerOver(AUTHZ);
		expect((await getCallerMembership(db, group, null, reader)).permissions.size).toBe(0);
		expect(reader.calls).toEqual([]);
	});

	it('fails closed when the space cannot be read', async () => {
		const down = spaceReader(GROUP_DID, { fail: hostDown(502) });
		await expect(getCallerMembership(db, group, ADMIN, down)).rejects.toThrow();
	});

	it('fails closed when the PDS refuses a space read with a 400 that is not RecordNotFound', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ error: 'SpaceNotFound' }, { status: 400 }));
		try {
			const reader = pdsSpaceReader(linkedCredential(GROUP_DID), GROUP_DID);
			await expect(getCallerMembership(db, group, ADMIN, reader)).rejects.toThrow();
		} finally {
			vi.unstubAllGlobals();
			unlinkAllGroups();
		}
	});
});

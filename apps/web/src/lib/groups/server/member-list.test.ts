// A group's three member lists, through the transport the app uses: the group's
// own session against the stub host. The host pages a few entries at a time, so
// a listing of more than one page shows the cursor is followed.
//
// Each list follows its space's `access` record: a member is listed read and
// write exactly where a role they hold is granted `read`. (Spec: FR-214.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { spaceUri } from '../ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord,
	parseGroupAccess,
	type GroupAccessFields
} from '../members-record';
import { GROUP_ROLES } from '../permissions';
import { stubPds } from './__fixtures__/stub-pds';
import { spaceReader } from './__fixtures__/space-reader';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	SPACE_MEMBER_ACCESS,
	alignSpaceMembers,
	pdsMemberList,
	placeMember,
	readSpaceAccess,
	readSpaceMembers,
	spacesReadBy,
	unlistMember,
	type GroupMemberList,
	type GroupSpaceAccess
} from './member-list';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const CALENDAR = spaceUri(GROUP_DID, CALENDAR_SPACE_TYPE, 'self');
const group = { group_did: GROUP_DID, about_space_uri: ABOUT, members_space_uri: MEMBERS };
const did = (n: number) => `did:plc:member${String(n).padStart(17, '0')}`;

/** A space's access record as atmo writes it: every role reads. */
const everyRoleReads = (spaceType: string): GroupAccessFields =>
	parseGroupAccess(groupAccessRecord({ spaceType, roles: GROUP_ROLES, public: false }))!;

/** All three spaces' records as a create leaves them. */
const created = (): GroupSpaceAccess => ({
	members: everyRoleReads(MEMBERS_SPACE_TYPE),
	about: everyRoleReads(ABOUT_SPACE_TYPE),
	calendar: everyRoleReads(CALENDAR_SPACE_TYPE)
});

let pds: ReturnType<typeof stubPds>;
let list: GroupMemberList;
let failing: string | null;

beforeEach(async () => {
	failing = null;
	pds = stubPds({
		did: GROUP_DID,
		handle: 'kona.groups.example.com',
		memberPageSize: 2,
		fail: (nsid) =>
			nsid === failing ? Response.json({ error: 'InternalError' }, { status: 500 }) : undefined
	});
	const cred = linkedCredential(GROUP_DID);
	list = pdsMemberList(cred, GROUP_DID);
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await provisionGroupSpaces(pdsProvisioner(cred, GROUP_DID));
	pds.clearLog();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
});

/** Each list call the host received, in order, as `<method> <space>`. */
function listCalls(): string[] {
	const name = { [MEMBERS]: 'members', [ABOUT]: 'about', [CALENDAR]: 'calendar' };
	return pds
		.writes()
		.filter((r) => r.nsid.startsWith('com.atproto.simplespace.'))
		.map((r) => {
			const body = r.body as { space: string; read?: boolean; write?: boolean };
			const method = r.nsid.replace('com.atproto.simplespace.', '');
			const access = method === 'putMember' ? ` read:${body.read} write:${body.write}` : '';
			return `${method} ${name[body.space] ?? body.space}${access}`;
		});
}

describe('the PDS transport', () => {
	it('puts, lists across pages and removes entries on a space', async () => {
		for (const n of [1, 2, 3, 4, 5])
			await list.put({ space: MEMBERS, did: did(n), read: false, write: true });
		await list.remove({ space: MEMBERS, did: did(3) });

		const members = await readSpaceMembers(list, MEMBERS);

		expect(members).toEqual([1, 2, 4, 5].map((n) => ({ did: did(n), read: false, write: true })));
		// Five entries at two a page: the read took more than one listing.
		expect(
			pds.requests.filter((r) => r.nsid === 'com.atproto.simplespace.listMembers').length
		).toBeGreaterThan(1);
	});

	it('refuses a change the host refuses', async () => {
		failing = 'com.atproto.simplespace.putMember';
		const refusal = list.put({ space: MEMBERS, did: did(1), ...SPACE_MEMBER_ACCESS });
		await expect(refusal).rejects.toBeInstanceOf(GroupSpaceError);
	});

	it('refuses a listing that fails rather than reading it as empty', async () => {
		failing = 'com.atproto.simplespace.listMembers';
		await expect(readSpaceMembers(list, ABOUT)).rejects.toThrow(`listMembers failed on ${ABOUT}`);
	});

	it('names the calendar space in a refusal about it', async () => {
		failing = 'com.atproto.simplespace.removeMember';
		const refusal = list.remove({ space: CALENDAR, did: did(1) });
		await expect(refusal).rejects.toMatchObject({ spaceType: CALENDAR_SPACE_TYPE });
	});
});

describe('reading a whole list', () => {
	it('stops on a cursor that does not move instead of looping', async () => {
		const stuck: GroupMemberList = {
			put: async () => {},
			remove: async () => {},
			list: async () => ({ members: [{ did: did(1), read: true, write: false }], cursor: 'same' })
		};
		await expect(readSpaceMembers(stuck, ABOUT)).rejects.toThrow('repeated its cursor');
	});
});

describe('reading the three access records', () => {
	it('reads each space’s record from its own space, and a missing one as null', async () => {
		const reader = spaceReader(GROUP_DID, {
			records: [
				{
					space: MEMBERS,
					collection: GROUP_ACCESS_COLLECTION,
					rkey: GROUP_ACCESS_RKEY,
					value: groupAccessRecord({
						spaceType: MEMBERS_SPACE_TYPE,
						roles: ['admin'],
						public: false
					})
				},
				{
					space: ABOUT,
					collection: GROUP_ACCESS_COLLECTION,
					rkey: GROUP_ACCESS_RKEY,
					value: groupAccessRecord({
						spaceType: ABOUT_SPACE_TYPE,
						roles: GROUP_ROLES,
						public: true
					})
				}
			]
		});

		const access = await readSpaceAccess(reader, group);

		expect(access.members?.roles).toEqual(['admin']);
		expect(access.about?.public).toBe(true);
		expect(access.calendar).toBeNull();
		expect(reader.calls.sort()).toEqual(
			[MEMBERS, ABOUT, CALENDAR]
				.map((space) => `get ${space} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`)
				.sort()
		);
	});

	it('throws when a read fails, rather than deriving a list from no policy', async () => {
		const reader = spaceReader(GROUP_DID, {
			fail: (call) => (call.space === CALENDAR ? new Error('502') : undefined)
		});
		await expect(readSpaceAccess(reader, group)).rejects.toThrow('502');
	});
});

describe('which spaces a member’s roles read', () => {
	it('every space a create writes, for every role it has', () => {
		for (const role of GROUP_ROLES) {
			expect([...spacesReadBy(created(), [role])]).toEqual(['members', 'about', 'calendar']);
		}
	});

	it('only the spaces whose record grants one of the roles read', () => {
		const access: GroupSpaceAccess = {
			...created(),
			calendar: parseGroupAccess(
				groupAccessRecord({ spaceType: CALENDAR_SPACE_TYPE, roles: ['admin'], public: false })
			)
		};
		expect([...spacesReadBy(access, ['member'])]).toEqual(['members', 'about']);
		expect([...spacesReadBy(access, ['member', 'admin'])]).toEqual([
			'members',
			'about',
			'calendar'
		]);
	});

	it('a missing record grants no one, and a grant without read is not one', () => {
		const access: GroupSpaceAccess = {
			members: null,
			about: parseGroupAccess({
				public: false,
				grants: [{ role: 'member', scopes: [`space:${ABOUT_SPACE_TYPE}?action=create`] }]
			}),
			calendar: everyRoleReads(CALENDAR_SPACE_TYPE)
		};
		expect([...spacesReadBy(access, ['member'])]).toEqual(['calendar']);
	});

	it('honors a role atmo does not know that a record grants read', () => {
		const access: GroupSpaceAccess = {
			...created(),
			calendar: parseGroupAccess({
				public: false,
				grants: [{ role: 'organizer', scopes: [`space:${CALENDAR_SPACE_TYPE}?action=read`] }]
			})
		};
		expect([...spacesReadBy(access, ['organizer'])]).toEqual(['calendar']);
		expect([...spacesReadBy(access, ['member'])]).toEqual(['members', 'about']);
	});
});

describe('placing a member', () => {
	// The members space's entry goes first, so it exists before the member
	// writes their acceptance there. (Spec: FR-206, FR-214.)
	it('lists the member on all three spaces, read and write, the members space first', async () => {
		await placeMember(list, group, did(1), ['member'], created());

		expect(listCalls()).toEqual([
			'putMember members read:true write:true',
			'putMember about read:true write:true',
			'putMember calendar read:true write:true'
		]);
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.members(space)).toEqual([{ did: did(1), ...SPACE_MEMBER_ACCESS }]);
		}
	});

	it('takes the member off a space whose record no longer grants their roles read', async () => {
		await placeMember(list, group, did(1), ['admin'], created());
		pds.clearLog();
		const access: GroupSpaceAccess = {
			...created(),
			calendar: parseGroupAccess(
				groupAccessRecord({ spaceType: CALENDAR_SPACE_TYPE, roles: ['admin'], public: false })
			)
		};

		await placeMember(list, group, did(1), ['member'], access);

		expect(listCalls()).toEqual([
			'putMember members read:true write:true',
			'putMember about read:true write:true',
			'removeMember calendar'
		]);
		expect(pds.listed(CALENDAR)).toEqual([]);
		expect(pds.listed(MEMBERS)).toEqual([did(1)]);
	});

	it('honors a role atmo does not know', async () => {
		const access: GroupSpaceAccess = {
			members: null,
			about: null,
			calendar: parseGroupAccess({
				public: false,
				grants: [{ role: 'organizer', scopes: [`space:${CALENDAR_SPACE_TYPE}`] }]
			})
		};

		await placeMember(list, group, did(1), ['organizer'], access);

		expect(pds.listed(CALENDAR)).toEqual([did(1)]);
		expect(pds.listed(MEMBERS)).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([]);
	});

	it('lists no one where the access record is missing', async () => {
		await placeMember(list, group, did(1), ['admin'], { ...created(), members: null });

		expect(pds.listed(MEMBERS)).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([did(1)]);
		expect(pds.listed(CALENDAR)).toEqual([did(1)]);
	});

	it('writes nothing for a group whose spaces were never recorded', async () => {
		await expect(
			placeMember(list, { ...group, about_space_uri: null }, did(1), ['member'], created())
		).rejects.toThrow();
		expect(pds.writes()).toEqual([]);
	});
});

describe('unlisting a member', () => {
	// The members space's entry goes last, so the host still accepts the notice
	// of the member's acceptance delete.
	it('takes the member off all three spaces, the members space last', async () => {
		await placeMember(list, group, did(1), ['member'], created());
		pds.clearLog();

		await unlistMember(list, group, did(1));

		expect(listCalls()).toEqual([
			'removeMember calendar',
			'removeMember about',
			'removeMember members'
		]);
		for (const space of [MEMBERS, ABOUT, CALENDAR]) expect(pds.listed(space)).toEqual([]);
	});

	it('writes nothing for a group whose spaces were never recorded', async () => {
		await expect(
			unlistMember(list, { ...group, members_space_uri: null }, did(1))
		).rejects.toThrow();
		expect(pds.writes()).toEqual([]);
	});
});

describe('aligning a list', () => {
	it('lists the holders read and write, rewrites a read-only entry, and drops everyone else', async () => {
		await list.put({ space: ABOUT, did: did(1), read: true, write: false });
		await list.put({ space: ABOUT, did: did(2), ...SPACE_MEMBER_ACCESS });
		await list.put({ space: ABOUT, did: did(3), ...SPACE_MEMBER_ACCESS });
		pds.clearLog();

		const changed = await alignSpaceMembers(
			list,
			group,
			'about',
			new Set([did(1), did(2), did(4), GROUP_DID])
		);

		expect(changed).toEqual({ added: [did(1), did(4)], removed: [did(3)] });
		expect(pds.members(ABOUT)).toEqual(
			[1, 2, 4].map((n) => ({ did: did(n), ...SPACE_MEMBER_ACCESS }))
		);
		// The group's own DID owns the space and is never listed.
		expect(pds.listed(ABOUT)).not.toContain(GROUP_DID);
	});

	it('writes nothing when the list already agrees', async () => {
		await list.put({ space: CALENDAR, did: did(1), ...SPACE_MEMBER_ACCESS });
		pds.clearLog();

		expect(await alignSpaceMembers(list, group, 'calendar', new Set([did(1)]))).toEqual({
			added: [],
			removed: []
		});
		expect(pds.writes()).toEqual([]);
	});
});

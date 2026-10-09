// A group's two member lists, through the transport the app uses: the group's
// own session against the stub host. The host pages a few entries at a time, so
// a listing of more than one page shows the cursor is followed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { spaceUri } from '../ids';
import { stubPds } from './__fixtures__/stub-pds';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	ABOUT_MEMBER_ACCESS,
	MEMBERS_WRITER_ACCESS,
	listRosterMember,
	pdsMemberList,
	readSpaceMembers,
	type GroupMemberList
} from './member-list';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const group = { group_did: GROUP_DID, about_space_uri: ABOUT, members_space_uri: MEMBERS };
const did = (n: number) => `did:plc:member${String(n).padStart(17, '0')}`;

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
	await provisionGroupSpaces(pdsProvisioner(cred, GROUP_DID), 'public');
	pds.clearLog();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
});

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
		const refusal = list.put({ space: MEMBERS, did: did(1), ...MEMBERS_WRITER_ACCESS });
		await expect(refusal).rejects.toBeInstanceOf(GroupSpaceError);
	});

	it('refuses a listing that fails rather than reading it as empty', async () => {
		failing = 'com.atproto.simplespace.listMembers';
		await expect(readSpaceMembers(list, ABOUT)).rejects.toThrow(`listMembers failed on ${ABOUT}`);
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

describe('listing a roster member', () => {
	it('grants the write-only entry before the read-only one, so read access comes last', async () => {
		await listRosterMember(list, group, did(1));

		const puts = pds.requests
			.filter((r) => r.nsid === 'com.atproto.simplespace.putMember')
			.map((r) => r.body as { space: string; read: boolean; write: boolean });
		expect(puts.map(({ space, read, write }) => ({ space, read, write }))).toEqual([
			{ space: MEMBERS, ...MEMBERS_WRITER_ACCESS },
			{ space: ABOUT, ...ABOUT_MEMBER_ACCESS }
		]);
	});

	it('writes nothing for a group whose spaces were never recorded', async () => {
		await expect(
			listRosterMember(list, { ...group, about_space_uri: null }, did(1))
		).rejects.toThrow();
		expect(pds.writes()).toEqual([]);
	});
});

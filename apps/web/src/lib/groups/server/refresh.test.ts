// The settings page's refresh from the group host. It re-reads the group's
// records into this site's copy, through the caller's own access, and so it
// writes nothing at the host: no record, no read policy, no member list. A
// second run finds nothing to change. Every case runs against the fake group
// host (./__fixtures__/group-host.ts) and reads what the host received and what
// the copy in D1 holds.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { fakeGroupHost } from './__fixtures__/group-host';
import { putGroupMembership } from './members-writer';
import { writeAuthzRecords, writeClosedAccess } from './__fixtures__/members-space';
import { writeAboutAccess } from './about-writer';
import { pdsSpaceReader, type GroupSpaceReader } from './about-read';
import { describeRefresh, refreshGroup } from './refresh';
import { didSpaceHosts, SpaceAccessDenied } from './space-credential';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import type { GroupRow } from '../types';
import { GroupPermissionError } from './group-write';
import { createGroup, getGroupByDid, recordGroupSpaces } from './db/groups';
import { addMember, getMemberRow } from './db/roster';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const CRED = linkedCredential(GROUP_DID);

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let pds: ReturnType<typeof fakeGroupHost>;
let env: ReturnType<typeof linkGroups>;

/** Every call that would change something at the host: the fake's own list of
 *  writes, and a batch of record writes, which it does not serve. */
const hostWrites = () => [
	...pds.writes().map((r) => r.nsid),
	...pds.requests.map((r) => r.nsid).filter((nsid) => nsid.endsWith('.applyWrites'))
];

/** This site's copy of the group: its row, roles and memberships. A rebuild
 *  stamps the row's `updated_at` each time, so that column is left out. */
function cache() {
	const all = (sql: string) => harness.raw.prepare(sql).all();
	return {
		groups: all('SELECT * FROM groups').map((row) => ({ ...row, updated_at: null })),
		roles: all('SELECT * FROM roles ORDER BY id'),
		permissions: all('SELECT * FROM role_permissions ORDER BY role_id, permission'),
		memberships: all('SELECT * FROM memberships ORDER BY did')
	};
}

/** The caller's own reader, as a request builds it. The fake host lets every
 *  session read every space, so the group's credential stands in for it. */
const ownReader = () => pdsSpaceReader(CRED, GROUP_DID);

/** Refresh as the settings page runs it, on the group's current row. */
const refresh = async (
	callerDid: string | null = OWNER,
	reader: GroupSpaceReader | null = ownReader(),
	refreshEnv: Parameters<typeof refreshGroup>[0]['env'] = env
) =>
	refreshGroup({
		db,
		env: refreshEnv,
		group: (await getGroupByDid(db, GROUP_DID))!,
		callerDid,
		reader
	});

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	env = linkGroups([GROUP_DID]);
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	pds = fakeGroupHost({ did: GROUP_DID });
	const uris = pds.holdGroup('private');
	await recordGroupSpaces(db, group.id, uris);
	group = {
		...group,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};

	// A complete group at the host: its access records, the creator's
	// membership and the authz config.
	const seed = { db, env, group, callerDid: GROUP_DID };
	await writeClosedAccess(seed);
	await writeClosedAccess({ ...seed, space: uris.calendarSpaceUri });
	await writeAboutAccess({ ...seed, visibility: 'private' });
	await putGroupMembership({ ...seed, subject: OWNER, roles: ['admin'], intent: 'admit' });
	await writeAuthzRecords(seed);
	pds.clearLog();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
	harness.close();
});

/** Someone joins at the host through another app: their record exists, and this
 *  site's copy does not know them. */
const joinElsewhere = () =>
	putGroupMembership({
		db,
		env,
		group,
		callerDid: GROUP_DID,
		subject: MEMBER,
		roles: ['member'],
		intent: 'admit'
	}).then(() => pds.clearLog());

describe('refreshGroup', () => {
	it('picks up a member who joined at the host, and writes nothing at the host', async () => {
		await joinElsewhere();
		expect(await getMemberRow(db, group.id, MEMBER)).toBeNull();

		const result = await refresh();

		expect(result.members.restored).toEqual([MEMBER]);
		expect(await getMemberRow(db, group.id, MEMBER)).not.toBeNull();
		expect(hostWrites()).toEqual([]);
	});

	it('changes nothing on a second run, here or at the host', async () => {
		await joinElsewhere();
		await refresh();
		const before = cache();
		pds.clearLog();

		const again = await refresh();

		expect(again.members.restored).toEqual([]);
		expect(cache()).toEqual(before);
		expect(hostWrites()).toEqual([]);
	});

	it('refuses a caller without the permission, and a signed-out one, and changes nothing', async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await joinElsewhere();
		const before = cache();

		await expect(refresh(MEMBER)).rejects.toBeInstanceOf(GroupPermissionError);
		await expect(refresh(null)).rejects.toBeInstanceOf(GroupPermissionError);

		expect(cache()).toEqual(before);
		expect(hostWrites()).toEqual([]);
	});

	// Without a reader the gate has only the rows, which grant no scope.
	it('refuses the owner when their sign-in reads none of the group, and changes nothing', async () => {
		await joinElsewhere();
		const before = cache();

		await expect(refresh(OWNER, null)).rejects.toBeInstanceOf(GroupPermissionError);

		expect(cache()).toEqual(before);
		expect(hostWrites()).toEqual([]);
	});

	// The caller's own access is what the gate reads their roles with. A host
	// that will not let them into the members space leaves them holding nothing
	// there, which the gate refuses as it refuses any non-member.
	it('refuses the owner when the host will not let their own access into the members space, and changes nothing', async () => {
		await joinElsewhere();
		const before = cache();
		const own = ownReader();
		const denied = (space: string) => {
			if (space === group.members_space_uri) {
				throw new SpaceAccessDenied(space, '400 UserNotAuthorized');
			}
		};
		const refused: GroupSpaceReader = {
			get: async (query) => (denied(query.space), own.get(query)),
			list: async (query) => (denied(query.space), own.list(query)),
			getSpace: async (space) => (denied(space), own.getSpace(space))
		};

		await expect(refresh(OWNER, refused)).rejects.toBeInstanceOf(GroupPermissionError);

		expect(cache()).toEqual(before);
		expect(hostWrites()).toEqual([]);
	});

	// The host decides every write to the group, but this site's copy is the
	// site's own, so the gate still checks a refresh there.
	it('refreshes a group at a group host the same way, behind the same gate', async () => {
		vi.spyOn(didSpaceHosts, 'repoHost').mockResolvedValue(STUB_PDS_SERVICE);
		const atHost = { ...env, GROUP_HOST_URL: STUB_PDS_SERVICE };
		await addMember(db, group.id, MEMBER, 'member');
		await joinElsewhere();

		await expect(refresh(MEMBER, ownReader(), atHost)).rejects.toBeInstanceOf(GroupPermissionError);
		const result = await refresh(OWNER, ownReader(), atHost);

		expect(result.path).toBe('repaired');
		expect(hostWrites()).toEqual([]);
	});

	it('says it changed nothing at the host', async () => {
		expect(describeRefresh(await refresh())).toBe(
			"Re-read the group from its host into this site's copy. Nothing at the host was changed. The group has no profile record, so its name and description here were left as they were."
		);
	});
});

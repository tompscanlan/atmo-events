// The settings save, tested against the fake group host and the real schema.
//
// A group's visibility is its about space's `access` record: `public` says
// anyone may read the space. The host decides every read from that record, so
// the save sends no read policy and no member list, and the record is all it
// changes. (Spec: FR-214, SC-208.)
//
// These cases pin the order the save writes in, because each failure between
// two writes leaves a different half-state behind. A group that ends up private
// withdraws its declaration, writes the record, then the row, the profile and
// the rules: browse shows a declared group's name and description from the row,
// so new text must not reach the row while the group is still declared, and a
// declaration exists only while the record says public. A group that ends up
// public writes the record, writes the row, reads the record again, and
// declares only when that read still says public, then writes the profile and
// the rules. The row holds no visibility at all.
//
// The form sends the visibility it showed as well as the one chosen, and a save
// changes the visibility only when the two differ. A tab opened before someone
// else changed the record still shows the old value, and saving it untouched
// must not put that value back.
//
// The host is the fake group host (./server/__fixtures__/group-host.ts),
// reached through the real transports, so the bodies asserted here are the
// bodies a host would receive.
//
// The save reads what it would change with the caller's own access (TS
// 2026-10-15) and writes as the group. The owner's roles read every space, so
// their own access reads what the group's session reads; the fake answers
// space reads, not credential exchanges, so the owner's reads reach it over the
// group's transport here. With no reader at all, nothing is saved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

/** Every URI our index was told about, in order. `down` makes it throw instead. */
const index = vi.hoisted(() => ({ told: [] as string[], down: null as Error | null }));

// The index runs in process over D1, and a real one would need its own database
// and an appview. So its client is replaced, and only that: the notifier that
// calls it is the app's own (./server/browse-index.test.ts runs the real one).
vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			if (index.down) throw index.down;
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		}
	})
}));

import { isRowWrite, sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { approvalRefusal } from './about-record';
import {
	fakeGroupHost,
	type FakeGroupHost,
	type FakeGroupHostOptions
} from './server/__fixtures__/group-host';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from './members-record';

import { pdsSpaceReader } from './server/about-read';
import { writeGroupProfile } from './server/about-writer';
import {
	STUB_PDS_SERVICE,
	atGroupHost,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './server/__fixtures__/linked-group';

import {
	ABOUT_SPACE_TYPE,
	CALENDAR_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type GroupRow,
	type GroupVisibility
} from './types';
import { runUpdateGroup, type UpdateGroupData } from './update-group';

import { pdsWriter } from './server/group-write';
import { putGroupMembership } from './server/members-writer';
import { writeAuthzRecords, writeClosedAccess } from './server/__fixtures__/members-space';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/db/groups';
const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:settingsgroupaaaaaaaaaaa';
const CRED = linkedCredential(GROUP_DID);
const ABOUT = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
const MEMBERS = `at://${GROUP_DID}/space/${MEMBERS_SPACE_TYPE}/self`;
const CALENDAR = `at://${GROUP_DID}/space/${CALENDAR_SPACE_TYPE}/self`;
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';

const pdsDown = () => Response.json({ error: 'InternalServerError' }, { status: 500 });

let harness: SqliteD1;
let env: ReturnType<typeof linkGroups>;

beforeEach(() => {
	harness = sqliteD1();
	env = atGroupHost(linkGroups([GROUP_DID]));
	index.told = [];
	index.down = null;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

type Host = FakeGroupHost;

function host(fail?: FakeGroupHostOptions['fail']): Host {
	return fakeGroupHost({ did: GROUP_DID, fail });
}

/** The background and the scenario's "given": a group whose owner linked its
 *  account, whose three spaces the host holds as it made them for
 *  `visibility`, the choice made then: the about space's access record says the
 *  choice, and the other two are closed. The host's log is cleared afterwards,
 *  so a case asserts on the save alone. */
async function givenGroup(
	visibility: GroupVisibility,
	pds: Host,
	requireApproval = true
): Promise<GroupRow> {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Trail Runners',
		requireApproval
	});
	const uris = pds.holdGroup(visibility);
	await recordGroupSpaces(harness.db, row.id, uris);
	const group = {
		...row,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	// The owner's membership and the authz config, which is what lets the owner
	// save. Written as the group, as the create writes them.
	await writeAuthzRecords(asGroup(group));
	await putGroupMembership({
		...asGroup(group),
		subject: OWNER,
		roles: ['admin'],
		intent: 'admit'
	});
	pds.clearLog();
	return group;
}

/** The group's own writes, past the gate, as the create makes them. */
function asGroup(group: GroupRow) {
	return {
		db: harness.db,
		env,
		group,
		callerDid: GROUP_DID,
		reader: pdsSpaceReader(CRED, GROUP_DID)
	};
}

/** The rest of what a create and an admission leave: the members and calendar
 *  spaces' access records, and `MEMBER` admitted as a `member`. */
async function givenMember(group: GroupRow, pds: Host): Promise<void> {
	await writeClosedAccess(asGroup(group));
	await writeClosedAccess({ ...asGroup(group), space: CALENDAR });
	await putGroupMembership({
		...asGroup(group),
		subject: MEMBER,
		roles: ['member'],
		intent: 'admit'
	});
	pds.clearLog();
}

/** Another client's narrowing: the access record says private. */
async function narrowedElsewhere(): Promise<void> {
	await writeAboutAccessDirect(false);
}

/** The about space's access record, put through the transport and past the
 *  gate, as another client with the scope would. */
function writeAboutAccessDirect(isPublic: boolean) {
	return pdsWriter(
		CRED,
		GROUP_DID
	)({
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record: {
			...groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: isPublic
			}),
			$type: GROUP_ACCESS_COLLECTION
		},
		intent: 'update',
		space: ABOUT
	});
}

/** The owner's own reads, which reach every space of the group (see the header). */
const ownerReader = () => pdsSpaceReader(CRED, GROUP_DID);

/** The owner saving the settings form. `shownVisibility`, what the form showed
 *  when it opened, defaults to the chosen visibility: a select left alone. A
 *  case that changes the visibility says what the form showed, because without
 *  it the save is an untouched one and changes nothing at the host. */
function save(group: GroupRow, visibility: GroupVisibility, extra: Partial<UpdateGroupData> = {}) {
	return runUpdateGroup(
		env,
		harness.db,
		group,
		{ did: OWNER, reader: ownerReader() },
		{
			name: 'Kona Trail Runners',
			visibility,
			shownVisibility: visibility,
			requireApproval: true,
			...extra
		}
	);
}

/** A form whose page could not read the access record when it opened, so it
 *  showed no visibility and sends none. */
const NOT_SHOWN: Partial<UpdateGroupData> = { shownVisibility: undefined };

/** Whether the group's public repo holds a declaration, asked the way an
 *  anonymous peer would. */
async function declaredNow(): Promise<boolean> {
	const q = new URLSearchParams({
		repo: GROUP_DID,
		collection: 'group.opensocial.declaration',
		rkey: 'self'
	});
	return (await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.repo.getRecord?${q}`)).ok;
}

/** The about space's access record as the host holds it, read with the group's
 *  own session, or null. */
async function aboutAccessNow(): Promise<Record<string, unknown> | null> {
	const found = await pdsSpaceReader(CRED, GROUP_DID).get({
		space: ABOUT,
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});
	return found?.value ?? null;
}

/** Every write the host received, in order, named by method and by the
 *  collection it wrote. */
function traced(pds: Host): string[] {
	return pds.writes().map((w) => `${w.nsid.replace('com.atproto.', '')} ${w.body?.collection}`);
}

/** The row's approval, read straight from D1. */
function approvalNow(): number {
	return (
		harness.raw
			.prepare('SELECT require_approval FROM groups WHERE group_did = ?')
			.get(GROUP_DID) as {
			require_approval: number;
		}
	).require_approval;
}

/** Every column a save can write, and the time of the last write, so "no row
 *  write" can be asserted rather than inferred from one column. */
function rowWhole(): Record<string, unknown> {
	return harness.raw
		.prepare(
			'SELECT name, description, require_approval, updated_at FROM groups WHERE group_did = ?'
		)
		.get(GROUP_DID) as Record<string, unknown>;
}

/** Every call that would set a space's read policy or member list. The host
 *  keeps neither apart from the access records, so a save sends none; the fake
 *  answers none, but logs each before it refuses. */
const policyCalls = (pds: Host) =>
	pds.requests.filter((r) =>
		/^com\.atproto\.simplespace\.(createSpace|updateSpace|putMember|removeMember)$/.test(r.nsid)
	);

/** A write to a space, a space's configuration or the public repo. The fake
 *  host sees every call before it answers, so this is the moment it arrives. */
const isHostWrite = (nsid: string, init?: RequestInit) =>
	init?.method?.toUpperCase() === 'POST' && /^com\.atproto\.(simplespace|space|repo)\./.test(nsid);

describe('a settings flip writes the access record, and no read policy', () => {
	it.each([
		['public', 'private', 'deleteRecord'],
		['private', 'public', 'putRecord']
	] as const)(
		'a group whose access record says %s, saved as %s, sends no read policy or member list',
		async (from, to, declarationWrite) => {
			const pds = host();
			const group = await givenGroup(from, pds);

			const result = await save(group, to, { shownVisibility: from, rules: 'Be kind' });

			expect(result).toEqual({ ok: true });
			expect(policyCalls(pds)).toEqual([]);
			// The host's writes in order. A narrowing withdraws the declaration, then
			// writes the access record; a widening writes the record, then declares.
			// Either way a declared group's record says public. Where the row falls
			// among them, the order cases below pin.
			const access = 'space.putRecord group.opensocial.access';
			const declaration = `repo.${declarationWrite} group.opensocial.declaration`;
			expect(traced(pds)).toEqual([
				...(to === 'public' ? [access, declaration] : [declaration, access]),
				'space.putRecord group.opensocial.profile',
				'space.createRecord group.opensocial.rule'
			]);
			expect(await aboutAccessNow()).toEqual({
				$type: 'group.opensocial.access',
				public: to === 'public',
				grants: ['admin', 'member'].map((role) => ({
					role,
					scopes: ['space:group.opensocial.meta?action=read']
				}))
			});
		}
	);
});

// A person's own writes go on their own group session (TS, 2026-10-15), and a
// save needs no one else's: not even a flip asks for the creator's.
describe('a save goes out on the caller’s own session alone', () => {
	const CREATOR = 'did:plc:creatoraaaaaaaaaaaaaaaaa';

	it('flips a group the caller did not create, with every write on their session', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		env = atGroupHost(linkGroups([GROUP_DID], undefined, [OWNER]));

		const result = await save({ ...group, owner_did: CREATOR }, 'private', {
			shownVisibility: 'public',
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: true });
		expect(policyCalls(pds)).toEqual([]);
		expect(pds.writes().length).toBeGreaterThan(0);
		expect(new Set(pds.writes().map((w) => w.person))).toEqual(new Set([OWNER]));
	});
});

describe('a save keeps what the settings form does not show', () => {
	// The save rewrites the whole profile, and the form has no picture field.
	it('keeps the picture the profile names', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const avatar = {
			$type: 'blob' as const,
			ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
			mimeType: 'image/webp',
			size: 70
		};
		await writeGroupProfile({
			...asGroup(group),
			visibility: 'public',
			profile: { name: 'Kona Trail Runners', avatar }
		});
		pds.clearLog();

		const result = await save(group, 'public', { description: 'Dawn runs' });

		expect(result).toEqual({ ok: true });
		const profile = pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile');
		expect(profile?.record).toMatchObject({ description: 'Dawn runs', avatar });
	});
});

describe('a save that keeps the visibility leaves the access record alone', () => {
	it('a public group saved as public writes no access record and sends no read policy', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);

		const result = await save(group, 'public');

		expect(result).toEqual({ ok: true });
		expect(policyCalls(pds)).toEqual([]);
		expect(traced(pds)).not.toContain('space.putRecord group.opensocial.access');
		expect((await aboutAccessNow())?.public).toBe(true);
	});
});

// A private group is invite-only, so it cannot also be open to join. The pair
// is two fields of this form, and visibility is the about space's access record,
// which no trigger on our tables can see. So the save refuses it in app code,
// before the host, the row or any record is written.
describe('the save reads with the caller’s own access', () => {
	it('an owner whose sign-in reads no spaces is told so, and nothing is read or written', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const before = rowWhole();

		const result = await runUpdateGroup(
			env,
			harness.db,
			group,
			{ did: OWNER, reader: null },
			{
				name: 'Renamed',
				visibility: 'private',
				shownVisibility: 'public',
				requireApproval: true
			}
		);

		expect(result).toEqual({
			ok: false,
			error: expect.stringMatching(/^Nothing was saved: your sign-in does not let this site read/)
		});
		expect(pds.calls).toEqual([]);
		expect(rowWhole()).toEqual(before);
		expect(index.told).toEqual([]);
	});
});

describe('a private group must require approval', () => {
	it('a settings save refuses a private group that is open to join before any write', async () => {
		const pds = host();
		const group = await givenGroup('public', pds, false);
		harness.statements.length = 0;

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			requireApproval: false,
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: false, error: approvalRefusal('private', false) });
		expect(pds.writes()).toEqual([]);
		expect(harness.statements.filter(isRowWrite)).toEqual([]);
		expect((await aboutAccessNow())?.public).toBe(true);
	});
});

// A widening whose first write, the access record, fails must leave the row
// where it was, and it does so by never writing it.
describe('a visibility change whose first write fails leaves the row where it was', () => {
	it('a private group saved as public and open, whose access write answers 500, is still private, writes nothing else, and leaves the whole row as it was', async () => {
		let hostDown = false;
		const pds = host((nsid) =>
			hostDown && nsid === 'com.atproto.space.putRecord' ? pdsDown() : undefined
		);
		const group = await givenGroup('private', pds, true);
		const before = rowWhole();
		hostDown = true;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			requireApproval: false,
			name: 'Kona Night Runners',
			description: 'After dark',
			rules: 'Be kind'
		});

		expect(result.ok).toBe(false);
		expect(traced(pds)).toEqual(['space.putRecord group.opensocial.access']);
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		// The whole row, the approval included: nothing of this save reached it.
		expect(rowWhole()).toEqual(before);
		expect(approvalNow()).toBe(1);
		// What failed is the visibility change itself, and the message says so.
		expect(!result.ok && result.error).toContain('visibility was not changed');
	});
});

// A narrowing withdraws the declaration before the access record says private,
// so a failure between the two leaves the group public and undeclared, never
// declared while private. Nothing after the failed write is written, and
// choosing private again finishes it.
describe('a visibility change that stops before the access record', () => {
	it('a switch to private whose access write fails leaves the declaration withdrawn and the row as it was, says the group is still public, and choosing private again finishes it', async () => {
		let failAccess = false;
		const isAccessWrite = (nsid: string, init?: RequestInit) =>
			nsid === 'com.atproto.space.putRecord' &&
			JSON.parse(String(init?.body)).collection === GROUP_ACCESS_COLLECTION;
		const pds = host((nsid, init) =>
			failAccess && isAccessWrite(nsid, init) ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		expect(await declaredNow()).toBe(true);
		const before = rowWhole();
		pds.clearLog();

		failAccess = true;
		const failed = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Members only'
		});

		expect(failed.ok).toBe(false);
		// The record is the visibility, so the group is still public, and an
		// untouched save would leave it so: the message says to choose private,
		// not merely to save again.
		expect(!failed.ok && failed.error).toContain('access record still says public');
		expect(!failed.ok && failed.error).toContain('so the group is still public');
		expect(!failed.ok && failed.error).toContain('Choose private and save the settings again');
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access'
		]);
		expect((await aboutAccessNow())?.public).toBe(true);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole()).toEqual(before);

		// The page still shows public, which is what the record says, so the owner
		// picks private again.
		failAccess = false;
		pds.clearLog();
		const again = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Members only'
		});

		expect(again).toEqual({ ok: true });
		expect(policyCalls(pds)).toEqual([]);
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Members only');
	});
});

/** Every host write, every read of the about space's configuration, and every
 *  read of its access record, in the order the host sees them, each with the
 *  row's name at that moment. The row write falls where the name changes. */
function rowAtEachCall() {
	const sequence: string[] = [];
	const observe: FakeGroupHostOptions['fail'] = (nsid, init, query) => {
		const accessRead =
			nsid === 'com.atproto.space.getRecord' &&
			query?.get('space') === ABOUT &&
			query?.get('collection') === GROUP_ACCESS_COLLECTION;
		if (isHostWrite(nsid, init) || nsid === 'com.atproto.simplespace.getSpace' || accessRead) {
			const { name } = harness.raw
				.prepare('SELECT name FROM groups WHERE group_did = ?')
				.get(GROUP_DID) as { name: string };
			const what = accessRead ? 'space.getRecord access' : nsid.replace('com.atproto.', '');
			sequence.push(`${what} (row ${name})`);
		}
		return undefined;
	};
	return { sequence, observe };
}

// After the visibility's own writes, the order follows where the group ends up.
// Browse shows a declared group's name and description from the row, so a group
// going private withdraws its declaration before the row takes the new text, and
// a group going public writes the row before it declares. Declaring also needs a
// fresh answer: the access record is read again just before it, and only a
// public answer publishes.
describe('a visibility change reaches the record before the row', () => {
	it('a switch to private withdraws the declaration, writes the record, then the row, the profile and the rules', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = host(observe);
		const group = await givenGroup('public', pds);
		sequence.length = 0;

		const result = await save(group, 'private', {
			shownVisibility: 'public',
			name: 'Kona Night Runners',
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		// The record is read once, before any write, and the space's
		// configuration not at all.
		expect(sequence).toEqual([
			'space.getRecord access (row Kona Trail Runners)',
			'repo.deleteRecord (row Kona Trail Runners)',
			'space.putRecord (row Kona Trail Runners)',
			'space.putRecord (row Kona Night Runners)',
			'space.createRecord (row Kona Night Runners)'
		]);
	});

	it('a switch to public writes the record, writes the row, reads the record again, then declares', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = host(observe);
		const group = await givenGroup('private', pds);
		sequence.length = 0;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			name: 'Kona Night Runners',
			rules: 'Be kind'
		});

		expect(result).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'space.putRecord group.opensocial.access',
			'repo.putRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile',
			'space.createRecord group.opensocial.rule'
		]);
		expect(sequence).toEqual([
			'space.getRecord access (row Kona Trail Runners)',
			'space.putRecord (row Kona Trail Runners)',
			'space.getRecord access (row Kona Night Runners)',
			'repo.putRecord (row Kona Night Runners)',
			'space.putRecord (row Kona Night Runners)',
			'space.createRecord (row Kona Night Runners)'
		]);
		expect(await declaredNow()).toBe(true);
	});

	// Another client narrows the group while this save widens it: it writes its
	// record just after this save's, so this save's own record write is
	// overtaken. The fresh read before the declaration finds that, and this save
	// withdraws the declaration instead of publishing one.
	it('a switch to public during which another client narrows the group withdraws the declaration, and the profile follows the record', async () => {
		let narrowing = true;
		const pds: Host = host();
		const group = await givenGroup('private', pds);
		const stubbed = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const response = await stubbed(input, init);
			if (
				narrowing &&
				String(input).includes('/com.atproto.space.putRecord') &&
				JSON.parse(String(init?.body)).record?.public === true
			) {
				narrowing = false;
				vi.stubGlobal('fetch', stubbed);
				await narrowedElsewhere();
				vi.stubGlobal('fetch', wrapper);
			}
			return response;
		});
		const wrapper = globalThis.fetch;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			description: 'Trail runs at dawn'
		});

		// The owner's own fields were saved, and the visibility is someone else's
		// change, so the save succeeded.
		expect(result).toEqual({ ok: true });
		expect(rowWhole().description).toBe('Trail runs at dawn');
		expect(traced(pds)).toEqual([
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.access',
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile'
		]);
		expect(policyCalls(pds)).toEqual([]);
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		const profile = pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile');
		expect(profile?.record.joinPolicy).toBe('invite');
	});

	it('a switch to public whose record does not answer the second read saves the row, leaves the declaration alone, and says so', async () => {
		let reads = 0;
		const pds = host((nsid, _init, query) =>
			nsid === 'com.atproto.space.getRecord' &&
			query?.get('space') === ABOUT &&
			query?.get('collection') === GROUP_ACCESS_COLLECTION &&
			++reads === 2
				? pdsDown()
				: undefined
		);
		const group = await givenGroup('private', pds);
		reads = 0;

		const result = await save(group, 'public', {
			shownVisibility: 'private',
			description: 'Trail runs at dawn',
			rules: 'Be kind'
		});

		expect(result.ok).toBe(false);
		// True whether or not the group was declared before this save.
		expect(!result.ok && result.error).toContain(
			"neither published nor withdrew the group's declaration"
		);
		expect(rowWhole().description).toBe('Trail runs at dawn');
		// Neither a declaration nor a withdrawal, and nothing after them.
		expect(traced(pds)).toEqual(['space.putRecord group.opensocial.access']);
		expect(await declaredNow()).toBe(false);
	});

	it('a switch to private whose withdrawal fails leaves the record public and the row as it was, says so, and choosing private again finishes it', async () => {
		let failDelete = false;
		const pds = host((nsid) =>
			failDelete && nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined
		);
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		expect(await declaredNow()).toBe(true);
		const before = rowWhole();

		failDelete = true;
		const failed = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Never previously public'
		});

		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.error).toContain('so the group is still public');
		expect(!failed.ok && failed.error).toContain('Choose private and save the settings again');
		// The declaration survived, and so did the record, which a declared
		// group's must: it still says public. The row never took the new text, so
		// browse, which joins the surviving declaration to the row, keeps showing
		// what strangers already saw.
		expect(await declaredNow()).toBe(true);
		expect((await aboutAccessNow())?.public).toBe(true);
		expect(rowWhole()).toEqual(before);
		const { listGroups } = await import('./server/browse');
		const browse = await listGroups(harness.db, {
			declared: [{ did: GROUP_DID, createdAt: null }]
		});
		expect(browse.map((entry) => entry.row?.description)).toEqual(['Trail runs at dawn']);

		// The page still shows public, which is what the record says, so the owner
		// picks private again.
		failDelete = false;
		pds.clearLog();
		const again = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Never previously public'
		});

		expect(again).toEqual({ ok: true });
		expect(policyCalls(pds)).toEqual([]);
		expect(await declaredNow()).toBe(false);
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(rowWhole().description).toBe('Never previously public');
	});

	// The PDS took the withdrawal but our index never heard, so browse still
	// lists the group and joins that entry to the row. The row keeps the text
	// strangers already saw until the index has dropped the entry.
	it('a switch to private whose index cannot be told leaves the row as it was, says the group is still public, and choosing private again finishes it', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		const before = rowWhole();

		index.down = new Error('D1_ERROR: Network connection lost');
		const failed = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Never previously public'
		});

		expect(failed.ok).toBe(false);
		expect(!failed.ok && failed.error).toContain('browse still lists it');
		expect(!failed.ok && failed.error).toContain('Choose private and save the settings again');
		expect(await declaredNow()).toBe(false);
		expect((await aboutAccessNow())?.public).toBe(true);
		expect(rowWhole()).toEqual(before);
		const { listGroups } = await import('./server/browse');
		const browse = await listGroups(harness.db, {
			declared: [{ did: GROUP_DID, createdAt: null }]
		});
		expect(browse.map((entry) => entry.row?.description)).toEqual(['Trail runs at dawn']);

		// The record still says public, so the page does too, and the owner picks
		// private again.
		index.down = null;
		const again = await save(group, 'private', {
			shownVisibility: 'public',
			description: 'Never previously public'
		});

		expect(again).toEqual({ ok: true });
		expect(index.told).toEqual([`at://${GROUP_DID}/group.opensocial.declaration/self`]);
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(rowWhole().description).toBe('Never previously public');
	});
});

// SC-208: a group flipped private to public to private changes only its about
// space's access record, which is what the host lets people in by. A member
// is let into all three spaces throughout, and a stranger into the about space
// only while the record says public.
describe('a group flipped private to public to private changes only its about space’s access', () => {
	it('lets a member into every space throughout, and a stranger into the about space only while public', async () => {
		const pds = host();
		const group = await givenGroup('private', pds);
		await givenMember(group, pds);
		const letIn = (did: string) =>
			[ABOUT, MEMBERS, CALENDAR].map((space) => pds.admits(did, space));
		expect(letIn(MEMBER)).toEqual([true, true, true]);
		expect(letIn(STRANGER)).toEqual([false, false, false]);

		const opened = await save(group, 'public', { shownVisibility: 'private' });

		expect(opened).toEqual({ ok: true });
		expect((await aboutAccessNow())?.public).toBe(true);
		expect(await declaredNow()).toBe(true);
		expect(letIn(MEMBER)).toEqual([true, true, true]);
		expect(letIn(STRANGER)).toEqual([true, false, false]);

		const closed = await save(group, 'private', { shownVisibility: 'public' });

		expect(closed).toEqual({ ok: true });
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		expect(letIn(MEMBER)).toEqual([true, true, true]);
		expect(letIn(STRANGER)).toEqual([false, false, false]);
		// Only the about space's record moved; the other two stay closed.
		expect(
			pds
				.writes()
				.filter((w) => w.body?.collection === GROUP_ACCESS_COLLECTION)
				.map((w) => w.body?.space)
		).toEqual([ABOUT, ABOUT]);
		expect(policyCalls(pds)).toEqual([]);
	});
});

// The form sends the visibility it showed as well as the one chosen, and only
// a difference between the two is a change the owner asked for. Anything else
// takes the access record's value as it stands: a tab opened before someone
// else changed the record still shows the old value, and saving it must not move
// the record back. There is no lock, so the record is also read again just
// before a declaration, and only a public answer publishes one.
describe('a save changes the visibility only when the owner changed it', () => {
	it('a stale form saved with its visibility untouched keeps the visibility the record has since taken', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		// The stale tab opens here, showing public.
		expect(await save(group, 'public')).toEqual({ ok: true });
		// Another tab takes the group private.
		expect(await save(group, 'private', { shownVisibility: 'public' })).toEqual({ ok: true });
		pds.clearLog();

		const result = await save(group, 'public', { description: 'Typo fixed' });

		expect(result).toEqual({ ok: true });
		expect(traced(pds)).not.toContain('space.putRecord group.opensocial.access');
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Typo fixed');
		// The profile follows the record too.
		const profile = pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile');
		expect(profile?.record.joinPolicy).toBe('invite');
	});

	it('a save that read public before a concurrent switch to private does not declare the group', async () => {
		const pds = host();
		const group = await givenGroup('public', pds, false);
		expect(await save(group, 'public', { requireApproval: false })).toEqual({ ok: true });
		expect(await declaredNow()).toBe(true);

		// Hold the first save just after its reads, which answer public.
		const originalFetch = globalThis.fetch;
		let release!: () => void;
		let captured!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const reached = new Promise<void>((r) => (captured = r));
		let intercept = true;
		vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
			const response = await originalFetch(input, init);
			if (intercept && String(input).includes('/com.atproto.space.listRecords?')) {
				intercept = false;
				captured();
				await held;
			}
			return response;
		});
		const older = save(group, 'public', {
			requireApproval: false,
			description: 'Written while going private'
		});
		await reached;

		// A second save takes the group private and completes.
		expect(await save(group, 'private', { shownVisibility: 'public' })).toEqual({ ok: true });
		pds.clearLog();
		release();

		expect(await older).toEqual({ ok: true });
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		const repoWrites = pds.writes().filter((w) => w.nsid.startsWith('com.atproto.repo.'));
		expect(repoWrites.at(-1)?.nsid).not.toBe('com.atproto.repo.putRecord');
		expect(policyCalls(pds)).toEqual([]);
	});

	it('a form that could not show the visibility is refused when its choice differs from the record', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		const before = rowWhole();
		harness.statements.length = 0;

		const result = await save(group, 'private', { ...NOT_SHOWN, description: 'Members only' });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('cannot tell which visibility the page showed');
		expect(pds.writes()).toEqual([]);
		expect(harness.statements.filter(isRowWrite)).toEqual([]);
		expect(rowWhole()).toEqual(before);
		expect((await aboutAccessNow())?.public).toBe(true);
	});
});

// The approval control is drawn for the visibility the form has chosen: a
// private choice fixes it on. A stale form whose save ends up with the other
// visibility therefore sends an approval nobody chose for the group it will
// be, so the row's approval stands, and the profile's join policy follows it.
describe('a stale form and the approval setting', () => {
	/** The settings form resolves the group from the row on every save. */
	const rowGroup = async () => (await getGroupByDid(harness.db, GROUP_DID))!;

	const profileJoinPolicy = (pds: Host) =>
		pds.spaceWrites.find((w) => w.collection === 'group.opensocial.profile')?.record.joinPolicy;

	// One direction, the one that matters: a stale tab that still shows public
	// with approval off must not turn approval off for a group that is now
	// private, the pair every form refuses.
	it('a stale form keeps the saved approval when the visibility it ends up with is not the one it chose', async () => {
		// A public group open to join, whose stale tab shows public with
		// approval off.
		const pds = host();
		await givenGroup('public', pds, false);
		expect(await save(await rowGroup(), 'public', { requireApproval: false })).toEqual({
			ok: true
		});
		// Elsewhere it is made private, which requires approval.
		expect(
			await save(await rowGroup(), 'private', { shownVisibility: 'public', requireApproval: true })
		).toEqual({ ok: true });
		expect(approvalNow()).toBe(1);
		pds.clearLog();

		const closed = await save(await rowGroup(), 'public', {
			requireApproval: false,
			description: 'Typo fixed'
		});

		expect(closed).toEqual({ ok: true });
		expect(approvalNow()).toBe(1);
		expect(profileJoinPolicy(pds)).toBe('invite');
		expect((await aboutAccessNow())?.public).toBe(false);
		expect(await declaredNow()).toBe(false);
		expect(rowWhole().description).toBe('Typo fixed');
	});
});

// The host checks the save's record writes, but this site's copy of the group
// is its own, and the host never sees it. So a member's save, which would
// change that copy before any record, is refused before anything is written.
// (Spec: FR-213.)
describe('this site’s own copy of the group', () => {
	it('a member’s save is refused before the row or any record is written', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);
		await givenMember(group, pds);

		const result = await runUpdateGroup(
			env,
			harness.db,
			group,
			{ did: MEMBER, reader: pdsSpaceReader(CRED, GROUP_DID) },
			{
				name: 'Renamed by a member',
				visibility: 'public',
				shownVisibility: 'public',
				requireApproval: true
			}
		);

		expect(result).toMatchObject({ ok: false });
		expect((await getGroupByDid(harness.db, GROUP_DID))?.name).toBe('Kona Trail Runners');
		expect(traced(pds)).toEqual([]);
	});

	// This site changes a group only through its own group host; an owner's
	// linked session on a group anywhere else saves nothing.
	it('a save for a group not at this site’s group host is refused before the row or any record is written', async () => {
		const pds = host();
		const group = await givenGroup('public', pds);

		const result = await runUpdateGroup(
			linkGroups([GROUP_DID]),
			harness.db,
			group,
			{ did: OWNER, reader: pdsSpaceReader(CRED, GROUP_DID) },
			{
				name: 'Renamed elsewhere',
				visibility: 'private',
				shownVisibility: 'public',
				requireApproval: true
			}
		);

		expect(result).toEqual({
			ok: false,
			error:
				'This group is not at this site’s group host, so this site cannot change it. Nothing was changed.'
		});
		expect((await getGroupByDid(harness.db, GROUP_DID))?.name).toBe('Kona Trail Runners');
		expect(traced(pds)).toEqual([]);
	});
});

// A switch to private writes the declaration's withdrawal first. When that
// fails, nothing has landed.
describe('a switch to private whose withdrawal fails', () => {
	const failingWithdrawal = async (fail: (nsid: string) => Response | undefined) => {
		let failing = false;
		const pds = host((nsid) => (failing ? fail(nsid) : undefined));
		const group = await givenGroup('public', pds);
		expect(await save(group, 'public', { description: 'Trail runs at dawn' })).toEqual({
			ok: true
		});
		failing = true;
		pds.clearLog();
		const result = await save(group, 'private', { shownVisibility: 'public' });
		expect(policyCalls(pds)).toEqual([]);
		expect(await declaredNow()).toBe(true);
		expect((await aboutAccessNow())?.public).toBe(true);
		return result;
	};

	it('says so, and that nothing was saved, when the host refuses it for the caller’s roles', async () => {
		const result = await failingWithdrawal((nsid) =>
			nsid === 'com.atproto.repo.deleteRecord'
				? Response.json({ error: 'ScopeMissingError' }, { status: 403 })
				: undefined
		);

		expect(result).toEqual({
			ok: false,
			error:
				'Not allowed: your roles do not allow com.atproto.repo.deleteRecord. Nothing was saved: the group is still public and still listed in browse.'
		});
	});

	it('otherwise says the group is still public, and choosing private again retries it', async () => {
		const result = await failingWithdrawal((nsid) =>
			nsid === 'com.atproto.repo.deleteRecord' ? pdsDown() : undefined
		);

		expect(result).toMatchObject({ ok: false });
		const error = !result.ok ? result.error : '';
		expect(error).toMatch(/^Its declaration could not be withdrawn: /);
		expect(error).not.toContain('closed it to non-members');
		expect(error).toContain('so the group is still public');
		expect(error).toContain('Choose private and save the settings again');
	});
});

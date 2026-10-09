// The write gate. These cases defend against one mistake: copying
// `repo: locals.did` from $lib/atproto/server/repo.remote.ts into the group
// path. That would look fine, pass every permission check, and silently author
// group events under whichever admin clicked, which is the model this feature
// exists to avoid.
//
// Every case runs the real transports against a fake group host
// (./__fixtures__/stub-pds.ts) and reads what the host was sent and what it
// holds, so a case proves what reached the PDS, not that a seam was called.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

/** What the index was told: every URI handed to `notifyOfUpdate`, in order.
 *  `down` makes the index throw instead. */
const index = vi.hoisted(() => ({ told: [] as string[], down: null as Error | null }));

// The index runs in process over D1, and a real one would need its own
// database and an appview. So its client is replaced, and only that: the
// notifier that calls it is the app's own, failure handling included.
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

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	LINKED_TEST_TOKEN,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import { stubPds, type StubPdsOptions } from './__fixtures__/stub-pds';

import { pdsProvisioner, provisionGroupSpaces } from './spaces';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent,
	type UploadGroupEventImageInput,
	type WriteGroupEventInput
} from './event-writer';
import type { GroupRow } from '../types';

import { GROUP_EVENT_COLLECTION } from '../ids';
import { GroupPermissionError, GroupRecordError } from './group-write';
import { GroupCredentialError } from './session';
import { type EventPlacement } from '../event-placement';
import { createGroup } from './db/groups';
import { addMember } from './db/roster';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
/** The admin in every case below: a non-owner who was promoted, exactly the
 *  actor the co-editing requirement is about. */
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let pds: ReturnType<typeof stubPds>;
let linkedEnv: ReturnType<typeof linkGroups>;

function validRecord(name = 'Kona weekly ride') {
	return {
		name,
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	};
}

/** The group, linked, on a host holding its three spaces as a create leaves
 *  them. The log starts empty. */
async function onHost(options: Partial<StubPdsOptions> = {}) {
	pds = stubPds({ did: GROUP_DID, handle: 'kona.stub.test', ...options });
	linkedEnv = linkGroups([GROUP_DID]);
	await provisionGroupSpaces(pdsProvisioner(linkedCredential(GROUP_DID), GROUP_DID), 'public');
	pds.clearLog();
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');

	index.told = [];
	index.down = null;
	// One line per write as the group (session.ts), which is noise here.
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await onHost();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

/** A write by the admin through the real writer. The gate reads D1 rows (the
 *  row records no members space, and `reader: null`), so every call the host
 *  logs is the write path's own. */
const write = (
	input: Partial<WriteGroupEventInput> & Pick<WriteGroupEventInput, 'intent' | 'placement'>
) =>
	writeGroupEvent({
		db,
		env: linkedEnv,
		group,
		callerDid: ADMIN,
		record: validRecord(),
		reader: null,
		...input
	});

const remove = (
	rkey: string,
	placement: EventPlacement,
	input: Partial<Parameters<typeof deleteGroupEvent>[0]> = {}
) =>
	deleteGroupEvent({
		db,
		env: linkedEnv,
		group,
		callerDid: ADMIN,
		rkey,
		placement,
		reader: null,
		...input
	});

/** The methods the host was asked for, in order. */
const nsids = () => pds.requests.map((r) => r.nsid);
const repoCalls = () => nsids().filter((nsid) => nsid.startsWith('com.atproto.repo.'));

/** The event as the host holds it, or null, asked straight from the stub and
 *  not through the app's reader: in the calendar space, or in the public repo
 *  for null. The log is left as it was. */
async function hostRecord(space: string | null, rkey: string) {
	const [requests, calls] = [pds.requests.length, pds.calls.length];
	const query = new URLSearchParams({
		...(space ? { space } : {}),
		repo: GROUP_DID,
		collection: GROUP_EVENT_COLLECTION,
		rkey
	});
	const method = space ? 'com.atproto.space.getRecord' : 'com.atproto.repo.getRecord';
	const res = await fetch(`https://pds.stub.test/xrpc/${method}?${query}`);
	pds.requests.splice(requests);
	pds.calls.splice(calls);
	return res.ok ? ((await res.json()) as { value: Record<string, unknown> }).value : null;
}

const hostHas = async (space: string | null, rkey: string) =>
	(await hostRecord(space, rkey)) !== null;

describe('authorship', () => {
	// The main requirement: a non-owner admin edits an event they did not
	// create, and the record that lands is the group's.
	it('lets a non-owner admin edit an event the owner created, as the group', async () => {
		const created = await write({ callerDid: OWNER, intent: 'create', placement: 'everyone' });
		expect(created.repo).toBe(GROUP_DID);

		const edited = await write({
			intent: 'update',
			placement: 'everyone',
			rkey: created.rkey,
			record: {
				...validRecord('Weekly ride, new time'),
				startsAt: '2026-09-21T18:00:00.000Z'
			}
		});

		expect(edited.rkey).toBe(created.rkey);
		expect(edited.repo).toBe(GROUP_DID);
		expect(edited.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);

		// Not the admin's repo, not the owner's, not `locals.did`: the group's.
		expect(pds.writes().map((w) => [w.nsid, w.body?.repo])).toEqual([
			['com.atproto.repo.createRecord', GROUP_DID],
			['com.atproto.repo.putRecord', GROUP_DID]
		]);
		expect(await hostRecord(null, created.rkey)).toMatchObject({ name: 'Weekly ride, new time' });
	});

	it('mints a TID for a create, and refuses an update that names no rkey', async () => {
		const created = await write({ intent: 'create', placement: 'everyone' });
		expect(created.rkey).toMatch(/^[a-z2-7]{13}$/);
		expect(pds.writes().map((w) => [w.nsid, w.body?.rkey])).toEqual([
			['com.atproto.repo.createRecord', created.rkey]
		]);

		await expect(write({ intent: 'update', placement: 'everyone' })).rejects.toBeInstanceOf(
			GroupRecordError
		);
		expect(pds.writes()).toHaveLength(1);
	});

	// If the host reports a URI under some other authority, the model has been
	// violated and the caller must not be told the write succeeded. A record
	// that landed under the wrong authority is not this group's, so it must not
	// be pushed into the index either: the refusal has to reach both.
	it('refuses a result whose URI is not in the group repo', async () => {
		await onHost({
			fail: (nsid) =>
				nsid === 'com.atproto.repo.createRecord'
					? Response.json({ uri: `at://${ADMIN}/${GROUP_EVENT_COLLECTION}/abc`, cid: 'x' })
					: undefined
		});

		await expect(write({ intent: 'create', placement: 'everyone' })).rejects.toThrow(
			/is not did:plc:jcwgw6fcnb5vyoid7nz7sl26's repo/
		);
		expect(index.told).toEqual([]);
	});
});

describe('the permission gate', () => {
	it('refuses a plain member: no CREATE_EVENT, no MANAGE_EVENTS', async () => {
		await expect(
			write({ callerDid: MEMBER, intent: 'create', placement: 'everyone' })
		).rejects.toMatchObject({ permission: 'CREATE_EVENT' });
		await expect(
			write({ callerDid: MEMBER, intent: 'update', placement: 'everyone', rkey: '3abc' })
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });
		expect(pds.calls).toEqual([]);
	});

	it('gates deletion on MANAGE_EVENTS and deletes from the group repo', async () => {
		const created = await write({ intent: 'create', placement: 'everyone' });
		pds.clearLog();

		await expect(remove(created.rkey, 'everyone', { callerDid: MEMBER })).rejects.toMatchObject({
			permission: 'MANAGE_EVENTS'
		});
		expect(pds.calls).toEqual([]);

		const deleted = await remove(created.rkey, 'everyone');
		expect(deleted.repo).toBe(GROUP_DID);
		expect(pds.writes()).toEqual([
			{
				nsid: 'com.atproto.repo.deleteRecord',
				body: { repo: GROUP_DID, collection: GROUP_EVENT_COLLECTION, rkey: created.rkey },
				params: {},
				token: LINKED_TEST_TOKEN
			}
		]);
		expect(await hostHas(null, created.rkey)).toBe(false);
	});

	// MEMBER holds neither event permission, STRANGER is off the roster, and
	// null is anonymous. The gate answers from D1 here, so any call the host
	// logs would be a calendar space check, a placement read or a write made
	// before the gate. The admin's edit at the end does reach the host, so the
	// silence is the gate's.
	it('a caller without the permission is refused before any PDS read or write', async () => {
		const refused = [
			() => write({ callerDid: MEMBER, intent: 'create', placement: 'members' }),
			() => write({ callerDid: STRANGER, intent: 'update', placement: 'members', rkey: '3abc' }),
			() => write({ callerDid: null, intent: 'update', placement: 'everyone', rkey: '3abc' }),
			() => remove('3abc', 'members', { callerDid: STRANGER })
		];
		for (const run of refused) await expect(run()).rejects.toBeInstanceOf(GroupPermissionError);
		expect(pds.calls).toEqual([]);
		expect(index.told).toEqual([]);

		await write({ intent: 'update', placement: 'everyone', rkey: '3abc' });
		expect(pds.calls).not.toEqual([]);
	});
});

describe('record validation', () => {
	it('rejects a malformed record before anything reaches the transport', async () => {
		await expect(
			write({
				intent: 'create',
				placement: 'everyone',
				// No `name`, which the lexicon requires.
				record: { createdAt: '2026-09-01T12:00:00.000Z' }
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(pds.calls).toEqual([]);
	});

	it('stamps the collection $type rather than trusting the caller', async () => {
		const created = await write({
			intent: 'create',
			placement: 'everyone',
			record: { ...validRecord(), $type: 'app.bsky.feed.post' }
		});
		expect(pds.writes().map((w) => w.body?.collection)).toEqual([GROUP_EVENT_COLLECTION]);
		expect(await hostRecord(null, created.rkey)).toMatchObject({ $type: GROUP_EVENT_COLLECTION });
	});
});

describe('records from the event editor', () => {
	// The shape atmo's EventEditor hands its adapter (buildEventRecord): fields
	// the group form never sent, a location, and a cover image uploaded as a
	// blob. The writer must pass it through its lexicon check unchanged.
	it('accepts the record the event editor builds, image and theme included', async () => {
		const editorRecord = {
			$type: GROUP_EVENT_COLLECTION,
			createdWith: 'https://atmo.rsvp',
			name: 'Kona weekly ride',
			mode: 'community.lexicon.calendar.event#inperson',
			status: 'community.lexicon.calendar.event#scheduled',
			startsAt: '2026-10-04T17:00:00.000Z',
			endsAt: '2026-10-04T19:00:00.000Z',
			timezone: 'Pacific/Honolulu',
			createdAt: '2026-09-30T12:00:00.000Z',
			theme: { name: 'default', accentColor: 'cyan', baseColor: 'stone' },
			description: 'Meet at the pier.',
			uris: [{ uri: 'https://example.com/route', name: 'Route' }],
			locations: [{ $type: 'community.lexicon.location.address', country: 'US', locality: 'Kona' }],
			media: [
				{
					role: 'thumbnail',
					content: {
						$type: 'blob',
						ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
						mimeType: 'image/webp',
						size: 12345
					},
					aspect_ratio: { width: 1200, height: 630 }
				}
			],
			preferences: { showInDiscovery: true }
		};

		const result = await write({
			intent: 'create',
			placement: 'everyone',
			rkey: '3mwqnkcuf7cnp',
			record: editorRecord
		});

		expect(result.repo).toBe(GROUP_DID);
		expect(await hostRecord(null, '3mwqnkcuf7cnp')).toEqual(editorRecord);
	});
});

describe('credentials', () => {
	it('checks the permission before the credential', async () => {
		// Order matters: a member must be told they lack the permission, not that
		// the group is not linked.
		await expect(
			writeGroupEvent({
				db,
				env: {},
				group,
				callerDid: MEMBER,
				placement: 'everyone',
				intent: 'create',
				record: validRecord()
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
	});

	// A group whose owner has not linked its account cannot publish, and no
	// password stands in for the link. Only the owner can fix that, so it is
	// reported as its own error, before anything leaves for the PDS.
	describe('for a group nobody has linked', () => {
		beforeEach(() => unlinkAllGroups());

		// Another group is linked, so the sessions namespace exists and answers.
		const unlinked = () => linkGroups(['did:plc:anothergroupaaaaaaaaaaaa']);

		it('refuses an admin’s event through the real writer, and sends nothing', async () => {
			await expect(
				write({ env: unlinked(), intent: 'create', placement: 'everyone' })
			).rejects.toBeInstanceOf(GroupCredentialError);
			expect(pds.calls).toEqual([]);
			expect(index.told).toEqual([]);
		});
	});
});

// The events tab is served from the app's index rather than from the group's
// PDS, so a write that does not reach the index is a write nobody can see.
// Discovery is not a substitute: an actor-scoped read backfills a repo once and
// then records that it is done, so everything written after that first read is
// invisible until someone says so.
describe('telling the index', () => {
	// The PDS has already accepted the record by this point. Failing the write
	// would be untrue, and would invite a retry of a write that landed.
	it('reports success when the index is unreachable', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		index.down = new Error('D1_ERROR: Network connection lost');

		const result = await write({ callerDid: OWNER, intent: 'create', placement: 'everyone' });

		expect(result.repo).toBe(GROUP_DID);
		expect(await hostHas(null, result.rkey)).toBe(true);
		expect(logged).toHaveBeenCalledOnce();
	});
});

describe('event images', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

	/** The admin's upload of a PNG for a create, through the real uploader. */
	const upload = (input: Partial<UploadGroupEventImageInput> = {}) =>
		uploadGroupEventImage({
			db,
			env: linkedEnv,
			group,
			callerDid: ADMIN,
			intent: 'create',
			bytes: PNG,
			mimeType: 'image/png',
			...input
		});

	it("uploads an admin's image into the group's repo, as the write it is for", async () => {
		const ref = await upload();

		expect(pds.blobs).toEqual([{ mimeType: 'image/png', bytes: PNG }]);
		// The reference the host answered with, for the event record to cite.
		expect(ref).toEqual({
			$type: 'blob',
			ref: { $link: 'bafkreiupload1' },
			mimeType: 'image/png',
			size: 4
		});
	});

	it('gates the upload on the permission its write needs', async () => {
		for (const [intent, permission] of [
			['create', 'CREATE_EVENT'],
			['update', 'MANAGE_EVENTS']
		] as const) {
			await expect(upload({ callerDid: MEMBER, intent })).rejects.toMatchObject({ permission });
		}
		await expect(upload({ callerDid: null })).rejects.toBeInstanceOf(GroupPermissionError);
		expect(pds.calls).toEqual([]);
	});

	it('refuses a file that is not an image, or is too large, before the transport', async () => {
		await expect(upload({ mimeType: 'text/html' })).rejects.toBeInstanceOf(GroupRecordError);
		await expect(
			upload({ bytes: new Uint8Array(GROUP_EVENT_IMAGE_MAX_BYTES + 1) })
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(pds.calls).toEqual([]);
	});
});

// Where an event is written. A members-only event is the same record as a public
// one, placed in the group's calendar space instead of its public repo, and the
// container is the only thing that keeps it from anonymous readers. So these
// cases read which methods the host was asked for and where it holds the event.
describe('members-only placement', () => {
	/** Written out, not taken from the app, so a wrong type or key in the app's
	 *  constant fails here. */
	const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
	const PUBLIC_POLICY = 'com.atproto.simplespace.defs#publicPolicy';

	it('a members-only create goes to space.createRecord and never to a repo method', async () => {
		const created = await write({ intent: 'create', placement: 'members' });

		// One check that the space is there and member-list, then the write.
		expect(nsids()).toEqual(['com.atproto.simplespace.getSpace', 'com.atproto.space.createRecord']);
		expect(pds.requests[0].params).toEqual({ space: CALENDAR });
		expect(pds.requests[1].body).toMatchObject({
			space: CALENDAR,
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey: created.rkey
		});
		expect(created.uri).toBe(`${CALENDAR}/${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);
		expect(await hostHas(CALENDAR, created.rkey)).toBe(true);
		expect(await hostHas(null, created.rkey)).toBe(false);
	});

	it('a members-only edit goes to space.putRecord in the calendar space', async () => {
		const created = await write({ intent: 'create', placement: 'members' });
		pds.clearLog();

		const edited = await write({
			intent: 'update',
			placement: 'members',
			rkey: created.rkey,
			record: validRecord('Kona weekly ride, new time')
		});

		// The space check, the read that finds the event where the page says, the put.
		expect(nsids()).toEqual([
			'com.atproto.simplespace.getSpace',
			'com.atproto.space.getRecord',
			'com.atproto.space.putRecord'
		]);
		expect(pds.requests[1].params).toMatchObject({ space: CALENDAR, rkey: created.rkey });
		expect(pds.requests[2].body).toMatchObject({
			space: CALENDAR,
			rkey: created.rkey,
			record: { name: 'Kona weekly ride, new time' }
		});
		expect(edited.uri).toBe(created.uri);
		expect(await hostHas(null, created.rkey)).toBe(false);
	});

	it('a members-only delete goes to space.deleteRecord and never to repo.deleteRecord', async () => {
		const created = await write({ intent: 'create', placement: 'members' });
		pds.clearLog();

		await remove(created.rkey, 'members');

		expect(nsids()).toEqual(['com.atproto.space.getRecord', 'com.atproto.space.deleteRecord']);
		expect(pds.requests[1].body).toEqual({
			space: CALENDAR,
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey: created.rkey
		});
		expect(await hostHas(CALENDAR, created.rkey)).toBe(false);
	});

	it('a members-only write and delete never notify the index', async () => {
		const created = await write({ intent: 'create', placement: 'members' });
		await write({ intent: 'update', placement: 'members', rkey: created.rkey });
		const deleted = await remove(created.rkey, 'members');

		// A space delete answers with the plain URI, the same shape as a public
		// one, so the skip cannot be told from the URI.
		expect(deleted.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);
		expect(index.told).toEqual([]);

		// The same three steps in the public repo tell the index once each.
		const shown = await write({ intent: 'create', placement: 'everyone' });
		await write({ intent: 'update', placement: 'everyone', rkey: shown.rkey });
		await remove(shown.rkey, 'everyone');
		const uri = `at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${shown.rkey}`;
		expect(index.told).toEqual([uri, uri, uri]);
	});

	// A put creates the record when none is there, in either container, so an
	// edit sent to the other container would silently copy the event across.
	it('an edit that changes placement is refused with no write', async () => {
		const membersOnly = await write({ intent: 'create', placement: 'members' });
		const shown = await write({ intent: 'create', placement: 'everyone' });
		pds.clearLog();

		await expect(
			write({ intent: 'update', placement: 'everyone', rkey: membersOnly.rkey })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'placement-change'
		});
		await expect(
			write({ intent: 'update', placement: 'members', rkey: shown.rkey })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'placement-change'
		});

		expect(pds.writes()).toEqual([]);
		expect(await hostHas(null, membersOnly.rkey)).toBe(false);
		expect(await hostHas(CALENDAR, membersOnly.rkey)).toBe(true);
		expect(await hostHas(CALENDAR, shown.rkey)).toBe(false);
		expect(await hostHas(null, shown.rkey)).toBe(true);
		expect(index.told).toHaveLength(1);
	});

	// A delete of a missing record succeeds in either container, so a delete sent
	// to the wrong one would report success and leave the event where it is.
	it('a delete at the wrong placement is refused with no write', async () => {
		const membersOnly = await write({ intent: 'create', placement: 'members' });
		const shown = await write({ intent: 'create', placement: 'everyone' });
		pds.clearLog();

		await expect(remove(membersOnly.rkey, 'everyone')).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'wrong-placement-delete'
		});
		await expect(remove(shown.rkey, 'members')).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'wrong-placement-delete'
		});

		expect(pds.writes()).toEqual([]);
		expect(await hostHas(CALENDAR, membersOnly.rkey)).toBe(true);
		expect(await hostHas(null, shown.rkey)).toBe(true);
	});

	it('a members-only write to a group with no calendar space is refused with no write', async () => {
		// A group with no calendar space at its host. The host would take the
		// write anyway and make the space as it went, so the refusal is the app's.
		pds.spaces.delete(CALENDAR);

		await expect(write({ intent: 'create', placement: 'members' })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'no-calendar-space'
		});
		await expect(
			write({ intent: 'update', placement: 'members', rkey: '3abc' })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'no-calendar-space'
		});

		// The space check is the only call each time: nothing written anywhere, and
		// nothing in the public repo instead.
		expect(nsids()).toEqual([
			'com.atproto.simplespace.getSpace',
			'com.atproto.simplespace.getSpace'
		]);
		expect(index.told).toEqual([]);
	});

	it('a members-only write into a calendar space that is not member-list is refused with no write', async () => {
		const config = pds.spaces.get(CALENDAR)!;
		pds.spaces.set(CALENDAR, { ...config, readPolicy: { $type: PUBLIC_POLICY } });

		await expect(write({ intent: 'create', placement: 'members' })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'calendar-space-readable'
		});
		await expect(
			write({ intent: 'update', placement: 'members', rkey: '3abc' })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'calendar-space-readable'
		});

		expect(pds.writes()).toEqual([]);
		expect(repoCalls()).toEqual([]);
	});

	it('a members-only write is refused when the calendar space cannot be checked', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const answers: (() => Response)[] = [
			() => Response.json({ error: 'InternalServerError' }, { status: 500 }),
			// A 200 with no read policy says nothing about who can read the space.
			() => Response.json({ uri: CALENDAR }),
			() => {
				throw new TypeError('fetch failed');
			}
		];
		for (const answer of answers) {
			await onHost({
				fail: (nsid) => (nsid === 'com.atproto.simplespace.getSpace' ? answer() : undefined)
			});
			await expect(write({ intent: 'create', placement: 'members' })).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'calendar-space-unchecked'
			});
			expect(pds.writes()).toEqual([]);
			expect(repoCalls()).toEqual([]);
		}
		expect(logged).toHaveBeenCalledTimes(answers.length);
	});

	// A read that fails says nothing about where the event is, so the write
	// does not guess.
	it('a placement read the host cannot answer refuses the edit and the delete, and writes nothing', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await onHost({
			fail: (nsid) =>
				nsid === 'com.atproto.repo.getRecord' || nsid === 'com.atproto.space.getRecord'
					? Response.json({ error: 'InternalServerError' }, { status: 500 })
					: undefined
		});

		for (const placement of ['everyone', 'members'] as const) {
			await expect(write({ intent: 'update', placement, rkey: '3abc' })).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'placement-unchecked'
			});
			await expect(remove('3abc', placement)).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'placement-unchecked'
			});
		}
		expect(pds.writes()).toEqual([]);
		expect(index.told).toEqual([]);
	});
});

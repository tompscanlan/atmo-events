import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The edit page's loader, for one of the group's events. With no placement in
// its link it reads a public event from the index, as it always has. With
// ?placement=members it reads the event from the group's calendar space, after
// the editor gate, and hands the editor the record whole: the editor saves what
// it loads, so a field the loader left out would be deleted by the next save,
// and a field it added would be written into the event.
//
// The space reader is a fake host that logs every call, so "read nothing" is a
// count, and the index read is stubbed at its module boundary. The editor gate
// is the real one, wrapped so the order of the calls can be read.
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/contrail', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail')>()),
	getEventRecordFromContrail: vi.fn(),
	getServerClient: vi.fn()
}));
vi.mock('$lib/groups/server/editor-page', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/groups/server/editor-page')>();
	return { groupEditorPage: vi.fn(real.groupEditorPage) };
});
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));
// The index module takes one helper from the UI package, whose index also pulls
// in plyr's CSS, which Node's ESM loader rejects.
vi.mock('@atmo-dev/events-ui', async () => ({
	getProfileUrl: (await import('@atmo-dev/events-ui/profile-url')).getProfileUrl
}));

import { isHttpError } from '@sveltejs/kit';
import { buildEventRecord, buildThumbnailMedia } from '@atmo-dev/events-ui/editor/save';
import { defaultTheme } from '@atmo-dev/events-ui/theme';
import { load } from './+page.server';
import { getEventRecordFromContrail, getServerClient, type FlatEventRecord } from '$lib/contrail';
import { type GroupSpaceReader, type GroupSpaceRecord } from '$lib/groups/server/about-read';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { MEMBERS_ONLY_UNLINKED, MEMBERS_ONLY_UNREADABLE } from '$lib/groups/server/calendar-read';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { groupSpaceUris } from '$lib/groups/server/spaces';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
/** A group made before the spaces: no members or calendar space recorded. */
const OLDER_GROUP_DID = 'did:plc:7dbq5kbxtnyzsnjwmufl2hyd';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
// Written out, so a wrong type, key or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const MEETING_URI = `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`;
const MEMBERS_ONLY = '?placement=members';
const NOT_FOUND = { status: 404, body: { message: 'Event not found' } };

const IMAGE = [
	{
		role: 'thumbnail',
		alt: 'The committee',
		content: { $type: 'blob', ref: { $link: 'bafkreithumb' }, mimeType: 'image/webp', size: 41250 },
		aspect_ratio: { width: 800, height: 800 }
	}
];
const MEETING_VALUE = {
	$type: EVENT,
	name: 'Committee call',
	description: 'Agenda in the group chat.',
	startsAt: '2030-11-02T18:00:00.000Z',
	endsAt: '2030-11-02T19:00:00.000Z',
	createdAt: '2026-10-02T09:00:00.000Z',
	additionalData: { agendaUrl: 'https://example.com/agenda' }
};

/** The calendar space's one event, as stored: with its image. */
function storedMeeting(): GroupSpaceRecord {
	return {
		uri: MEETING_URI,
		cid: 'bafymeeting',
		collection: EVENT,
		rkey: '3lmeeting',
		value: { ...MEETING_VALUE, media: structuredClone(IMAGE) }
	};
}

let harness: SqliteD1;

beforeEach(async () => {
	harness = sqliteD1();
	const created = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await recordGroupSpaces(harness.db, created.id, groupSpaceUris(GROUP_DID));
	await addMember(harness.db, created.id, MEMBER, 'member');
	// An index that holds none of the group's events, unless a test says otherwise.
	vi.mocked(getEventRecordFromContrail).mockResolvedValue(null);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	resetReaderHost();
});

type Host = GroupSpaceReader & { calls: string[] };

/** The group's host. Its about space holds the profile and its members space
 *  no records, so a caller's standing comes from the rows. `calendar` is what
 *  the calendar space holds, or the error every read of it fails with. */
function host(calendar: GroupSpaceRecord[] | Error): Host {
	const calls: string[] = [];
	return {
		calls,
		async get(q) {
			calls.push(`get ${q.space} ${q.collection} ${q.rkey}`);
			if (q.space === CALENDAR) {
				if (calendar instanceof Error) throw calendar;
				return calendar.find((r) => r.collection === q.collection && r.rkey === q.rkey) ?? null;
			}
			if (q.space === ABOUT && q.collection === 'group.opensocial.profile') {
				return {
					uri: `${ABOUT}/${GROUP_DID}/group.opensocial.profile/self`,
					cid: 'bafyprofile',
					collection: 'group.opensocial.profile',
					rkey: 'self',
					value: { displayName: 'Kona Paddlers' }
				};
			}
			return null;
		},
		async list(q) {
			calls.push(`list ${q.space} ${q.collection ?? '(no collection)'}`);
			if (q.space === CALENDAR) throw new Error('the edit page reads one event by its key');
			return [];
		},
		async getSpace(space) {
			calls.push(`getSpace ${space}`);
			if (space === CALENDAR) throw new Error('the calendar space is never asked its policy');
			return { readPolicy: 'com.atproto.simplespace.defs#publicPolicy' };
		}
	};
}

function event(did: string | null, rkey: string, query: string, actor = GROUP_DID) {
	return {
		params: { actor, rkey },
		locals: { did },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${actor}/events/${rkey}/edit${query}`)
	} as unknown as Parameters<typeof load>[0];
}

type PageData = Record<string, unknown> & { eventData: FlatEventRecord; space: string | null };

async function openAs(did: string | null, rkey: string, query = ''): Promise<PageData> {
	return (await load(event(did, rkey, query))) as PageData;
}

/** What the load threw, which must be one of SvelteKit's HTTP errors. */
async function refusalFor(did: string | null, rkey: string, query = '', actor = GROUP_DID) {
	try {
		await load(event(did, rkey, query, actor));
	} catch (e) {
		if (!isHttpError(e)) throw e;
		return { status: e.status, body: e.body };
	}
	throw new Error(`the edit page loaded for ${did} at ${rkey}${query}`);
}

function calendarCalls(h: Host): string[] {
	return h.calls.filter((call) => call.includes(CALENDAR));
}

/** The record EventEditor saves from what the page loaded, the image left as it
 *  was: the editor's own two builders, called with the arguments its save
 *  passes them for an edit. */
async function asTheEditorSaves(eventData: FlatEventRecord) {
	const media = await buildThumbnailMedia({
		isNew: false,
		thumbnailChanged: false,
		thumbnailFile: null,
		existingMedia: (eventData.media ?? []) as Array<Record<string, unknown>>,
		uploadBlob: async () => {
			throw new Error('an unchanged image is not uploaded again');
		}
	});
	return buildEventRecord({
		eventData,
		isNew: false,
		name: eventData.name,
		description: eventData.description ?? '',
		startsAt: '2030-11-02T18:00',
		endsAt: '2030-11-02T19:00',
		timezone: 'UTC',
		mode: 'inperson',
		visibility: 'public',
		theme: defaultTheme,
		links: [],
		location: null,
		locationChanged: false,
		media,
		resolveHandle: async (handle) => {
			throw new Error(`no mention to resolve, got ${handle}`);
		}
	});
}

describe('/groups/[actor]/events/[rkey]/edit load: a members-only event', () => {
	it('the edit read of a members-only event keeps its image and puts no space on the record', async () => {
		const stored = storedMeeting();
		const h = host([stored]);
		serveReader(GROUP_DID, h);
		// A shared cache holding a copy, which the edit page must never touch.
		const cache = { match: vi.fn(), put: vi.fn() };
		vi.stubGlobal('caches', { default: cache });

		const data = await openAs(OWNER, '3lmeeting', MEMBERS_ONLY);

		expect(data).toStrictEqual({
			groupDid: GROUP_DID,
			groupName: 'Kona Paddlers',
			handle: null,
			canDelete: true,
			rkey: '3lmeeting',
			eventData: {
				...MEETING_VALUE,
				media: IMAGE,
				cid: 'bafymeeting',
				did: GROUP_DID,
				rkey: '3lmeeting',
				uri: MEETING_URI
			},
			space: CALENDAR
		});
		// The image is the stored one, whole, so the editor writes it back as it is.
		expect(data.eventData.media).toStrictEqual(stored.value.media);
		// The placement is the page's own field. On the record the editor saves, a
		// key naming the container would be written into the event.
		expect('space' in data.eventData).toBe(false);
		// Behind the editor gate, one getRecord in the calendar space, and nothing
		// from the index or a cache.
		expect(vi.mocked(groupEditorPage).mock.calls).toEqual([
			[{ DB: harness.db, OAUTH_SESSIONS: fixtureSessions }, GROUP_DID, OWNER, 'MANAGE_EVENTS']
		]);
		expect(calendarCalls(h)).toEqual([`get ${CALENDAR} ${EVENT} 3lmeeting`]);
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();
		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
		// What the host holds is untouched.
		expect(stored.value.media).toStrictEqual(IMAGE);
	});

	it('a members-only edit, saved as the editor builds it, keeps the image and adds no field', async () => {
		const stored = storedMeeting();
		serveReader(GROUP_DID, host([stored]));
		const { eventData } = await openAs(OWNER, '3lmeeting', MEMBERS_ONLY);

		const saved = await asTheEditorSaves(eventData);

		expect(saved.media).toStrictEqual(stored.value.media);
		for (const key of ['space', 'uri', 'cid', 'did', 'rkey']) expect(saved).not.toHaveProperty(key);
		// The fields the editor does not edit come through as stored.
		expect(saved.additionalData).toStrictEqual(MEETING_VALUE.additionalData);
		expect(saved.createdAt).toBe(MEETING_VALUE.createdAt);

		// The same stored event opened as a public one, from the index, saves to the
		// very same record: the members-only read adds nothing and drops nothing.
		serveReader(GROUP_DID, host([]));
		vi.mocked(getEventRecordFromContrail).mockResolvedValue({
			uri: `at://${GROUP_DID}/${EVENT}/3lmeeting`,
			cid: 'bafymeeting',
			did: GROUP_DID,
			rkey: '3lmeeting',
			value: storedMeeting().value
		} as never);
		const asPublic = await asTheEditorSaves((await openAs(OWNER, '3lmeeting')).eventData);
		expect(saved).toStrictEqual(asPublic);
	});

	it('a members-only edit of a key the space does not hold is a 404, and a failed read is a 503', async () => {
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		// A key the space does not hold, and one no record can have.
		for (const rkey of ['3lmadeup', 'not a key']) {
			serveReader(GROUP_DID, host([storedMeeting()]));
			expect(await refusalFor(OWNER, rkey, MEMBERS_ONLY)).toStrictEqual(NOT_FOUND);
		}
		// A stored record with no start is not an event the editor can open.
		const undated = storedMeeting();
		delete undated.value.startsAt;
		serveReader(GROUP_DID, host([undated]));
		expect(await refusalFor(OWNER, '3lmeeting', MEMBERS_ONLY)).toStrictEqual(NOT_FOUND);
		// A group whose host never made the calendar space holds no such event.
		serveReader(GROUP_DID, host(new Error('com.atproto.space.getRecord failed: SpaceNotFound')));
		expect(await refusalFor(OWNER, '3lmeeting', MEMBERS_ONLY)).toStrictEqual(NOT_FOUND);

		// A placement the page does not know is the same 404, with no event read:
		// a mangled link never falls through to the public read.
		for (const query of ['?placement=everyone', '?placement=', '?placement=Members']) {
			const h = host([storedMeeting()]);
			serveReader(GROUP_DID, h);
			expect(await refusalFor(OWNER, '3lmeeting', query)).toStrictEqual(NOT_FOUND);
			expect(calendarCalls(h)).toEqual([]);
		}

		// A read that fails is a 503 that says why, after one attempt.
		const down = host(new Error('com.atproto.space.getRecord failed: 502'));
		serveReader(GROUP_DID, down);
		expect(await refusalFor(OWNER, '3lmeeting', MEMBERS_ONLY)).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNREADABLE }
		});
		expect(calendarCalls(down)).toEqual([`get ${CALENDAR} ${EVENT} 3lmeeting`]);
		expect(logged).toHaveBeenCalled();
		// A group whose session is gone. When its roster is in the members space,
		// the editor gate cannot read the caller's grants and refuses first, as it
		// does for every edit of such a group. A group from before the spaces, whose
		// grants are its rows, gets the read's own notice that an organizer has to
		// link it again. Neither is read.
		serveReader(GROUP_DID, null);
		expect(await refusalFor(OWNER, '3lmeeting', MEMBERS_ONLY)).toStrictEqual({
			status: 403,
			body: { message: 'Not allowed: MANAGE_EVENTS required' }
		});
		await createGroup(harness.db, { groupDid: OLDER_GROUP_DID, ownerDid: OWNER, name: 'Hilo' });
		expect(await refusalFor(OWNER, '3lmeeting', MEMBERS_ONLY, OLDER_GROUP_DID)).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNLINKED }
		});

		// Nothing in place of the space: the index is never asked.
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();
		warned.mockRestore();
		logged.mockRestore();
	});
});

describe('/groups/[actor]/events/[rkey]/edit load: who may edit', () => {
	// The editor gate answers before any event read, with the same 403 for every
	// key and every placement, so its answer says nothing about whether an event
	// exists. (Spec: FR-117.)
	it('the edit page: a caller who may not edit gets the same answer for any key, with nothing read past standing', async () => {
		const signedInRefusal = {
			status: 403,
			body: { message: 'Not allowed: MANAGE_EVENTS required' }
		};
		const anonymousRefusal = { status: 403, body: { message: 'Sign in to publish as a group' } };
		const urls = [
			['3lmeeting', MEMBERS_ONLY],
			['3lmeeting', ''],
			['3lmadeup', MEMBERS_ONLY],
			['3lmadeup', ''],
			['3lmeeting', '?placement=everyone']
		] as const;
		for (const [who, did, expected] of [
			['a roster member without MANAGE_EVENTS', MEMBER, signedInRefusal],
			['a signed-in caller off the roster', STRANGER, signedInRefusal],
			['an anonymous caller', null, anonymousRefusal]
		] as const) {
			// What the group's route context sends on its own, for this caller.
			const alone = host([storedMeeting()]);
			serveReader(GROUP_DID, alone);
			await groupRouteContext(
				{ OAUTH_SESSIONS: fixtureSessions } as never,
				harness.db,
				GROUP_DID,
				did
			);

			for (const [rkey, query] of urls) {
				fixtureSessions.reads = 0;
				const h = host([storedMeeting()]);
				serveReader(GROUP_DID, h);

				expect(await refusalFor(did, rkey, query), `${who} at ${rkey}${query}`).toStrictEqual(
					expected
				);
				// The standing read, the visibility check for a caller off the roster,
				// and not one request more: no event read, no profile read.
				expect(h.calls, `${who} at ${rkey}${query}`).toEqual(alone.calls);
				expect(calendarCalls(h)).toEqual([]);
				expect(fixtureSessions.reads).toBe(1);
			}
		}
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();

		// The answer is the caller's, not the URL's: at the same URL, a caller who
		// may manage events gets the event.
		serveReader(GROUP_DID, host([storedMeeting()]));
		const data = await openAs(OWNER, '3lmeeting', MEMBERS_ONLY);
		expect(data.eventData.name).toBe('Committee call');
		expect(data.space).toBe(CALENDAR);
	});
});

describe('/groups/[actor]/events/[rkey]/edit load: a public event', () => {
	it('a public edit reads the index as before and names no space', async () => {
		const h = host([storedMeeting()]);
		serveReader(GROUP_DID, h);
		const client = { index: 'the app index' };
		vi.mocked(getServerClient).mockReturnValue(client as never);
		const paddleValue = {
			$type: EVENT,
			name: 'Sunrise paddle',
			startsAt: '2030-11-01T06:00:00.000Z',
			createdAt: '2026-10-01T09:00:00.000Z'
		};
		vi.mocked(getEventRecordFromContrail).mockResolvedValue({
			uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`,
			cid: 'bafypaddle',
			did: GROUP_DID,
			rkey: '3lpaddle',
			value: paddleValue
		} as never);

		const data = await openAs(OWNER, '3lpaddle');

		expect(data).toStrictEqual({
			groupDid: GROUP_DID,
			groupName: 'Kona Paddlers',
			handle: null,
			canDelete: true,
			rkey: '3lpaddle',
			eventData: {
				...paddleValue,
				cid: 'bafypaddle',
				did: GROUP_DID,
				rkey: '3lpaddle',
				uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`
			},
			space: null
		});
		// The gate, then one index read by the group's DID and the key, and no
		// read of the calendar space.
		expect(vi.mocked(groupEditorPage).mock.calls).toEqual([
			[{ DB: harness.db, OAUTH_SESSIONS: fixtureSessions }, GROUP_DID, OWNER, 'MANAGE_EVENTS']
		]);
		expect(vi.mocked(getEventRecordFromContrail).mock.calls).toEqual([
			[client, { did: GROUP_DID, rkey: '3lpaddle' }]
		]);
		expect(vi.mocked(groupEditorPage).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(getEventRecordFromContrail).mock.invocationCallOrder[0]
		);
		expect(calendarCalls(h)).toEqual([]);

		// What the index does not hold, or cannot read, is the same 404 as before,
		// a members-only event's key included: without its placement, the edit
		// page never looks in the space.
		vi.mocked(getEventRecordFromContrail).mockResolvedValue(null);
		expect(await refusalFor(OWNER, '3lmeeting')).toStrictEqual(NOT_FOUND);
		vi.mocked(getEventRecordFromContrail).mockRejectedValue(new Error('D1 is down'));
		expect(await refusalFor(OWNER, '3lpaddle')).toStrictEqual(NOT_FOUND);
		expect(calendarCalls(h)).toEqual([]);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

// The page of one members-only event, at /groups/<actor>/events/<rkey>. Only a
// roster member may cause its read, and everyone else, like a key the calendar
// space does not hold, gets the same 404. The space reader is a fake host that
// logs every call, so "sent nothing" is a count, not a reading of the page.
//
// The page is rendered on the server with the shared EventView as it ships.
// Only EventRsvp is stubbed, to record what EventView hands it (the event's
// URI, the space and the adapter), along with the two media players, which
// import a stylesheet the test runner cannot load.
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));
const signedIn = vi.hoisted(() => ({
	user: {
		isLoggedIn: true,
		did: 'did:plc:member',
		profile: { handle: 'member.test', displayName: 'A member', avatar: undefined }
	}
}));
vi.mock('$lib/atproto/auth.svelte', () => signedIn);
const login = vi.hoisted(() => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('$lib/components/LoginModal.svelte', () => login);
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://atmo.test/groups/did:plc:jcwgw6fcnb5vyoid7nz7sl26/events/3lmeeting')
	}
}));
const rsvp = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
vi.mock('@atmo-dev/events-ui/EventRsvp.svelte', () => ({
	default: (_renderer: unknown, props: Record<string, unknown>) => {
		rsvp.renders.push(props);
	}
}));
vi.mock('@atmo-dev/events-ui/VodPlayer.svelte', () => ({ default: () => {} }));
vi.mock('@atmo-dev/events-ui/event-view/StreamPlacePlayer.svelte', () => ({ default: () => {} }));

import { isHttpError } from '@sveltejs/kit';
import { load } from './+page.server';
import Page from './+page.svelte';
import type { EditorAdapter, EditorViewer } from '$lib/components/editor/adapter';
import { createMembersOnlyEventAdapter } from '$lib/groups/event-page-adapter';
import {
	groupSpaceReader,
	type GroupSpaceReader,
	type GroupSpaceRecord
} from '$lib/groups/server/about-read';
import { MEMBERS_ONLY_UNLINKED, MEMBERS_ONLY_UNREADABLE } from '$lib/groups/server/calendar-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, getGroupByDid, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { groupSpaceUris } from '$lib/groups/server/spaces';

const OWNER = 'did:plc:owner';
const MEMBER = signedIn.user.did;
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
// Written out, so a wrong type, key or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const MEETING_URI = `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`;
const POLICY = {
	public: 'com.atproto.simplespace.defs#publicPolicy',
	memberList: 'com.atproto.simplespace.defs#memberListPolicy'
};

const IMAGE = [
	{
		role: 'thumbnail',
		alt: 'The committee',
		content: { $type: 'blob', ref: { $link: 'bafkreithumb' }, mimeType: 'image/webp', size: 41250 }
	}
];
const MEETING_VALUE = {
	$type: EVENT,
	name: 'Committee call',
	description: 'Agenda in the group chat.',
	startsAt: '2030-11-02T18:00:00.000Z',
	createdAt: '2026-10-02T09:00:00.000Z'
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
	rsvp.renders.length = 0;
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

type Host = GroupSpaceReader & { calls: string[] };

/** The group's host. Its about space holds the profile and its members space
 *  no records, so a caller's standing comes from the rows. `calendar` is what
 *  the calendar space holds, or the error every read of it fails with. */
function host(
	calendar: GroupSpaceRecord[] | Error,
	{ policy = POLICY.public }: { policy?: string } = {}
): Host {
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
			if (q.space === CALENDAR)
				throw new Error('the page reads one event by its key, never a listing');
			return [];
		},
		async getSpace(space) {
			calls.push(`getSpace ${space}`);
			if (space === CALENDAR) throw new Error('the calendar space is never asked its policy');
			return { readPolicy: policy };
		}
	};
}

function event(did: string | null, rkey: string) {
	return {
		params: { actor: GROUP_DID, rkey },
		locals: { did },
		platform: { env: { DB: harness.db } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}`)
	} as unknown as Parameters<typeof load>[0];
}

type PageData = Record<string, unknown> & {
	eventData: Record<string, unknown>;
	eventUri: string;
	spaceUri: string;
};

async function openAs(did: string | null, rkey = '3lmeeting'): Promise<PageData> {
	return (await load(event(did, rkey))) as PageData;
}

/** What the load threw, which must be one of SvelteKit's HTTP errors. */
async function refusalFor(did: string | null, rkey: string) {
	try {
		await load(event(did, rkey));
	} catch (e) {
		if (!isHttpError(e)) throw e;
		return { status: e.status, body: e.body };
	}
	throw new Error(`the page loaded for ${did} at ${rkey}`);
}

function calendarCalls(h: Host): string[] {
	return h.calls.filter((call) => call.includes(CALENDAR));
}

/** The page rendered as the server renders it, with what EventView handed EventRsvp. */
function renderPage(data: PageData) {
	const { body } = render(Page, { props: { data } as never });
	expect(rsvp.renders).toHaveLength(1);
	return {
		body,
		rsvp: rsvp.renders[0] as {
			eventUri: string;
			eventCid: string | null;
			initialRsvpStatus: unknown;
			initialRsvpRkey: unknown;
			spaceUri: string | null;
			adapter: EditorAdapter;
			viewer: EditorViewer;
		}
	};
}

describe('/groups/[actor]/events/[rkey] load: who gets a 404', () => {
	it('the event page: an absent rkey and a caller off the roster get the same 404', async () => {
		const refusals: Record<string, unknown> = {};
		for (const [who, did, rkey] of [
			['a member, at a key the space does not hold', MEMBER, '3lmadeup'],
			['a member, at a key no record can have', MEMBER, 'not a key'],
			['a signed-in non-member, at the real key', STRANGER, '3lmeeting'],
			['a signed-in non-member, at a made-up key', STRANGER, '3lmadeup'],
			['an anonymous visitor, at the real key', null, '3lmeeting'],
			['an anonymous visitor, at a made-up key', null, '3lmadeup']
		] as const) {
			vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
			refusals[who] = await refusalFor(did, rkey);
		}

		const expected = { status: 404, body: { message: 'Event not found' } };
		for (const refusal of Object.values(refusals)) expect(refusal).toStrictEqual(expected);
		expect(new Set(Object.values(refusals).map((r) => JSON.stringify(r))).size).toBe(1);
	});

	// A group the host reads as member-list only is hidden from anyone off its
	// roster before the event is reached, so the key changes nothing there either.
	it('in a group hidden from callers off its roster, the real key and a made-up one get the same 404', async () => {
		for (const did of [STRANGER, null]) {
			const answers = [];
			for (const rkey of ['3lmeeting', '3lmadeup']) {
				const h = host([storedMeeting()], { policy: POLICY.memberList });
				vi.mocked(groupSpaceReader).mockResolvedValue(h);
				answers.push(await refusalFor(did, rkey));
				expect(calendarCalls(h)).toEqual([]);
			}
			expect(answers[0]).toStrictEqual({ status: 404, body: { message: 'Group not found' } });
			expect(answers[1]).toStrictEqual(answers[0]);
		}
	});

	it("the event page: a caller off the roster sends nothing through the group's session after standing", async () => {
		for (const did of [STRANGER, null]) {
			// What the group's route context sends on its own, for this caller.
			const alone = host([storedMeeting()]);
			vi.mocked(groupSpaceReader).mockResolvedValue(alone);
			await groupRouteContext({} as never, harness.db, GROUP_DID, did);
			vi.mocked(groupSpaceReader).mockClear();

			const h = host([storedMeeting()]);
			vi.mocked(groupSpaceReader).mockResolvedValue(h);
			const refusal = await refusalFor(did, '3lmeeting');

			expect(refusal.status).toBe(404);
			// The standing read and the visibility check, and not one request more:
			// no event read, no profile read.
			expect(h.calls).toEqual(alone.calls);
			expect(h.calls).toContain(`getSpace ${ABOUT}`);
			expect(calendarCalls(h)).toEqual([]);
			expect(h.calls.filter((c) => c.includes('group.opensocial.profile'))).toEqual([]);
			// The route context's reader is the only one made.
			expect(groupSpaceReader).toHaveBeenCalledTimes(1);
		}
	});
});

describe('/groups/[actor]/events/[rkey] load: when the event cannot be read', () => {
	let logged: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => logged.mockRestore());

	it('the event page: a failed read is a 503 and never a cached copy', async () => {
		// A shared cache that holds a copy of the event, as the public event page
		// would have stored it. The members-only page must never touch it.
		const cache = {
			match: vi.fn(async () => Response.json({ uri: MEETING_URI, value: MEETING_VALUE })),
			put: vi.fn(async () => {})
		};
		vi.stubGlobal('caches', { default: cache });

		// A read that works first, so a copy could have been kept.
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		expect((await openAs(MEMBER)).eventData.name).toBe('Committee call');

		const down = host(new Error('com.atproto.space.getRecord failed: 502'));
		vi.mocked(groupSpaceReader).mockResolvedValue(down);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNREADABLE }
		});
		expect(logged).toHaveBeenCalled();
		// One attempt at the space and nothing read in its place.
		expect(calendarCalls(down)).toEqual([`get ${CALENDAR} ${EVENT} 3lmeeting`]);

		// A group whose session is gone tells a member why, and reads nothing.
		vi.mocked(groupSpaceReader).mockResolvedValue(null);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNLINKED }
		});

		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('a profile that cannot be read leaves the host unnamed, and the event still shows', async () => {
		const h = host([storedMeeting()]);
		vi.mocked(groupSpaceReader).mockResolvedValue({
			...h,
			async get(q) {
				if (q.space === ABOUT) throw new Error('com.atproto.space.getRecord failed: 502');
				return h.get(q);
			}
		});

		const data = await openAs(MEMBER);

		expect(data.eventData.name).toBe('Committee call');
		expect(data.hostProfile).toBeNull();
	});
});

describe('/groups/[actor]/events/[rkey]: what a member gets', () => {
	it('the event page hands EventView the space-form URI and the calendar space, without the image', async () => {
		const stored = storedMeeting();
		const h = host([stored]);
		vi.mocked(groupSpaceReader).mockResolvedValue(h);

		const data = await openAs(MEMBER);

		expect(data).toStrictEqual({
			eventData: {
				...MEETING_VALUE,
				cid: 'bafymeeting',
				did: GROUP_DID,
				rkey: '3lmeeting',
				uri: MEETING_URI,
				space: CALENDAR
			},
			actorDid: GROUP_DID,
			rkey: '3lmeeting',
			eventUri: MEETING_URI,
			spaceUri: CALENDAR,
			attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
			viewerRsvpStatus: null,
			viewerRsvpRkey: null,
			hostProfile: { did: GROUP_DID, displayName: 'Kona Paddlers' },
			canManageEvents: false
		});
		expect('media' in data.eventData).toBe(false);
		expect('spaceKey' in data).toBe(false);
		// The event read is one getRecord, and the profile is read after it.
		expect(calendarCalls(h)).toEqual([`get ${CALENDAR} ${EVENT} 3lmeeting`]);
		const eventRead = h.calls.indexOf(`get ${CALENDAR} ${EVENT} 3lmeeting`);
		const profileRead = h.calls.indexOf(`get ${ABOUT} group.opensocial.profile self`);
		expect(profileRead).toBeGreaterThan(eventRead);
		// What the host holds keeps its image.
		expect(stored.value.media).toStrictEqual(IMAGE);

		// EventView hands RSVP the space-form URI, not the plain one it builds for
		// a public event, and the calendar space as the place to write it.
		const page = renderPage(data);
		expect(page.rsvp.eventUri).toBe(MEETING_URI);
		expect(page.rsvp.eventUri).not.toBe(`at://${GROUP_DID}/${EVENT}/3lmeeting`);
		expect(page.rsvp.spaceUri).toBe(CALENDAR);
		expect(page.rsvp.eventCid).toBe('bafymeeting');
		expect(page.rsvp.initialRsvpStatus).toBeNull();
		expect(page.rsvp.initialRsvpRkey).toBeNull();
		// The event shows, and nothing on the page cites its image.
		expect(page.body).toContain('Committee call');
		expect(page.body).not.toContain('bafkreithumb');
		expect(page.body).not.toContain('cdn.bsky.app');
	});

	it('an organizer who may manage events is told so; a member is not', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		expect((await openAs(OWNER)).canManageEvents).toBe(true);
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		expect((await openAs(MEMBER)).canManageEvents).toBe(false);
	});

	it("the members-only event page's adapter has no space write", async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		const { rsvp: handed } = renderPage(await openAs(MEMBER));
		const { adapter, viewer } = handed;

		// EventRsvp writes into the space it is given only through these, and with
		// a space and neither of them it writes nothing and falls back to nothing.
		expect(handed.spaceUri).toBe(CALENDAR);
		expect('putSpaceRecord' in adapter).toBe(false);
		expect('deleteSpaceRecord' in adapter).toBe(false);
		// Nor any other way to reach a space, or to tell the index about a record.
		expect('createSpaceInvite' in adapter).toBe(false);
		expect('createPrivateEvent' in adapter).toBe(false);
		expect('notifyUpdate' in adapter).toBe(false);
		// A public write would cite the event outside its space, so each refuses.
		const record = { $type: 'community.lexicon.calendar.rsvp' };
		await expect(
			adapter.putRecord({ collection: 'community.lexicon.calendar.rsvp', rkey: '3lrsvp', record })
		).rejects.toThrow();
		await expect(
			adapter.createRecord({ collection: 'app.bsky.feed.post', record })
		).rejects.toThrow();
		await expect(
			adapter.deleteRecord({ collection: 'community.lexicon.calendar.rsvp', rkey: '3lrsvp' })
		).rejects.toThrow();
		await expect(adapter.uploadBlob(new Blob(['x']))).rejects.toThrow();
		expect(adapter.features).toStrictEqual({ delete: false, recurring: false, privateMode: false });
		// Signing in still works.
		adapter.requestLogin();
		expect(login.atProtoLoginModalState.show).toHaveBeenCalledTimes(1);

		// The viewer is the signed-in person, not the group.
		expect(viewer.did).toBe(MEMBER);
		expect(viewer.isLoggedIn).toBe(true);

		// The page's adapter is the module's own, as built for any caller.
		const built = createMembersOnlyEventAdapter();
		expect(Object.keys(built).sort()).toEqual(Object.keys(adapter).sort());
	});
});

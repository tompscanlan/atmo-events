import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

// The page of one members-only event, rendered on the server from what its
// loader returns (./page.server.test.ts tests the loader on its own). The page
// is the shared EventView as it ships. Only EventRsvp is stubbed, to record
// what EventView hands it (the event's URI, the space and the adapter), along
// with the two media players, which import a stylesheet the test runner cannot
// load. The space reader is a fake host, as in the loader's tests.
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

import { load } from './+page.server';
import Page from './+page.svelte';
import type { EditorAdapter, EditorViewer } from '$lib/components/editor/adapter';
import { createMembersOnlyEventAdapter } from '$lib/groups/event-page-adapter';
import {
	groupSpaceReader,
	type GroupSpaceReader,
	type GroupSpaceRecord
} from '$lib/groups/server/about-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupSpaceUris } from '$lib/groups/server/spaces';

const OWNER = 'did:plc:owner';
const MEMBER = signedIn.user.did;
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
// Written out, so a wrong type, key or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const MEETING_URI = `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`;

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
	signedIn.user.did = MEMBER;
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
});

type Host = GroupSpaceReader & { calls: string[] };

/** The group's host. Its about space holds the profile and its members space
 *  no records, so a caller's standing comes from the rows. */
function host(calendar: GroupSpaceRecord[]): Host {
	const calls: string[] = [];
	return {
		calls,
		async get(q) {
			calls.push(`get ${q.space} ${q.collection} ${q.rkey}`);
			if (q.space === CALENDAR) {
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
			return { readPolicy: 'com.atproto.simplespace.defs#publicPolicy' };
		}
	};
}

type PageData = Record<string, unknown> & {
	eventData: Record<string, unknown>;
	eventUri: string;
	spaceUri: string;
};

async function openAs(did: string | null, rkey = '3lmeeting'): Promise<PageData> {
	return (await load({
		params: { actor: GROUP_DID, rkey },
		locals: { did },
		platform: { env: { DB: harness.db } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}`)
	} as unknown as Parameters<typeof load>[0])) as PageData;
}

function calendarCalls(h: Host): string[] {
	return h.calls.filter((call) => call.includes(CALENDAR));
}

/** The page rendered as the server renders it, with what EventView handed EventRsvp. */
function renderPage(data: PageData) {
	const { head, body } = render(Page, { props: { data } as never });
	expect(rsvp.renders).toHaveLength(1);
	return {
		head,
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

/** The href of every link to an edit page, in page order. */
function editLinksIn(body: string): string[] {
	return [...body.matchAll(/href="([^"]*\/edit\b[^"]*)"/g)].map((m) => m[1]);
}

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
		// The event shows, and nothing on the page cites its image: not the body,
		// and not the head, where the page's og and twitter image tags go.
		expect(page.body).toContain('Committee call');
		expect(page.body).not.toContain('bafkreithumb');
		expect(page.body).not.toContain('cdn.bsky.app');
		expect(page.head).toContain('Committee call');
		expect(page.head).not.toContain('bafkreithumb');
		expect(page.head).not.toContain('cdn.bsky.app');
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

	// The edit page reads a members-only event only when its link says so, since
	// a public event can share the key, so the page's own Edit link carries the
	// placement. Only someone who may manage the group's events is offered it.
	it('the members-only event page offers its Edit link to a manager only, with the placement', async () => {
		const editHref = `/groups/${GROUP_DID}/events/3lmeeting/edit?placement=members`;

		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		const managed = await openAs(OWNER);
		expect(managed.canManageEvents).toBe(true);
		expect(managed.editHref).toBe(editHref);
		signedIn.user.did = OWNER;
		const asManager = renderPage(managed);
		expect(editLinksIn(asManager.body)).toEqual([editHref]);
		expect(asManager.body.match(/Edit Event/g)).toHaveLength(1);
		// Talks and the invite flow stay the group account's own.
		expect(asManager.body).not.toContain('Manage talks');
		expect(asManager.body).not.toContain('/talks');

		rsvp.renders.length = 0;
		signedIn.user.did = MEMBER;
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		const plain = await openAs(MEMBER);
		expect(plain.canManageEvents).toBe(false);
		expect('editHref' in plain).toBe(false);
		const asMember = renderPage(plain);
		expect(editLinksIn(asMember.body)).toEqual([]);
		expect(asMember.body).not.toContain('Edit Event');
	});
});

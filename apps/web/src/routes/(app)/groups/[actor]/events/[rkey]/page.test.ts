import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

// The page of one members-only event, rendered on the server from what its
// loader returns (./page.server.test.ts tests the loader on its own). The page
// is the shared EventView as it ships. Only EventRsvp is stubbed, to record
// what EventView hands it (the event's URI, the space and the adapter) and, when
// a test asks, to press RSVP as it renders; ShareModal is wrapped to record
// whether it was opened; and the two media players are stubbed, since they
// import a stylesheet the test runner cannot load. The space reader is a fake
// host, as in the loader's tests, and the two RSVP commands are stand-ins that
// record what the adapter sent them.
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));
const signedIn = vi.hoisted(() => ({
	user: {
		isLoggedIn: true,
		did: 'did:plc:member',
		profile: { handle: 'member.test', displayName: 'A member', avatar: undefined }
	},
	reauthorize: vi.fn()
}));
vi.mock('$lib/atproto/auth.svelte', () => signedIn);
const login = vi.hoisted(() => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('$lib/components/LoginModal.svelte', () => login);
const PAGE_URL = 'https://atmo.test/groups/did:plc:jcwgw6fcnb5vyoid7nz7sl26/events/3lmeeting';
const appState = vi.hoisted(() => ({
	page: {
		url: new URL('https://atmo.test/'),
		params: {} as Record<string, string>,
		state: {} as Record<string, unknown>
	}
}));
vi.mock('$app/state', () => appState);
const navigation = vi.hoisted(() => ({ replaceState: vi.fn() }));
vi.mock('$app/navigation', () => navigation);
const commands = vi.hoisted(() => ({
	rsvpToMembersOnlyEvent: vi.fn(),
	cancelMembersOnlyRsvp: vi.fn()
}));
vi.mock('$lib/groups/member-rsvp.remote', () => commands);
const rsvp = vi.hoisted(() => ({
	renders: [] as Array<Record<string, unknown>>,
	/** Set to press RSVP with this status as EventRsvp renders. */
	press: null as null | 'going' | 'interested'
}));
vi.mock('@atmo-dev/events-ui/EventRsvp.svelte', () => ({
	default: (_renderer: unknown, props: Record<string, unknown>) => {
		rsvp.renders.push(props);
		if (rsvp.press) (props.onrsvp as (status: string, rkey: string) => void)(rsvp.press, '3lrsvp');
	}
}));
const share = vi.hoisted(() => ({ opened: [] as unknown[] }));
vi.mock('@atmo-dev/events-ui/ShareModal.svelte', async (importOriginal) => {
	const actual = await importOriginal<{
		default: (renderer: unknown, props: Record<string, unknown>) => unknown;
	}>();
	return {
		default: (renderer: unknown, props: Record<string, unknown>) => {
			share.opened.push(props.open);
			return actual.default(renderer, props);
		}
	};
});
vi.mock('@atmo-dev/events-ui/VodPlayer.svelte', () => ({ default: () => {} }));
vi.mock('@atmo-dev/events-ui/event-view/StreamPlacePlayer.svelte', () => ({ default: () => {} }));

import { load } from './+page.server';
import Page from './+page.svelte';
import { EventView } from '@atmo-dev/events-ui';
import type { EditorAdapter, EditorViewer } from '$lib/components/editor/adapter';
import { createMembersOnlyEventAdapter } from '$lib/groups/event-page-adapter';
import {
	EVENT_COLLECTION as EVENT,
	MEETING_IMAGE as IMAGE,
	MEETING_VALUE,
	PROFILE_NAME,
	calendarSpaceOf,
	eventHost,
	meetingUri,
	storedMeeting
} from '$lib/groups/server/__fixtures__/members-only-event';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import { groupSpaceUris } from '$lib/groups/ids';
const OWNER = 'did:plc:owner';
const MEMBER = signedIn.user.did;
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
const CALENDAR = calendarSpaceOf(GROUP_DID);
const RSVP = 'community.lexicon.calendar.rsvp';
const MEETING_URI = meetingUri(GROUP_DID);
/** The meeting's cid as the group's host holds it. */
const MEETING_CID = 'bafymeeting';

/** An RSVP record as EventRsvp builds it, naming `subject` (by default the
 *  meeting's space-form URI). */
function rsvpRecord(status: 'going' | 'interested', subject = MEETING_URI) {
	return {
		$type: RSVP,
		createdWith: 'https://atmo.rsvp',
		status: `${RSVP}#${status}`,
		subject: { uri: subject, cid: MEETING_CID },
		createdAt: '2026-10-08T12:00:00.000Z'
	};
}

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	rsvp.renders.length = 0;
	rsvp.press = null;
	share.opened.length = 0;
	appState.page.url = new URL(PAGE_URL);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	resetReaderHost();
});

type PageData = Record<string, unknown> & {
	eventData: Record<string, unknown>;
	eventUri: string;
	spaceUri: string;
};

async function openAs(did: string | null, rkey = '3lmeeting'): Promise<PageData> {
	return (await load({
		params: { actor: GROUP_DID, rkey },
		locals: { did },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}`)
	} as unknown as Parameters<typeof load>[0])) as PageData;
}

/** The page rendered as the server renders it, with what EventView handed
 *  EventRsvp. `before` is how many renders the test made already. */
function renderPage(data: PageData, before = 0) {
	const { head, body } = render(Page, { props: { data } as never });
	expect(rsvp.renders).toHaveLength(before + 1);
	return {
		head,
		body,
		rsvp: rsvp.renders[before] as {
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

describe('/groups/[actor]/events/[rkey]: what a member gets', () => {
	it('the event page hands EventView the space-form URI and the calendar space, without the image', async () => {
		const stored = storedMeeting(GROUP_DID);
		const h = eventHost(GROUP_DID, { calendar: [stored] });
		serveReader(GROUP_DID, h);

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
			hostProfile: { did: GROUP_DID, displayName: PROFILE_NAME },
			membersOnly: true
		});
		expect('media' in data.eventData).toBe(false);
		expect('spaceKey' in data).toBe(false);
		// The event read is one getRecord, and the profile is read after it.
		expect(h.callsIn(CALENDAR)).toEqual([`get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`]);
		const eventRead = h.calls.indexOf(`get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`);
		const profileRead = h.calls.indexOf(`get ${ABOUT} ${GROUP_DID} group.opensocial.profile self`);
		expect(profileRead).toBeGreaterThan(eventRead);
		// What the host holds keeps its image.
		expect(stored.value.media).toStrictEqual(IMAGE);

		// EventView hands RSVP the space-form URI, not the plain one it builds for
		// a public event, and the calendar space as the place to write it.
		const page = renderPage(data);
		expect(page.rsvp.eventUri).toBe(MEETING_URI);
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

	it("the members-only event page's adapter writes an RSVP only through the members-only RSVP command", async () => {
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		const { adapter } = renderPage(await openAs(MEMBER)).rsvp;

		// What EventRsvp sends for a first RSVP: a fresh key of its own, and the
		// event's space-form URI as the subject.
		commands.rsvpToMembersOnlyEvent.mockResolvedValue({
			ok: true,
			uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`
		});
		expect(
			await adapter.putSpaceRecord!({
				spaceUri: CALENDAR,
				collection: RSVP,
				rkey: '3lfreshtid',
				record: rsvpRecord('going')
			})
		).toEqual({ ok: true });
		// The command names the event, the status and the version of the event
		// the page showed, and nothing else: the server picks the space, the
		// collection, the key and the subject.
		expect(commands.rsvpToMembersOnlyEvent.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lmeeting', status: 'going', cid: MEETING_CID, asked: null }]
		]);

		commands.cancelMembersOnlyRsvp.mockResolvedValue({ ok: true });
		await expect(
			adapter.deleteSpaceRecord!({ spaceUri: CALENDAR, collection: RSVP, rkey: '3lfreshtid' })
		).resolves.toBeUndefined();
		expect(commands.cancelMembersOnlyRsvp.mock.calls).toEqual([
			[{ groupDid: GROUP_DID, rkey: '3lmeeting', asked: null }]
		]);

		// No other way to reach a space, or to tell the index about a record.
		expect('createSpaceInvite' in adapter).toBe(false);
		expect('createPrivateEvent' in adapter).toBe(false);
		expect('notifyUpdate' in adapter).toBe(false);
		// A public write would cite the event outside its space, so each refuses.
		const record = { $type: RSVP };
		await expect(adapter.putRecord({ collection: RSVP, rkey: '3lrsvp', record })).rejects.toThrow();
		await expect(
			adapter.createRecord({ collection: 'app.bsky.feed.post', record })
		).rejects.toThrow();
		await expect(adapter.deleteRecord({ collection: RSVP, rkey: '3lrsvp' })).rejects.toThrow();
		await expect(adapter.uploadBlob(new Blob(['x']))).rejects.toThrow();
	});

	it("the members-only event page's adapter refuses a space write that is not an RSVP to its event", async () => {
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		const { adapter } = renderPage(await openAs(MEMBER)).rsvp;
		const { membersSpaceUri } = groupSpaceUris(GROUP_DID);

		const puts: [string, Parameters<NonNullable<EditorAdapter['putSpaceRecord']>>[0]][] = [
			[
				'another space of the group',
				{
					spaceUri: membersSpaceUri,
					collection: RSVP,
					rkey: '3lmeeting',
					record: rsvpRecord('going')
				}
			],
			[
				'another collection',
				{
					spaceUri: CALENDAR,
					collection: EVENT,
					rkey: '3lmeeting',
					record: { ...rsvpRecord('going'), $type: EVENT }
				}
			],
			[
				'the plain repo URI',
				{
					spaceUri: CALENDAR,
					collection: RSVP,
					rkey: '3lmeeting',
					record: rsvpRecord('going', `at://${GROUP_DID}/${EVENT}/3lmeeting`)
				}
			]
		];
		for (const [, call] of puts) {
			expect(await adapter.putSpaceRecord!(call)).toEqual({ ok: false });
		}
		for (const call of [
			{ spaceUri: membersSpaceUri, collection: RSVP, rkey: '3lmeeting' },
			{ spaceUri: CALENDAR, collection: EVENT, rkey: '3lmeeting' }
		]) {
			await expect(adapter.deleteSpaceRecord!(call)).rejects.toThrow();
		}
		expect(commands.rsvpToMembersOnlyEvent).not.toHaveBeenCalled();
		expect(commands.cancelMembersOnlyRsvp).not.toHaveBeenCalled();
	});

	// A members-only event offers no share prompt after an RSVP of going, since
	// the post would cite the event outside its space. The shared EventView opens
	// the prompt for every other event. (Spec: FR-118.)
	it("a members-only RSVP opens no share prompt, and a public event's RSVP still does", async () => {
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		const data = await openAs(MEMBER);
		rsvp.press = 'going';

		// The server renders on the first read of the output.
		expect(render(Page, { props: { data } as never }).body).toContain('Committee call');
		expect(rsvp.renders).toHaveLength(1);
		// The prompt rendered, once, and stayed shut.
		expect(share.opened).toHaveLength(1);
		expect(share.opened).not.toContain(true);

		// The same view for a public event, as the person-style page hands it: an
		// RSVP of going opens the prompt.
		rsvp.renders.length = 0;
		share.opened.length = 0;
		const publicData = {
			eventData: { ...MEETING_VALUE, did: GROUP_DID, rkey: '3lpublic' },
			actorDid: GROUP_DID,
			rkey: '3lpublic',
			attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
			viewerRsvpStatus: null,
			viewerRsvpRkey: null,
			hostProfile: null
		};
		const viewer = { isLoggedIn: true, did: MEMBER, handle: 'member.test' };
		const shown = render(EventView, {
			props: {
				data: publicData,
				adapter: createMembersOnlyEventAdapter({
					groupDid: GROUP_DID,
					rkey: '3lpublic',
					calendarSpaceUri: CALENDAR,
					asked: null,
					onNotice: () => {}
				}),
				viewer,
				pageUrl: new URL(PAGE_URL)
			}
		});
		expect(shown.body).toContain('Committee call');
		expect(rsvp.renders.length).toBeGreaterThan(0);
		expect(share.opened).toContain(true);
	});
});

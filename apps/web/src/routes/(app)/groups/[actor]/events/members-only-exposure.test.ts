// A members-only event never reaches the public index, so every public address answers for it as
// for an event that was never made: its page, its JSON, its picture card and the group's calendar
// feed. The index here holds only what the group's writes put in its public repo and tell it of,
// as the real one does. The calendar space beside it holds the members-only event, and lets the
// group's link and a member read it, so each public address is checked against a store a loader
// could find it in: one that read the space, as the group or as the member asking, would show it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
	calendarAt,
	fakeCalendar,
	GROUP,
	READY_POLICY,
	event
} from '#lib/groups/server/__fixtures__/group-calendar.js';
import { memoryKV } from '#lib/groups/server/__fixtures__/kv.js';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';

const EVENT = 'community.lexicon.calendar.event';
const mocks = vi.hoisted(() => ({
	index: new Map<string, Record<string, unknown>>(),
	notified: [] as string[],
	requireGroupWriter: vi.fn(),
	groupView: vi.fn(),
	callerSession: vi.fn()
}));
let calendar: ReturnType<typeof fakeCalendar>;

vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: () => ({ locals: { did: 'did:plc:alice' } })
}));
vi.mock('#lib/groups/server/context.js', () => ({
	requireGroupWriter: mocks.requireGroupWriter,
	requireStoredLink: vi.fn(),
	groupView: mocks.groupView
}));
vi.mock('#lib/groups/server/sign-in.js', () => ({ unlinkGroup: vi.fn() }));
// Reads of the calendar space go to the group's host as the fake keeps it.
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => calendar.fetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('#lib/spaces/server/space-credential.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/spaces/server/space-credential.js')>()),
	didSpaceHosts: (await import('#lib/groups/server/__fixtures__/group-calendar.js')).calendarHosts
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
// The index fetches what it is told of from the group's public repo, and keeps it if it is there.
vi.mock('#lib/groups/server/group.js', () => ({
	notifyIndex: async (uri: string) => {
		mocks.notified.push(uri);
		const rkey = uri.split('/').pop()!;
		const value = calendar.state.publicRepo.get(rkey);
		if (uri.startsWith(`at://${GROUP}/${EVENT}/`) && value) {
			mocks.index.set(uri, { ...value, uri, did: GROUP, rkey, cid: 'c' });
		}
	},
	resolveGroup: vi.fn()
}));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/actor.js', () => ({ getActor: async (actor: string) => actor }));
vi.mock('#lib/contrail.js', () => {
	const found = ({ did, rkey }: { did: string; rkey: string }) =>
		mocks.index.get(`at://${did}/community.lexicon.calendar.event/${rkey}`) ?? null;
	return {
		getEventRecordFromContrail: async (_client: unknown, q: { did: string; rkey: string }) =>
			found(q),
		listEventRecordsFromContrail: async () => ({
			records: [...mocks.index.values()],
			profiles: []
		}),
		flattenEventRecord: (record: unknown) => record,
		flattenEventRecords: (records: unknown[]) => records,
		withD1Retry: (read: () => Promise<unknown>) => read(),
		RSVP_HYDRATE_LIMIT: 50,
		getHostProfile: () => null,
		buildEventAttendees: () => ({ going: [], interested: [] }),
		getProfileBlobUrl: vi.fn(),
		getProfileFromContrail: vi.fn(),
		getRsvpStatus: vi.fn(),
		getViewerRsvpFromContrail: vi.fn(),
		listConferenceTalksFromContrail: vi.fn(),
		eventAttendeesFromRecord: () => ({ going: [], interested: [] })
	};
});

const { putGroupEvent } = await import('#lib/groups/group.remote.js');
const { load: eventPage } = await import('../../../p/[actor]/e/[rkey]/+page.server');
const { GET: eventJson } = await import('../../../p/[actor]/e/[rkey]/data.json/+server');
const { GET: eventCard } = await import('../../../p/[actor]/e/[rkey]/og.png/+server');
const { GET: calendarFeed } = await import('../../../p/[actor]/e/calendar/+server');
const { load: membersOnlyPage } = await import('./[rkey]/+page.server');

const MEMBER = 'did:plc:member';
const SECRET = '3lsecret';
const MADE_UP = '3lmadeup';
const OPEN = '3lopen';

const answer = async (run: () => unknown) =>
	Promise.resolve()
		.then(run)
		.then(
			async (value) => (value instanceof Response ? [value.status, await value.text()] : value),
			(e: unknown) => e
		);

beforeEach(async () => {
	mocks.index.clear();
	mocks.notified.length = 0;
	Object.assign(env, { OAUTH_SESSIONS: memoryKV(), GROUP_HOST_URL: 'https://host.example' });
	calendar = fakeCalendar();
	calendar.state.policy = READY_POLICY;
	calendar.state.readers.add('group');
	calendar.state.readers.add(MEMBER);
	mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: calendar.groupHandle });
	mocks.callerSession.mockResolvedValue({
		did: MEMBER,
		scope: 'atproto',
		handle: calendar.personHandle(MEMBER)
	});
	await putGroupEvent({
		groupDid: GROUP,
		rkey: SECRET,
		record: event('Members supper'),
		placement: 'members'
	});
	await putGroupEvent({ groupDid: GROUP, rkey: OPEN, record: event('Open day') });
});

describe('a members-only event and the public index', () => {
	it('is written to the calendar space alone, and the index is told nothing of it', () => {
		expect(calendar.state.events.has(SECRET)).toBe(true);
		expect(calendar.state.publicRepo.has(SECRET)).toBe(false);
		expect(mocks.notified).toEqual([`at://${GROUP}/${EVENT}/${OPEN}`]);
		expect([...mocks.index.keys()]).toEqual([`at://${GROUP}/${EVENT}/${OPEN}`]);
		const repoWrites = calendar.state.sent.filter(([, nsid]) =>
			nsid.startsWith('com.atproto.repo.put')
		);
		expect(repoWrites.map(([, , body]) => body.rkey)).toEqual([OPEN]);
	});

	it('is not made public under its key', async () => {
		const copy = putGroupEvent({ groupDid: GROUP, rkey: SECRET, record: event('Members supper') });
		await expect(copy).rejects.toMatchObject({ status: 409 });
		expect(calendar.state.publicRepo.has(SECRET)).toBe(false);
		expect(mocks.notified).toEqual([`at://${GROUP}/${EVENT}/${OPEN}`]);
	});

	it.each([
		[
			'its public page, signed out',
			(rkey: string) =>
				eventPage({
					params: { actor: GROUP, rkey },
					locals: { did: null, session: null },
					url: new URL(`https://atmo.example/p/${GROUP}/e/${rkey}`)
				} as never)
		],
		[
			'its public page, signed in as a member',
			(rkey: string) =>
				eventPage({
					params: { actor: GROUP, rkey },
					locals: { did: MEMBER, session: {} },
					url: new URL(`https://atmo.example/p/${GROUP}/e/${rkey}`)
				} as never)
		],
		['its JSON', (rkey: string) => eventJson({ params: { actor: GROUP, rkey } } as never)],
		[
			'its picture card',
			(rkey: string) =>
				eventCard({
					params: { actor: GROUP, rkey },
					request: new Request(`https://atmo.example/p/${GROUP}/e/${rkey}/og.png`),
					fetch
				} as never)
		]
	])('answers at %s as for a key never used', async (_, read) => {
		const made = await answer(() => read(MADE_UP));
		expect(made).toMatchObject({ status: 404 });
		expect(await answer(() => read(SECRET))).toEqual(made);
		// The public event next to it is there, so the address is the right one.
		expect(await answer(() => read(OPEN))).not.toEqual(made);
		// And the members-only one is in the space, for any loader that read it.
		expect(calendar.state.events.get(SECRET)).toMatchObject({ name: 'Members supper' });
	});

	it("leaves it out of the group's calendar feed", async () => {
		const res = await calendarFeed({ params: { actor: GROUP } } as never);
		const feed = await res.text();
		expect(feed).toContain('Open day');
		expect(feed).not.toContain('Members supper');
		expect(feed).not.toContain(SECRET);
	});
});

// The group uses a calendar a wiki made it first, where the wiki also writes records of its own,
// and events of its own that are not valid ones.
describe('a calendar another app made, which the group uses', () => {
	const WIKI = calendarAt('3lwikicalendar');
	const WIKI_EVENT = '3lwikisupper';
	const BROKEN = '3lbroken';
	const PAGE = '3lwikipage';

	beforeEach(async () => {
		const wiki = calendar.anotherAppsCalendar('3lwikicalendar', READY_POLICY);
		await env.OAUTH_SESSIONS.put(`group:calendar:${GROUP}`, WIKI);
		wiki.events.set(WIKI_EVENT, event('Wiki supper'));
		wiki.events.set(BROKEN, { $type: EVENT, name: 'No start' });
		wiki.others.set(PAGE, {
			collection: 'com.example.wiki.page',
			value: { $type: 'com.example.wiki.page', name: 'Minutes', startsAt: '2099-01-01T00:00:00Z' }
		});
	});

	const asPerson = (did: string | null, member: boolean | null) => (rkey: string) => {
		mocks.callerSession.mockResolvedValue(
			did && { did, scope: `atproto ${GUEST_SCOPE}`, handle: calendar.personHandle(did) }
		);
		mocks.groupView.mockResolvedValue({
			did: GROUP,
			handle: 'knit.example',
			name: 'Knitters',
			member,
			linked: null,
			askAccess: false
		});
		return membersOnlyPage({
			params: { actor: GROUP, rkey },
			locals: { did, session: did ? {} : null },
			url: new URL(`https://atmo.example/groups/${GROUP}/events/${rkey}`),
			setHeaders: () => {}
		} as never);
	};

	it("shows a member the group's valid events there, and the rest as a key never used", async () => {
		const member = asPerson(MEMBER, true);
		expect(await answer(() => member(WIKI_EVENT))).toMatchObject({
			view: 'event',
			eventData: {
				name: 'Wiki supper',
				uri: `${WIKI}/${GROUP}/${EVENT}/${WIKI_EVENT}`
			}
		});
		const made = await answer(() => member(MADE_UP));
		expect(made).toMatchObject({ status: 404 });
		// The members-only event written to `self` before is not in the calendar the group uses.
		for (const rkey of [BROKEN, PAGE, SECRET])
			expect(await answer(() => member(rkey))).toEqual(made);
	});
});

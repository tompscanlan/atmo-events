import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The loader of one members-only event's page, at /groups/<actor>/events/<rkey>.
// Only a roster member may cause its read, and everyone else, like a key the
// calendar space does not hold, gets the same 404. The space reader is a fake
// host that logs every call, so "sent nothing" is a count, not a reading of the
// page. The page itself, rendered with the shared EventView, is tested in
// ./page.test.ts.
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { isHttpError } from '@sveltejs/kit';
import { load } from './+page.server';
import {
	EVENT_COLLECTION as EVENT,
	MEETING_VALUE,
	calendarSpaceOf,
	eventHost,
	meetingUri
} from '$lib/groups/server/__fixtures__/members-only-event';
import type { FakeSpaceReader } from '$lib/groups/server/__fixtures__/space-reader';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { MEMBERS_ONLY_UNLINKED, MEMBERS_ONLY_UNREADABLE } from '$lib/groups/server/calendar-read';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import { groupRouteContext } from '$lib/groups/server/route-context';

import { memberGrant } from '$lib/groups/server/member-grants';

import { groupSpaceUris } from '$lib/groups/ids';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
const CALENDAR = calendarSpaceOf(GROUP_DID);
const MEETING_URI = meetingUri(GROUP_DID);
const MEMBER_LIST_POLICY = 'com.atproto.simplespace.defs#memberListPolicy';

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	resetReaderHost();
});

function event(did: string | null, rkey: string, session?: unknown) {
	return {
		params: { actor: GROUP_DID, rkey },
		locals: session === undefined ? { did } : { did, session },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}`)
	} as unknown as Parameters<typeof load>[0];
}

type PageData = Record<string, unknown> & {
	eventData: Record<string, unknown>;
	eventUri: string;
	spaceUri: string;
};

async function openAs(
	did: string | null,
	rkey = '3lmeeting',
	session?: unknown
): Promise<PageData> {
	return (await load(event(did, rkey, session))) as PageData;
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
			serveReader(GROUP_DID, eventHost(GROUP_DID));
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
				const h = eventHost(GROUP_DID, { policy: MEMBER_LIST_POLICY });
				serveReader(GROUP_DID, h);
				answers.push(await refusalFor(did, rkey));
				expect(h.callsIn(CALENDAR)).toEqual([]);
			}
			expect(answers[0]).toStrictEqual({ status: 404, body: { message: 'Group not found' } });
			expect(answers[1]).toStrictEqual(answers[0]);
		}
	});

	it("the event page: a caller off the roster sends nothing through the group's session after standing", async () => {
		for (const did of [STRANGER, null]) {
			// What the group's route context sends on its own, for this caller.
			const alone = eventHost(GROUP_DID);
			serveReader(GROUP_DID, alone);
			await groupRouteContext(
				{ OAUTH_SESSIONS: fixtureSessions } as never,
				harness.db,
				GROUP_DID,
				did
			);
			fixtureSessions.reads = 0;

			const h = eventHost(GROUP_DID);
			serveReader(GROUP_DID, h);
			const refusal = await refusalFor(did, '3lmeeting');

			expect(refusal.status).toBe(404);
			// The standing read and the visibility check, and not one request more:
			// no event read, no profile read.
			expect(h.calls).toEqual(alone.calls);
			expect(h.calls).toContain(`getSpace ${ABOUT}`);
			expect(h.callsIn(CALENDAR)).toEqual([]);
			expect(h.calls.filter((c) => c.includes('group.opensocial.profile'))).toEqual([]);
			// The route context's reader is the only one made: one session lookup.
			expect(fixtureSessions.reads).toBe(1);
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
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		expect((await openAs(MEMBER)).eventData.name).toBe('Committee call');

		const down = eventHost(GROUP_DID, {
			calendar: new Error('com.atproto.space.getRecord failed: 502')
		});
		serveReader(GROUP_DID, down);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNREADABLE }
		});
		expect(logged).toHaveBeenCalled();
		// One attempt at the space and nothing read in its place.
		expect(down.callsIn(CALENDAR)).toEqual([`get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`]);

		// A group whose session is gone tells a member why, and reads nothing.
		serveReader(GROUP_DID, null);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNLINKED }
		});

		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
	});
});

describe('/groups/[actor]/events/[rkey]: what a member gets', () => {
	it('an organizer who may manage events gets the Edit link; a member does not', async () => {
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		expect((await openAs(OWNER)).editHref).toBe(
			`/groups/${GROUP_DID}/events/3lmeeting/edit?placement=members`
		);
		serveReader(GROUP_DID, eventHost(GROUP_DID));
		expect('editHref' in (await openAs(MEMBER))).toBe(false);
	});
});

// The viewer's own RSVP, read back through their own session from their repo in
// the calendar space, at the event's key. Only after the event read, so a page
// that 404s sends nothing on the member's behalf either. (Spec: FR-113, FR-117.)
describe("/groups/[actor]/events/[rkey] load: the viewer's own RSVP", () => {
	const RSVP = 'community.lexicon.calendar.rsvp';

	/** The member's signed-in session. Its requests go into `log`, beside the
	 *  group host's, so the order of the two is a fact of the test. */
	function memberSession(scope: string, log: string[]) {
		return {
			did: MEMBER,
			getTokenInfo: async () => ({ scope }),
			handle: async (pathname: string, init?: RequestInit) => {
				log.push(`member ${init?.method ?? 'GET'} ${pathname}`);
				return Response.json({
					uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`,
					cid: 'bafyrsvp',
					value: {
						$type: RSVP,
						status: `${RSVP}#going`,
						subject: { uri: MEETING_URI },
						createdAt: '2026-10-08T12:00:00.000Z'
					}
				});
			}
		};
	}

	/** The group's host, logging into the same list. */
	function sharedHost(log: string[]): FakeSpaceReader {
		return eventHost(GROUP_DID, { onCall: (line) => log.push(`group ${line}`) });
	}

	const ownRead = `member GET /xrpc/com.atproto.space.getRecord?${new URLSearchParams({
		space: CALENDAR,
		repo: MEMBER,
		collection: RSVP,
		rkey: '3lmeeting'
	})}`;

	it("the event page reads the viewer's own RSVP through their session, after the event read", async () => {
		const log: string[] = [];
		serveReader(GROUP_DID, sharedHost(log));

		const data = await openAs(
			MEMBER,
			'3lmeeting',
			memberSession(`atproto ${memberGrant(GROUP_DID)}`, log)
		);

		expect(data.viewerRsvpStatus).toBe('going');
		expect(data.viewerRsvpRkey).toBe('3lmeeting');
		expect(data.membersOnly).toBe(true);
		// One read through the member's session, at the event's key, and only once
		// the event itself was read.
		expect(log.filter((line) => line.startsWith('member '))).toEqual([ownRead]);
		const eventRead = log.indexOf(`group get ${CALENDAR} ${GROUP_DID} ${EVENT} 3lmeeting`);
		expect(eventRead).toBeGreaterThan(-1);
		expect(log.indexOf(ownRead)).toBeGreaterThan(eventRead);

		// A page that 404s reads nothing through the session.
		const absent: string[] = [];
		serveReader(GROUP_DID, sharedHost(absent));
		await expect(
			openAs(MEMBER, '3lmadeup', memberSession(`atproto ${memberGrant(GROUP_DID)}`, absent))
		).rejects.toMatchObject({ status: 404 });
		expect(absent.filter((line) => line.startsWith('member '))).toEqual([]);
	});
});

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
import type { GroupSpaceReader, GroupSpaceRecord } from '$lib/groups/server/about-read';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { MEMBERS_ONLY_UNLINKED, MEMBERS_ONLY_UNREADABLE } from '$lib/groups/server/calendar-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { groupSpaceUris } from '$lib/groups/server/spaces';
import { acceptanceGrant } from '$lib/groups/server/member-grants';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
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

function calendarCalls(h: Host): string[] {
	return h.calls.filter((call) => call.includes(CALENDAR));
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
			serveReader(GROUP_DID, host([storedMeeting()]));
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
				serveReader(GROUP_DID, h);
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
			serveReader(GROUP_DID, alone);
			await groupRouteContext(
				{ OAUTH_SESSIONS: fixtureSessions } as never,
				harness.db,
				GROUP_DID,
				did
			);
			fixtureSessions.reads = 0;

			const h = host([storedMeeting()]);
			serveReader(GROUP_DID, h);
			const refusal = await refusalFor(did, '3lmeeting');

			expect(refusal.status).toBe(404);
			// The standing read and the visibility check, and not one request more:
			// no event read, no profile read.
			expect(h.calls).toEqual(alone.calls);
			expect(h.calls).toContain(`getSpace ${ABOUT}`);
			expect(calendarCalls(h)).toEqual([]);
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
		serveReader(GROUP_DID, host([storedMeeting()]));
		expect((await openAs(MEMBER)).eventData.name).toBe('Committee call');

		const down = host(new Error('com.atproto.space.getRecord failed: 502'));
		serveReader(GROUP_DID, down);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNREADABLE }
		});
		expect(logged).toHaveBeenCalled();
		// One attempt at the space and nothing read in its place.
		expect(calendarCalls(down)).toEqual([`get ${CALENDAR} ${EVENT} 3lmeeting`]);

		// A group whose session is gone tells a member why, and reads nothing.
		serveReader(GROUP_DID, null);
		expect(await refusalFor(MEMBER, '3lmeeting')).toStrictEqual({
			status: 503,
			body: { message: MEMBERS_ONLY_UNLINKED }
		});

		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('a profile that cannot be read leaves the host unnamed, and the event still shows', async () => {
		const h = host([storedMeeting()]);
		serveReader(GROUP_DID, {
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
	it('an organizer who may manage events is told so; a member is not', async () => {
		serveReader(GROUP_DID, host([storedMeeting()]));
		expect((await openAs(OWNER)).canManageEvents).toBe(true);
		serveReader(GROUP_DID, host([storedMeeting()]));
		expect((await openAs(MEMBER)).canManageEvents).toBe(false);
	});
});

// The viewer's own RSVP, read back through their own session from their repo in
// the calendar space, at the event's key. Only after the event read, so a page
// that 404s sends nothing on the member's behalf either. (Spec: FR-113, FR-117.)
describe("/groups/[actor]/events/[rkey] load: the viewer's own RSVP", () => {
	const RSVP = 'community.lexicon.calendar.rsvp';
	/** What a sign-in granted before RSVPs joined the grant, written out. */
	const ACCEPTANCE_ONLY = `atproto space:*?authority=${GROUP_DID}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;

	/** The member's signed-in session. Its requests go into `log`, beside the
	 *  group host's, so the order of the two is a fact of the test. */
	function memberSession(scope: string, log: string[], status: string | null = 'going') {
		return {
			did: MEMBER,
			getTokenInfo: async () => ({ scope }),
			handle: async (pathname: string, init?: RequestInit) => {
				log.push(`member ${init?.method ?? 'GET'} ${pathname}`);
				if (status === null) {
					return Response.json({ error: 'RecordNotFound' }, { status: 400 });
				}
				return Response.json({
					uri: `${CALENDAR}/${MEMBER}/${RSVP}/3lmeeting`,
					cid: 'bafyrsvp',
					value: {
						$type: RSVP,
						status: `${RSVP}#${status}`,
						subject: { uri: MEETING_URI },
						createdAt: '2026-10-08T12:00:00.000Z'
					}
				});
			}
		};
	}

	/** The group's host, logging into the same list. */
	function sharedHost(log: string[]): Host {
		const h = host([storedMeeting()]);
		return {
			...h,
			async get(q) {
				log.push(`group get ${q.space} ${q.collection} ${q.rkey}`);
				return h.get(q);
			}
		};
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
			memberSession(`atproto ${acceptanceGrant(GROUP_DID)}`, log)
		);

		expect(data.viewerRsvpStatus).toBe('going');
		expect(data.viewerRsvpRkey).toBe('3lmeeting');
		expect(data.membersOnly).toBe(true);
		// One read through the member's session, at the event's key, and only once
		// the event itself was read.
		expect(log.filter((line) => line.startsWith('member '))).toEqual([ownRead]);
		const eventRead = log.indexOf(`group get ${CALENDAR} ${EVENT} 3lmeeting`);
		expect(eventRead).toBeGreaterThan(-1);
		expect(log.indexOf(ownRead)).toBeGreaterThan(eventRead);

		// A member who said they are not going reads back as that.
		const later: string[] = [];
		serveReader(GROUP_DID, sharedHost(later));
		const notGoing = await openAs(
			MEMBER,
			'3lmeeting',
			memberSession(`atproto ${acceptanceGrant(GROUP_DID)}`, later, 'notgoing')
		);
		expect(notGoing.viewerRsvpStatus).toBe('notgoing');

		// A page that 404s reads nothing through the session.
		const absent: string[] = [];
		serveReader(GROUP_DID, sharedHost(absent));
		await expect(
			openAs(MEMBER, '3lmadeup', memberSession(`atproto ${acceptanceGrant(GROUP_DID)}`, absent))
		).rejects.toMatchObject({ status: 404 });
		expect(absent.filter((line) => line.startsWith('member '))).toEqual([]);
	});

	it('the event page reads no RSVP for a session without the read grant', async () => {
		const log: string[] = [];
		// A session granted before RSVPs joined the grant, one whose PDS dropped the
		// grant, a signed-in caller with no session, and a member with the grant who
		// has not RSVPed yet.
		const cases: [string, unknown][] = [
			['acceptance only', memberSession(ACCEPTANCE_ONLY, log)],
			['base scope', memberSession('atproto', log)],
			['no session', undefined]
		];
		for (const [, session] of cases) {
			serveReader(GROUP_DID, host([storedMeeting()]));
			const data = await openAs(MEMBER, '3lmeeting', session);
			expect(data.viewerRsvpStatus).toBeNull();
			expect(data.viewerRsvpRkey).toBeNull();
			expect(data.membersOnly).toBe(true);
			expect(data.eventData.name).toBe('Committee call');
		}
		expect(log).toEqual([]);

		serveReader(GROUP_DID, host([storedMeeting()]));
		const none = await openAs(
			MEMBER,
			'3lmeeting',
			memberSession(`atproto ${acceptanceGrant(GROUP_DID)}`, log, null)
		);
		expect(none.viewerRsvpStatus).toBeNull();
		expect(none.viewerRsvpRkey).toBeNull();
		// The one session that holds the grant is the one read.
		expect(log).toEqual([ownRead]);
	});

	it("a viewer's RSVP that cannot be read leaves the page showing none", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const failing = {
			did: MEMBER,
			getTokenInfo: async () => ({ scope: `atproto ${acceptanceGrant(GROUP_DID)}` }),
			handle: async () => Response.json({ error: 'InternalServerError' }, { status: 500 })
		};
		const unreadable = {
			...failing,
			getTokenInfo: async () => {
				throw new Error('the session store is down');
			}
		};
		for (const session of [failing, unreadable]) {
			serveReader(GROUP_DID, host([storedMeeting()]));
			const data = await openAs(MEMBER, '3lmeeting', session);
			expect(data.eventData.name).toBe('Committee call');
			expect(data.viewerRsvpStatus).toBeNull();
		}
		expect(logged).toHaveBeenCalledTimes(1);
		expect(warned).toHaveBeenCalledTimes(1);
		logged.mockRestore();
		warned.mockRestore();
	});
});

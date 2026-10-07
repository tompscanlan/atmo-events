import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The loader of one members-only event's page, at /groups/<actor>/events/<rkey>.
// Only a roster member may cause its read, and everyone else, like a key the
// calendar space does not hold, gets the same 404. The space reader is a fake
// host that logs every call, so "sent nothing" is a count, not a reading of the
// page. The page itself, rendered with the shared EventView, is tested in
// ./page.test.ts.
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { isHttpError } from '@sveltejs/kit';
import { load } from './+page.server';
import {
	groupSpaceReader,
	type GroupSpaceReader,
	type GroupSpaceRecord
} from '$lib/groups/server/about-read';
import { MEMBERS_ONLY_UNLINKED, MEMBERS_ONLY_UNREADABLE } from '$lib/groups/server/calendar-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { groupSpaceUris } from '$lib/groups/server/spaces';

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
	it('an organizer who may manage events is told so; a member is not', async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		expect((await openAs(OWNER)).canManageEvents).toBe(true);
		vi.mocked(groupSpaceReader).mockResolvedValue(host([storedMeeting()]));
		expect((await openAs(MEMBER)).canManageEvents).toBe(false);
	});
});

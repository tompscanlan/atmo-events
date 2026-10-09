import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The events tab shows two slices of a public group's events: the public slice
// from the app's index, which every visitor gets, and the members-only slice
// from the group's calendar space, which only a roster member may cause to be
// read. The index read is stubbed at its module boundary, since what is under
// test is the union and the gate, not the index. The space reader is a fake
// host that logs every call, so "made no space read" is a count, not a reading
// of the page.
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/groups/server/events-index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/events-index')>()),
	listGroupEvents: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { type GroupSpaceReader, type GroupSpaceRecord } from '$lib/groups/server/about-read';
import {
	spaceReader,
	type FakeSpaceReader,
	type SpaceRecordInput
} from '$lib/groups/server/__fixtures__/space-reader';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { listGroupEvents } from '$lib/groups/server/events-index';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import type { CallerMembership, GroupEventRecord, GroupRow } from '$lib/groups/types';

import { groupSpaceUris } from '$lib/groups/ids';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
const PUBLIC_POLICY = 'com.atproto.simplespace.defs#publicPolicy';

/** The public slice, as the index hands it over. */
const PUBLIC_PADDLE: GroupEventRecord = {
	uri: `at://${GROUP_DID}/${EVENT}/3lpaddle`,
	cid: 'bafypaddle',
	rkey: '3lpaddle',
	value: { name: 'Sunrise paddle', createdAt: '2026-10-01T09:00:00.000Z' }
};

/** The calendar space: one members-only event, and the space's access record,
 *  which is not an event and must never show as one. */
const MEETING: GroupSpaceRecord = {
	uri: `${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`,
	cid: 'bafymeeting',
	collection: EVENT,
	rkey: '3lmeeting',
	value: { name: 'Committee call', createdAt: '2026-10-02T09:00:00.000Z' }
};
const ACCESS_SELF: GroupSpaceRecord = {
	uri: `${CALENDAR}/${GROUP_DID}/group.opensocial.access/self`,
	cid: 'bafyaccess',
	collection: 'group.opensocial.access',
	rkey: 'self',
	value: { public: false, readRoles: ['owner', 'admin', 'member'], grants: [] }
};

let harness: SqliteD1;
let row: GroupRow;
/** A fresh array per test, so `toBe` can tell the index's own list from a copy. */
let publicSlice: GroupEventRecord[];

beforeEach(async () => {
	({ harness, group: row } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	publicSlice = [PUBLIC_PADDLE];
	vi.mocked(listGroupEvents).mockImplementation(async () => publicSlice);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	resetReaderHost();
});

/** A public group's host. Its about and members spaces hold no records, so a
 *  roster caller's standing comes from the rows. `calendar` is what the
 *  calendar space holds, or the error every listing of it fails with. The host
 *  honors the collection filter unless `ignoresFilter`. */
function publicHost(
	calendar: SpaceRecordInput[] | Error,
	{ ignoresFilter = false } = {}
): FakeSpaceReader {
	return spaceReader(GROUP_DID, {
		space: CALENDAR,
		records: calendar instanceof Error ? [] : calendar,
		policies: { [ABOUT]: PUBLIC_POLICY },
		ignoresFilter,
		fail: (call) => {
			if (call.space !== CALENDAR) return undefined;
			if (call.method !== 'list') {
				return new Error(`the calendar space is listed, never read with ${call.method}`);
			}
			return calendar instanceof Error ? calendar : undefined;
		}
	});
}

const FULL_CALENDAR = () => publicHost([ACCESS_SELF, MEETING]);
const EMPTY_CALENDAR = () => publicHost([]);

async function openAs(did: string | null) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events`)
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown> & {
		events: GroupEventRecord[];
		membership: CallerMembership;
		membersOnlyNotice?: string;
	};
}

/** The reads a page load makes for a caller off the roster, written out: the
 *  gate's (the caller's standing, then the host's visibility), then the
 *  profile for the name. */
const ABOUT_READS = [
	`getSpace ${ABOUT}`,
	`get ${ABOUT} ${GROUP_DID} group.opensocial.profile self`
];
function standingReads(did: string): string[] {
	return [
		`get ${MEMBERS} ${GROUP_DID} group.opensocial.membership ${did}`,
		`get ${MEMBERS} ${GROUP_DID} group.opensocial.permissions self`,
		`get ${MEMBERS} ${GROUP_DID} net.openmeet.group.eventPermissions self`,
		`list ${MEMBERS} ${GROUP_DID} group.opensocial.role`
	];
}

/** What the loader returns for a caller off the roster, written out: the
 *  index's own list, and these six keys and no other. */
function asBefore() {
	return {
		group: row,
		groupName: 'Kona',
		handle: null,
		events: publicSlice,
		canCreateEvent: false,
		canManageEvents: false
	};
}

describe('/groups/[actor]/events load: a viewer off the roster costs nothing', () => {
	it('no space read for an anonymous viewer', async () => {
		for (const host of [FULL_CALENDAR(), EMPTY_CALENDAR()]) {
			serveReader(GROUP_DID, host);

			const data = await openAs(null);

			expect(host.callsIn(CALENDAR)).toEqual([]);
			expect(host.calls).toEqual(ABOUT_READS);
			expect(data).toStrictEqual(asBefore());
			expect(data.events).toBe(publicSlice);
		}
	});

	it('no space read for a signed-in non-member', async () => {
		for (const host of [FULL_CALENDAR(), EMPTY_CALENDAR()]) {
			serveReader(GROUP_DID, host);

			const data = await openAs(STRANGER);

			expect(host.callsIn(CALENDAR)).toEqual([]);
			expect(host.calls.sort()).toEqual([...standingReads(STRANGER), ...ABOUT_READS].sort());
			expect(data).toStrictEqual(asBefore());
			expect(data.events).toBe(publicSlice);
		}
	});

	// A members space that errors puts even a member off the roster for the
	// read, so the slice is not read for them either, and no notice appears.
	it('a member whose roster cannot be read is a non-member here, with no notice', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const host = FULL_CALENDAR();
		const membersDown: GroupSpaceReader = {
			...host,
			async get(q) {
				if (q.space === MEMBERS) throw new Error('com.atproto.space.getRecord failed: 502');
				return host.get(q);
			}
		};
		serveReader(GROUP_DID, membersDown);

		const data = await openAs(MEMBER);

		expect(host.callsIn(CALENDAR)).toEqual([]);
		expect('membersOnlyNotice' in data).toBe(false);
		expect(data.events).toBe(publicSlice);
		logged.mockRestore();
	});
});

describe('/groups/[actor]/events load: a member sees both slices', () => {
	it('three viewers, one page: 2 events for a member, 1 for a signed-in non-member, 1 anonymous', async () => {
		const counts: Record<string, number> = {};
		for (const [who, did] of [
			['member', MEMBER],
			['non-member', STRANGER],
			['anonymous', null]
		] as const) {
			serveReader(GROUP_DID, FULL_CALENDAR());
			counts[who] = (await openAs(did)).events.length;
		}

		expect(counts).toEqual({ member: 2, 'non-member': 1, anonymous: 1 });
	});

	it("a member's page is the union, newest first, at one listing of the calendar space", async () => {
		const host = FULL_CALENDAR();
		serveReader(GROUP_DID, host);

		const data = await openAs(MEMBER);

		expect(host.callsIn(CALENDAR)).toEqual([`list ${CALENDAR} ${GROUP_DID} ${EVENT}`]);
		expect(data.events).toStrictEqual([
			{
				uri: `at://${GROUP_DID}/space/net.openmeet.space.calendar/self/${GROUP_DID}/${EVENT}/3lmeeting`,
				cid: 'bafymeeting',
				rkey: '3lmeeting',
				value: MEETING.value,
				space: CALENDAR
			},
			PUBLIC_PADDLE
		]);
		// The public record is the index's own object, with no key added.
		expect(data.events[1]).toBe(PUBLIC_PADDLE);
		expect('membersOnlyNotice' in data).toBe(false);
		expect(listGroupEvents).toHaveBeenCalledTimes(1);
	});

	// The card builds a cdn.bsky.app URL from an event's image. A public event's
	// is public anyway; a members-only event's would hand a third party the
	// group's DID and the image's CID, so it reaches the page without one.
	it("a member's page drops a members-only event's image and keeps a public event's", async () => {
		const image = {
			role: 'thumbnail',
			content: {
				$type: 'blob',
				ref: { $link: 'bafkreithumb' },
				mimeType: 'image/webp',
				size: 41250
			}
		};
		const publicWithImage: GroupEventRecord = {
			...PUBLIC_PADDLE,
			value: { ...PUBLIC_PADDLE.value, media: [image] }
		};
		const stored: GroupSpaceRecord = { ...MEETING, value: { ...MEETING.value, media: [image] } };
		publicSlice = [publicWithImage];
		serveReader(GROUP_DID, publicHost([stored]));

		const data = await openAs(MEMBER);

		expect(data.events.map((e) => e.rkey)).toEqual(['3lmeeting', '3lpaddle']);
		// The members-only event: every field as stored but the image.
		expect(data.events[0].value).toStrictEqual(MEETING.value);
		expect('media' in data.events[0].value).toBe(false);
		// The public event: the index's own object, image and all.
		expect(data.events[1]).toBe(publicWithImage);
		expect(data.events[1].value.media).toStrictEqual([image]);
		// What the host holds is untouched.
		expect(stored.value.media).toStrictEqual([image]);
	});

	it('the owner, who is on the roster, sees the members-only event too', async () => {
		serveReader(GROUP_DID, FULL_CALENDAR());

		const data = await openAs(OWNER);

		expect(data.events.map((e) => e.rkey)).toEqual(['3lmeeting', '3lpaddle']);
	});

	it('the access record never shows as an event, even from a host that ignores the filter', async () => {
		serveReader(GROUP_DID, publicHost([ACCESS_SELF, MEETING], { ignoresFilter: true }));

		const data = await openAs(MEMBER);

		expect(data.events.map((e) => e.uri)).toEqual([MEETING.uri, PUBLIC_PADDLE.uri]);
	});

	it('a members-only event that shares an rkey with a public one is still its own entry', async () => {
		serveReader(GROUP_DID, publicHost([{ ...MEETING, rkey: '3lpaddle' }]));

		const data = await openAs(MEMBER);

		expect(data.events.map((e) => e.rkey)).toEqual(['3lpaddle', '3lpaddle']);
		expect(new Set(data.events.map((e) => e.uri)).size).toBe(2);
	});
});

describe('/groups/[actor]/events load: when the members-only slice cannot be read', () => {
	let logged: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => logged.mockRestore());

	it('an unlinked group shows a member the public slice and says an organizer has to relink', async () => {
		serveReader(GROUP_DID, null);

		const data = await openAs(MEMBER);

		expect(data.events).toStrictEqual([PUBLIC_PADDLE]);
		expect(data.membersOnlyNotice).toMatch(
			/^members-only events can't be shown until an organizer relinks the group\.$/i
		);
	});

	it('a calendar read that fails shows the public slice with a notice, and logs it', async () => {
		const host = publicHost(new Error('com.atproto.space.listRecords failed: 502'));
		serveReader(GROUP_DID, host);

		const data = await openAs(MEMBER);

		expect(data.events).toStrictEqual([PUBLIC_PADDLE]);
		expect(data.membersOnlyNotice).toMatch(/^members-only events couldn't be loaded right now\.$/i);
		expect(logged).toHaveBeenCalled();
		// One attempt at the space and no other read in its place.
		expect(host.callsIn(CALENDAR)).toEqual([`list ${CALENDAR} ${GROUP_DID} ${EVENT}`]);
		expect(listGroupEvents).toHaveBeenCalledTimes(1);
	});

	it('an empty calendar space shows a member the public slice and no notice', async () => {
		serveReader(GROUP_DID, EMPTY_CALENDAR());

		const data = await openAs(MEMBER);

		expect(data.events).toStrictEqual([PUBLIC_PADDLE]);
		expect('membersOnlyNotice' in data).toBe(false);
		expect(logged).not.toHaveBeenCalled();
	});

	it('a failed index read still leaves a member the members-only slice', async () => {
		vi.mocked(listGroupEvents).mockRejectedValue(new Error('index down'));
		serveReader(GROUP_DID, FULL_CALENDAR());

		const member = await openAs(MEMBER);
		const anonymous = await openAs(null);

		expect(member.events.map((e) => e.rkey)).toEqual(['3lmeeting']);
		expect(anonymous.events).toEqual([]);
	});
});

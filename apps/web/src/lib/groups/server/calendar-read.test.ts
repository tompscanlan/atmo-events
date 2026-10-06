// The members-only slice of a group's events: who may cause the read, what the
// read returns, and what a member is told when it cannot be made.
//
// The gate is pinned with a reader that records every call and fails loudly on
// one, so "the reader was never touched" is asserted rather than inferred from
// an empty result. The wire shapes are pinned through the real reader over a
// stubbed fetch, because `listRecords` answers without a `uri` and a parser that
// required one would read a full calendar space as empty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MEMBERS_ONLY_UNLINKED,
	MEMBERS_ONLY_UNREADABLE,
	readMembersOnlyEvents,
	unionGroupEvents
} from './calendar-read';
import { pdsSpaceReader, type GroupSpaceReader, type GroupSpaceRecord } from './about-read';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import type { CallerMembership, GroupEventRecord } from '../types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GROUP = { group_did: GROUP_DID };
// Written out, not taken from the app's constants, so a wrong space type, key
// or URI form in the code under test fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
const ABOUT = `at://${GROUP_DID}/space/group.opensocial.meta/self`;
const EVENT = 'community.lexicon.calendar.event';
const ACCESS = 'group.opensocial.access';

function spaceForm(collection: string, rkey: string): string {
	return `${CALENDAR}/${GROUP_DID}/${collection}/${rkey}`;
}

const MEETING_VALUE = {
	$type: EVENT,
	name: 'Committee call',
	startsAt: '2026-11-02T18:00:00.000Z',
	createdAt: '2026-10-02T09:00:00.000Z'
};
const ACCESS_VALUE = { public: false, readRoles: ['owner', 'admin', 'member'], grants: [] };

/** An image as the event editor stores it: a blob in the group's repo, cited
 *  by its CID. */
function image(role: string, cid: string) {
	return {
		role,
		alt: 'The committee',
		content: { $type: 'blob', ref: { $link: cid }, mimeType: 'image/webp', size: 41250 }
	};
}

/** The calendar space as the reader returns it: an event and the space's own
 *  access record, each at its space-form URI. */
const CALENDAR_RECORDS: GroupSpaceRecord[] = [
	{
		uri: spaceForm(ACCESS, 'self'),
		cid: 'bafyaccess',
		collection: ACCESS,
		rkey: 'self',
		value: ACCESS_VALUE
	},
	{
		uri: spaceForm(EVENT, '3lmeeting'),
		cid: 'bafymeeting',
		collection: EVENT,
		rkey: '3lmeeting',
		value: MEETING_VALUE
	}
];

function viewer(onRoster: boolean, extra: Partial<CallerMembership> = {}): CallerMembership {
	return {
		did: 'did:plc:viewer',
		role: onRoster ? 'member' : null,
		status: onRoster ? 'active' : null,
		pendingRequestId: null,
		permissions: new Set(),
		onRoster,
		...extra
	};
}

const ANONYMOUS: CallerMembership = { ...viewer(false), did: null };

/** Every way a caller can be off the roster for a read. The last two hold a
 *  row that names a role, which must not count: only `onRoster` does. */
const OFF_THE_ROSTER: [string, CallerMembership][] = [
	['an anonymous visitor', ANONYMOUS],
	['a signed-in non-member', viewer(false)],
	['a pending requester', viewer(false, { pendingRequestId: 'req-1' })],
	[
		'a member whose roster read failed',
		viewer(false, { role: 'member', status: 'active', unreadable: 'listRecords failed: 502' })
	],
	['an admin row with no membership record', viewer(false, { role: 'admin', status: 'active' })]
];

interface RecordingReader extends GroupSpaceReader {
	calls: string[];
}

/** A reader over `records` that logs each call. A host that ignores the
 *  collection parameter hands back every record whatever was asked for. */
function recordingReader(
	records: GroupSpaceRecord[] | Error,
	{ ignoresFilter = false } = {}
): RecordingReader {
	const calls: string[] = [];
	return {
		calls,
		async get(q) {
			calls.push(`get ${q.space} ${q.collection} ${q.rkey}`);
			throw new Error('the slice is read with list, never get');
		},
		async list(q) {
			calls.push(`list ${q.space} ${q.repo} ${q.collection ?? '(no collection)'}`);
			if (records instanceof Error) throw records;
			return ignoresFilter ? records : records.filter((r) => r.collection === q.collection);
		},
		async getSpace(space) {
			calls.push(`getSpace ${space}`);
			throw new Error('the slice never asks for a space configuration');
		}
	};
}

describe('readMembersOnlyEvents: the roster check comes before the read', () => {
	it.each(OFF_THE_ROSTER)('%s causes no read at all and gets nothing back', async (_, who) => {
		const reader = recordingReader(CALENDAR_RECORDS, { ignoresFilter: true });

		const slice = await readMembersOnlyEvents(who, reader, GROUP);

		expect(slice).toBeNull();
		expect(reader.calls).toEqual([]);
	});

	// No reader is the unlinked case, which has a member-facing notice. Off the
	// roster, there must not even be that.
	it.each(OFF_THE_ROSTER)('%s gets no notice when the group is unlinked either', async (_, who) => {
		expect(await readMembersOnlyEvents(who, null, GROUP)).toBeNull();
	});

	it("a roster member's read is one listing of the calendar space, for events only", async () => {
		const reader = recordingReader(CALENDAR_RECORDS);

		await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(reader.calls).toEqual([`list ${CALENDAR} ${GROUP_DID} ${EVENT}`]);
	});
});

describe('readMembersOnlyEvents: what a member gets back', () => {
	it('returns the events and never the access record, even from a host that ignores the filter', async () => {
		for (const ignoresFilter of [false, true]) {
			const reader = recordingReader(CALENDAR_RECORDS, { ignoresFilter });

			const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

			expect(slice?.events.map((e) => e.rkey)).toEqual(['3lmeeting']);
			expect(slice?.notice).toBeNull();
		}
	});

	it('keeps each event at its space-form URI and marks it with the calendar space', async () => {
		const slice = await readMembersOnlyEvents(
			viewer(true),
			recordingReader(CALENDAR_RECORDS),
			GROUP
		);

		expect(slice?.events).toStrictEqual([
			{
				uri: `at://${GROUP_DID}/space/net.openmeet.space.calendar/self/${GROUP_DID}/${EVENT}/3lmeeting`,
				cid: 'bafymeeting',
				rkey: '3lmeeting',
				value: MEETING_VALUE,
				space: CALENDAR
			}
		]);
	});

	it('an empty calendar space is no members-only events and no notice', async () => {
		const slice = await readMembersOnlyEvents(viewer(true), recordingReader([]), GROUP);

		expect(slice).toStrictEqual({ events: [], notice: null });
	});
});

describe('readMembersOnlyEvents: failing gracefully, for a member', () => {
	let logged: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => logged.mockRestore());

	it('with no reader, the slice is empty and says an organizer has to relink the group', async () => {
		const slice = await readMembersOnlyEvents(viewer(true, { unlinked: true }), null, GROUP);

		expect(slice).toStrictEqual({ events: [], notice: MEMBERS_ONLY_UNLINKED });
		expect(MEMBERS_ONLY_UNLINKED).toMatch(
			/^members-only events can't be shown until an organizer relinks the group\.$/i
		);
		expect(logged).not.toHaveBeenCalled();
	});

	it('a read that throws leaves the slice empty, says so, and logs the error', async () => {
		const failure = new Error('com.atproto.space.listRecords failed: 502');
		const reader = recordingReader(failure);

		const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(slice).toStrictEqual({ events: [], notice: MEMBERS_ONLY_UNREADABLE });
		expect(MEMBERS_ONLY_UNREADABLE).toMatch(
			/^members-only events couldn't be loaded right now\.$/i
		);
		expect(logged).toHaveBeenCalledWith(expect.stringContaining(GROUP_DID), failure);
		// One attempt, and nothing read in its place.
		expect(reader.calls).toEqual([`list ${CALENDAR} ${GROUP_DID} ${EVENT}`]);
	});
});

// The two space read methods answer in different shapes:
//
//   getRecord   -> { uri, cid, value }
//   listRecords -> { collection, rkey, cid, value }, no uri
//
// These cases go through the real reader, on the group's linked session, to a
// stubbed host that answers the way the live one does.
describe('readMembersOnlyEvents: through the real reader', () => {
	let requested: URL[];
	let logged: ReturnType<typeof vi.spyOn>;
	let warned: ReturnType<typeof vi.spyOn>;

	function hostAnswering(answer: () => Response) {
		requested = [];
		vi.stubGlobal('fetch', async (input: URL | string) => {
			requested.push(new URL(String(input)));
			return answer();
		});
		return pdsSpaceReader(linkedCredential(GROUP_DID), GROUP_DID);
	}

	beforeEach(() => {
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		unlinkAllGroups();
		logged.mockRestore();
		warned.mockRestore();
	});

	// The card builds a cdn.bsky.app URL from an event's image, and that URL
	// carries the group's DID and the image's CID to a third party. Only the
	// image goes: the event's identity and every other field arrive as stored.
	it('a members-only event is read without its image', async () => {
		const stored = {
			...MEETING_VALUE,
			media: [image('thumbnail', 'bafkreithumb'), image('header', 'bafkreiheader')]
		};
		const reader = hostAnswering(() =>
			Response.json({
				records: [{ collection: EVENT, rkey: '3lmeeting', cid: 'bafymeeting', value: stored }]
			})
		);

		const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(slice).toStrictEqual({
			events: [
				{
					uri: spaceForm(EVENT, '3lmeeting'),
					cid: 'bafymeeting',
					rkey: '3lmeeting',
					value: MEETING_VALUE,
					space: CALENDAR
				}
			],
			notice: null
		});
		expect('media' in slice!.events[0].value).toBe(false);
	});

	it('reads a listRecords body that carries no uri, and rebuilds the space-form one', async () => {
		// A host that ignores the collection filter, in the live shape.
		const reader = hostAnswering(() =>
			Response.json({
				records: [
					{ collection: ACCESS, rkey: 'self', cid: 'bafyaccess', value: ACCESS_VALUE },
					{ collection: EVENT, rkey: '3lmeeting', cid: 'bafymeeting', value: MEETING_VALUE }
				]
			})
		);

		const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(slice).toStrictEqual({
			events: [
				{
					uri: spaceForm(EVENT, '3lmeeting'),
					cid: 'bafymeeting',
					rkey: '3lmeeting',
					value: MEETING_VALUE,
					space: CALENDAR
				}
			],
			notice: null
		});
		expect(requested).toHaveLength(1);
		expect(requested[0].pathname).toBe('/xrpc/com.atproto.space.listRecords');
		expect(requested[0].searchParams.get('space')).toBe(CALENDAR);
		expect(requested[0].searchParams.get('repo')).toBe(GROUP_DID);
		expect(requested[0].searchParams.get('collection')).toBe(EVENT);
	});

	it('sends nothing to the host for a viewer off the roster', async () => {
		const reader = hostAnswering(() => Response.json({ records: [] }));

		for (const [, who] of OFF_THE_ROSTER) {
			expect(await readMembersOnlyEvents(who, reader, GROUP)).toBeNull();
		}
		expect(requested).toEqual([]);
	});

	// A group made before the calendar space existed has none. One host answers
	// that with an empty list (devnet does), another with SpaceNotFound. Either
	// way the group simply has no members-only events, which is not a failure.
	it('a space the host never created is no members-only events and no notice', async () => {
		for (const answer of [
			() => Response.json({ records: [] }),
			() => Response.json({ error: 'SpaceNotFound' }, { status: 400 })
		]) {
			const slice = await readMembersOnlyEvents(viewer(true), hostAnswering(answer), GROUP);
			expect(slice).toStrictEqual({ events: [], notice: null });
		}
		expect(logged).not.toHaveBeenCalled();
	});

	// A host that answered a refused read with SpaceNotFound would leave a member
	// looking at no members-only events and no notice, so the log has to say it.
	// The line names the group and not its calendar space, as the error line does.
	it('a calendar space the host says does not exist is a warning in the log, not a notice', async () => {
		const reader = hostAnswering(() => Response.json({ error: 'SpaceNotFound' }, { status: 400 }));

		const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(slice).toStrictEqual({ events: [], notice: null });
		expect(warned).toHaveBeenCalledTimes(1);
		expect(warned).toHaveBeenCalledWith(
			expect.stringContaining(GROUP_DID),
			expect.objectContaining({ message: expect.stringMatching(/\bSpaceNotFound\b/) })
		);
		expect(warned.mock.calls[0][0]).not.toContain(CALENDAR);
		expect(warned.mock.calls[0][1]).toBeInstanceOf(Error);
		expect(logged).not.toHaveBeenCalled();
	});

	it('an empty calendar space is no warning', async () => {
		const reader = hostAnswering(() => Response.json({ records: [] }));

		const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(slice).toStrictEqual({ events: [], notice: null });
		expect(warned).not.toHaveBeenCalled();
		expect(logged).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 400, error: 'InvalidRequest' },
		{ status: 401, error: 'AuthMissing' },
		{ status: 502, error: undefined }
	])(
		'any other refusal ($status $error) is a notice, not an empty space',
		async ({ status, error }) => {
			const reader = hostAnswering(() => Response.json(error ? { error } : {}, { status }));

			const slice = await readMembersOnlyEvents(viewer(true), reader, GROUP);

			expect(slice).toStrictEqual({ events: [], notice: MEMBERS_ONLY_UNREADABLE });
			expect(logged).toHaveBeenCalled();
		}
	);

	it('never reads a space other than the calendar space', async () => {
		const reader = hostAnswering(() => Response.json({ records: [] }));

		await readMembersOnlyEvents(viewer(true), reader, GROUP);

		expect(requested.map((u) => u.searchParams.get('space'))).toEqual([CALENDAR]);
		expect(requested.map((u) => u.searchParams.get('space'))).not.toContain(ABOUT);
	});
});

describe('unionGroupEvents', () => {
	function publicEvent(rkey: string, createdAt: string | undefined): GroupEventRecord {
		return {
			uri: `at://${GROUP_DID}/${EVENT}/${rkey}`,
			cid: `bafy${rkey}`,
			rkey,
			value: { name: `public ${rkey}`, ...(createdAt ? { createdAt } : {}) }
		};
	}
	function membersOnlyEvent(rkey: string, createdAt: string): GroupEventRecord {
		return {
			uri: spaceForm(EVENT, rkey),
			cid: `bafy${rkey}`,
			rkey,
			value: { name: `members-only ${rkey}`, createdAt },
			space: CALENDAR
		};
	}

	it('orders both slices newest first by createdAt, ties broken by uri', () => {
		const older = publicEvent('3la', '2026-10-01T09:00:00.000Z');
		const newer = publicEvent('3lb', '2026-10-03T09:00:00.000Z');
		const middle = membersOnlyEvent('3lc', '2026-10-02T09:00:00.000Z');
		// Same instant, so the URI decides: the plain form sorts before the space form.
		const tiedPublic = publicEvent('3ld', '2026-10-03T09:00:00.000Z');
		const tiedMembers = membersOnlyEvent('3le', '2026-10-03T09:00:00.000Z');

		const union = unionGroupEvents([newer, tiedPublic, older], [middle, tiedMembers]);

		expect(union.map((e) => e.rkey)).toEqual(['3lb', '3ld', '3le', '3lc', '3la']);
	});

	it('puts a record with no usable createdAt last', () => {
		const dated = membersOnlyEvent('3la', '2026-10-01T09:00:00.000Z');
		const undated = publicEvent('3lb', undefined);
		const garbled = publicEvent('3lc', 'not a date');

		const union = unionGroupEvents([undated, garbled], [dated]);

		expect(union.map((e) => e.rkey)).toEqual(['3la', '3lb', '3lc']);
	});

	it('keeps a public and a members-only event that share an rkey, apart by uri', () => {
		const pub = publicEvent('3lsame', '2026-10-01T09:00:00.000Z');
		const mem = membersOnlyEvent('3lsame', '2026-10-02T09:00:00.000Z');

		const union = unionGroupEvents([pub], [mem]);

		expect(union).toHaveLength(2);
		expect(new Set(union.map((e) => e.uri)).size).toBe(2);
	});

	it('hands back the public records as the same objects, with no new key', () => {
		const pub = publicEvent('3la', '2026-10-01T09:00:00.000Z');
		const before = JSON.stringify(pub);

		const [only] = unionGroupEvents([pub], []);

		expect(only).toBe(pub);
		expect(JSON.stringify(only)).toBe(before);
		expect('space' in only).toBe(false);
	});
});

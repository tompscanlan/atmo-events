import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPlacement } from '../event-placement';
import { groupPds, type GroupPds } from './__fixtures__/group-pds';
import type { GroupWriter } from './context';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({ post: mocks.post }) }));

import {
	calendarSpaceState,
	deleteGroupEvent,
	GroupEventRefused,
	putGroupEvent,
	readMembersOnlyEventAsGroup
} from './group-events';

const GROUP = 'did:plc:group';
const CALENDAR = `at://${GROUP}/space/rsvp.atmo.group.calendar/self`;
const PRIVATE = { public: false, grants: [{ role: 'member', scopes: ['space:x?action=read'] }] };
const EVENT = {
	name: 'Trail day',
	createdAt: '2026-10-30T12:00:00.000Z',
	startsAt: '2026-11-07T15:00:00.000Z'
};

/** The URIs the index was told of. */
const told = () => mocks.post.mock.calls.flatMap(([, { input }]) => input.uris as string[]);

const put = (writer: GroupWriter, placement: EventPlacement, record: object = EVENT) =>
	putGroupEvent(writer, { rkey: 'e1', record: { ...record }, placement });

/** Why the write was refused, once it is clear nothing was written and the index heard nothing. */
async function refusal(pds: GroupPds, run: Promise<unknown>) {
	const reason = await run.then(
		() => null,
		(e) => (e instanceof GroupEventRefused ? e.reason : e)
	);
	expect(pds.writes).toEqual([]);
	expect(mocks.post).not.toHaveBeenCalled();
	return reason;
}

/** Answers 500 to every read of `nsid`, and passes the rest to the PDS. */
function failingReads(pds: GroupPds, nsid: string): GroupWriter {
	return {
		did: GROUP,
		handle: (pathname, init) =>
			pathname.startsWith(`/xrpc/${nsid}?`)
				? Promise.resolve(Response.json({ error: 'InternalServerError' }, { status: 500 }))
				: pds.writer.handle(pathname, init)
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.post.mockResolvedValue({ ok: true, data: {} });
});

describe('a public event', () => {
	it("goes into the group's repo, needing no calendar space, and the index is told", async () => {
		const pds = groupPds(GROUP);
		const saved = await put(pds.writer, 'everyone');
		expect(pds.writes).toEqual(['event']);
		expect(pds.state.events.e1).toEqual({ ...EVENT, $type: 'community.lexicon.calendar.event' });
		expect(saved.uri).toBe(`at://${GROUP}/community.lexicon.calendar.event/e1`);
		expect(told()).toEqual([saved.uri]);
	});
});

describe('a members-only event', () => {
	it('goes into the calendar space, named by its space URI, and the index never hears of it', async () => {
		const pds = groupPds(GROUP, { calendar: PRIVATE });
		const saved = await put(pds.writer, 'members');
		expect(pds.writes).toEqual(['members event']);
		expect(pds.state.events).toEqual({});
		expect(saved.uri).toBe(`${CALENDAR}/${GROUP}/community.lexicon.calendar.event/e1`);
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it.each([
		['missing', null, 'no-calendar-space'],
		['readable by more than its members', { ...PRIVATE, public: true }, 'calendar-space-readable'],
		['set to an access that does not parse', { public: false }, 'calendar-space-unchecked']
	])('is refused, with nothing written, if the calendar space is %s', async (_, access, why) => {
		const pds = groupPds(GROUP, { calendar: access });
		expect(await refusal(pds, put(pds.writer, 'members'))).toBe(why);
	});

	it('is refused when the calendar space cannot be checked, never read as private', async () => {
		const pds = groupPds(GROUP, { calendar: PRIVATE });
		const writer = failingReads(pds, 'com.atproto.space.getRecord');
		expect(await refusal(pds, put(writer, 'members'))).toBe('calendar-space-unchecked');
	});
});

describe('an event stays where it was first written', () => {
	it.each([
		['everyone', { membersEvents: { e1: EVENT } }],
		['members', { events: { e1: EVENT } }]
	] as const)('is not copied into the other container by a save for %s', async (placement, at) => {
		const pds = groupPds(GROUP, { calendar: PRIVATE, ...at });
		expect(await refusal(pds, put(pds.writer, placement))).toBe('moved');
	});

	it('is saved again where it is', async () => {
		const pds = groupPds(GROUP, { calendar: PRIVATE, membersEvents: { e1: EVENT } });
		const renamed = { ...EVENT, name: 'Trail day, moved to Sunday' };
		await put(pds.writer, 'members', renamed);
		expect(pds.state.membersEvents.e1).toMatchObject({ name: renamed.name });
	});

	it('is refused when where it is cannot be checked', async () => {
		const pds = groupPds(GROUP, { calendar: PRIVATE });
		const writer = failingReads(pds, 'com.atproto.repo.getRecord');
		expect(await refusal(pds, put(writer, 'members'))).toBe('unchecked');
	});

	it('is deleted only where it is, and a delete sent to the other container does nothing', async () => {
		const pds = groupPds(GROUP, { calendar: PRIVATE, membersEvents: { e1: EVENT } });
		const wrong = deleteGroupEvent(pds.writer, { rkey: 'e1', placement: 'everyone' });
		expect(await refusal(pds, wrong)).toBe('wrong-delete');

		await deleteGroupEvent(pds.writer, { rkey: 'e1', placement: 'members' });
		expect(pds.writes).toEqual(['delete members event']);
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it('tells the index when a public event is deleted', async () => {
		const pds = groupPds(GROUP, { events: { e1: EVENT } });
		await deleteGroupEvent(pds.writer, { rkey: 'e1', placement: 'everyone' });
		expect(pds.writes).toEqual(['delete event']);
		expect(told()).toEqual([`at://${GROUP}/community.lexicon.calendar.event/e1`]);
	});
});

it('refuses a record that is not an event, writing nothing', async () => {
	const pds = groupPds(GROUP, { calendar: PRIVATE });
	const noDate = { name: EVENT.name, startsAt: EVENT.startsAt };
	for (const placement of ['everyone', 'members'] as const) {
		expect(await refusal(pds, put(pds.writer, placement, noDate))).toBe('not-an-event');
	}
});

it("takes a record as the event editor builds it, with fields the lexicon doesn't name", async () => {
	// The shape of packages/ui editor/save.ts buildEventRecord's output.
	const edited = {
		$type: 'community.lexicon.calendar.event',
		createdWith: 'https://atmo.rsvp',
		name: 'Trail day',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled',
		startsAt: '2026-11-07T15:00:00.000Z',
		endsAt: '2026-11-07T18:00:00.000Z',
		timezone: 'America/New_York',
		createdAt: '2026-10-30T12:00:00.000Z',
		theme: { accentColor: 'pink', baseColor: 'stone' },
		description: 'Meet at the trailhead.',
		uris: [{ uri: 'https://example.com/map', name: 'Map' }],
		locations: [
			{ $type: 'community.lexicon.location.address', country: 'US', locality: 'Louisville' }
		],
		additionalData: { importedFrom: 'x' }
	};
	const pds = groupPds(GROUP, { calendar: PRIVATE });
	await putGroupEvent(pds.writer, { rkey: 'e1', record: edited, placement: 'members' });
	await putGroupEvent(pds.writer, { rkey: 'e2', record: edited, placement: 'everyone' });
	expect(pds.writes).toEqual(['members event', 'event']);
});

describe('calendarSpaceState', () => {
	it('says whether members-only events can go in', async () => {
		expect(await calendarSpaceState(groupPds(GROUP, { calendar: PRIVATE }).writer)).toBe('ready');
		expect(await calendarSpaceState(groupPds(GROUP).writer)).toBe('missing');
		const readable = groupPds(GROUP, { calendar: { ...PRIVATE, public: true } });
		expect(await calendarSpaceState(readable.writer)).toBe('readable');
	});
});

describe('readMembersOnlyEventAsGroup', () => {
	it('reads the event whole, by its space URI, or nothing', async () => {
		const stored = { ...EVENT, $type: 'community.lexicon.calendar.event', extra: { kept: true } };
		const pds = groupPds(GROUP, { calendar: PRIVATE, membersEvents: { e1: stored } });
		expect(await readMembersOnlyEventAsGroup(pds.writer, 'e1')).toMatchObject({
			uri: `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/e1`,
			cid: 'cid-e1',
			value: stored
		});
		expect(await readMembersOnlyEventAsGroup(pds.writer, 'e2')).toBeNull();
		expect(await readMembersOnlyEventAsGroup(groupPds(GROUP).writer, 'e1')).toBeNull();
	});
});

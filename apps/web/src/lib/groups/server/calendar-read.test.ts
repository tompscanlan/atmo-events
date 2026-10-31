import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_RSVP_SCOPE } from '../scopes';
import type { CallerSession } from './caller';
import { SpaceAccessDenied } from './space-credential';
import type { GroupSpaceReader } from './space-read';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('./space-read', () => ({
	credentialSpaceReader: (): GroupSpaceReader => ({ list: mocks.list, get: mocks.get })
}));

import { readMembersOnlyEvent, readMembersOnlyEvents, upcoming } from './calendar-read';

const GROUP = 'did:plc:group';
const CALENDAR = `at://${GROUP}/space/rsvp.atmo.group.calendar/self`;
const EVENT = 'community.lexicon.calendar.event';
/** The group's events in its calendar space, as the reader is asked for them. */
const EVENTS = { space: CALENDAR, repo: GROUP, collection: EVENT };
const caller = (scope = `atproto ${CALENDAR_RSVP_SCOPE}`): CallerSession => ({
	did: 'did:plc:alice',
	scope,
	handle: vi.fn()
});
const IMAGE = { role: 'thumbnail', content: { $type: 'blob', ref: { $link: 'bafyimage' } } };
const record = (rkey: string, value: Record<string, unknown>, collection = EVENT) => ({
	uri: `${CALENDAR}/${GROUP}/${collection}/${rkey}`,
	cid: `cid-${rkey}`,
	collection,
	rkey,
	value
});
const TRAIL = { name: 'Trail day', startsAt: '2026-11-07T15:00:00.000Z', media: [IMAGE] };

beforeEach(() => vi.resetAllMocks());

describe('readMembersOnlyEvents', () => {
	it("lists the group's events in its calendar space, without their images", async () => {
		mocks.list.mockResolvedValue([
			record('e1', TRAIL),
			record('self', { public: false }, 'group.opensocial.access'),
			record('e2', { name: 'No start' })
		]);
		const events = await readMembersOnlyEvents(caller(), GROUP);
		expect(mocks.list).toHaveBeenCalledWith(EVENTS);
		expect(events).toEqual([
			expect.objectContaining({ name: 'Trail day', did: GROUP, rkey: 'e1', cid: 'cid-e1' })
		]);
		expect(events?.[0]).not.toHaveProperty('media');
		expect(JSON.stringify(events)).not.toContain('bafyimage');
	});

	it('is nothing, with no read made, for a sign-in without the calendar grant', async () => {
		expect(await readMembersOnlyEvents(caller('atproto'), GROUP)).toBeNull();
		expect(mocks.list).not.toHaveBeenCalled();
	});

	it('is nothing for someone the host turns away, and throws on any other failure', async () => {
		mocks.list.mockRejectedValueOnce(new SpaceAccessDenied(CALENDAR, '403 UserNotAuthorized'));
		expect(await readMembersOnlyEvents(caller(), GROUP)).toBeNull();
		mocks.list.mockRejectedValueOnce(new Error('host down'));
		await expect(readMembersOnlyEvents(caller(), GROUP)).rejects.toThrow();
	});
});

describe('readMembersOnlyEvent', () => {
	it('reads one event by its key, without its image', async () => {
		mocks.get.mockResolvedValue(record('e1', TRAIL));
		const event = await readMembersOnlyEvent(caller(), GROUP, 'e1');
		expect(mocks.get).toHaveBeenCalledWith({ ...EVENTS, rkey: 'e1' });
		expect(event).toMatchObject({ name: 'Trail day', cid: 'cid-e1' });
		expect(event).not.toHaveProperty('media');
	});

	it('answers an absent event and a caller kept out alike', async () => {
		mocks.get.mockResolvedValueOnce(null);
		const absent = await readMembersOnlyEvent(caller(), GROUP, 'e1');
		mocks.get.mockRejectedValueOnce(new SpaceAccessDenied(CALENDAR, '403 UserNotAuthorized'));
		const keptOut = await readMembersOnlyEvent(caller(), GROUP, 'e1');
		expect(absent).toBeNull();
		expect(keptOut).toBe(absent);
	});
});

describe('upcoming', () => {
	it('keeps the events not over yet, soonest first', () => {
		const now = Date.parse('2026-11-01T00:00:00.000Z');
		const at = (rkey: string, startsAt: string, endsAt?: string) =>
			({ rkey, startsAt, endsAt, did: GROUP, uri: rkey, name: rkey }) as never;
		const events = [
			at('later', '2026-12-01T00:00:00.000Z'),
			at('past', '2026-10-01T00:00:00.000Z'),
			at('running', '2026-10-31T20:00:00.000Z', '2026-11-02T00:00:00.000Z'),
			at('soon', '2026-11-02T00:00:00.000Z')
		];
		expect(upcoming(events, now).map((e) => e.rkey)).toEqual(['running', 'soon', 'later']);
	});
});

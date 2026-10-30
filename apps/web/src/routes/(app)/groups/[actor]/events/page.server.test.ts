import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	groupView: vi.fn(),
	requireGroupWriter: vi.fn(),
	callerSession: vi.fn(),
	readMembersOnlyEvent: vi.fn(),
	readMembersOnlyRsvp: vi.fn(),
	calendarSpaceState: vi.fn(),
	readMembersOnlyEventAsGroup: vi.fn(),
	getEventRecordFromContrail: vi.fn()
}));
vi.mock('#lib/groups/server/context.js', () => ({
	GROUP_NOT_FOUND: 'Group not found',
	groupView: mocks.groupView,
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/groups/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/calendar-read.js', async (original) => ({
	...(await original()),
	readMembersOnlyEvent: mocks.readMembersOnlyEvent
}));
vi.mock('#lib/groups/server/member-rsvp.js', () => ({
	readMembersOnlyRsvp: mocks.readMembersOnlyRsvp
}));
vi.mock('#lib/groups/server/group-events.js', () => ({
	calendarSpaceState: mocks.calendarSpaceState,
	readMembersOnlyEventAsGroup: mocks.readMembersOnlyEventAsGroup
}));
vi.mock('#lib/contrail/index.js', () => ({ getServerClient: () => ({}) }));
vi.mock('#lib/contrail.js', () => ({
	getEventRecordFromContrail: mocks.getEventRecordFromContrail,
	flattenEventRecord: (record: { value: object; did: string; rkey: string }) => ({
		...record.value,
		did: record.did,
		rkey: record.rkey
	})
}));

import { load as eventPage } from './[rkey]/+page.server';
import { load as editPage } from './[rkey]/edit/+page.server';
import { load as newPage } from './new/+page.server';

const GROUP = 'did:plc:group';
const CALENDAR = `at://${GROUP}/space/rsvp.atmo.group.calendar/self`;
const writer = { did: GROUP, handle: vi.fn() };
const caller = { did: 'did:plc:alice', scope: 'x', handle: vi.fn() };
const view = (over: object = {}) => ({
	did: GROUP,
	handle: 'knit.example',
	name: 'Knitters',
	member: true,
	linked: null,
	...over
});
const TRAIL = { name: 'Trail day', startsAt: '2026-11-07T15:00:00.000Z', cid: 'cid-e1' };
const input = (rkey = 'e1') =>
	({ params: { actor: GROUP, rkey }, locals: { did: caller.did } }) as never;

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.groupView.mockResolvedValue(view());
	mocks.callerSession.mockResolvedValue(caller);
	mocks.requireGroupWriter.mockResolvedValue(writer);
	mocks.readMembersOnlyRsvp.mockResolvedValue(null);
});

describe("a members-only event's page", () => {
	it('shows the event under its space URI, with no share prompt and the member’s own RSVP', async () => {
		mocks.readMembersOnlyEvent.mockResolvedValue(TRAIL);
		mocks.readMembersOnlyRsvp.mockResolvedValue('going');
		const data = (await eventPage(input())) as Record<string, unknown>;
		expect(data).toMatchObject({
			eventData: TRAIL,
			actorDid: GROUP,
			eventUri: `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/e1`,
			shareable: false,
			viewerRsvpStatus: 'going',
			viewerRsvpRkey: 'e1',
			group: { linked: false }
		});
		expect(mocks.readMembersOnlyEvent).toHaveBeenCalledWith(caller, GROUP, 'e1');
	});

	it('is the same 404 for someone the host does not count a member and for an event not there', async () => {
		mocks.groupView.mockResolvedValue(view({ member: false }));
		const keptOut = await eventPage(input()).catch((e) => e);
		expect(mocks.readMembersOnlyEvent).not.toHaveBeenCalled();

		mocks.groupView.mockResolvedValue(view());
		mocks.readMembersOnlyEvent.mockResolvedValue(null);
		const absent = await eventPage(input()).catch((e) => e);
		expect(keptOut).toMatchObject({ status: 404 });
		expect(absent).toEqual(keptOut);
	});

	it('says "try again" when the read fails, never "not found"', async () => {
		mocks.readMembersOnlyEvent.mockRejectedValue(new Error('host down'));
		await expect(eventPage(input())).rejects.toMatchObject({ status: 503 });
	});
});

describe('the new-event page', () => {
	it('offers members-only only when the calendar space is ready', async () => {
		mocks.groupView.mockResolvedValue(view({ linked: { meta: {}, listed: false } }));
		mocks.calendarSpaceState.mockResolvedValue('ready');
		expect(await newPage(input())).toMatchObject({ membersOnlyUnavailable: null });
		expect(mocks.calendarSpaceState).toHaveBeenCalledWith(writer);
		for (const state of ['missing', 'readable', 'unchecked']) {
			mocks.calendarSpaceState.mockResolvedValue(state);
			const data = (await newPage(input())) as { membersOnlyUnavailable: unknown };
			expect(typeof data.membersOnlyUnavailable).toBe('string');
		}
	});

	it('is a 404 for someone who has not linked the group', async () => {
		await expect(newPage(input())).rejects.toMatchObject({ status: 404 });
		expect(mocks.calendarSpaceState).not.toHaveBeenCalled();
	});
});

describe('the edit page', () => {
	beforeEach(() => {
		mocks.groupView.mockResolvedValue(view({ linked: { meta: {}, listed: false } }));
	});

	it('edits a public event the index has as public, reading nothing as the group', async () => {
		mocks.getEventRecordFromContrail.mockResolvedValue({ value: TRAIL, did: GROUP, rkey: 'e1' });
		expect(await editPage(input())).toMatchObject({ placement: 'everyone' });
		expect(mocks.readMembersOnlyEventAsGroup).not.toHaveBeenCalled();
	});

	it('edits a members-only event as stored, whole, from the calendar space', async () => {
		mocks.getEventRecordFromContrail.mockResolvedValue(null);
		const value = { ...TRAIL, additionalData: { kept: true } };
		mocks.readMembersOnlyEventAsGroup.mockResolvedValue({
			uri: `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/e1`,
			cid: 'cid-e1',
			collection: 'community.lexicon.calendar.event',
			rkey: 'e1',
			value
		});
		expect(await editPage(input())).toMatchObject({
			placement: 'members',
			eventData: { ...value, did: GROUP, rkey: 'e1', cid: 'cid-e1' }
		});
		expect(mocks.readMembersOnlyEventAsGroup).toHaveBeenCalledWith(writer, 'e1');
	});

	it('is a 404 for an event in neither, and "try again" when the space read fails', async () => {
		mocks.getEventRecordFromContrail.mockResolvedValue(null);
		mocks.readMembersOnlyEventAsGroup.mockResolvedValue(null);
		await expect(editPage(input())).rejects.toMatchObject({ status: 404 });
		mocks.readMembersOnlyEventAsGroup.mockRejectedValue(new Error('PDS down'));
		await expect(editPage(input())).rejects.toMatchObject({ status: 503 });
	});
});

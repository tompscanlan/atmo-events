import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
import {
	CALENDAR,
	calendarHosts,
	event,
	fakeCalendar,
	GROUP,
	READY_POLICY
} from './__fixtures__/group-calendar';

const mocks = vi.hoisted(() => ({ networkFetch: vi.fn<typeof fetch>() }));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));

import {
	deleteMembersOnlyRsvp,
	putMembersOnlyRsvp,
	readMembersOnlyEventPage,
	RsvpRefused
} from './member-rsvp';

const BOB = 'did:plc:bob';
const EVENT_URI = `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/r1`;
let calendar: ReturnType<typeof fakeCalendar>;
const bob = (scope = `atproto ${GUEST_SCOPE}`) => ({
	did: BOB,
	scope,
	handle: calendar.personHandle(BOB)
});
const writes = () =>
	calendar.state.sent.filter(([, nsid]) => nsid !== 'com.atproto.space.getDelegationToken');

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
	calendar = fakeCalendar();
	calendar.state.policy = READY_POLICY;
	calendar.state.events.set('r1', event('Supper'));
	calendar.state.readers.add(BOB);
	mocks.networkFetch.mockImplementation(calendar.fetch);
});

async function shownCid(): Promise<string> {
	const page = await readMembersOnlyEventPage(bob(), GROUP, 'r1', calendarHosts);
	return page!.event.cid!;
}

describe("a member's RSVP to a members-only event", () => {
	it('goes into their own repo in the calendar space, naming the event as they saw it', async () => {
		const cid = await shownCid();
		await putMembersOnlyRsvp(bob(), GROUP, { rkey: 'r1', status: 'going', cid }, calendarHosts);
		expect(writes()).toEqual([
			[
				BOB,
				'com.atproto.space.putRecord',
				{
					space: CALENDAR,
					repo: BOB,
					collection: 'community.lexicon.calendar.rsvp',
					rkey: 'r1',
					record: {
						$type: 'community.lexicon.calendar.rsvp',
						status: 'community.lexicon.calendar.rsvp#going',
						subject: { uri: EVENT_URI, cid },
						createdAt: expect.any(String)
					}
				}
			]
		]);
		const page = await readMembersOnlyEventPage(bob(), GROUP, 'r1', calendarHosts);
		expect(page?.viewerStatus).toBe('going');
		await deleteMembersOnlyRsvp(bob(), GROUP, 'r1');
		expect(calendar.state.rsvps.size).toBe(0);
	});

	it('is refused, unsent, without the guest grant, for an event changed since, or one gone', async () => {
		const cid = await shownCid();
		const refused = (caller: ReturnType<typeof bob>, rkey: string, seen: string | null) =>
			putMembersOnlyRsvp(caller, GROUP, { rkey, status: 'going', cid: seen }, calendarHosts).catch(
				(e: RsvpRefused) => e.reason
			);
		expect(await refused(bob('atproto'), 'r1', cid)).toBe('no-grant');
		expect(await refused(bob(), 'r1', 'older')).toBe('changed');
		expect(await refused(bob(), 'gone', cid)).toBe('no-event');
		calendar.state.readers.clear();
		expect(await refused(bob(), 'r1', cid)).toBe('no-event');
		expect(writes()).toEqual([]);
	});

	it('cannot be taken back without the guest grant', async () => {
		await expect(deleteMembersOnlyRsvp(bob('atproto'), GROUP, 'r1')).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(writes()).toEqual([]);
	});
});

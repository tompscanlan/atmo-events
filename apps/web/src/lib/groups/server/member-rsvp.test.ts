import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
import { memoryKV } from './__fixtures__/kv';
import {
	CALENDAR,
	calendarAt,
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
	Object.assign(env, { OAUTH_SESSIONS: memoryKV() });
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
		expect(page?.privacy).toBe('private');
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

	it("shows the event's calendar as no longer private once anyone may read it", async () => {
		calendar.state.policy = { ...READY_POLICY, publicRead: true };
		const page = await readMembersOnlyEventPage(bob(), GROUP, 'r1', calendarHosts);
		expect(page?.event).toMatchObject({ name: 'Supper' });
		expect(page?.privacy).toBe('public');
	});

	it('cannot be taken back without the guest grant', async () => {
		await expect(deleteMembersOnlyRsvp(bob('atproto'), GROUP, 'r1')).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(writes()).toEqual([]);
	});
});

describe('an RSVP in a calendar another app made, which the group uses', () => {
	const WIKI = calendarAt('3lwikicalendar');

	it('goes into that space, naming the event there, and is read and taken back from there', async () => {
		const wiki = calendar.anotherAppsCalendar('3lwikicalendar', READY_POLICY);
		wiki.events.set('r2', event('Wiki supper'));
		await env.OAUTH_SESSIONS.put(`group:calendar:${GROUP}`, WIKI);
		const page = await readMembersOnlyEventPage(bob(), GROUP, 'r2', calendarHosts);
		expect(page?.event).toMatchObject({
			name: 'Wiki supper',
			uri: `${WIKI}/${GROUP}/community.lexicon.calendar.event/r2`
		});
		// The group's own `self` calendar beside it is not read.
		expect(await readMembersOnlyEventPage(bob(), GROUP, 'r1', calendarHosts)).toBeNull();

		await putMembersOnlyRsvp(
			bob(),
			GROUP,
			{ rkey: 'r2', status: 'going', cid: page!.event.cid! },
			calendarHosts
		);
		expect(writes()).toEqual([
			[
				BOB,
				'com.atproto.space.putRecord',
				expect.objectContaining({
					space: WIKI,
					record: expect.objectContaining({
						subject: {
							uri: `${WIKI}/${GROUP}/community.lexicon.calendar.event/r2`,
							cid: page!.event.cid
						}
					})
				})
			]
		]);
		expect((await readMembersOnlyEventPage(bob(), GROUP, 'r2', calendarHosts))?.viewerStatus).toBe(
			'going'
		);
		await deleteMembersOnlyRsvp(bob(), GROUP, 'r2');
		expect(writes().at(-1)).toEqual([
			BOB,
			'com.atproto.space.deleteRecord',
			{ space: WIKI, repo: BOB, collection: 'community.lexicon.calendar.rsvp', rkey: 'r2' }
		]);
	});
});

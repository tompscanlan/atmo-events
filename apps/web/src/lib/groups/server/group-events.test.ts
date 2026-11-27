import { beforeEach, describe, expect, it, vi } from 'vitest';
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
	CALENDAR_POLICY,
	calendarSpaceState,
	deleteMembersOnlyEvent,
	GroupEventRefused,
	putMembersOnlyEvent,
	readCalendarSpace,
	readMembersOnlyEventAsGroup,
	refuseMembersOnlyKey,
	turnOnMembersOnly
} from './group-events';

let calendar: ReturnType<typeof fakeCalendar>;
const writer = () => ({ did: GROUP, handle: calendar.groupHandle });
const nsids = () => calendar.state.sent.map(([, nsid]) => nsid);

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	calendar = fakeCalendar();
	mocks.networkFetch.mockImplementation(calendar.fetch);
});

describe('turning members-only events on', () => {
	it("makes the group's one calendar space, private, with the policy the host needs", async () => {
		await turnOnMembersOnly(writer());
		expect(calendar.state.sent).toEqual([
			[
				'group',
				'com.atproto.space.createSpace',
				{
					spaceType: 'community.lexicon.calendar.collection',
					skey: 'self',
					policy: CALENDAR_POLICY
				}
			]
		]);
		expect(CALENDAR_POLICY).toEqual({
			$type: 'org.atgrp.policy',
			publicRead: false,
			grants: [
				{
					role: 'admin',
					permissions: [
						'space:community.lexicon.calendar.collection?collection=community.lexicon.calendar.event'
					]
				},
				{ role: 'member', read: true }
			]
		});
		// No one is put in its writer set, so no member's RSVP reaches another member.
		expect(CALENDAR_POLICY.grants.some((grant) => 'write' in grant)).toBe(false);
		expect(await calendarSpaceState(writer())).toBe('ready');
	});

	it('takes a space already there as done, and sends nothing that would change its policy', async () => {
		calendar.state.policy = READY_POLICY;
		await expect(turnOnMembersOnly(writer())).resolves.toBeUndefined();
		expect(nsids()).toEqual(['com.atproto.space.createSpace']);
	});

	it('throws any other refusal', async () => {
		calendar.state.refuse.set(
			'com.atproto.space.createSpace',
			Response.json({ error: 'NotAuthorized' }, { status: 403 })
		);
		await expect(turnOnMembersOnly(writer())).rejects.toMatchObject({ error: 'NotAuthorized' });
	});
});

describe("the calendar space's state", () => {
	it.each([
		['missing', null],
		['ready', READY_POLICY],
		['readable', { ...READY_POLICY, publicRead: true }],
		['readable', { $type: 'com.atproto.memberspace.policy' }],
		['unusable', { ...READY_POLICY, grants: [{ role: 'member', read: true }] }],
		['unusable', { ...READY_POLICY, grants: [READY_POLICY.grants[0]] }],
		[
			'unusable',
			{
				...READY_POLICY,
				grants: [
					{
						role: 'admin',
						permissions: ['space:community.lexicon.calendar.collection?collection=x']
					},
					{ role: 'member', read: true }
				]
			}
		]
	])('is %s', async (expected, policy) => {
		calendar.state.policy = policy;
		expect(await calendarSpaceState(writer())).toBe(expected);
	});

	it('names the roles its policy lets post events as the group', async () => {
		calendar.state.policy = {
			...READY_POLICY,
			grants: [
				...READY_POLICY.grants,
				{
					role: 'organizer',
					permissions: [
						'space:community.lexicon.calendar.collection?collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete'
					]
				},
				{
					role: 'helper',
					permissions: [
						'space:community.lexicon.calendar.collection?collection=community.lexicon.calendar.event&action=read'
					]
				}
			]
		};
		expect(await readCalendarSpace(writer())).toEqual({
			state: 'ready',
			posters: ['admin', 'organizer']
		});
	});

	it('is unchecked in an outage, and throws a refused link, as a write would', async () => {
		calendar.state.refuse.set('com.atproto.space.getSpace', new Response('', { status: 502 }));
		expect(await calendarSpaceState(writer())).toBe('unchecked');
		calendar.state.refuse.set(
			'com.atproto.space.getSpace',
			Response.json({ error: 'ScopeMissing' }, { status: 403 })
		);
		await expect(calendarSpaceState(writer())).rejects.toMatchObject({ error: 'ScopeMissing' });
	});
});

describe('a members-only event', () => {
	beforeEach(() => {
		calendar.state.policy = READY_POLICY;
	});

	it('goes into the calendar space as the group, never its public repo', async () => {
		const saved = await putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') });
		expect(saved).toEqual({
			uri: `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/r1`,
			cid: 'cid'
		});
		expect(calendar.state.publicRepo.size).toBe(0);
		expect(nsids()).not.toContain('com.atproto.repo.putRecord');
		expect(calendar.state.sent.at(-1)).toEqual([
			'group',
			'com.atproto.space.putRecord',
			{
				repo: GROUP,
				space: CALENDAR,
				collection: 'community.lexicon.calendar.event',
				rkey: 'r1',
				record: event('Supper')
			}
		]);
	});

	it.each([
		['missing', null, "Members-only events aren't turned on"],
		['readable', { ...READY_POLICY, publicRead: true }, 'can be read by more than its members'],
		[
			'unusable',
			{ ...READY_POLICY, grants: [{ role: 'member', read: true }] },
			"wasn't set up for atmo"
		]
	])('is refused, unsent, when the space is %s', async (_, policy, words) => {
		calendar.state.policy = policy;
		const put = putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') });
		await expect(put).rejects.toThrow(GroupEventRefused);
		await expect(put).rejects.toThrow(words);
		expect(nsids()).not.toContain('com.atproto.space.putRecord');
	});

	it('is refused when it is no event, or carries an image, which would be public', async () => {
		const refusedFor = (record: Record<string, unknown>) =>
			putMembersOnlyEvent(writer(), { rkey: 'r1', record }).catch(
				(e: GroupEventRefused) => e.reason
			);
		expect(await refusedFor({ name: 'No start or date' })).toBe('not-an-event');
		const image = { image: { $type: 'blob', ref: { $link: 'b' }, mimeType: 'image/png', size: 1 } };
		expect(await refusedFor({ ...event('Supper'), media: [image] })).toBe('has-image');
		expect(calendar.state.events.size).toBe(0);
	});

	it('does not copy a public event of the same key into the space', async () => {
		calendar.state.publicRepo.set('r1', event('Open day'));
		await expect(
			putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') })
		).rejects.toMatchObject({ reason: 'moved' });
		expect(calendar.state.events.size).toBe(0);
	});

	it('is refused under the key self, which private events read as their own', async () => {
		await expect(
			putMembersOnlyEvent(writer(), { rkey: 'self', record: event('Supper') })
		).rejects.toMatchObject({ reason: 'reserved-key' });
		expect(calendar.state.sent).toEqual([]);
	});

	it('is deleted from the space', async () => {
		calendar.state.events.set('r1', event('Supper'));
		await deleteMembersOnlyEvent(writer(), 'r1');
		expect(calendar.state.events.size).toBe(0);
		expect(nsids()).toEqual(['com.atproto.space.deleteRecord']);
	});

	it("is read as stored, as the group, with the group's own credential", async () => {
		calendar.state.events.set('r1', { ...event('Supper'), poster: 'kept' });
		calendar.state.readers.add('group');
		const found = await readMembersOnlyEventAsGroup(writer(), 'r1', calendarHosts);
		expect(found?.value).toMatchObject({ name: 'Supper', poster: 'kept' });
		expect(nsids()).toEqual(['com.atproto.space.getDelegationToken']);
		calendar.state.readers.clear();
		expect(await readMembersOnlyEventAsGroup(writer(), 'r1', calendarHosts)).toBeNull();
	});
});

describe('a public save over a members-only key', () => {
	beforeEach(() => {
		calendar.state.policy = READY_POLICY;
		calendar.state.readers.add('group');
	});

	it('is refused when the calendar space has an event under that key', async () => {
		calendar.state.events.set('r1', event('Supper'));
		await expect(refuseMembersOnlyKey(writer(), 'r1', calendarHosts)).rejects.toMatchObject({
			reason: 'members-only'
		});
	});

	it('goes ahead under a key the space does not have, with no space, or a link that may not read it', async () => {
		calendar.state.events.set('r1', event('Supper'));
		await expect(refuseMembersOnlyKey(writer(), 'r2', calendarHosts)).resolves.toBeUndefined();
		calendar.state.readers.clear();
		await expect(refuseMembersOnlyKey(writer(), 'r1', calendarHosts)).resolves.toBeUndefined();
		calendar.state.policy = null;
		await expect(refuseMembersOnlyKey(writer(), 'r1', calendarHosts)).resolves.toBeUndefined();
	});

	it('is refused when the space could not be checked, and throws a refused link', async () => {
		calendar.state.refuse.set(
			'com.atproto.space.getDelegationToken',
			new Response('', { status: 502 })
		);
		await expect(refuseMembersOnlyKey(writer(), 'r1', calendarHosts)).rejects.toMatchObject({
			reason: 'key-unchecked'
		});
		calendar.state.refuse.set(
			'com.atproto.space.getDelegationToken',
			Response.json({ error: 'invalid_token' }, { status: 401 })
		);
		await expect(refuseMembersOnlyKey(writer(), 'r1', calendarHosts)).rejects.not.toBeInstanceOf(
			GroupEventRefused
		);
	});
});

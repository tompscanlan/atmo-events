import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
	CALENDAR,
	calendarAt,
	calendarHosts,
	event,
	fakeCalendar,
	GROUP,
	MEMBERS,
	READY_POLICY
} from './__fixtures__/group-calendar';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';

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
let kv: MemoryKV;
const writer = () => ({ did: GROUP, handle: calendar.groupHandle });
const nsids = () => calendar.state.sent.map(([, nsid]) => nsid);
const made = () => calendar.state.sent.filter(([, nsid]) => nsid.endsWith('createSpace'));
const policyChanges = () => calendar.state.sent.filter(([, nsid]) => nsid.endsWith('updateSpace'));
const chosen = () => kv.get(`group:calendar:${GROUP}`, 'text');

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	calendar = fakeCalendar();
	mocks.networkFetch.mockImplementation(calendar.fetch);
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv });
});

describe('turning members-only events on', () => {
	it("makes the group's one calendar space, private, with the policy the host needs", async () => {
		await turnOnMembersOnly(writer(), [], calendarHosts);
		expect(made()).toEqual([
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
		// It looked first, at the group's index and at `self`.
		expect(nsids().slice(0, 2)).toEqual([
			'com.atproto.space.getDelegationToken',
			'com.atproto.space.getSpace'
		]);
		expect(await chosen()).toBe(CALENDAR);
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
		await expect(turnOnMembersOnly(writer(), [], calendarHosts)).resolves.toMatchObject({
			state: 'ready',
			space: CALENDAR
		});
		expect(made()).toEqual([]);
		expect(policyChanges()).toEqual([]);
	});

	it('throws any other refusal', async () => {
		calendar.state.refuse.set(
			'com.atproto.space.createSpace',
			Response.json({ error: 'NotAuthorized' }, { status: 403 })
		);
		await expect(turnOnMembersOnly(writer(), [], calendarHosts)).rejects.toMatchObject({
			error: 'NotAuthorized'
		});
	});
});

// Another app, a wiki that also keeps events, made the group a calendar first, under a key of its
// own and a policy of its own.
const WIKI = calendarAt('3lwikicalendar');
const WIKI_POLICY = {
	$type: 'org.atgrp.policy',
	publicRead: false,
	grants: [
		{
			role: 'admin',
			permissions: [
				'space:community.lexicon.calendar.collection?collection=community.lexicon.calendar.event&collection=com.example.wiki.page'
			]
		},
		{ role: 'member', read: true }
	]
};

describe('turning members-only events on where the group has a calendar already', () => {
	it('uses the one another app made, makes none, and posts there from then on', async () => {
		calendar.anotherAppsCalendar('3lwikicalendar', WIKI_POLICY);
		expect(await turnOnMembersOnly(writer(), [], calendarHosts)).toEqual({
			state: 'ready',
			posters: ['admin'],
			space: WIKI
		});
		expect(made()).toEqual([]);
		expect(policyChanges()).toEqual([]);
		expect(await chosen()).toBe(WIKI);
		// The index was read as the group, in its members space.
		expect(calendar.state.sent[0]).toEqual([
			'group',
			'com.atproto.space.getDelegationToken',
			{ space: MEMBERS }
		]);

		calendar.state.sent.length = 0;
		const saved = await putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') });
		expect(saved.uri).toBe(`${WIKI}/${GROUP}/community.lexicon.calendar.event/r1`);
		expect(calendar.state.spaces.get(WIKI)?.events.get('r1')).toMatchObject({ name: 'Supper' });
		expect(calendar.state.events.size).toBe(0);
		expect(calendar.state.sent.filter(([, nsid]) => nsid === 'com.atproto.space.getSpace')).toEqual(
			[['group', 'com.atproto.space.getSpace', { space: WIKI }]]
		);

		await deleteMembersOnlyEvent(writer(), 'r1');
		expect(calendar.state.spaces.get(WIKI)?.events.size).toBe(0);
	});

	it('makes its own when the group has none its members could use, nor any at all', async () => {
		calendar.anotherAppsCalendar('3lpublic', { ...WIKI_POLICY, publicRead: true });
		calendar.anotherAppsCalendar('3lboard', {
			...WIKI_POLICY,
			grants: [WIKI_POLICY.grants[0]]
		});
		await turnOnMembersOnly(writer(), [], calendarHosts);
		expect(made()).toHaveLength(1);
		expect(made()[0][2]).toMatchObject({ skey: 'self', policy: CALENDAR_POLICY });
		expect(await chosen()).toBe(CALENDAR);
		// Neither of the others was changed.
		expect(policyChanges()).toEqual([]);
	});

	it.each([
		['no role at all', { ...WIKI_POLICY, grants: [{ role: 'member', read: true }] }],
		[
			'only reading',
			{
				...WIKI_POLICY,
				grants: [
					{
						role: 'admin',
						permissions: [
							'space:community.lexicon.calendar.collection?collection=community.lexicon.calendar.event&action=read'
						]
					},
					{ role: 'member', read: true }
				]
			}
		],
		[
			'another key only',
			{
				...WIKI_POLICY,
				grants: [
					{
						role: 'admin',
						permissions: [
							'space:community.lexicon.calendar.collection?skey=self&collection=community.lexicon.calendar.event'
						]
					},
					{ role: 'member', read: true }
				]
			}
		]
	])(
		'makes no second calendar beside one whose policy lets %s post, and says so',
		async (_, policy) => {
			calendar.anotherAppsCalendar('3lwikicalendar', policy);
			const on = turnOnMembersOnly(writer(), [], calendarHosts);
			await expect(on).rejects.toMatchObject({ reason: 'calendar-space-not-granted' });
			await expect(on).rejects.toThrow('atmo made no second one. An admin can allow it');
			expect(made()).toEqual([]);
			expect(policyChanges()).toEqual([]);
			// Remembered, so the page says why, and posting is refused there.
			expect(await chosen()).toBe(WIKI);
			expect(await readCalendarSpace(writer())).toEqual({
				state: 'unusable',
				posters: [],
				space: WIKI
			});
			await expect(
				putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') })
			).rejects.toMatchObject({ reason: 'calendar-space-unusable' });
		}
	);

	it('takes `self` first among several, else the oldest listed', async () => {
		calendar.anotherAppsCalendar('3lnewer', WIKI_POLICY, '2026-10-02T00:00:00.000Z');
		calendar.anotherAppsCalendar('3lolder', WIKI_POLICY, '2026-09-01T00:00:00.000Z');
		calendar.anotherAppsCalendar('3lundated', WIKI_POLICY, '');
		expect((await turnOnMembersOnly(writer(), [], calendarHosts)).space).toBe(
			calendarAt('3lolder')
		);
		calendar.anotherAppsCalendar('self', WIKI_POLICY, '2026-11-01T00:00:00.000Z');
		expect((await turnOnMembersOnly(writer(), [], calendarHosts)).space).toBe(CALENDAR);
		expect(made()).toEqual([]);
	});

	it('takes a calendar some role may post to over an older one where none may', async () => {
		calendar.anotherAppsCalendar(
			'3lungranted',
			{
				...WIKI_POLICY,
				grants: [{ role: 'member', read: true }]
			},
			'2026-01-01T00:00:00.000Z'
		);
		calendar.anotherAppsCalendar('3lwikicalendar', WIKI_POLICY, '2026-10-01T00:00:00.000Z');
		expect((await turnOnMembersOnly(writer(), [], calendarHosts)).space).toBe(WIKI);
	});

	it("reads the index with the person's own sign-in when the link may not", async () => {
		const person = { handle: calendar.personHandle('did:plc:admin') };
		calendar.state.indexReaders = new Set(['did:plc:admin']);
		calendar.anotherAppsCalendar('3lwikicalendar', WIKI_POLICY);
		expect((await turnOnMembersOnly(writer(), [person], calendarHosts)).space).toBe(WIKI);
		expect(made()).toEqual([]);
	});

	it('makes nothing when no one may read the index, or a calendar could not be checked', async () => {
		calendar.state.indexReaders.clear();
		await expect(turnOnMembersOnly(writer(), [], calendarHosts)).rejects.toMatchObject({
			reason: 'calendar-index-unread'
		});
		calendar.state.indexReaders.add('group');
		calendar.anotherAppsCalendar('3lwikicalendar', WIKI_POLICY);
		calendar.state.refuse.set('com.atproto.space.getSpace', new Response('', { status: 502 }));
		await expect(turnOnMembersOnly(writer(), [], calendarHosts)).rejects.toMatchObject({
			reason: 'calendar-space-unchecked'
		});
		expect(made()).toEqual([]);
		expect(await chosen()).toBeNull();
	});

	it('notices a chosen calendar that is gone, and goes back to `self` without making one', async () => {
		calendar.anotherAppsCalendar('3lwikicalendar', WIKI_POLICY);
		await turnOnMembersOnly(writer(), [], calendarHosts);
		calendar.state.spaces.delete(WIKI);
		calendar.state.sent.length = 0;
		expect(await readCalendarSpace(writer())).toEqual({
			state: 'missing',
			posters: [],
			space: CALENDAR
		});
		expect(await chosen()).toBeNull();
		expect(made()).toEqual([]);
		await expect(
			putMembersOnlyEvent(writer(), { rkey: 'r1', record: event('Supper') })
		).rejects.toMatchObject({ reason: 'no-calendar-space' });
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
			posters: ['admin', 'organizer'],
			space: CALENDAR
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

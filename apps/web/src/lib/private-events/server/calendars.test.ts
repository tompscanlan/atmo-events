import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	CALENDAR_COLLECTION,
	calendarEvent,
	EVENT_COLLECTION,
	eventUri,
	privateEventSpace,
	RSVP_COLLECTION
} from '../ids';
import { CALENDAR_SCOPE, GUEST_SCOPE, HOST_SCOPE } from '../scopes';
import type { CallerSession } from './caller';

const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
const credentialSpaceReader = vi.fn<(...args: unknown[]) => typeof reader>(() => reader);
vi.mock('#lib/spaces/server/space-read.js', () => ({
	credentialSpaceReader: (...args: unknown[]) => credentialSpaceReader(...args)
}));
const actorToDid = vi.fn();
vi.mock('#lib/actor.js', () => ({ actorToDid: (actor: string) => actorToDid(actor) }));
vi.mock('./people', () => ({
	verifiedHandle: async (did: string) => `${did.split(':').at(-1)}.example.com`
}));

const {
	addCalendarMember,
	createCalendar,
	deleteCalendar,
	myPrivateEventsAndCalendars,
	ownCalendars,
	readCalendarEventPage,
	readCalendarPage,
	removeCalendarMember,
	renameCalendar
} = await import('./calendars');
const { cancelPrivateEvent, putPrivateRsvp, savePrivateEvent } = await import('./events');

const OWNER = 'did:plc:ownerownerownerownerowner';
const MEMBER = 'did:plc:membermembermembermember';
const OTHER = 'did:plc:otherotherotherotherothe';
const KEY = 'cal-3lcalcalcalcal';
const SPACE = privateEventSpace(OWNER, KEY);
const OWNER_SCOPE = `${HOST_SCOPE} ${CALENDAR_SCOPE} ${GUEST_SCOPE}`;
const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const event = (name: string, startsAt: string, more: Record<string, unknown> = {}) => ({
	$type: EVENT_COLLECTION,
	name,
	createdAt: '2026-11-01T00:00:00.000Z',
	startsAt,
	...more
});

type Sent = { pathname: string; body?: Record<string, unknown>; query: URLSearchParams };

/** A session whose PDS answers `answers[nsid]`, or an empty 200. */
function caller(
	did: string,
	scope: string,
	answers: Record<string, (sent: Sent) => Response> = {}
): CallerSession & { sent: Sent[]; nsids(): string[] } {
	const sent: Sent[] = [];
	return {
		did,
		scope,
		sent,
		nsids: () => sent.map((s) => s.pathname.replace('/xrpc/', '')),
		handle: async (pathname, init) => {
			const url = new URL(pathname, 'https://pds.example.com');
			const one: Sent = {
				pathname: url.pathname,
				query: url.searchParams,
				...(init.body ? { body: JSON.parse(String(init.body)) } : {})
			};
			sent.push(one);
			const answer = answers[url.pathname.replace('/xrpc/', '')];
			return answer ? answer(one) : Response.json({});
		}
	};
}

const privateSpace = () =>
	Response.json({ policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true } });
const refuse = (status: number, error: string) => () => Response.json({ error }, { status });
const owner = (answers: Record<string, (sent: Sent) => Response> = {}) =>
	caller(OWNER, OWNER_SCOPE, { 'com.atproto.space.getSpace': privateSpace, ...answers });

/** What the calendar's space holds, by repo: the owner's name record and events, and anything else
 *  anyone else wrote there. */
function theCalendarHolds(holds: {
	name?: unknown;
	events?: Record<string, Record<string, unknown>>;
	answers?: Record<string, Record<string, unknown>>;
	capped?: boolean;
	space?: string;
}) {
	const space = holds.space ?? SPACE;
	const record = (repo: string, collection: string, rkey: string, value: unknown) => ({
		uri: `${space}/${repo}/${collection}/${rkey}`,
		cid: `cid-of-${repo}-${rkey}`,
		rkey,
		value
	});
	reader.get.mockImplementation(
		async (q: { space: string; repo: string; collection: string; rkey: string }) => {
			if (q.space !== space) return null;
			if (q.collection === CALENDAR_COLLECTION && q.repo === OWNER) {
				return holds.name === undefined ? null : record(OWNER, q.collection, 'self', holds.name);
			}
			if (q.collection === EVENT_COLLECTION && q.repo === OWNER) {
				const value = holds.events?.[q.rkey];
				return value ? record(OWNER, q.collection, q.rkey, value) : null;
			}
			if (q.collection === RSVP_COLLECTION) {
				const value = holds.answers?.[q.repo];
				return value ? record(q.repo, q.collection, q.rkey, value) : null;
			}
			return null;
		}
	);
	reader.list.mockImplementation(async (q: { space: string; repo: string }) => {
		if (q.space !== space || q.repo !== OWNER) return { records: [], capped: false };
		return {
			records: Object.entries(holds.events ?? {}).map(([rkey, value]) =>
				record(OWNER, EVENT_COLLECTION, rkey, value)
			),
			capped: holds.capped ?? false
		};
	});
}

beforeEach(() => {
	reader.get.mockReset();
	reader.list.mockReset();
	reader.writers.mockReset();
	actorToDid.mockReset();
	credentialSpaceReader.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('making a shared calendar', () => {
	it('makes a member-only space under a calendar key, then names it in the owner’s own repo there', async () => {
		const host = owner();
		const { key, actor } = await createCalendar(host, { name: '  Supper club ' });

		expect(key).toMatch(/^cal-[a-z2-7]{13}$/);
		expect(actor).toBe('ownerownerownerownerowner.example.com');
		expect(host.nsids()).toEqual([
			'com.atproto.space.createSpace',
			'com.atproto.space.getSpace',
			'com.atproto.space.putRecord'
		]);
		expect(host.sent[0].body).toMatchObject({
			spaceType: 'rsvp.atmo.dev.space',
			skey: key,
			policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true }
		});
		expect(host.sent[0].body?.policy).not.toHaveProperty('publicRead');
		expect(host.sent[2].body).toMatchObject({
			space: privateEventSpace(OWNER, key),
			repo: OWNER,
			collection: CALENDAR_COLLECTION,
			rkey: 'self',
			record: { $type: CALENDAR_COLLECTION, name: 'Supper club', createdAt: expect.any(String) }
		});
	});

	it('asks for the calendar grant even of someone who hosts events', async () => {
		const host = caller(OWNER, `${HOST_SCOPE} ${GUEST_SCOPE}`);
		await expect(createCalendar(host, { name: 'Supper club' })).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(host.sent).toHaveLength(0);
	});

	it('refuses a guest, and calls nothing', async () => {
		const guest = caller(MEMBER, GUEST_SCOPE);
		await expect(createCalendar(guest, { name: 'Supper club' })).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(guest.sent).toHaveLength(0);
	});

	it.each([
		['empty', ''],
		['blank', '   '],
		['past 64 characters', 'x'.repeat(65)]
	])('refuses a name that is %s, and calls nothing', async (_, name) => {
		const host = owner();
		await expect(createCalendar(host, { name })).rejects.toMatchObject({ reason: 'bad-name' });
		expect(host.sent).toHaveLength(0);
	});

	it('counts a name in characters as a person sees them', async () => {
		const host = owner();
		// Each is a letter and an accent: two code points, one character.
		await createCalendar(host, { name: 'e\u0301'.repeat(64) });
		expect(host.nsids()).toContain('com.atproto.space.putRecord');
	});

	it('names nothing in a space anyone can read', async () => {
		const host = owner({
			'com.atproto.space.getSpace': () =>
				Response.json({ policy: { $type: 'com.atproto.memberspace.policy', publicRead: true } })
		});
		await expect(createCalendar(host, { name: 'Supper club' })).rejects.toMatchObject({
			reason: 'not-private'
		});
		expect(host.nsids()).not.toContain('com.atproto.space.putRecord');
	});

	it('takes the space down again when its name could not be written', async () => {
		const host = owner({
			'com.atproto.space.putRecord': () => Response.json({ error: 'Nope' }, { status: 500 })
		});
		await expect(createCalendar(host, { name: 'Supper club' })).rejects.toMatchObject({
			reason: 'refused'
		});
		const created = host.sent[0].body?.skey as string;
		expect(host.sent.at(-1)).toMatchObject({
			pathname: '/xrpc/com.atproto.space.deleteSpace',
			body: { space: privateEventSpace(OWNER, created) }
		});
	});
});

describe('renaming a shared calendar', () => {
	it('writes the new name over the old, and keeps when it was made', async () => {
		theCalendarHolds({ name: { name: 'Old', createdAt: '2026-01-01T00:00:00.000Z' } });
		const host = owner();
		await renameCalendar(host, { key: KEY, name: 'Supper club' });
		expect(host.nsids()).toEqual(['com.atproto.space.getSpace', 'com.atproto.space.putRecord']);
		expect(host.sent[1].body).toMatchObject({
			space: SPACE,
			repo: OWNER,
			collection: CALENDAR_COLLECTION,
			rkey: 'self',
			record: { name: 'Supper club', createdAt: '2026-01-01T00:00:00.000Z' }
		});
	});

	it('refuses a calendar that is not there, and writes nothing', async () => {
		const host = owner({ 'com.atproto.space.getSpace': refuse(400, 'SpaceNotFound') });
		await expect(renameCalendar(host, { key: KEY, name: 'Supper club' })).rejects.toMatchObject({
			reason: 'no-calendar'
		});
		expect(host.nsids()).not.toContain('com.atproto.space.putRecord');
	});

	it('refuses a key that is not a calendar’s, and calls nothing', async () => {
		const host = owner();
		await expect(
			renameCalendar(host, { key: '3lsingleevent', name: 'Supper club' })
		).rejects.toMatchObject({ reason: 'no-calendar' });
		expect(host.sent).toHaveLength(0);
	});

	it('asks for the calendar grant', async () => {
		const host = caller(OWNER, HOST_SCOPE);
		await expect(renameCalendar(host, { key: KEY, name: 'Supper club' })).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(host.sent).toHaveLength(0);
	});
});

describe('deleting a shared calendar', () => {
	it('deletes the caller’s own calendar space, which ends everyone’s access at once', async () => {
		const host = owner();
		await deleteCalendar(host, KEY);
		expect(host.sent).toMatchObject([
			{ pathname: '/xrpc/com.atproto.space.deleteSpace', body: { space: SPACE } }
		]);
	});

	it('refuses a key that is not a calendar’s, so it never deletes a single event', async () => {
		const host = owner();
		await expect(deleteCalendar(host, '3lsingleevent')).rejects.toMatchObject({
			reason: 'no-calendar'
		});
		expect(host.sent).toHaveLength(0);
	});

	it('refuses a guest', async () => {
		const guest = caller(MEMBER, GUEST_SCOPE);
		await expect(deleteCalendar(guest, KEY)).rejects.toMatchObject({ reason: 'no-grant' });
		expect(guest.sent).toHaveLength(0);
	});
});

describe('the people on a calendar', () => {
	it('puts the person a handle names on the list, able to read and answer', async () => {
		actorToDid.mockResolvedValue(MEMBER);
		const host = owner();
		const added = await addCalendarMember(host, { key: KEY, handleOrDid: '@member.example.com ' });
		expect(actorToDid).toHaveBeenCalledWith('member.example.com');
		expect(added).toEqual({ did: MEMBER, handle: 'membermembermembermember.example.com' });
		expect(host.sent).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.memberspace.putMembers',
				body: { space: SPACE, members: [{ did: MEMBER, read: true, write: true }] }
			}
		]);
	});

	it('refuses a handle that names no one', async () => {
		actorToDid.mockRejectedValue(new Error('not found'));
		const host = owner();
		await expect(
			addCalendarMember(host, { key: KEY, handleOrDid: 'no.one' })
		).rejects.toMatchObject({ reason: 'no-such-person' });
		expect(host.sent).toHaveLength(0);
	});

	it('refuses the owner themself', async () => {
		actorToDid.mockResolvedValue(OWNER);
		await expect(
			addCalendarMember(owner(), { key: KEY, handleOrDid: 'owner.example.com' })
		).rejects.toMatchObject({ reason: 'own-calendar' });
	});

	it('acts only on the caller’s own calendar, whatever a page sends', async () => {
		actorToDid.mockResolvedValue(OTHER);
		const someone = caller(MEMBER, HOST_SCOPE);
		await addCalendarMember(someone, { key: KEY, handleOrDid: 'other.example.com' });
		expect(someone.sent[0].body?.space).toBe(privateEventSpace(MEMBER, KEY));
	});

	it('refuses a member who tries to change the list', async () => {
		const member = caller(MEMBER, GUEST_SCOPE);
		await expect(
			addCalendarMember(member, { key: KEY, handleOrDid: 'other.example.com' })
		).rejects.toMatchObject({ reason: 'no-grant' });
		await expect(removeCalendarMember(member, { key: KEY, did: OTHER })).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(member.sent).toHaveLength(0);
	});

	it('takes someone off the caller’s own calendar', async () => {
		const host = owner();
		await removeCalendarMember(host, { key: KEY, did: MEMBER });
		expect(host.sent).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.memberspace.removeMembers',
				body: { space: SPACE, dids: [MEMBER] }
			}
		]);
	});

	it('refuses a key that is not a calendar’s', async () => {
		const host = owner();
		await expect(
			addCalendarMember(host, { key: '3lsingleevent', handleOrDid: 'member.example.com' })
		).rejects.toMatchObject({ reason: 'no-calendar' });
		expect(host.sent).toHaveLength(0);
	});
});

describe('a calendar’s page', () => {
	const EVENTS = {
		'3lpast': event('Last month', '2026-10-01T18:00:00.000Z'),
		'3llater': event('December', '2026-12-01T18:00:00.000Z'),
		'3lsoon': event('Next week', '2026-11-17T18:00:00.000Z'),
		'3lstill': event('Still on', '2026-11-09T18:00:00.000Z', {
			endsAt: '2026-11-11T18:00:00.000Z'
		})
	};
	const listMembers = (dids: string[], cursor?: string) => () =>
		Response.json({ members: dids.map((did) => ({ did })), ...(cursor ? { cursor } : {}) });

	it('shows a member its name and events, upcoming soonest first and past latest first', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS });
		const member = caller(MEMBER, GUEST_SCOPE);
		const page = await readCalendarPage(member, OWNER, KEY, NOW);
		expect(page?.name).toBe('Supper club');
		expect(page?.upcoming.map((e) => e.rkey)).toEqual(['3lstill', '3lsoon', '3llater']);
		expect(page?.past.map((e) => e.rkey)).toEqual(['3lpast']);
		expect(page?.members).toBeNull();
		expect(member.sent).toHaveLength(0);
	});

	it('lists events from the owner’s repo only, and reads no one’s answers', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS });
		await readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(reader.list.mock.calls.map(([q]) => q)).toEqual([
			{ space: SPACE, repo: OWNER, collection: EVENT_COLLECTION }
		]);
		expect(reader.get.mock.calls.map(([q]) => q.collection)).toEqual([CALENDAR_COLLECTION]);
		expect(reader.writers).not.toHaveBeenCalled();
	});

	it('shows the owner the people on it, and only the owner', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const page = await readCalendarPage(
			owner({ 'com.atproto.memberspace.listMembers': listMembers([MEMBER, OTHER]) }),
			OWNER,
			KEY,
			NOW
		);
		expect(page?.members).toEqual([
			{ did: MEMBER, handle: 'membermembermembermember.example.com' },
			{ did: OTHER, handle: 'otherotherotherotherothe.example.com' }
		]);
		expect(page?.membersCapped).toBe(false);
	});

	it('says there may be more people at the page limit', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({ 'com.atproto.memberspace.listMembers': listMembers([MEMBER], 'more') });
		const page = await readCalendarPage(host, OWNER, KEY, NOW);
		expect(host.nsids().filter((n) => n.endsWith('listMembers'))).toHaveLength(10);
		expect(page?.membersCapped).toBe(true);
	});

	it('says there may be more events when the listing stopped at its limit', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS, capped: true });
		const page = await readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page?.eventsCapped).toBe(true);
	});

	it.each([
		['no name', undefined],
		['a name that is not text', { name: 7 }],
		['a name past 64 characters', { name: 'x'.repeat(65) }]
	])('reads a calendar with %s as untitled', async (_, name) => {
		theCalendarHolds({ name, events: {} });
		const page = await readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page).not.toBeNull();
		expect(page?.name).toBeNull();
	});

	it.each([
		['refused', new SpaceAccessDenied(SPACE, '400 SpaceNotFound')],
		['deleted', new SpaceAccessDenied(SPACE, '400 SpaceDeleted')]
	])('reads as nothing there when %s', async (_, denial) => {
		reader.get.mockRejectedValue(denial);
		reader.list.mockRejectedValue(denial);
		expect(await readCalendarPage(caller(OTHER, GUEST_SCOPE), OWNER, KEY, NOW)).toBeNull();
	});

	it('reads a key that is not a calendar’s as nothing there, without asking', async () => {
		expect(
			await readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, '3lsingleevent', NOW)
		).toBeNull();
		expect(credentialSpaceReader).not.toHaveBeenCalled();
	});

	it('does not pass an outage off as nothing there', async () => {
		reader.get.mockResolvedValue(null);
		reader.list.mockRejectedValue(new Error('503'));
		await expect(readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, KEY, NOW)).rejects.toThrow();
	});

	it('leaves out what is not an event', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { '3lbroken': { name: 'No start' }, ...EVENTS }
		});
		const page = await readCalendarPage(caller(MEMBER, GUEST_SCOPE), OWNER, KEY, NOW);
		expect([...page!.upcoming, ...page!.past].map((e) => e.rkey)).not.toContain('3lbroken');
	});
});

describe('an event on a calendar', () => {
	const RKEY = '3levent';
	const ADDRESS = calendarEvent(OWNER, KEY, RKEY);
	const going = (uri = eventUri(ADDRESS)) => ({
		$type: RSVP_COLLECTION,
		status: `${RSVP_COLLECTION}#going`,
		subject: { uri, cid: 'x' }
	});

	it('gives the owner the calendar’s people, each with their answer to this event', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') },
			answers: { [MEMBER]: going() }
		});
		reader.writers.mockResolvedValue([MEMBER]);
		const host = owner({
			'com.atproto.memberspace.listMembers': () =>
				Response.json({ members: [{ did: MEMBER }, { did: OTHER }] })
		});
		const page = await readCalendarEventPage(host, ADDRESS);
		expect(page?.calendar).toEqual({ key: KEY, name: 'Supper club' });
		expect(page?.guests).toMatchObject([
			{ did: MEMBER, answer: 'going' },
			{ did: OTHER, answer: null }
		]);
		expect(host.sent[0].query.get('space')).toBe(SPACE);
	});

	it('is read from the owner’s repo only, so a member’s event record in the space is ignored', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const crafted = reader.get.getMockImplementation()!;
		reader.get.mockImplementation(async (q: { repo: string; collection: string }) =>
			q.repo === MEMBER && q.collection === EVENT_COLLECTION
				? { uri: `${SPACE}/${MEMBER}/${EVENT_COLLECTION}/${RKEY}`, cid: 'c', rkey: RKEY, value: {} }
				: crafted(q)
		);
		const page = await readCalendarEventPage(
			caller(OTHER, GUEST_SCOPE),
			calendarEvent(OWNER, KEY, RKEY)
		);
		expect(page).toBeNull();
		expect(reader.get).toHaveBeenCalledWith(
			expect.objectContaining({ repo: OWNER, collection: EVENT_COLLECTION })
		);
		expect(reader.get).not.toHaveBeenCalledWith(expect.objectContaining({ repo: MEMBER }));
	});

	it('counts only answers that name this event in this calendar', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') },
			answers: { [MEMBER]: going(), [OTHER]: going(eventUri(calendarEvent(OWNER, KEY, 'x'))) }
		});
		reader.writers.mockResolvedValue([MEMBER, OTHER]);
		const page = await readCalendarEventPage(caller(MEMBER, GUEST_SCOPE), ADDRESS);
		expect(page?.attendees.going.map((a) => a.did)).toEqual([MEMBER]);
		expect(page?.viewerStatus).toBe('going');
	});

	it('takes a member’s answer into their own repo in the calendar’s space', async () => {
		theCalendarHolds({ events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') } });
		const member = caller(MEMBER, GUEST_SCOPE);
		await putPrivateRsvp(member, ADDRESS, { status: 'going', cid: `cid-of-${OWNER}-${RKEY}` });
		expect(member.sent).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.space.putRecord',
				body: {
					space: SPACE,
					repo: MEMBER,
					collection: RSVP_COLLECTION,
					rkey: RKEY,
					record: { subject: { uri: eventUri(ADDRESS), cid: `cid-of-${OWNER}-${RKEY}` } }
				}
			}
		]);
	});

	it('refuses an answer to a version the page no longer shows', async () => {
		theCalendarHolds({ events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') } });
		const member = caller(MEMBER, GUEST_SCOPE);
		await expect(
			putPrivateRsvp(member, ADDRESS, { status: 'going', cid: 'old' })
		).rejects.toMatchObject({ reason: 'changed' });
		expect(member.sent).toHaveLength(0);
	});

	it('reads a key that is not a calendar’s as nothing there', async () => {
		const address = { host: OWNER, spaceKey: '3lother', rkey: RKEY };
		expect(await readCalendarEventPage(caller(MEMBER, GUEST_SCOPE), address)).toBeNull();
		expect(credentialSpaceReader).not.toHaveBeenCalled();
	});
});

describe('putting an event on a calendar', () => {
	const RECORD = event('Dinner', '2026-11-20T18:00:00.000Z');

	it('writes it into the calendar’s space under its own key, and makes no new space', async () => {
		const host = owner();
		const saved = await savePrivateEvent(host, { rkey: '3levent', record: RECORD, calendar: KEY });
		expect(saved.uri).toBe(eventUri(calendarEvent(OWNER, KEY, '3levent')));
		expect(host.nsids()).toEqual(['com.atproto.space.getSpace', 'com.atproto.space.putRecord']);
		expect(host.sent[1].body).toMatchObject({
			space: SPACE,
			repo: OWNER,
			collection: EVENT_COLLECTION,
			rkey: '3levent'
		});
	});

	it('refuses a calendar that is not there, rather than make it', async () => {
		const host = owner({ 'com.atproto.space.getSpace': refuse(400, 'SpaceNotFound') });
		await expect(
			savePrivateEvent(host, { rkey: '3levent', record: RECORD, calendar: KEY })
		).rejects.toMatchObject({ reason: 'no-calendar' });
		expect(host.nsids()).toEqual(['com.atproto.space.getSpace']);
	});

	it('puts it on the caller’s own calendar, whatever key a page sends', async () => {
		const someone = caller(MEMBER, HOST_SCOPE, { 'com.atproto.space.getSpace': privateSpace });
		await savePrivateEvent(someone, { rkey: '3levent', record: RECORD, calendar: KEY });
		expect(someone.sent[0].query.get('space')).toBe(privateEventSpace(MEMBER, KEY));
	});

	it('refuses a member who tries to add an event, and calls nothing', async () => {
		const member = caller(MEMBER, GUEST_SCOPE);
		await expect(
			savePrivateEvent(member, { rkey: '3levent', record: RECORD, calendar: KEY })
		).rejects.toMatchObject({ reason: 'no-grant' });
		expect(member.sent).toHaveLength(0);
	});

	it('refuses a single event whose key would read as a calendar’s', async () => {
		const host = owner();
		await expect(savePrivateEvent(host, { rkey: KEY, record: RECORD })).rejects.toMatchObject({
			reason: 'not-an-event'
		});
		expect(host.sent).toHaveLength(0);
	});

	it('never deletes a calendar as if it were an event', async () => {
		const host = owner();
		await expect(cancelPrivateEvent(host, { spaceKey: KEY, rkey: KEY })).rejects.toMatchObject({
			reason: 'no-event'
		});
		expect(host.sent).toHaveLength(0);
	});

	it('takes only the event off the calendar when it is deleted, never the calendar', async () => {
		const host = owner();
		await cancelPrivateEvent(host, { spaceKey: KEY, rkey: '3levent' });
		expect(host.sent).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.space.deleteRecord',
				body: { space: SPACE, repo: OWNER, collection: EVENT_COLLECTION, rkey: '3levent' }
			}
		]);
		expect(host.nsids()).not.toContain('com.atproto.space.deleteSpace');
	});
});

describe('/private with single events and calendars', () => {
	const SINGLE = privateEventSpace(OTHER, '3lsingle');
	const KEPT_OUT = privateEventSpace(OTHER, 'cal-3lkeptout');
	const OWN = privateEventSpace(MEMBER, 'cal-3lown');

	it('mixes single and calendar events, soonest first, each calendar event marked with its calendar', async () => {
		reader.get.mockImplementation(async (q: { space: string; collection: string }) => {
			if (q.space === KEPT_OUT) throw new SpaceAccessDenied(q.space, '400 SpaceNotFound');
			if (q.space === SINGLE) {
				return {
					uri: `${SINGLE}/${OTHER}/${EVENT_COLLECTION}/3lsingle`,
					cid: 'c',
					rkey: '3lsingle',
					value: event('Single', '2026-11-15T18:00:00.000Z')
				};
			}
			if (q.collection === CALENDAR_COLLECTION) {
				const name = q.space === SPACE ? 'Supper club' : 'Mine';
				return { uri: `${q.space}/x`, cid: 'c', rkey: 'self', value: { name } };
			}
			return null;
		});
		reader.list.mockImplementation(async (q: { space: string }) => {
			if (q.space === KEPT_OUT) throw new SpaceAccessDenied(q.space, '400 SpaceNotFound');
			if (q.space !== SPACE) return { records: [], capped: false };
			return {
				records: [
					{
						uri: `${SPACE}/${OWNER}/${EVENT_COLLECTION}/3lsecond`,
						cid: 'c2',
						rkey: '3lsecond',
						value: event('Second', '2026-11-20T18:00:00.000Z')
					},
					{
						uri: `${SPACE}/${OWNER}/${EVENT_COLLECTION}/3lfirst`,
						cid: 'c1',
						rkey: '3lfirst',
						value: event('First', '2026-11-12T18:00:00.000Z')
					}
				],
				capped: false
			};
		});
		const member = caller(MEMBER, `${GUEST_SCOPE} ${HOST_SCOPE}`, {
			'com.atproto.space.listSpaces': () =>
				Response.json({
					spaces: [{ space: SINGLE }, { space: SPACE }, { space: KEPT_OUT }, { space: OWN }]
				})
		});
		const { events, calendars, incomplete } = await myPrivateEventsAndCalendars(member);

		expect(events.map((e) => e.event.name)).toEqual(['First', 'Single', 'Second']);
		expect(events[0]).toMatchObject({
			hosting: false,
			href: `/p/ownerownerownerownerowner.example.com/calendar/${KEY}/3lfirst`,
			calendar: { name: 'Supper club', key: KEY }
		});
		expect(events[1].calendar).toBeUndefined();
		expect(calendars).toEqual([
			expect.objectContaining({ key: KEY, name: 'Supper club', owning: false }),
			expect.objectContaining({ key: 'cal-3lown', name: 'Mine', owning: true })
		]);
		expect(incomplete).toBe(false);
	});

	it('says the list is incomplete when a calendar could not be read', async () => {
		reader.get.mockResolvedValue(null);
		reader.list.mockRejectedValue(new Error('503'));
		const member = caller(MEMBER, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const { calendars, incomplete } = await myPrivateEventsAndCalendars(member);
		expect(calendars).toEqual([]);
		expect(incomplete).toBe(true);
	});

	it('says the list is incomplete when a calendar had more events than it lists', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {}, capped: true });
		const member = caller(MEMBER, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		expect((await myPrivateEventsAndCalendars(member)).incomplete).toBe(true);
	});
});

describe('the owner’s own calendars, to put an event on', () => {
	it('lists only their own calendars, by name', async () => {
		theCalendarHolds({ name: { name: 'Supper club' } });
		const host = owner({
			'com.atproto.space.listSpaces': () =>
				Response.json({
					spaces: [
						{ space: SPACE },
						{ space: privateEventSpace(OWNER, '3lsingle') },
						{ space: privateEventSpace(OTHER, 'cal-3ltheirs') }
					]
				})
		});
		const calendars = await ownCalendars(host);
		expect(calendars).toEqual([
			expect.objectContaining({ key: KEY, name: 'Supper club', owning: true })
		]);
		expect(host.sent[0].query.get('spaceDid')).toBe(OWNER);
	});

	it('keeps one whose name could not be read, untitled, so a page that names it finds it', async () => {
		reader.get.mockRejectedValue(new Error('timed out'));
		const host = owner({
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		expect(await ownCalendars(host)).toEqual([
			expect.objectContaining({ key: KEY, name: null, owning: true })
		]);
	});
});

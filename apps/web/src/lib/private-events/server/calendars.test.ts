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
	addPersonToCalendar,
	createCalendar,
	deleteCalendar,
	myPrivateEventsAndCalendars,
	ownCalendars,
	readCalendarEventPage,
	readCalendarPage,
	readSpaceEventPage,
	NAMED_SPACES_READ,
	removePersonFromCalendar,
	renameCalendar,
	saveNamedEvent
} = await import('./calendars');
const { cancelPrivateEvent, putPrivateRsvp, savePrivateEvent } = await import('./events');

const OWNER = 'did:plc:ownerownerownerownerowner';
const PERSON = 'did:plc:personpersonpersonperson';
const OTHER = 'did:plc:otherotherotherotherothe';
/** A shared calendar's key: a plain TID, as any space's. */
const KEY = '3lcalcalcalcal';
/** A single event's space, under the event's own key. */
const SINGLE_KEY = '3lsingleevent';
const SINGLE_SPACE = privateEventSpace(OWNER, SINGLE_KEY);
const MEMBER_COLLECTION = 'com.atproto.memberspace.member';
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
	/** The people the owner's server publishes in the space, as `did` or `[did, access]`. */
	people?: (string | [string, { read: boolean; write: boolean }])[];
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
	reader.list.mockImplementation(async (q: { space: string; repo: string; collection: string }) => {
		if (q.space !== space || q.repo !== OWNER) return { records: [], capped: false };
		if (q.collection === MEMBER_COLLECTION) {
			return {
				records: (holds.people ?? []).map((entry) => {
					const [did, access] = typeof entry === 'string' ? [entry, null] : entry;
					const value = { $type: MEMBER_COLLECTION, ...(access ?? { read: true, write: true }) };
					return record(OWNER, MEMBER_COLLECTION, did, value);
				}),
				capped: false
			};
		}
		if (q.collection !== EVENT_COLLECTION) return { records: [], capped: false };
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
	it('makes a private space under a TID of its own that shows its people to everyone on it, then names it in the owner’s own repo there', async () => {
		const host = owner();
		const { key, actor } = await createCalendar(host, { name: '  Supper club ' });

		expect(key).toMatch(/^[a-z2-7]{13}$/);
		expect(actor).toBe('ownerownerownerownerowner.example.com');
		expect(host.nsids()).toEqual([
			'com.atproto.space.createSpace',
			'com.atproto.space.getSpace',
			'com.atproto.space.putRecord'
		]);
		expect(host.sent[0].body).toMatchObject({
			spaceType: 'rsvp.atmo.dev.space',
			skey: key,
			policy: {
				$type: 'com.atproto.memberspace.policy',
				publishPolicy: true,
				publishMembers: true
			}
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
		const guest = caller(PERSON, GUEST_SCOPE);
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
		expect(host.nsids().slice(0, 2)).toEqual([
			'com.atproto.space.getSpace',
			'com.atproto.space.putRecord'
		]);
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

	it('names a single event’s space, then has its server show its people to everyone on it', async () => {
		theCalendarHolds({ space: SINGLE_SPACE });
		const host = owner();
		await renameCalendar(host, { key: SINGLE_KEY, name: ' Supper club ' });
		expect(host.nsids()).toEqual([
			'com.atproto.space.getSpace',
			'com.atproto.space.putRecord',
			'com.atproto.space.getSpace',
			'com.atproto.space.updateSpace'
		]);
		expect(host.sent[1].body).toMatchObject({
			space: SINGLE_SPACE,
			repo: OWNER,
			collection: CALENDAR_COLLECTION,
			rkey: 'self',
			record: { name: 'Supper club', createdAt: expect.any(String) }
		});
		expect(host.sent[3].body).toMatchObject({
			space: SINGLE_SPACE,
			policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true, publishMembers: true }
		});
		// Nothing moves: no event is written, and no space is made or deleted.
		expect(host.sent.map((sent) => sent.body?.collection)).not.toContain(EVENT_COLLECTION);
	});

	it('names only the caller’s own space, whatever key a page sends', async () => {
		reader.get.mockResolvedValue(null);
		const someone = caller(PERSON, OWNER_SCOPE, { 'com.atproto.space.getSpace': privateSpace });
		await renameCalendar(someone, { key: SINGLE_KEY, name: 'Supper club' });
		expect(someone.sent[0].query.get('space')).toBe(privateEventSpace(PERSON, SINGLE_KEY));
		expect(someone.sent[1].body).toMatchObject({ repo: PERSON });
	});

	it('names nothing in a space anyone can read, and shows no one its people', async () => {
		const host = owner({
			'com.atproto.space.getSpace': () =>
				Response.json({ policy: { $type: 'com.atproto.memberspace.policy', publicRead: true } })
		});
		await expect(
			renameCalendar(host, { key: SINGLE_KEY, name: 'Supper club' })
		).rejects.toMatchObject({ reason: 'not-private' });
		expect(host.nsids()).toEqual(['com.atproto.space.getSpace']);
	});

	it('asks for the calendar grant to name a single event’s space, and calls nothing', async () => {
		const host = caller(OWNER, `${HOST_SCOPE} ${GUEST_SCOPE}`);
		await expect(
			renameCalendar(host, { key: SINGLE_KEY, name: 'Supper club' })
		).rejects.toMatchObject({ reason: 'no-grant' });
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
			{ pathname: '/xrpc/com.atproto.space.getSpace' },
			{ pathname: '/xrpc/com.atproto.space.deleteSpace', body: { space: SPACE } }
		]);
	});

	it('deletes a calendar that was a single event’s space the same way', async () => {
		const host = owner();
		await deleteCalendar(host, SINGLE_KEY);
		expect(host.sent).toMatchObject([
			{ pathname: '/xrpc/com.atproto.space.getSpace' },
			{ pathname: '/xrpc/com.atproto.space.deleteSpace', body: { space: SINGLE_SPACE } }
		]);
	});

	it.each([
		['was never made', refuse(400, 'SpaceNotFound'), 'no-calendar'],
		[
			'anyone can read',
			() =>
				Response.json({ policy: { $type: 'com.atproto.memberspace.policy', publicRead: true } }),
			'not-private'
		]
	])('refuses a space that %s, before any write', async (_, getSpace, reason) => {
		actorToDid.mockResolvedValue(PERSON);
		const runs = [
			(host: CallerSession) => deleteCalendar(host, SINGLE_KEY),
			(host: CallerSession) =>
				addPersonToCalendar(host, { key: SINGLE_KEY, handleOrDid: 'person.example.com' }),
			(host: CallerSession) => removePersonFromCalendar(host, { key: SINGLE_KEY, did: PERSON })
		];
		for (const run of runs) {
			const host = owner({ 'com.atproto.space.getSpace': getSpace });
			await expect(run(host)).rejects.toMatchObject({ reason });
			expect(host.nsids()).toEqual(['com.atproto.space.getSpace']);
		}
	});

	it('refuses a guest', async () => {
		const guest = caller(PERSON, GUEST_SCOPE);
		await expect(deleteCalendar(guest, KEY)).rejects.toMatchObject({ reason: 'no-grant' });
		expect(guest.sent).toHaveLength(0);
	});
});

describe('the people on a calendar', () => {
	it('puts the person a handle names on the list, able to read and answer', async () => {
		actorToDid.mockResolvedValue(PERSON);
		const host = owner();
		const added = await addPersonToCalendar(host, {
			key: KEY,
			handleOrDid: '@person.example.com '
		});
		expect(actorToDid).toHaveBeenCalledWith('person.example.com');
		expect(added).toEqual({ did: PERSON, handle: 'personpersonpersonperson.example.com' });
		expect(host.sent).toMatchObject([
			{ pathname: '/xrpc/com.atproto.space.getSpace' },
			{
				pathname: '/xrpc/com.atproto.memberspace.putMembers',
				body: { space: SPACE, members: [{ did: PERSON, read: true, write: true }] }
			}
		]);
	});

	it('refuses a handle that names no one', async () => {
		actorToDid.mockRejectedValue(new Error('not found'));
		const host = owner();
		await expect(
			addPersonToCalendar(host, { key: KEY, handleOrDid: 'no.one' })
		).rejects.toMatchObject({ reason: 'no-such-person' });
		expect(host.sent).toHaveLength(0);
	});

	it('refuses the owner themself', async () => {
		actorToDid.mockResolvedValue(OWNER);
		await expect(
			addPersonToCalendar(owner(), { key: KEY, handleOrDid: 'owner.example.com' })
		).rejects.toMatchObject({ reason: 'own-calendar' });
	});

	it('acts only on the caller’s own calendar, whatever a page sends', async () => {
		actorToDid.mockResolvedValue(OTHER);
		const someone = caller(PERSON, HOST_SCOPE, { 'com.atproto.space.getSpace': privateSpace });
		await addPersonToCalendar(someone, { key: KEY, handleOrDid: 'other.example.com' });
		expect(someone.sent[0].query.get('space')).toBe(privateEventSpace(PERSON, KEY));
		expect(someone.sent[1].body?.space).toBe(privateEventSpace(PERSON, KEY));
	});

	it('refuses someone on it who tries to change the list', async () => {
		const person = caller(PERSON, GUEST_SCOPE);
		await expect(
			addPersonToCalendar(person, { key: KEY, handleOrDid: 'other.example.com' })
		).rejects.toMatchObject({ reason: 'no-grant' });
		await expect(removePersonFromCalendar(person, { key: KEY, did: OTHER })).rejects.toMatchObject({
			reason: 'no-grant'
		});
		expect(person.sent).toHaveLength(0);
	});

	it('takes someone off the caller’s own calendar', async () => {
		const host = owner();
		await removePersonFromCalendar(host, { key: KEY, did: PERSON });
		expect(host.sent).toMatchObject([
			{ pathname: '/xrpc/com.atproto.space.getSpace' },
			{
				pathname: '/xrpc/com.atproto.memberspace.removeMembers',
				body: { space: SPACE, dids: [PERSON] }
			}
		]);
	});

	it('changes the people on a calendar that was a single event’s space the same way', async () => {
		actorToDid.mockResolvedValue(PERSON);
		const host = owner();
		await addPersonToCalendar(host, { key: SINGLE_KEY, handleOrDid: 'person.example.com' });
		await removePersonFromCalendar(host, { key: SINGLE_KEY, did: PERSON });
		expect(host.sent.filter((sent) => sent.body).map((sent) => sent.body?.space)).toEqual([
			SINGLE_SPACE,
			SINGLE_SPACE
		]);
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

	it('shows someone on it its name and events, upcoming soonest first and past latest first', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS });
		const person = caller(PERSON, GUEST_SCOPE);
		const page = await readCalendarPage(person, OWNER, KEY, NOW);
		expect(page?.name).toBe('Supper club');
		expect(page?.upcoming.map((e) => e.rkey)).toEqual(['3lstill', '3lsoon', '3llater']);
		expect(page?.past.map((e) => e.rkey)).toEqual(['3lpast']);
		expect(page?.people).toBeNull();
		expect(person.sent).toHaveLength(0);
	});

	it('lists events and people from the owner’s repo only, and reads no one’s answers', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS });
		await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(reader.list.mock.calls.map(([q]) => q)).toEqual([
			{ space: SPACE, repo: OWNER, collection: EVENT_COLLECTION },
			{ space: SPACE, repo: OWNER, collection: MEMBER_COLLECTION }
		]);
		expect(reader.get.mock.calls.map(([q]) => q.collection)).toEqual([CALENDAR_COLLECTION]);
		expect(reader.writers).not.toHaveBeenCalled();
	});

	it('shows someone on it the people its owner’s server publishes there, themself included, and asks that server nothing', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {}, people: [PERSON, OTHER] });
		const person = caller(PERSON, GUEST_SCOPE);
		const page = await readCalendarPage(person, OWNER, KEY, NOW);
		expect(page?.people).toEqual([
			{ did: PERSON, handle: 'personpersonpersonperson.example.com' },
			{ did: OTHER, handle: 'otherotherotherotherothe.example.com' }
		]);
		expect(person.sent).toHaveLength(0);
	});

	it('leaves out a published entry that cannot read the calendar', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: {},
			people: [PERSON, [OTHER, { read: false, write: false }]]
		});
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page?.people?.map((p) => p.did)).toEqual([PERSON]);
	});

	it('shows someone on it no people where the calendar publishes none yet', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page?.people).toBeNull();
	});

	it('still shows the calendar when its people could not be read', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS });
		const listed = reader.list.getMockImplementation()!;
		reader.list.mockImplementation(async (q: { collection: string }) => {
			if (q.collection === MEMBER_COLLECTION) throw new Error('503');
			return listed(q);
		});
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page?.upcoming).toHaveLength(3);
		expect(page?.people).toBeNull();
	});

	it('switches an older calendar of the owner’s over to showing its people, keeping the rest of its policy', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({ 'com.atproto.memberspace.listMembers': listMembers([PERSON]) });
		await readCalendarPage(host, OWNER, KEY, NOW);
		const update = host.sent.find((s) => s.pathname.endsWith('updateSpace'));
		expect(update?.body).toEqual({
			space: SPACE,
			policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true, publishMembers: true }
		});
	});

	it('never switches a calendar anyone can read, so its people stay unpublished', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({
			'com.atproto.space.getSpace': () =>
				Response.json({
					policy: { $type: 'com.atproto.memberspace.policy', publishPolicy: true, publicRead: true }
				}),
			'com.atproto.memberspace.listMembers': listMembers([PERSON])
		});
		await readCalendarPage(host, OWNER, KEY, NOW);
		expect(host.nsids()).not.toContain('com.atproto.space.updateSpace');
	});

	it('leaves a calendar that already shows its people as it is', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({
			'com.atproto.space.getSpace': () =>
				Response.json({
					policy: {
						$type: 'com.atproto.memberspace.policy',
						publishPolicy: true,
						publishMembers: true
					}
				}),
			'com.atproto.memberspace.listMembers': listMembers([PERSON])
		});
		await readCalendarPage(host, OWNER, KEY, NOW);
		expect(host.nsids()).not.toContain('com.atproto.space.updateSpace');
	});

	it('still shows the owner their calendar when the switch fails', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({
			'com.atproto.space.updateSpace': refuse(500, 'InternalServerError'),
			'com.atproto.memberspace.listMembers': listMembers([PERSON])
		});
		const page = await readCalendarPage(host, OWNER, KEY, NOW);
		expect(page?.people?.map((p) => p.did)).toEqual([PERSON]);
	});

	it('never switches a calendar for someone on it, only for its owner', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const person = caller(PERSON, GUEST_SCOPE);
		await readCalendarPage(person, OWNER, KEY, NOW);
		expect(person.nsids()).toEqual([]);
	});

	it('shows the owner the people on it from their own server’s list', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const page = await readCalendarPage(
			owner({ 'com.atproto.memberspace.listMembers': listMembers([PERSON, OTHER]) }),
			OWNER,
			KEY,
			NOW
		);
		expect(page?.people).toEqual([
			{ did: PERSON, handle: 'personpersonpersonperson.example.com' },
			{ did: OTHER, handle: 'otherotherotherotherothe.example.com' }
		]);
		expect(page?.peopleCapped).toBe(false);
	});

	it('says there may be more people at the page limit', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const host = owner({ 'com.atproto.memberspace.listMembers': listMembers([PERSON], 'more') });
		const page = await readCalendarPage(host, OWNER, KEY, NOW);
		expect(host.nsids().filter((n) => n.endsWith('listMembers'))).toHaveLength(10);
		expect(page?.peopleCapped).toBe(true);
	});

	it('says there may be more events when the listing stopped at its limit', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: EVENTS, capped: true });
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
		expect(page?.eventsCapped).toBe(true);
	});

	it.each([
		['a name that is not text', { name: 7 }],
		['a name past 64 characters', { name: 'x'.repeat(65) }]
	])('reads a calendar with %s as untitled', async (_, name) => {
		theCalendarHolds({ name, events: {} });
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
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

	it.each([KEY, 'cal-3lmadebefore'])(
		'reads a space with no name record as no calendar, whatever its key: %s',
		async (key) => {
			theCalendarHolds({
				space: privateEventSpace(OWNER, key),
				events: { '3lone': event('Dinner', '2026-11-20T18:00:00.000Z') }
			});
			expect(await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, key, NOW)).toBeNull();
		}
	);

	it('still reads a calendar made under the old cal- key, by its name', async () => {
		const key = 'cal-3lmadebefore';
		theCalendarHolds({ space: privateEventSpace(OWNER, key), name: { name: 'Old club' } });
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, key, NOW);
		expect(page).toMatchObject({ key, name: 'Old club' });
	});

	it('reads a single event’s space with no name as nothing there', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		expect(await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, SINGLE_KEY, NOW)).toBeNull();
	});

	it('reads a single event’s space with no name as nothing there for its owner too, and changes nothing', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		const host = owner({
			'com.atproto.memberspace.listMembers': () => Response.json({ members: [{ did: PERSON }] })
		});
		expect(await readCalendarPage(host, OWNER, SINGLE_KEY, NOW)).toBeNull();
		expect(host.nsids()).not.toContain('com.atproto.space.updateSpace');
		expect(host.nsids()).not.toContain('com.atproto.space.getSpace');
	});

	it('reads a single event’s space with a name as a calendar, its event first among them', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			name: { name: 'Supper club' },
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') },
			people: [PERSON, OTHER]
		});
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, SINGLE_KEY, NOW);
		expect(page).toMatchObject({ key: SINGLE_KEY, name: 'Supper club' });
		expect(page?.upcoming.map((e) => e.rkey)).toEqual([SINGLE_KEY]);
		expect(page?.people?.map((p) => p.did)).toEqual([PERSON, OTHER]);
	});

	it('does not pass an outage off as nothing there', async () => {
		reader.get.mockResolvedValue(null);
		reader.list.mockRejectedValue(new Error('503'));
		await expect(readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW)).rejects.toThrow();
	});

	it('leaves out what is not an event', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { '3lbroken': { name: 'No start' }, ...EVENTS }
		});
		const page = await readCalendarPage(caller(PERSON, GUEST_SCOPE), OWNER, KEY, NOW);
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
			answers: { [PERSON]: going() }
		});
		reader.writers.mockResolvedValue([PERSON]);
		const host = owner({
			'com.atproto.memberspace.listMembers': () =>
				Response.json({ members: [{ did: PERSON }, { did: OTHER }] })
		});
		const page = await readCalendarEventPage(host, ADDRESS);
		expect(page?.calendar).toEqual({ key: KEY, name: 'Supper club' });
		expect(page?.guests).toMatchObject([
			{ did: PERSON, answer: 'going' },
			{ did: OTHER, answer: null }
		]);
		expect(host.sent[0].query.get('space')).toBe(SPACE);
	});

	it('gives someone on it the calendar’s people too, each with their answer, from the list the owner’s server publishes', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') },
			answers: { [PERSON]: going() },
			people: [PERSON, OTHER]
		});
		reader.writers.mockResolvedValue([PERSON]);
		const person = caller(PERSON, GUEST_SCOPE);
		const page = await readCalendarEventPage(person, ADDRESS);
		expect(page?.guests).toMatchObject([
			{ did: PERSON, answer: 'going' },
			{ did: OTHER, answer: null }
		]);
		expect(person.sent).toHaveLength(0);
	});

	it('gives someone on it no guest list where the calendar publishes none yet', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		reader.writers.mockResolvedValue([]);
		const page = await readCalendarEventPage(caller(PERSON, GUEST_SCOPE), ADDRESS);
		expect(page?.guests).toBeNull();
	});

	it('is read from the owner’s repo only, so an event record someone else wrote in the space is ignored', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {} });
		const crafted = reader.get.getMockImplementation()!;
		reader.get.mockImplementation(async (q: { repo: string; collection: string }) =>
			q.repo === PERSON && q.collection === EVENT_COLLECTION
				? { uri: `${SPACE}/${PERSON}/${EVENT_COLLECTION}/${RKEY}`, cid: 'c', rkey: RKEY, value: {} }
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
		expect(reader.get).not.toHaveBeenCalledWith(expect.objectContaining({ repo: PERSON }));
	});

	it('counts only answers that name this event in this calendar', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') },
			answers: { [PERSON]: going(), [OTHER]: going(eventUri(calendarEvent(OWNER, KEY, 'x'))) }
		});
		reader.writers.mockResolvedValue([PERSON, OTHER]);
		const page = await readCalendarEventPage(caller(PERSON, GUEST_SCOPE), ADDRESS);
		expect(page?.attendees.going.map((a) => a.did)).toEqual([PERSON]);
		expect(page?.viewerStatus).toBe('going');
	});

	it('takes the answer of someone on it into their own repo in the calendar’s space', async () => {
		theCalendarHolds({ events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') } });
		const person = caller(PERSON, GUEST_SCOPE);
		await putPrivateRsvp(person, ADDRESS, { status: 'going', cid: `cid-of-${OWNER}-${RKEY}` });
		expect(person.sent).toMatchObject([
			{
				pathname: '/xrpc/com.atproto.space.putRecord',
				body: {
					space: SPACE,
					repo: PERSON,
					collection: RSVP_COLLECTION,
					rkey: RKEY,
					record: { subject: { uri: eventUri(ADDRESS), cid: `cid-of-${OWNER}-${RKEY}` } }
				}
			}
		]);
	});

	it('refuses an answer to a version the page no longer shows', async () => {
		theCalendarHolds({ events: { [RKEY]: event('Dinner', '2026-11-20T18:00:00.000Z') } });
		const person = caller(PERSON, GUEST_SCOPE);
		await expect(
			putPrivateRsvp(person, ADDRESS, { status: 'going', cid: 'old' })
		).rejects.toMatchObject({ reason: 'changed' });
		expect(person.sent).toHaveLength(0);
	});

	it('reads an event in a space with no name, under a key not made for a calendar, as no calendar’s', async () => {
		const address = { host: OWNER, spaceKey: SINGLE_KEY, rkey: SINGLE_KEY };
		theCalendarHolds({
			space: SINGLE_SPACE,
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		reader.writers.mockResolvedValue([]);
		expect(await readCalendarEventPage(caller(PERSON, GUEST_SCOPE), address)).toBeNull();
	});
});

describe('putting an event on a calendar', () => {
	const RECORD = event('Dinner', '2026-11-20T18:00:00.000Z');

	it('writes it into the calendar’s space under its own key, and makes no new space', async () => {
		theCalendarHolds({ name: { name: 'Supper club' } });
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
		reader.get.mockImplementation(async (q: { space: string; repo: string; collection: string }) =>
			q.space === privateEventSpace(PERSON, KEY) &&
			q.repo === PERSON &&
			q.collection === CALENDAR_COLLECTION
				? { uri: 'at://x', cid: 'c', rkey: 'self', value: { name: 'Mine' } }
				: null
		);
		const someone = caller(PERSON, HOST_SCOPE, { 'com.atproto.space.getSpace': privateSpace });
		await savePrivateEvent(someone, { rkey: '3levent', record: RECORD, calendar: KEY });
		expect(someone.sent[0].query.get('space')).toBe(privateEventSpace(PERSON, KEY));
	});

	it('refuses someone on it who tries to add an event, and calls nothing', async () => {
		const person = caller(PERSON, GUEST_SCOPE);
		await expect(
			savePrivateEvent(person, { rkey: '3levent', record: RECORD, calendar: KEY })
		).rejects.toMatchObject({ reason: 'no-grant' });
		expect(person.sent).toHaveLength(0);
	});

	it('puts it in a single event’s space once that space has a name', async () => {
		theCalendarHolds({ space: SINGLE_SPACE, name: { name: 'Supper club' } });
		const host = owner();
		const saved = await savePrivateEvent(host, {
			rkey: '3lsecond',
			record: RECORD,
			calendar: SINGLE_KEY
		});
		expect(saved.uri).toBe(eventUri(calendarEvent(OWNER, SINGLE_KEY, '3lsecond')));
		expect(host.nsids()).toEqual(['com.atproto.space.getSpace', 'com.atproto.space.putRecord']);
		expect(host.sent[1].body).toMatchObject({ space: SINGLE_SPACE, rkey: '3lsecond' });
	});

	it('refuses a single event’s space with no name, which holds only its own event', async () => {
		theCalendarHolds({ space: SINGLE_SPACE });
		const host = owner();
		await expect(
			savePrivateEvent(host, { rkey: '3lsecond', record: RECORD, calendar: SINGLE_KEY })
		).rejects.toMatchObject({ reason: 'no-calendar' });
		expect(host.nsids()).not.toContain('com.atproto.space.putRecord');
	});

	it('never deletes a calendar as if it were an event, whatever keys a page sends', async () => {
		theCalendarHolds({ name: { name: 'Supper club' } });
		const host = owner();
		await cancelPrivateEvent(host, { spaceKey: KEY, rkey: KEY });
		expect(host.nsids()).toEqual(['com.atproto.space.deleteRecord']);
	});

	it('takes only the event off the calendar when it is deleted, never the calendar', async () => {
		theCalendarHolds({ name: { name: 'Supper club' } });
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
	const OWN = privateEventSpace(PERSON, 'cal-3lown');

	it('mixes single and calendar events, soonest first, each calendar event marked with its calendar', async () => {
		reader.get.mockImplementation(async (q: { space: string; collection: string }) => {
			if (q.space === KEPT_OUT) throw new SpaceAccessDenied(q.space, '400 SpaceNotFound');
			if (q.space === SINGLE && q.collection === EVENT_COLLECTION) {
				return {
					uri: `${SINGLE}/${OTHER}/${EVENT_COLLECTION}/3lsingle`,
					cid: 'c',
					rkey: '3lsingle',
					value: event('Single', '2026-11-15T18:00:00.000Z')
				};
			}
			if (q.collection === CALENDAR_COLLECTION) {
				if (q.space === SINGLE) return null;
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
		const person = caller(PERSON, `${GUEST_SCOPE} ${HOST_SCOPE}`, {
			'com.atproto.space.listSpaces': () =>
				Response.json({
					spaces: [{ space: SINGLE }, { space: SPACE }, { space: KEPT_OUT }, { space: OWN }]
				})
		});
		const { events, calendars, incomplete } = await myPrivateEventsAndCalendars(person);

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

	it('lists a single event’s space with a name as a calendar, its event at the address it always had', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			name: { name: 'Supper club' },
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SINGLE_SPACE }] })
		});
		const { events, calendars } = await myPrivateEventsAndCalendars(person);
		expect(calendars).toEqual([
			expect.objectContaining({ key: SINGLE_KEY, name: 'Supper club', owning: false })
		]);
		expect(events).toEqual([
			expect.objectContaining({
				href: `/p/ownerownerownerownerowner.example.com/private/${SINGLE_KEY}`,
				calendar: { name: 'Supper club', key: SINGLE_KEY }
			})
		]);
	});

	it('reads a named single event’s name once, for both the Calendars page and Your events', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			name: { name: 'Supper club' },
			events: { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') }
		});
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SINGLE_SPACE }] })
		});
		for (const calendarEvents of [true, false]) {
			reader.get.mockClear();
			await myPrivateEventsAndCalendars(person, { calendarEvents });
			const nameReads = reader.get.mock.calls.filter(
				([q]) => (q as { collection: string }).collection === CALENDAR_COLLECTION
			);
			expect(nameReads).toHaveLength(1);
		}
	});

	it('says the list is incomplete when a calendar could not be read', async () => {
		reader.get.mockImplementation(async (q: { collection: string }) =>
			q.collection === CALENDAR_COLLECTION
				? { uri: 'at://x', cid: 'c', rkey: 'self', value: { name: 'Supper club' } }
				: null
		);
		reader.list.mockRejectedValue(new Error('503'));
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const { calendars, incomplete } = await myPrivateEventsAndCalendars(person);
		expect(calendars).toEqual([]);
		expect(incomplete).toBe(true);
	});

	it('for the Calendars page, reads each calendar’s name only, never its events', async () => {
		theCalendarHolds({
			name: { name: 'Supper club' },
			events: { '3lfirst': event('First', '2026-11-12T18:00:00.000Z') }
		});
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const listed = await myPrivateEventsAndCalendars(person, { calendarEvents: false });
		expect(listed.calendars).toEqual([
			expect.objectContaining({ key: KEY, name: 'Supper club', owning: false })
		]);
		expect(listed.events).toEqual([]);
		expect(reader.list).not.toHaveBeenCalled();
		expect(listed.incomplete).toBe(false);
	});

	it('for the Calendars page, still leaves out a calendar the person was taken off', async () => {
		reader.get.mockImplementation(async (q: { space: string }) => {
			throw new SpaceAccessDenied(q.space, '400 SpaceNotFound');
		});
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const listed = await myPrivateEventsAndCalendars(person, { calendarEvents: false });
		expect(listed.calendars).toEqual([]);
		expect(listed.incomplete).toBe(false);
	});

	it('for the Calendars page, says the list is incomplete when a calendar could not be read', async () => {
		reader.get.mockRejectedValue(new Error('503'));
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const listed = await myPrivateEventsAndCalendars(person, { calendarEvents: false });
		expect(listed.calendars).toEqual([]);
		expect(listed.incomplete).toBe(true);
	});

	it('says a calendar had more events than it lists, without calling any unread', async () => {
		theCalendarHolds({ name: { name: 'Supper club' }, events: {}, capped: true });
		const person = caller(PERSON, GUEST_SCOPE, {
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		const listed = await myPrivateEventsAndCalendars(person);
		expect(listed.capped).toBe(true);
		expect(listed.incomplete).toBe(false);
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
		const { calendars } = await ownCalendars(host);
		expect(calendars).toEqual([
			expect.objectContaining({ key: KEY, name: 'Supper club', owning: true })
		]);
		expect(host.sent[0].query.get('spaceDid')).toBe(OWNER);
	});

	it('leaves out one whose name could not be read, since only a name makes it a calendar', async () => {
		reader.get.mockRejectedValue(new Error('timed out'));
		const host = owner({
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SPACE }] })
		});
		expect((await ownCalendars(host)).calendars).toEqual([]);
	});
});

describe('a new single event named at once', () => {
	const RECORD = event('Dinner', '2026-11-20T18:00:00.000Z');
	const NEW_KEY = '3lnewevent';
	const NEW_SPACE = privateEventSpace(OWNER, NEW_KEY);

	it('makes its space, writes the event, then the name, then shows its people to everyone on it', async () => {
		const host = owner();
		const saved = await saveNamedEvent(host, { rkey: NEW_KEY, record: RECORD, name: 'Supper' });
		expect(saved.uri).toBe(eventUri(calendarEvent(OWNER, NEW_KEY, NEW_KEY)));
		expect(host.nsids()).toEqual([
			'com.atproto.space.createSpace',
			'com.atproto.space.getSpace',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.getSpace',
			'com.atproto.space.updateSpace'
		]);
		// Its people are shown only once it has a name.
		expect(host.sent[0].body?.policy).not.toHaveProperty('publishMembers');
		expect(host.sent[2].body).toMatchObject({ space: NEW_SPACE, collection: EVENT_COLLECTION });
		expect(host.sent[3].body).toMatchObject({
			space: NEW_SPACE,
			repo: OWNER,
			collection: CALENDAR_COLLECTION,
			rkey: 'self',
			record: { name: 'Supper' }
		});
		expect(host.sent[5].body).toMatchObject({ space: NEW_SPACE, policy: { publishMembers: true } });
	});

	it('keeps the event when the name could not be written, and says the name was not saved', async () => {
		const host = owner({
			'com.atproto.space.putRecord': (sent) =>
				sent.body?.collection === CALENDAR_COLLECTION
					? Response.json({ error: 'Nope' }, { status: 500 })
					: Response.json({ cid: 'c' })
		});
		await expect(
			saveNamedEvent(host, { rkey: NEW_KEY, record: RECORD, name: 'Supper' })
		).rejects.toMatchObject({ reason: 'name-not-saved' });
		expect(host.nsids()).not.toContain('com.atproto.space.deleteSpace');
		expect(host.nsids()).not.toContain('com.atproto.space.updateSpace');
	});

	it('asks for the calendar grant, and calls nothing', async () => {
		const host = caller(OWNER, `${HOST_SCOPE} ${GUEST_SCOPE}`);
		await expect(
			saveNamedEvent(host, { rkey: NEW_KEY, record: RECORD, name: 'Supper' })
		).rejects.toMatchObject({ reason: 'no-grant' });
		expect(host.sent).toHaveLength(0);
	});

	it('refuses a bad name before writing anything', async () => {
		const host = owner();
		await expect(
			saveNamedEvent(host, { rkey: NEW_KEY, record: RECORD, name: '   ' })
		).rejects.toMatchObject({ reason: 'bad-name' });
		expect(host.sent).toHaveLength(0);
	});

	it('names no event that is going on a calendar already', async () => {
		const host = owner();
		await expect(
			saveNamedEvent(host, { rkey: NEW_KEY, record: RECORD, name: 'Supper', calendar: KEY })
		).rejects.toMatchObject({ reason: 'named-on-calendar' });
		expect(host.sent).toHaveLength(0);
	});
});

describe('a single event’s page, by whether its space has a name', () => {
	const ADDRESS = calendarEvent(OWNER, SINGLE_KEY, SINGLE_KEY);
	const dinner = { [SINGLE_KEY]: event('Dinner', '2026-11-20T18:00:00.000Z') };

	it('shows a guest a single event with no calendar and no list of people while it has no name', async () => {
		theCalendarHolds({ space: SINGLE_SPACE, events: dinner, people: [PERSON, OTHER] });
		reader.writers.mockResolvedValue([]);
		const page = await readSpaceEventPage(caller(PERSON, GUEST_SCOPE), ADDRESS);
		expect(page?.calendar).toBeNull();
		expect(page?.guests).toBeNull();
		expect(reader.list).not.toHaveBeenCalled();
	});

	it('shows a guest the calendar and the people on it once it has one, at the same address', async () => {
		theCalendarHolds({
			space: SINGLE_SPACE,
			name: { name: 'Supper club' },
			events: dinner,
			people: [PERSON, OTHER]
		});
		reader.writers.mockResolvedValue([]);
		const page = await readSpaceEventPage(caller(PERSON, GUEST_SCOPE), ADDRESS);
		expect(page?.calendar).toEqual({ key: SINGLE_KEY, name: 'Supper club' });
		expect(page?.guests?.map((guest) => guest.did)).toEqual([PERSON, OTHER]);
		expect(page?.event.rkey).toBe(SINGLE_KEY);
	});

	it('fails rather than show a single event when its name could not be read: named, its people are shown to everyone on it, which a single event’s page would not say', async () => {
		theCalendarHolds({ space: SINGLE_SPACE, events: dinner });
		const get = reader.get.getMockImplementation()!;
		reader.get.mockImplementation(async (q: { collection: string }) => {
			if (q.collection === CALENDAR_COLLECTION) throw new Error('503');
			return get(q);
		});
		reader.writers.mockResolvedValue([]);
		await expect(readSpaceEventPage(caller(PERSON, GUEST_SCOPE), ADDRESS)).rejects.toThrow();
	});

	it('is nothing there for someone kept out, as before', async () => {
		reader.get.mockRejectedValue(new SpaceAccessDenied(SINGLE_SPACE, '400 SpaceNotFound'));
		expect(await readSpaceEventPage(caller(OTHER, GUEST_SCOPE), ADDRESS)).toBeNull();
	});
});

describe('the owner’s own calendars, with single events among their spaces', () => {
	it('lists a single event’s space once it has a name, and no other', async () => {
		reader.get.mockImplementation(async (q: { space: string; collection: string }) =>
			q.collection === CALENDAR_COLLECTION && q.space === SINGLE_SPACE
				? { uri: `${q.space}/x`, cid: 'c', rkey: 'self', value: { name: 'Supper' } }
				: null
		);
		const host = owner({
			'com.atproto.space.listSpaces': () =>
				Response.json({
					spaces: [{ space: SINGLE_SPACE }, { space: privateEventSpace(OWNER, '3lunnamed') }]
				})
		});
		expect((await ownCalendars(host)).calendars).toEqual([
			expect.objectContaining({ key: SINGLE_KEY, name: 'Supper', owning: true })
		]);
	});

	it('reads the names of only the newest few spaces, and says there may be more', async () => {
		reader.get.mockResolvedValue(null);
		// TIDs sort by time: 3l00 is the oldest.
		const keys = Array.from({ length: 30 }, (_, i) => `3l${String(i).padStart(2, '0')}`);
		const host = owner({
			'com.atproto.space.listSpaces': () =>
				Response.json({
					spaces: [
						...keys.map((key) => ({ space: privateEventSpace(OWNER, key) })),
						{ space: SPACE }
					]
				})
		});
		const { capped } = await ownCalendars(host);
		const asked = reader.get.mock.calls.map(([q]) => (q as { space: string }).space);
		// Every space alike: the calendar's key sorts as newest here, as a TID made later would.
		expect(asked).toHaveLength(NAMED_SPACES_READ);
		expect(asked).toContain(SPACE);
		expect(asked).toContain(privateEventSpace(OWNER, '3l29'));
		expect(asked).not.toContain(privateEventSpace(OWNER, '3l00'));
		expect(capped).toBe(true);
	});

	it('also reads the one a page asks for, though it is older', async () => {
		reader.get.mockImplementation(async (q: { space: string }) =>
			q.space === privateEventSpace(OWNER, '3l00')
				? { uri: `${q.space}/x`, cid: 'c', rkey: 'self', value: { name: 'Old club' } }
				: null
		);
		const keys = Array.from({ length: 30 }, (_, i) => `3l${String(i).padStart(2, '0')}`);
		const host = owner({
			'com.atproto.space.listSpaces': () =>
				Response.json({ spaces: keys.map((key) => ({ space: privateEventSpace(OWNER, key) })) })
		});
		const { calendars } = await ownCalendars(host, { wanted: '3l00' });
		expect(calendars).toEqual([expect.objectContaining({ key: '3l00', name: 'Old club' })]);
	});

	it('says nothing of more when it read them all', async () => {
		reader.get.mockResolvedValue(null);
		const host = owner({
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SINGLE_SPACE }] })
		});
		expect((await ownCalendars(host)).capped).toBe(false);
	});

	it('leaves out a single event’s space whose name could not be read', async () => {
		reader.get.mockRejectedValue(new Error('timed out'));
		const host = owner({
			'com.atproto.space.listSpaces': () => Response.json({ spaces: [{ space: SINGLE_SPACE }] })
		});
		expect((await ownCalendars(host)).calendars).toEqual([]);
	});
});

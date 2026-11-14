// A shared calendar: one space on its owner's PDS, holding a list of people and any number of the
// owner's private events. Everyone on the list can read every event on it, past ones included, and
// answers each one in their own repo in the space. Only the owner adds events or changes the list:
// every write here goes to the caller's own calendar, and an event counts only from the owner's repo.
import { now as tidNow } from '@atcute/tid';
import type { FlatEventRecord } from '#lib/contrail.js';
import { actorToDid } from '#lib/actor.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader, type SpaceReader } from '#lib/spaces/server/space-read.js';
import { xrpc } from '#lib/spaces/server/xrpc.js';
import { parseSpaceUri } from '#lib/spaces/uri.js';
import {
	CALENDAR_COLLECTION,
	CALENDAR_NAME_MAX,
	CALENDAR_RKEY,
	calendarKey,
	calendarPath,
	EVENT_COLLECTION,
	eventPath,
	isCalendarKey,
	privateEventSpace,
	type EventAddress
} from '../ids';
import { holdsCalendarGrant } from '../scopes';
import type { CallerSession } from './caller';
import {
	checkPrivateSpace,
	ensurePrivateSpace,
	flatEvent,
	listedSpaces,
	memberPages,
	myPrivateEvents,
	PrivateEventRefused,
	readPrivateEventPage,
	requireHost,
	write,
	type MyPrivateEvent,
	type PrivateEventPage
} from './events';
import { verifiedHandle } from './people';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const bytes = new TextEncoder();
/** The lexicon's limit in bytes, beside its limit in characters. */
const CALENDAR_NAME_BYTES = 640;

/** The name as stored, when it is one; null for a missing or invalid one, which pages show as
 *  "Untitled calendar". */
export function calendarName(value: unknown): string | null {
	const name = (value as { name?: unknown } | null)?.name;
	if (typeof name !== 'string') return null;
	const length = [...graphemes.segment(name)].length;
	const fits = length <= CALENDAR_NAME_MAX && bytes.encode(name).length <= CALENDAR_NAME_BYTES;
	return name.trim() && fits ? name : null;
}

function validName(input: string): string {
	const name = calendarName({ name: input.trim() });
	if (!name) throw new PrivateEventRefused('bad-name');
	return name;
}

function requireCalendarHost(caller: CallerSession): void {
	if (!holdsCalendarGrant(caller.scope, caller.did)) throw new PrivateEventRefused('no-grant');
}

function requireCalendarKey(key: string): void {
	if (!isCalendarKey(key)) throw new PrivateEventRefused('no-calendar');
}

function nameRecord(name: string, createdAt: string) {
	return { $type: CALENDAR_COLLECTION, name, createdAt };
}

async function putName(caller: CallerSession, space: string, record: Record<string, unknown>) {
	await write(
		caller,
		'com.atproto.space.putRecord',
		{ space, repo: caller.did, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY, record },
		`name of ${space} not saved`
	);
}

/** A new calendar of the caller's own, with only them on it, and how its page names them. */
export async function createCalendar(
	caller: CallerSession,
	input: { name: string }
): Promise<{ key: string; actor: string }> {
	requireCalendarHost(caller);
	const name = validName(input.name);
	const key = calendarKey(tidNow());
	let space: string;
	try {
		space = await ensurePrivateSpace(caller, key);
	} catch (e) {
		if (e instanceof PrivateEventRefused) throw e;
		console.error(`[private-events] ${caller.did}: calendar ${key} not made:`, e);
		throw new PrivateEventRefused('refused');
	}
	try {
		await putName(caller, space, nameRecord(name, new Date().toISOString()));
	} catch (e) {
		// A calendar without its name would be left over as "Untitled calendar".
		await xrpc(caller.handle, 'com.atproto.space.deleteSpace', { body: { space } }).catch(
			(cleanup) => console.error(`[private-events] ${caller.did}: ${space} left over:`, cleanup)
		);
		throw e;
	}
	return { key, actor: (await verifiedHandle(caller.did)) ?? caller.did };
}

export async function renameCalendar(
	caller: CallerSession,
	input: { key: string; name: string }
): Promise<void> {
	requireCalendarHost(caller);
	requireCalendarKey(input.key);
	const name = validName(input.name);
	const space = await checkPrivateSpace(caller, input.key).catch((e) => {
		if (e instanceof PrivateEventRefused) throw e;
		console.error(`[private-events] ${caller.did}: ${input.key} unchecked:`, e);
		throw new PrivateEventRefused('unchecked');
	});
	const found = await credentialSpaceReader(caller)
		.get({ space, repo: caller.did, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY })
		.catch(() => null);
	const createdAt = found?.value.createdAt;
	const kept = typeof createdAt === 'string' ? createdAt : new Date().toISOString();
	await putName(caller, space, nameRecord(name, kept));
}

/** Deleting the space ends everyone's access to every event on it at once. */
export async function deleteCalendar(caller: CallerSession, key: string): Promise<void> {
	requireHost(caller);
	requireCalendarKey(key);
	const space = privateEventSpace(caller.did, key);
	await write(caller, 'com.atproto.space.deleteSpace', { space }, `calendar ${key} not deleted`);
}

export interface CalendarMember {
	did: string;
	handle: string | null;
}

/** On the list, able to read every event and answer each one. As with a single event's guests, a
 *  PDS answers the same for someone whose own server can't take part. */
export async function addCalendarMember(
	caller: CallerSession,
	input: { key: string; handleOrDid: string }
): Promise<CalendarMember> {
	requireHost(caller);
	requireCalendarKey(input.key);
	const actor = input.handleOrDid.trim().replace(/^@/, '');
	const did = await actorToDid(actor, timeLimitedNetwork()).catch(() => null);
	if (!did) throw new PrivateEventRefused('no-such-person');
	if (did === caller.did) throw new PrivateEventRefused('own-calendar');
	const space = privateEventSpace(caller.did, input.key);
	const body = { space, members: [{ did, read: true, write: true }] };
	await write(caller, 'com.atproto.memberspace.putMembers', body, `not added to ${input.key}`);
	return { did, handle: await verifiedHandle(did) };
}

export async function removeCalendarMember(
	caller: CallerSession,
	input: { key: string; did: string }
): Promise<void> {
	requireHost(caller);
	requireCalendarKey(input.key);
	const body = { space: privateEventSpace(caller.did, input.key), dids: [input.did] };
	await write(
		caller,
		'com.atproto.memberspace.removeMembers',
		body,
		`not removed from ${input.key}`
	);
}

/** The calendar's name and its events, read with the caller's own access. Null for a calendar that
 *  isn't there and for a caller kept out alike. Only the owner's own records count. */
async function readCalendar(
	reader: SpaceReader,
	host: string,
	key: string
): Promise<{ name: string | null; events: FlatEventRecord[]; capped: boolean } | null> {
	if (!isCalendarKey(key)) return null;
	const space = privateEventSpace(host, key);
	try {
		const [named, listed] = await Promise.all([
			reader.get({ space, repo: host, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY }),
			reader.list({ space, repo: host, collection: EVENT_COLLECTION })
		]);
		const events = listed.records
			.map((record) => flatEvent(host, record))
			.filter((event): event is FlatEventRecord => event !== null);
		return { name: named ? calendarName(named.value) : null, events, capped: listed.capped };
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

/** Over once it has ended, or started when it has no end. */
function isPast(event: FlatEventRecord, now: number): boolean {
	const end = Date.parse(event.endsAt ?? event.startsAt);
	return Number.isFinite(end) && end < now;
}

const byStart = (a: FlatEventRecord, b: FlatEventRecord) =>
	Date.parse(a.startsAt) - Date.parse(b.startsAt);

export interface CalendarPage {
	key: string;
	host: string;
	/** Null for a missing or invalid name. */
	name: string | null;
	ownerHandle: string | null;
	/** Soonest first. */
	upcoming: FlatEventRecord[];
	/** Latest first. */
	past: FlatEventRecord[];
	/** There were too many to list, so there may be more events than these. */
	eventsCapped: boolean;
	/** The owner's own view of who is on it; null for anyone else. */
	members: CalendarMember[] | null;
	membersCapped: boolean;
}

/** What the calendar's page shows. It reads no one's answers: those are on each event's page. */
export async function readCalendarPage(
	caller: CallerSession,
	host: string,
	key: string,
	now = Date.now()
): Promise<CalendarPage | null> {
	if (!isCalendarKey(key)) return null;
	const calendar = await readCalendar(credentialSpaceReader(caller), host, key);
	if (!calendar) return null;
	let members: CalendarMember[] | null = null;
	let membersCapped = false;
	if (caller.did === host) {
		const listed = await memberPages(caller, privateEventSpace(host, key));
		membersCapped = listed.capped;
		members = await Promise.all(
			listed.dids.map(async (did) => ({ did, handle: await verifiedHandle(did) }))
		);
	}
	const past = calendar.events.filter((event) => isPast(event, now));
	return {
		key,
		host,
		name: calendar.name,
		ownerHandle: await verifiedHandle(host),
		upcoming: calendar.events.filter((event) => !isPast(event, now)).sort(byStart),
		past: past.sort((a, b) => byStart(b, a)),
		eventsCapped: calendar.capped,
		members,
		membersCapped
	};
}

export interface CalendarEventPage extends PrivateEventPage {
	calendar: { key: string; name: string | null };
}

/** An event on a calendar, as a single event's page shows it. For the owner, the guests are the
 *  calendar's people, each with their answer to this event. */
export async function readCalendarEventPage(
	caller: CallerSession,
	address: EventAddress
): Promise<CalendarEventPage | null> {
	if (!isCalendarKey(address.spaceKey)) return null;
	const reader = credentialSpaceReader(caller);
	const space = privateEventSpace(address.host, address.spaceKey);
	const [page, named] = await Promise.all([
		readPrivateEventPage(caller, address, reader),
		reader
			.get({ space, repo: address.host, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY })
			.catch((e) => {
				if (isSpaceAccessDenied(e)) return null;
				console.info(`[private-events] the name of ${space} unread for ${caller.did}:`, e);
				return null;
			})
	]);
	if (!page) return null;
	return {
		...page,
		calendar: { key: address.spaceKey, name: named ? calendarName(named.value) : null }
	};
}

export interface MyCalendar {
	key: string;
	host: string;
	name: string | null;
	ownerHandle: string | null;
	owning: boolean;
	href: string;
}

/** The caller's own calendars, for choosing one to put an event on. Any not read are left out. */
export async function ownCalendars(caller: CallerSession): Promise<MyCalendar[]> {
	requireHost(caller);
	const { spaces } = await listedSpaces(caller, true);
	const keys = spaces
		.map((uri) => parseSpaceUri(uri))
		.filter((parsed) => parsed?.authority === caller.did && isCalendarKey(parsed.key))
		.map((parsed) => parsed!.key);
	const reader = credentialSpaceReader(caller);
	const ownerHandle = await verifiedHandle(caller.did);
	const calendars = await Promise.all(
		keys.map(async (key) => {
			const space = privateEventSpace(caller.did, key);
			const named = await reader
				.get({ space, repo: caller.did, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY })
				.catch((e) => {
					console.info(`[private-events] the name of ${space} unread:`, e);
					return undefined;
				});
			if (named === undefined) return null;
			return {
				key,
				host: caller.did,
				name: named ? calendarName(named.value) : null,
				ownerHandle,
				owning: true,
				href: calendarPath(ownerHandle ?? caller.did, key)
			};
		})
	);
	return calendars.filter((calendar) => calendar !== null);
}

export interface MyPrivateEventsAndCalendars {
	events: MyPrivateEvent[];
	calendars: MyCalendar[];
	incomplete: boolean;
}

/** /private: single events and events on calendars together, soonest first, and the calendars. A
 *  calendar shows here once they own it or have written in it, which is all their PDS lists. */
export async function myPrivateEventsAndCalendars(
	caller: CallerSession
): Promise<MyPrivateEventsAndCalendars> {
	const single = await myPrivateEvents(caller);
	const reader = credentialSpaceReader(caller);
	let incomplete = single.incomplete;
	const read = await Promise.all(
		single.calendars.map(async ({ host, key }) => {
			const calendar = await readCalendar(reader, host, key).catch((e) => {
				console.info(`[private-events] calendar ${key} of ${host} unread for ${caller.did}:`, e);
				incomplete = true;
				return null;
			});
			if (!calendar) return null;
			if (calendar.capped) incomplete = true;
			const ownerHandle = await verifiedHandle(host);
			const href = calendarPath(ownerHandle ?? host, key);
			const name = calendar.name;
			const summary: MyCalendar = {
				key,
				host,
				name,
				ownerHandle,
				owning: host === caller.did,
				href
			};
			const events: MyPrivateEvent[] = calendar.events.map((event) => ({
				event,
				hosting: host === caller.did,
				hostHandle: ownerHandle,
				href: eventPath(ownerHandle ?? host, { spaceKey: key, rkey: event.rkey }),
				calendar: { name, key }
			}));
			return { summary, events };
		})
	);
	const found = read.filter((calendar) => calendar !== null);
	return {
		events: [...single.events, ...found.flatMap((calendar) => calendar.events)].sort(
			(a, b) => Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt)
		),
		calendars: found.map((calendar) => calendar.summary),
		incomplete
	};
}

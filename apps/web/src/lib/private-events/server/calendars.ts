// A shared calendar: one space on its owner's PDS, holding a list of people and any number of the
// owner's private events. Everyone on the list can read every event on it, past ones included, and
// answers each one in their own repo in the space. Only the owner adds events or changes the list:
// every write here goes to the caller's own calendar, and an event counts only from the owner's repo.
// A space is a calendar when it has a name, or was made as one (its key says so). A single event's
// space becomes one when its host names it: nothing moves, so every link to the event still works.
import { now as tidNow } from '@atcute/tid';
import type { FlatEventRecord } from '#lib/contrail.js';
import { actorToDid } from '#lib/actor.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	credentialSpaceReader,
	type SpaceReader,
	type SpaceRecord
} from '#lib/spaces/server/space-read.js';
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
	readSpaceName,
	requireHost,
	savePrivateEvent,
	write,
	type MyPrivateEvent,
	type PrivateEventPage
} from './events';
import { verifiedHandle } from './people';

/** Where a space's server shows its list of people to everyone on it, one record per person in the
 *  owner's repo there, keyed by their DID. Written only by that server, and only where the space's
 *  policy asks for it, as a calendar's does. */
const MEMBER_COLLECTION = 'com.atproto.memberspace.member';
const MEMBER_POLICY = 'com.atproto.memberspace.policy';

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
		space = await ensurePrivateSpace(caller, key, { publishMembers: true });
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

/** One of the caller's own private spaces, checked before anything is written to it: one that was
 *  never made, or that anyone can read, is refused. */
async function ownPrivateSpace(caller: CallerSession, key: string): Promise<string> {
	return checkPrivateSpace(caller, key).catch((e) => {
		if (e instanceof PrivateEventRefused) throw e;
		console.error(`[private-events] ${caller.did}: ${key} unchecked:`, e);
		throw new PrivateEventRefused('unchecked');
	});
}

/** Names one of the caller's own spaces, or renames it. A single event's space named this way is a
 *  shared calendar from then on, its people shown to everyone on it: the event, its guests and their
 *  answers stay where they are. */
export async function renameCalendar(
	caller: CallerSession,
	input: { key: string; name: string }
): Promise<void> {
	requireCalendarHost(caller);
	const name = validName(input.name);
	const space = await ownPrivateSpace(caller, input.key);
	const found = await credentialSpaceReader(caller)
		.get({ space, repo: caller.did, collection: CALENDAR_COLLECTION, rkey: CALENDAR_RKEY })
		.catch(() => null);
	const createdAt = found?.value.createdAt;
	const kept = typeof createdAt === 'string' ? createdAt : new Date().toISOString();
	await putName(caller, space, nameRecord(name, kept));
	// Only once it has a name, so a single event's guests are never shown to each other unnamed.
	await showPeopleOnIt(caller, space);
}

/** A new single event whose space is named at once, so its guests are a shared calendar from the
 *  start. The name is written after the event: when it fails, the event is still there, unnamed, and
 *  saving again names it. */
export async function saveNamedEvent(
	caller: CallerSession,
	input: { rkey: string; record: Record<string, unknown>; calendar?: string; name: string }
): Promise<{ uri: string; cid: string }> {
	requireCalendarHost(caller);
	// An event already on a calendar goes by that calendar's name.
	if (input.calendar !== undefined) throw new PrivateEventRefused('named-on-calendar');
	const name = validName(input.name);
	const saved = await savePrivateEvent(caller, { rkey: input.rkey, record: input.record });
	const space = privateEventSpace(caller.did, input.rkey);
	try {
		await putName(caller, space, nameRecord(name, new Date().toISOString()));
	} catch {
		throw new PrivateEventRefused('name-not-saved');
	}
	await showPeopleOnIt(caller, space);
	return saved;
}

/** Deleting the space ends everyone's access to every event on it at once. */
export async function deleteCalendar(caller: CallerSession, key: string): Promise<void> {
	requireHost(caller);
	const space = await ownPrivateSpace(caller, key);
	await write(caller, 'com.atproto.space.deleteSpace', { space }, `calendar ${key} not deleted`);
}

export interface CalendarPerson {
	did: string;
	handle: string | null;
}

/** On the list, able to read every event and answer each one. As with a single event's guests, a
 *  PDS answers the same for someone whose own server can't take part. */
export async function addPersonToCalendar(
	caller: CallerSession,
	input: { key: string; handleOrDid: string }
): Promise<CalendarPerson> {
	requireHost(caller);
	const actor = input.handleOrDid.trim().replace(/^@/, '');
	const did = await actorToDid(actor, timeLimitedNetwork()).catch(() => null);
	if (!did) throw new PrivateEventRefused('no-such-person');
	if (did === caller.did) throw new PrivateEventRefused('own-calendar');
	const space = await ownPrivateSpace(caller, input.key);
	const body = { space, members: [{ did, read: true, write: true }] };
	await write(caller, 'com.atproto.memberspace.putMembers', body, `not added to ${input.key}`);
	return { did, handle: await verifiedHandle(did) };
}

export async function removePersonFromCalendar(
	caller: CallerSession,
	input: { key: string; did: string }
): Promise<void> {
	requireHost(caller);
	const body = { space: await ownPrivateSpace(caller, input.key), dids: [input.did] };
	await write(
		caller,
		'com.atproto.memberspace.removeMembers',
		body,
		`not removed from ${input.key}`
	);
}

/** Whether a space with this name record is a calendar: one with a name, or made as one. */
function isCalendar(key: string, named: unknown): boolean {
	return named !== null || isCalendarKey(key);
}

/** The calendar's name and its events, read with the caller's own access. Null for a calendar that
 *  isn't there and for a caller kept out alike, and for a space that isn't a calendar. Only the
 *  owner's own records count. */
async function readCalendar(
	reader: SpaceReader,
	host: string,
	key: string,
	known?: SpaceRecord | null
): Promise<{ name: string | null; events: FlatEventRecord[]; capped: boolean } | null> {
	const space = privateEventSpace(host, key);
	try {
		const [named, listed] = await Promise.all([
			known === undefined ? readSpaceName(reader, host, key) : known,
			reader.list({ space, repo: host, collection: EVENT_COLLECTION })
		]);
		if (!isCalendar(key, named)) return null;
		const events = listed.records
			.map((record) => flatEvent(host, record))
			.filter((event): event is FlatEventRecord => event !== null);
		return { name: named ? calendarName(named.value) : null, events, capped: listed.capped };
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

/** Only the calendar's name, for a page that lists calendars and not their events. Null for a
 *  calendar the caller is kept out of, as `readCalendar`. */
async function readCalendarName(
	reader: SpaceReader,
	host: string,
	key: string,
	known?: SpaceRecord | null
): Promise<{ name: string | null; events: FlatEventRecord[]; capped: boolean } | null> {
	try {
		const named = known === undefined ? await readSpaceName(reader, host, key) : known;
		if (!isCalendar(key, named)) return null;
		return { name: named ? calendarName(named.value) : null, events: [], capped: false };
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

/** A record key's DID: a server writes a localhost did:web's port with a plain colon, since `%` can't
 *  be in a key. Only local test networks have one. */
function recordKeyToDid(rkey: string): string {
	return rkey.replace(/^(did:web:[^:]+):(\d+)$/, '$1%3A$2');
}

/** The people the owner's server shows everyone on the calendar, read with the caller's own access
 *  from the owner's repo only. Null where it shows none: a calendar made before calendars did, until
 *  its owner next opens it. */
async function publishedPeople(
	reader: SpaceReader,
	host: string,
	key: string
): Promise<{ dids: string[]; capped: boolean } | null> {
	const listed = await reader.list({
		space: privateEventSpace(host, key),
		repo: host,
		collection: MEMBER_COLLECTION
	});
	const dids = listed.records
		.filter((record) => record.value.read === true)
		.map((record) => recordKeyToDid(record.rkey));
	return dids.length > 0 ? { dids, capped: listed.capped } : null;
}

/** Has the owner's server show the calendar's people to everyone on it, for a calendar made before
 *  calendars did. Keeps the rest of its policy. Never fails the page: it is tried again next time. */
async function showPeopleOnIt(caller: CallerSession, space: string): Promise<void> {
	try {
		const found = await xrpc(caller.handle, 'com.atproto.space.getSpace', { query: { space } });
		const policy = found.policy as Record<string, unknown> | undefined;
		// A space anyone can read isn't a private calendar, and must not publish its people to anyone.
		if (policy?.$type !== MEMBER_POLICY || policy.publicRead === true) return;
		if (policy.publishMembers === true) return;
		await xrpc(caller.handle, 'com.atproto.space.updateSpace', {
			body: { space, policy: { ...policy, publishMembers: true } }
		});
	} catch (e) {
		console.error(`[private-events] ${caller.did}: ${space} not switched to show its people:`, e);
	}
}

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
	/** Who is on it: the owner's own list, or the one their server shows everyone on it; null where
	 *  there is none to show or it couldn't be read. */
	people: CalendarPerson[] | null;
	peopleCapped: boolean;
}

/** What the calendar's page shows. It reads no one's answers: those are on each event's page. */
export async function readCalendarPage(
	caller: CallerSession,
	host: string,
	key: string,
	now = Date.now()
): Promise<CalendarPage | null> {
	const reader = credentialSpaceReader(caller);
	const calendar = await readCalendar(reader, host, key);
	if (!calendar) return null;
	let listed: { dids: string[]; capped: boolean } | null;
	if (caller.did === host) {
		const space = privateEventSpace(host, key);
		await showPeopleOnIt(caller, space);
		listed = await memberPages(caller, space);
	} else {
		listed = await publishedPeople(reader, host, key).catch((e) => {
			console.info(`[private-events] the people on ${key} unread for ${caller.did}:`, e);
			return null;
		});
	}
	const people = listed
		? await Promise.all(
				listed.dids.map(async (did) => ({ did, handle: await verifiedHandle(did) }))
			)
		: null;
	const peopleCapped = listed?.capped ?? false;
	const past = calendar.events.filter((event) => isPast(event, now));
	return {
		key,
		host,
		name: calendar.name,
		ownerHandle: await verifiedHandle(host),
		upcoming: calendar.events.filter((event) => !isPast(event, now)).sort(byStart),
		past: past.sort((a, b) => byStart(b, a)),
		eventsCapped: calendar.capped,
		people,
		peopleCapped
	};
}

export interface CalendarEventPage extends PrivateEventPage {
	calendar: { key: string; name: string | null };
}

export interface SpaceEventPage extends PrivateEventPage {
	/** The calendar the event is on; null for a single event, whose space has no name. */
	calendar: { key: string; name: string | null } | null;
}

/** An event in any private space, and the calendar it is on when its space is one. On a calendar,
 *  the guests are the calendar's people, each with their answer to this event: the owner's own list,
 *  or for someone on it the list the owner's server shows them. A single event's guests are as
 *  `readPrivateEventPage` gives them. */
export async function readSpaceEventPage(
	caller: CallerSession,
	address: EventAddress
): Promise<SpaceEventPage | null> {
	const reader = credentialSpaceReader(caller);
	const space = privateEventSpace(address.host, address.spaceKey);
	const named = readSpaceName(reader, address.host, address.spaceKey).catch((e) => {
		if (isSpaceAccessDenied(e)) return null;
		// A space made as a calendar is one either way, and shows untitled. Any other space can't be
		// told from a single event without its name. If it has one, its people are shown to everyone
		// on it, and a single event's page would say only the host sees them.
		if (!isCalendarKey(address.spaceKey)) throw e;
		console.info(`[private-events] the name of ${space} unread for ${caller.did}:`, e);
		return null;
	});
	const published = async () => {
		if (!isCalendar(address.spaceKey, await named)) return null;
		return publishedPeople(reader, address.host, address.spaceKey).catch((e) => {
			console.info(`[private-events] the people on ${space} unread for ${caller.did}:`, e);
			return null;
		});
	};
	const [page, record] = await Promise.all([
		readPrivateEventPage(caller, address, reader, published),
		named
	]);
	if (!page) return null;
	const calendar = isCalendar(address.spaceKey, record)
		? { key: address.spaceKey, name: record ? calendarName(record.value) : null }
		: null;
	return { ...page, calendar };
}

/** An event on a calendar, as a single event's page shows it; null where its space isn't a calendar. */
export async function readCalendarEventPage(
	caller: CallerSession,
	address: EventAddress
): Promise<CalendarEventPage | null> {
	const found = await readSpaceEventPage(caller, address);
	if (!found?.calendar) return null;
	return { ...found, calendar: found.calendar };
}

export interface MyCalendar {
	key: string;
	host: string;
	name: string | null;
	ownerHandle: string | null;
	owning: boolean;
	href: string;
}

/** How many of the caller's other spaces, newest first, have their names read for the list of their
 *  own calendars. Each is a few outbound requests, and a request may make only so many. */
export const NAMED_SPACES_READ = 10;

/** The caller's own calendars, for choosing one to put an event on: each made as a calendar, and
 *  each of their other spaces with a name, of the newest few and of `wanted`, the one a page asks
 *  for. One made as a calendar whose name can't be read is still listed, untitled, so a page that
 *  names it finds it; any other space is left out. `capped` when older spaces went unread, so there
 *  may be more calendars than these. */
export async function ownCalendars(
	caller: CallerSession,
	options: { wanted?: string } = {}
): Promise<{ calendars: MyCalendar[]; capped: boolean }> {
	requireHost(caller);
	const { spaces } = await listedSpaces(caller, true);
	const keys = spaces
		.map((uri) => parseSpaceUri(uri))
		.filter((parsed) => parsed?.authority === caller.did)
		.map((parsed) => parsed!.key);
	// A single event's key is a TID, which sorts by time.
	const others = keys.filter((key) => !isCalendarKey(key)).sort((a, b) => (a < b ? 1 : -1));
	const read = new Set([
		...keys.filter(isCalendarKey),
		...others.slice(0, NAMED_SPACES_READ),
		...(options.wanted && keys.includes(options.wanted) ? [options.wanted] : [])
	]);
	const reader = credentialSpaceReader(caller);
	const ownerHandle = await verifiedHandle(caller.did);
	const found = await Promise.all(
		[...read].map(async (key): Promise<MyCalendar | null> => {
			const named = await readSpaceName(reader, caller.did, key).catch((e) => {
				console.info(`[private-events] the name of ${key} unread:`, e);
				return null;
			});
			if (!isCalendar(key, named)) return null;
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
	return {
		calendars: found.filter((calendar) => calendar !== null),
		capped: others.some((key) => !read.has(key))
	};
}

export interface MyPrivateEventsAndCalendars {
	events: MyPrivateEvent[];
	calendars: MyCalendar[];
	/** Something couldn't be read just now, so there may be more than these. */
	incomplete: boolean;
	/** A calendar has more events than one listing returns, so there may be more than these. */
	capped: boolean;
}

/** Single events and events on calendars together, soonest first, and the calendars, for Your
 *  events. A calendar shows once they own it or have written in it, which is all their PDS lists.
 *  `calendarEvents: false` reads only each calendar's name, for the Calendars page, which lists a
 *  calendar's events on the calendar's own page. */
export async function myPrivateEventsAndCalendars(
	caller: CallerSession,
	options: { calendarEvents?: boolean } = {}
): Promise<MyPrivateEventsAndCalendars> {
	const readOne = options.calendarEvents === false ? readCalendarName : readCalendar;
	const single = await myPrivateEvents(caller);
	const reader = credentialSpaceReader(caller);
	let incomplete = single.incomplete;
	let capped = false;
	const read = await Promise.all(
		single.calendars.map(async ({ host, key, named }) => {
			const calendar = await readOne(reader, host, key, named).catch((e) => {
				console.info(`[private-events] calendar ${key} of ${host} unread for ${caller.did}:`, e);
				incomplete = true;
				return null;
			});
			if (!calendar) return null;
			if (calendar.capped) capped = true;
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
		incomplete,
		capped
	};
}

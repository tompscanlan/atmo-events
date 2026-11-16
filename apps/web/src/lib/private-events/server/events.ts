// A person's private event: written to a space on their own PDS, and read directly from the PDS
// with each person's own access, so the PDS alone decides who sees it. It never reaches the index
// or a public URL. A single event has a space of its own, under the event's key, so each one has
// its own guest list. Once its host names that space, it is a shared calendar like any other, and
// the event stays where it is.
import * as v from '@atcute/lexicons/validations';
import type { AttendeeInfo, FlatEventRecord } from '#lib/contrail.js';
import { actorToDid } from '#lib/actor.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	credentialSpaceReader,
	type SpaceReader,
	type SpaceRecord
} from '#lib/spaces/server/space-read.js';
import { errorKind, isRecordNotFound, xrpc, XrpcError } from '#lib/spaces/server/xrpc.js';
import { parseSpaceUri } from '#lib/spaces/uri.js';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import {
	calendarEvent,
	CALENDAR_COLLECTION,
	CALENDAR_NAME_MAX,
	CALENDAR_RKEY,
	EVENT_COLLECTION,
	eventPath,
	isSingleEvent,
	eventSpace,
	eventUri,
	PRIVATE_CALENDAR_TYPE,
	privateEventSpace,
	RSVP_COLLECTION,
	RSVP_STATUSES,
	singleEvent,
	type EventAddress,
	type EventKeys,
	type RsvpStatus
} from '../ids';
import { holdsGuestGrant, holdsHostGrant } from '../scopes';
import type { CallerSession } from './caller';
import { verifiedHandle } from './people';

const REFUSALS = {
	'no-grant': "atmo doesn't have your permission for this yet, so nothing changed.",
	'not-an-event': 'That is not a valid event, so nothing was saved.',
	'not-private': 'That space can be read by more than its guests, so nothing was saved.',
	'no-event': "This event isn't there for you anymore, so nothing was saved.",
	changed: 'This event changed since you opened it. Reload to see the latest, then answer again.',
	unchecked: "That couldn't be saved just now. Try again shortly.",
	refused: "Your server didn't take the change, so nothing changed.",
	'no-such-person': "No one with that handle was found, so they weren't added.",
	'own-event': "You're the host, so you're already on your own event.",
	'no-calendar': "That calendar isn't there anymore, so nothing changed.",
	'own-calendar': "It's your calendar, so you're already on it.",
	'bad-name': `A calendar's name needs 1 to ${CALENDAR_NAME_MAX} characters, so nothing was saved.`
} as const;

/** In words a page can show; a PDS's own message is never kept. */
export class PrivateEventRefused extends Error {
	constructor(readonly reason: Refusal) {
		super(REFUSALS[reason]);
		this.name = 'PrivateEventRefused';
	}
}

export function requireHost(caller: CallerSession): void {
	if (!holdsHostGrant(caller.scope, caller.did)) throw new PrivateEventRefused('no-grant');
}

/** Writes to the person's own PDS. If that fails, the page is told in our words, and the log gets
 *  only `failed` and the failure's kind. Every log here names an operation and never a person, a
 *  space or an event, so none can tell who is invited to what. */
export async function write(
	caller: CallerSession,
	nsid: string,
	body: Record<string, unknown>,
	failed: string
): Promise<void> {
	try {
		await xrpc(caller.handle, nsid, { body });
	} catch (e) {
		console.error(`[private-events] ${failed}: ${errorKind(e)}`);
		throw new PrivateEventRefused('refused');
	}
}

function isAlreadyThere(e: unknown): boolean {
	return e instanceof XrpcError && e.error === 'SpaceAlreadyExists';
}

function isGone(e: unknown): boolean {
	return e instanceof XrpcError && (e.error === 'SpaceNotFound' || e.error === 'SpaceDeleted');
}

export type Refusal = keyof typeof REFUSALS;

/** Checks a space of the caller's own: a write into a space that was never made succeeds anyway,
 *  and one that lets everyone read would publish what is written there. */
async function checkPrivateSpace(
	caller: CallerSession,
	spaceKey: string,
	whenGone: Refusal = 'no-calendar'
): Promise<string> {
	const space = privateEventSpace(caller.did, spaceKey);
	const found = await xrpc(caller.handle, 'com.atproto.space.getSpace', {
		query: { space }
	}).catch((e) => {
		if (isGone(e)) throw new PrivateEventRefused(whenGone);
		throw e;
	});
	const policy = found.policy as { $type?: unknown; publicRead?: unknown } | undefined;
	if (policy?.$type !== 'com.atproto.memberspace.policy' || policy.publicRead === true) {
		throw new PrivateEventRefused('not-private');
	}
	return space;
}

/** Makes a space of the caller's own if need be, then checks it. `publishMembers` has their server
 *  show the list of people to everyone on it, as a shared calendar's does. */
export async function ensurePrivateSpace(
	caller: CallerSession,
	spaceKey: string,
	options: { publishMembers?: boolean } = {}
): Promise<string> {
	try {
		await xrpc(caller.handle, 'com.atproto.space.createSpace', {
			body: {
				spaceType: PRIVATE_CALENDAR_TYPE,
				skey: spaceKey,
				policy: {
					$type: 'com.atproto.memberspace.policy',
					publishPolicy: true,
					...(options.publishMembers ? { publishMembers: true } : {})
				}
			}
		});
	} catch (e) {
		if (!isAlreadyThere(e)) throw e;
	}
	return checkPrivateSpace(caller, spaceKey, 'refused');
}

/** A space's name record, in its owner's repo there; null when it has none. A space with one is a
 *  shared calendar. A failure to read it throws, so "could not read" never passes for "no name". */
export async function readSpaceName(
	reader: SpaceReader,
	host: string,
	spaceKey: string
): Promise<SpaceRecord | null> {
	const found = await reader.get({
		space: privateEventSpace(host, spaceKey),
		repo: host,
		collection: CALENDAR_COLLECTION,
		rkey: CALENDAR_RKEY
	});
	return found ?? null;
}

/** A shared calendar of the caller's own: a space of theirs with a name. Throws when the name can't
 *  be read. */
export async function isOwnCalendar(caller: CallerSession, spaceKey: string): Promise<boolean> {
	return (await readSpaceName(credentialSpaceReader(caller), caller.did, spaceKey)) !== null;
}

/** A link the kit would load as the event's picture by itself. */
function isEventImage(link: unknown): boolean {
	return (link as { name?: unknown } | null)?.name === 'Event Image';
}

/** What `flatEvent` leaves out of every page's copy, put back from the stored record, so an edit
 *  made from that copy keeps it. */
function keepUnshown(record: Record<string, unknown>, stored: Record<string, unknown> | undefined) {
	if (!stored) return;
	if (stored.media !== undefined) record.media = stored.media;
	if (stored.poster !== undefined) record.poster = stored.poster;
	const images = Array.isArray(stored.uris) ? stored.uris.filter(isEventImage) : [];
	if (images.length > 0) {
		record.uris = [...(Array.isArray(record.uris) ? record.uris : []), ...images];
	}
}

/** The event, with no image from the page, since atmo can't show a private one yet; an edit keeps
 *  the one stored. With `calendar`, it goes on that shared calendar of the caller's own, which must
 *  be there already and have a name; without, it gets a space of its own. */
export async function savePrivateEvent(
	caller: CallerSession,
	input: { rkey: string; record: Record<string, unknown>; calendar?: string }
): Promise<{ uri: string; cid: string }> {
	requireHost(caller);
	const record: Record<string, unknown> = { ...input.record, $type: EVENT_COLLECTION };
	delete record.media;
	// A PDS doesn't validate a space record at all.
	if (!v.safeParse(eventSchema, record).ok) throw new PrivateEventRefused('not-an-event');
	const address = input.calendar
		? calendarEvent(caller.did, input.calendar, input.rkey)
		: singleEvent(caller.did, input.rkey);
	const reader = credentialSpaceReader(caller);
	try {
		const space = input.calendar
			? await checkPrivateSpace(caller, address.spaceKey)
			: await ensurePrivateSpace(caller, address.spaceKey);
		// A single event's space holds only its own event until its host names it.
		if (input.calendar && !(await readSpaceName(reader, caller.did, address.spaceKey))) {
			throw new PrivateEventRefused('no-calendar');
		}
		const stored = await reader.get({
			space,
			repo: caller.did,
			collection: EVENT_COLLECTION,
			rkey: address.rkey
		});
		keepUnshown(record, stored?.value);
		const saved = await xrpc(caller.handle, 'com.atproto.space.putRecord', {
			body: {
				space,
				repo: caller.did,
				collection: EVENT_COLLECTION,
				rkey: address.rkey,
				record
			}
		});
		return { uri: eventUri(address), cid: String(saved.cid) };
	} catch (e) {
		if (e instanceof PrivateEventRefused) throw e;
		console.error(`[private-events] event not saved: ${errorKind(e)}`);
		throw new PrivateEventRefused('refused');
	}
}

/** For a single event, deleting its space ends every guest's access. Their answers stay in their
 *  own repos, unreadable. An event on a shared calendar is only taken off it, and the calendar stays,
 *  even when the event is the one its space was made for: the space has a name by then. */
export async function cancelPrivateEvent(caller: CallerSession, keys: EventKeys): Promise<void> {
	requireHost(caller);
	const address = { ...keys, host: caller.did };
	const space = eventSpace(address);
	const failed = 'event not cancelled';
	// Without the name, the space can't be told apart from a calendar, and must not be deleted.
	const onCalendar = await isOwnCalendar(caller, keys.spaceKey).catch((e) => {
		console.error(`[private-events] space name unread for a cancel: ${errorKind(e)}`);
		throw new PrivateEventRefused('unchecked');
	});
	if (!onCalendar) {
		if (!isSingleEvent(keys)) throw new PrivateEventRefused('no-event');
		await write(caller, 'com.atproto.space.deleteSpace', { space }, failed);
		return;
	}
	try {
		await xrpc(caller.handle, 'com.atproto.space.deleteRecord', {
			body: { space, repo: caller.did, collection: EVENT_COLLECTION, rkey: keys.rkey }
		});
	} catch (e) {
		if (isRecordNotFound(e)) return;
		console.error(`[private-events] ${failed}: ${errorKind(e)}`);
		throw new PrivateEventRefused('refused');
	}
}

/** As the event components take it: the record whole, its address beside it, and no image, since a
 *  page would build a public CDN URL from it, or load a poster or an "Event Image" link from
 *  wherever it points without a click. Null for what isn't an event, since a PDS doesn't
 *  validate a space record and any host could write one that breaks their guests' pages, and with
 *  no start, which every page needs. */
export function flatEvent(host: string, record: SpaceRecord): FlatEventRecord | null {
	const value = { ...record.value };
	delete value.media;
	delete value.poster;
	if (Array.isArray(value.uris)) {
		value.uris = value.uris.filter((link) => !isEventImage(link));
	}
	if (typeof value.startsAt !== 'string' || !v.safeParse(eventSchema, value).ok) return null;
	return {
		...(value as unknown as FlatEventRecord),
		cid: record.cid,
		did: host,
		rkey: record.rkey,
		uri: record.uri
	};
}

/** Null for an event that isn't there and for a caller kept out alike, so a page can't tell one
 *  from the other. Any other failure throws, so "could not read" never passes for "none". Only the
 *  host's own record is the event. */
export async function readEvent(
	reader: SpaceReader,
	address: EventAddress
): Promise<FlatEventRecord | null> {
	try {
		const found = await reader.get({
			space: eventSpace(address),
			repo: address.host,
			collection: EVENT_COLLECTION,
			rkey: address.rkey
		});
		return found ? flatEvent(address.host, found) : null;
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

function rsvpStatus(address: EventAddress, value: Record<string, unknown>): RsvpStatus | null {
	const subject = value.subject as { uri?: unknown } | undefined;
	if (subject?.uri !== eventUri(address)) return null;
	return RSVP_STATUSES.find((s) => value.status === `${RSVP_COLLECTION}#${s}`) ?? null;
}

export interface Guest {
	did: string;
	handle: string | null;
	/** What they answered, so a record of theirs is in the space; null until they do. */
	answer: RsvpStatus | null;
	/** An answer may be there that could not be read, so null above says nothing about them. */
	answerUnread: boolean;
}

export interface PrivateEventPage {
	event: FlatEventRecord;
	hostHandle: string | null;
	attendees: {
		going: AttendeeInfo[];
		interested: AttendeeInfo[];
		goingCount: number;
		interestedCount: number;
	};
	viewerStatus: RsvpStatus | null;
	/** A server didn't answer, so the answers above may not be all of them. */
	answersUnread: boolean;
	/** Who was added: the host's own list, or for someone else the list a calendar shows everyone on
	 *  it; null where they can't see one. */
	guests: Guest[] | null;
	/** The host's list stopped at the page limit, so there may be more guests than these. */
	guestsCapped: boolean;
}

const LIST_LIMIT = 100;
const MAX_PAGES = 10;

/** The people on a space of the caller's own, up to a limit of pages; `capped` when it stopped there. */
export async function memberPages(
	caller: CallerSession,
	space: string
): Promise<{ dids: string[]; capped: boolean }> {
	const dids: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const found = await xrpc(caller.handle, 'com.atproto.memberspace.listMembers', {
			query: { space, limit: String(LIST_LIMIT), ...(cursor ? { cursor } : {}) }
		});
		const members = Array.isArray(found.members) ? found.members : [];
		for (const member of members) {
			const did = (member as { did?: unknown } | null)?.did;
			if (typeof did === 'string') dids.push(did);
		}
		cursor = typeof found.cursor === 'string' ? found.cursor : undefined;
		if (!cursor || members.length === 0) return { dids, capped: false };
	}
	return { dids, capped: true };
}

/** Null when the caller may not see it. An answer counts only from someone the PDS tracks as a
 *  writer: a person taken off the list is no longer tracked, and someone let back in isn't until
 *  they answer again, so they see no answer of theirs until they do. `published` gives someone
 *  other than the host the list of people, where the space shows them one; null for none. */
export async function readPrivateEventPage(
	caller: CallerSession,
	address: EventAddress,
	reader: SpaceReader = credentialSpaceReader(caller),
	published?: () => Promise<{ dids: string[]; capped: boolean } | null>
): Promise<PrivateEventPage | null> {
	const { host, rkey } = address;
	const event = await readEvent(reader, address);
	if (!event) return null;

	const space = eventSpace(address);
	const writers = await reader.writers(space).catch((e) => {
		console.error(`[private-events] writers unread: ${errorKind(e)}`);
		return null;
	});
	const unread = new Set<string>();
	const answers = new Map<string, RsvpStatus>();
	const going: AttendeeInfo[] = [];
	const interested: AttendeeInfo[] = [];
	let viewerStatus: RsvpStatus | null = null;
	await Promise.all(
		(writers ?? []).map(async (did) => {
			const found = await reader
				.get({ space, repo: did, collection: RSVP_COLLECTION, rkey })
				.catch((e) => {
					console.info(`[private-events] an answer unread: ${errorKind(e)}`);
					unread.add(did);
					return null;
				});
			const status = found ? rsvpStatus(address, found.value) : null;
			if (!status) return;
			answers.set(did, status);
			if (did === caller.did) viewerStatus = status;
			if (status === 'notgoing') return;
			const handle = await verifiedHandle(did);
			const attendee: AttendeeInfo = {
				did,
				status,
				name: handle ?? did,
				...(handle ? { handle } : {}),
				url: `/p/${encodeURIComponent(handle ?? did)}`
			};
			(status === 'going' ? going : interested).push(attendee);
		})
	);

	let guests: Guest[] | null = null;
	let guestsCapped = false;
	const members =
		caller.did === host ? await memberPages(caller, space) : ((await published?.()) ?? null);
	if (members) {
		guestsCapped = members.capped;
		guests = await Promise.all(
			members.dids.map(async (did) => ({
				did,
				handle: await verifiedHandle(did),
				answer: answers.get(did) ?? null,
				answerUnread: writers === null || unread.has(did)
			}))
		);
	}

	return {
		event,
		hostHandle: await verifiedHandle(host),
		attendees: {
			going,
			interested,
			goingCount: going.length,
			interestedCount: interested.length
		},
		viewerStatus,
		answersUnread: writers === null || unread.size > 0,
		guests,
		guestsCapped
	};
}

/** The caller's own event as stored, for its edit page; null when absent. */
export async function readPrivateEventForEdit(
	caller: CallerSession,
	keys: EventKeys
): Promise<FlatEventRecord | null> {
	requireHost(caller);
	return readEvent(credentialSpaceReader(caller), { ...keys, host: caller.did });
}

function requireAccess(caller: CallerSession, host: string): void {
	const held =
		caller.did === host ? holdsHostGrant(caller.scope, caller.did) : holdsGuestGrant(caller.scope);
	if (!held) throw new PrivateEventRefused('no-grant');
}

function ownRsvp(caller: CallerSession, address: EventAddress) {
	return {
		space: eventSpace(address),
		repo: caller.did,
		collection: RSVP_COLLECTION,
		rkey: address.rkey
	};
}

/** Written with a put, into the person's own repo in the space, never their public repo. The server
 *  picks the space, the key (the event's) and the subject (read with their own access, which also
 *  proves they are let in). `cid` is the event's as the page showed it, so no one answers a version
 *  they never saw. */
export async function putPrivateRsvp(
	caller: CallerSession,
	address: EventAddress,
	input: { status: RsvpStatus; cid: string | null }
): Promise<void> {
	requireAccess(caller, address.host);
	const event = await readEvent(credentialSpaceReader(caller), address).catch((e) => {
		console.error(`[private-events] event unread for an answer: ${errorKind(e)}`);
		throw new PrivateEventRefused('unchecked');
	});
	if (!event?.cid) throw new PrivateEventRefused('no-event');
	if (input.cid !== event.cid) throw new PrivateEventRefused('changed');
	const record = {
		$type: RSVP_COLLECTION,
		status: `${RSVP_COLLECTION}#${input.status}`,
		subject: { uri: eventUri(address), cid: event.cid },
		createdAt: new Date().toISOString()
	};
	const body = { ...ownRsvp(caller, address), record };
	await write(caller, 'com.atproto.space.putRecord', body, 'answer not saved');
}

export async function deletePrivateRsvp(
	caller: CallerSession,
	address: EventAddress
): Promise<void> {
	requireAccess(caller, address.host);
	try {
		await xrpc(caller.handle, 'com.atproto.space.deleteRecord', {
			body: ownRsvp(caller, address)
		});
	} catch (e) {
		if (isRecordNotFound(e)) return;
		console.error(`[private-events] answer not deleted: ${errorKind(e)}`);
		throw new PrivateEventRefused('refused');
	}
}

/** One of the caller's own private spaces, a single event's or a calendar's, checked before anything
 *  is written to it: one that was never made (`whenGone`), or that anyone can read, is refused. */
export async function ownPrivateSpace(
	caller: CallerSession,
	spaceKey: string,
	whenGone: Refusal = 'no-calendar'
): Promise<string> {
	return checkPrivateSpace(caller, spaceKey, whenGone).catch((e) => {
		if (e instanceof PrivateEventRefused) throw e;
		console.error(`[private-events] space unchecked before a change: ${errorKind(e)}`);
		throw new PrivateEventRefused('unchecked');
	});
}

/** Puts them on the event's list, which is all it takes to let them read. A PDS answers the same
 *  for someone whose own server has no spaces, who can never get in, and only their own sign-in
 *  can show that, so the host's page says who has answered. */
export async function addGuest(
	caller: CallerSession,
	input: { rkey: string; handleOrDid: string }
): Promise<Guest> {
	requireHost(caller);
	const actor = input.handleOrDid.trim().replace(/^@/, '');
	const did = await actorToDid(actor, timeLimitedNetwork()).catch(() => null);
	if (!did) throw new PrivateEventRefused('no-such-person');
	if (did === caller.did) throw new PrivateEventRefused('own-event');
	const space = await ownPrivateSpace(caller, input.rkey, 'no-event');
	const body = { space, members: [{ did, read: true, write: true }] };
	await write(caller, 'com.atproto.memberspace.putMembers', body, 'guest not added');
	return { did, handle: await verifiedHandle(did), answer: null, answerUnread: false };
}

export async function removeGuest(
	caller: CallerSession,
	input: { rkey: string; did: string }
): Promise<void> {
	requireHost(caller);
	const body = { space: await ownPrivateSpace(caller, input.rkey, 'no-event'), dids: [input.did] };
	await write(caller, 'com.atproto.memberspace.removeMembers', body, 'guest not removed');
}

/** The spaces the caller's own PDS lists for them: all they own or have written in, or with `own`,
 *  only those they own. Up to a limit of pages; `cutOff` when it stopped there. */
export async function listedSpaces(
	caller: CallerSession,
	own: boolean
): Promise<{ spaces: string[]; cutOff: boolean }> {
	const spaces: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const found = await xrpc(caller.handle, 'com.atproto.space.listSpaces', {
			query: {
				spaceType: PRIVATE_CALENDAR_TYPE,
				limit: String(LIST_LIMIT),
				...(own ? { spaceDid: caller.did } : {}),
				...(cursor ? { cursor } : {})
			}
		});
		const listed = Array.isArray(found.spaces) ? found.spaces : [];
		for (const entry of listed) {
			const space = (entry as { space?: unknown } | null)?.space;
			if (typeof space === 'string') spaces.push(space);
		}
		cursor = typeof found.cursor === 'string' ? found.cursor : undefined;
		if (!cursor || listed.length === 0) return { spaces, cutOff: false };
	}
	return { spaces, cutOff: true };
}

export interface MyPrivateEvent {
	event: FlatEventRecord;
	hosting: boolean;
	hostHandle: string | null;
	href: string;
	/** The shared calendar it is on, with its name, null when it has none; absent for a single event. */
	calendar?: { name: string | null; key: string };
}

export interface MyPrivateEvents {
	events: MyPrivateEvent[];
	/** A server didn't answer, or there were too many to list, so there may be more than these. */
	incomplete: boolean;
	/** Shared calendars among their spaces, to be read as calendars, each with its name record when
	 *  that was read here already (null for none), so it isn't read twice. */
	calendars: { host: string; key: string; named?: SpaceRecord | null }[];
}

/** Events they host or have answered, by their own PDS. It keeps spaces they were taken off or never
 *  let into, and misses ones they haven't written in, so each is read before it is listed. A space
 *  with a name is passed on with it, for the caller to read as a calendar. */
export async function myPrivateEvents(caller: CallerSession): Promise<MyPrivateEvents> {
	// Without a guest's grant, the PDS answers only for their own spaces.
	const { spaces, cutOff } = await listedSpaces(caller, !holdsGuestGrant(caller.scope));

	const reader = credentialSpaceReader(caller);
	let unread = 0;
	const calendars: MyPrivateEvents['calendars'] = [];
	const events = await Promise.all(
		spaces.map(async (uri): Promise<MyPrivateEvent | null> => {
			const parsed = parseSpaceUri(uri);
			if (!parsed) return null;
			const address = singleEvent(parsed.authority, parsed.key);
			const read = await Promise.all([
				readEvent(reader, address),
				readSpaceName(reader, parsed.authority, parsed.key).catch((e) => {
					if (isSpaceAccessDenied(e)) return null;
					throw e;
				})
			]).catch((e) => {
				console.info(`[private-events] a space unread for the list: ${errorKind(e)}`);
				unread++;
				return null;
			});
			if (!read) return null;
			const [event, named] = read;
			// Still a calendar once the event it was made for is cancelled.
			if (named) {
				calendars.push({ host: parsed.authority, key: parsed.key, named });
				return null;
			}
			if (!event) return null;
			const hostHandle = await verifiedHandle(parsed.authority);
			return {
				event,
				hosting: parsed.authority === caller.did,
				hostHandle,
				href: eventPath(hostHandle ?? parsed.authority, address)
			};
		})
	);
	return {
		events: events
			.filter((event): event is MyPrivateEvent => event !== null)
			.sort((a, b) => Date.parse(a.event.startsAt) - Date.parse(b.event.startsAt)),
		incomplete: cutOff || unread > 0,
		calendars
	};
}

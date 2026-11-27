// A group's members-only events, read from its calendar space with a space credential: a member's
// own, which the group host gives only to the group's roles, so the host decides who sees them; or
// the group's, through a link that may post them. The space may be one another app made and
// writes to as well, so only the group's own records of the event collection that are valid
// events are shown. Nothing is kept between requests, and the index never learns of one. Each log
// names an operation, never a person or an event.
import * as v from '@atcute/lexicons/validations';
import type { FlatEventRecord } from '#lib/contrail.js';
import { RSVP_COLLECTION, RSVP_STATUSES, type RsvpStatus } from '#lib/private-events/ids.js';
import {
	didSpaceHosts,
	exchangeSpaceCredential,
	fetchWithCredential,
	GET_RECORD,
	isSpaceAccessDenied,
	type SpaceCredential,
	type SpaceHolder,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import type { SpaceReader, SpaceRecord } from '#lib/spaces/server/space-read.js';
import {
	answerError,
	answerIsRecordNotFound,
	errorKind,
	readXrpc
} from '#lib/spaces/server/xrpc.js';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import { eventCalendarSpace, membersOnlyEventUri } from '../calendar';
import {
	GROUP_EVENT_COLLECTION,
	GROUP_POLICY_TYPE,
	SPACE_POLICY_COLLECTION,
	SPACE_POLICY_RKEY
} from '../ids';
import { chosenCalendar } from './calendar-choice';

/** Whether the calendar space is still for its members alone, as its authority publishes its
 *  policy in it (the group's `com.atproto.space.policy/self`), read with the same credential as
 *  its events, at the time they are shown. `public` for a policy that lets anyone read it, or one
 *  of a kind this site does not read, which may; `unknown` when it could not be read. Only
 *  `private` is shown as members-only. */
export type CalendarPrivacy = 'private' | 'public' | 'unknown';

export function calendarPrivacy(published: Record<string, unknown> | null): CalendarPrivacy {
	if (!published) return 'unknown';
	const policy = published.policy as { $type?: unknown; publicRead?: unknown } | undefined;
	return policy?.$type === GROUP_POLICY_TYPE && policy.publicRead !== true ? 'private' : 'public';
}

const policyQuery = (groupDid: string, space: string) => ({
	space,
	repo: groupDid,
	collection: SPACE_POLICY_COLLECTION,
	rkey: SPACE_POLICY_RKEY
});

/** The calendar space's privacy, read with `reader`; `unknown`, never a throw, when it could not
 *  be. */
export async function readCalendarPrivacy(
	reader: SpaceReader,
	groupDid: string,
	space: string
): Promise<CalendarPrivacy> {
	try {
		return calendarPrivacy((await reader.get(policyQuery(groupDid, space)))?.value ?? null);
	} catch (e) {
		console.info(`[groups] a calendar's policy unread: ${errorKind(e)}`);
		return 'unknown';
	}
}

/** A link that would load an outside image by itself, as the kit takes one named so. */
function isEventImage(link: unknown): boolean {
	return (link as { name?: unknown } | null)?.name === 'Event Image';
}

/** The event's address: in the calendar space its URI names, which a read checks; else `self`. */
function eventUri(groupDid: string, record: SpaceRecord): string {
	const space = eventCalendarSpace(groupDid, record.uri) ?? undefined;
	return membersOnlyEventUri(groupDid, record.rkey, space);
}

/** Whether the record is a valid event with a start, which every page needs. Another app writing
 *  to the same calendar may have written anything. */
function isEvent(value: Record<string, unknown>): boolean {
	return typeof value.startsAt === 'string' && v.safeParse(eventSchema, value).ok;
}

/** As the event components take it: the record, its address beside it. No picture of any kind: a
 *  page would load it from wherever it points, telling a third party someone is reading it. Null for
 *  what isn't an event, and with no start. */
export function membersOnlyEvent(groupDid: string, record: SpaceRecord): FlatEventRecord | null {
	const value = { ...record.value };
	delete value.media;
	delete value.poster;
	if (Array.isArray(value.uris)) value.uris = value.uris.filter((link) => !isEventImage(link));
	if (!isEvent(value)) return null;
	return {
		...(value as unknown as FlatEventRecord),
		cid: record.cid,
		did: groupDid,
		rkey: record.rkey,
		uri: eventUri(groupDid, record)
	};
}

/** For the edit page: whole, as stored, since the editor saves what it loads, and a field left out
 *  would go. Null for what isn't an event, as the event's own page has it. */
export function storedMembersOnlyEvent(
	groupDid: string,
	record: SpaceRecord
): FlatEventRecord | null {
	if (!membersOnlyEvent(groupDid, record)) return null;
	return {
		...(record.value as unknown as FlatEventRecord),
		cid: record.cid,
		did: groupDid,
		rkey: record.rkey,
		uri: eventUri(groupDid, record)
	};
}

const LIST_RECORDS = 'com.atproto.space.listRecords';
const LIST_LIMIT = 100;
const MAX_PAGES = 5;

/** How many of the calendar space's records a list reads, at most. */
export const MEMBERS_ONLY_LIST_LIMIT = LIST_LIMIT * MAX_PAGES;

export interface MembersOnlyList {
	events: FlatEventRecord[];
	/** It stopped at `MEMBERS_ONLY_LIST_LIMIT` records with more to read, in whatever order the host
	 *  lists them, so an upcoming event may be missing. */
	cutOff: boolean;
	/** Whether the space is still for members alone, read beside the events. */
	privacy: CalendarPrivacy;
}

/** The group's events in its calendar space, every page up to a limit. Null when the holder may not
 *  read the space, or it is not there: the host answers both alike. Any other failure throws, so
 *  "could not read" never passes for "none".
 *
 *  NOT authenticated: `listRecords` carries no MAC, so nothing here shows these values are the
 *  group's as its host keeps them. A page that acts on an event (its own page, an RSVP) reads it
 *  again with `getRecord`, whose MAC is checked. */
export async function listMembersOnlyEvents(
	holder: SpaceHolder,
	groupDid: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<MembersOnlyList | null> {
	const space = await chosenCalendar(groupDid);
	const events: FlatEventRecord[] = [];
	try {
		// The group's repo is at its host, which is also the space's authority.
		const host = await hosts.repoHost(groupDid);
		const credential = await exchangeSpaceCredential(holder, space, host);
		const privacy = readPolicy(credential, hosts, host, groupDid, space);
		const done = async (cutOff: boolean) => ({ events, cutOff, privacy: await privacy });
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const res = await fetchWithCredential(credential, hosts, {
				host,
				audience: groupDid,
				nsid: LIST_RECORDS,
				query: {
					space,
					repo: groupDid,
					collection: GROUP_EVENT_COLLECTION,
					limit: String(LIST_LIMIT),
					...(cursor ? { cursor } : {})
				}
			});
			const answer = await readXrpc(res);
			// The group has written nothing there yet.
			if (answerIsRecordNotFound(answer)) return done(false);
			if (!answer.ok) throw answerError(LIST_RECORDS, answer);
			const records = Array.isArray(answer.data.records) ? answer.data.records : [];
			for (const entry of records) {
				const { collection, rkey, cid, value } = (entry ?? {}) as Record<string, unknown>;
				if (collection !== GROUP_EVENT_COLLECTION || typeof rkey !== 'string') continue;
				if (!value || typeof value !== 'object') continue;
				const record = {
					uri: membersOnlyEventUri(groupDid, rkey, space),
					cid: typeof cid === 'string' ? cid : '',
					rkey,
					value: value as Record<string, unknown>
				};
				const event = membersOnlyEvent(groupDid, record);
				if (event) events.push(event);
			}
			// The group host ends its last page with a `cursor` of null, its own way: the spec says none.
			const next = typeof answer.data.cursor === 'string' ? answer.data.cursor : undefined;
			if (!next || next === cursor || records.length === 0) return done(false);
			cursor = next;
		}
		return done(true);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

/** The space's privacy, read with the credential its events are listed with; `unknown` when it
 *  could not be. The record's MAC is checked as any record read's is. */
async function readPolicy(
	credential: SpaceCredential,
	hosts: SpaceHosts,
	host: string,
	groupDid: string,
	space: string
): Promise<CalendarPrivacy> {
	try {
		const res = await fetchWithCredential(credential, hosts, {
			host,
			audience: groupDid,
			nsid: GET_RECORD,
			query: policyQuery(groupDid, space)
		});
		const answer = await readXrpc(res);
		if (!answer.ok) return 'unknown';
		const value = answer.data.value;
		return calendarPrivacy(
			value && typeof value === 'object' ? (value as Record<string, unknown>) : null
		);
	} catch (e) {
		console.info(`[groups] a calendar's policy unread: ${errorKind(e)}`);
		return 'unknown';
	}
}

/** Null for an event that is not there and for a reader kept out alike, so a page cannot tell one
 *  from the other. Any other failure throws. */
export async function readMembersOnlyEvent(
	reader: SpaceReader,
	groupDid: string,
	rkey: string,
	space: string
): Promise<FlatEventRecord | null> {
	try {
		const found = await reader.get({
			space,
			repo: groupDid,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
		return found ? membersOnlyEvent(groupDid, found) : null;
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

/** The member's own RSVP to the event, in their repo in the calendar space, under the event's key;
 *  null when there is none, it answers another event, or it could not be read. */
export async function readOwnRsvp(
	reader: SpaceReader,
	groupDid: string,
	memberDid: string,
	rkey: string,
	space: string
): Promise<RsvpStatus | null> {
	const found = await reader
		.get({ space, repo: memberDid, collection: RSVP_COLLECTION, rkey })
		.catch((e) => {
			if (!isSpaceAccessDenied(e)) console.info(`[groups] an RSVP unread: ${errorKind(e)}`);
			return null;
		});
	const value = found?.value as { status?: unknown; subject?: { uri?: unknown } } | undefined;
	if (!value || value.subject?.uri !== membersOnlyEventUri(groupDid, rkey, space)) return null;
	return RSVP_STATUSES.find((s) => value.status === `${RSVP_COLLECTION}#${s}`) ?? null;
}

/** Not over yet, soonest first. */
export function upcoming(events: FlatEventRecord[], now = Date.now()): FlatEventRecord[] {
	return events
		.filter((event) => Date.parse(event.endsAt ?? event.startsAt) >= now)
		.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

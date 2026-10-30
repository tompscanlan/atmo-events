// A group's events, written as the group: into its public repo, or for members only into its
// calendar space. Nothing on the record says which, so the container alone says who may read
// it, and these checks keep each write where it was sent.
import * as v from '@atcute/lexicons/validations';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import type { EventPlacement } from '../event-placement';
import {
	calendarSpaceUri,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_COLLECTION,
	membersOnlyEventUri
} from '../ids';
import { parseGroupAccess } from '../members-record';
import type { GroupWriter } from './context';
import { notifyIndex } from './group';
import type { GroupSpaceRecord } from './space-read';
import { isRecordNotFound, xrpc, XrpcError } from './xrpc';

const REFUSALS = {
	'not-an-event': 'That is not a valid event, so nothing was saved.',
	'no-calendar-space':
		'This group has no calendar space for members-only events, so nothing was saved.',
	'calendar-space-readable':
		"This group's calendar space can be read by more than its members, so the members-only event was not saved.",
	'calendar-space-unchecked':
		"The group's calendar space could not be checked, so the members-only event was not saved. Try again shortly.",
	moved: "An event can't be moved between public and members-only. Nothing was saved.",
	'wrong-delete':
		"The event wasn't deleted: the page had it as public when it's members-only, or the other way round. Reload and try again.",
	unchecked:
		'Whether this event is public or members-only could not be checked, so nothing was saved. Try again shortly.'
} as const;

/** A write refused before it was sent, in words a page can show. */
export class GroupEventRefused extends Error {
	constructor(readonly reason: keyof typeof REFUSALS) {
		super(REFUSALS[reason]);
		this.name = 'GroupEventRefused';
	}
}

/** From the DID, never from a page. */
function spaceOf(groupDid: string, placement: EventPlacement): string | null {
	return placement === 'members' ? calendarSpaceUri(groupDid) : null;
}

/** A space that was never made answers SpaceNotFound, which here means the event is not in it. */
function isAbsent(e: unknown): boolean {
	return isRecordNotFound(e) || (e instanceof XrpcError && e.error === 'SpaceNotFound');
}

async function getEvent(
	writer: GroupWriter,
	space: string | null,
	rkey: string
): Promise<Record<string, unknown>> {
	const query = { repo: writer.did, collection: GROUP_EVENT_COLLECTION, rkey };
	return space === null
		? xrpc(writer.handle, 'com.atproto.repo.getRecord', { query })
		: xrpc(writer.handle, 'com.atproto.space.getRecord', { query: { ...query, space } });
}

async function hasEvent(writer: GroupWriter, space: string | null, rkey: string) {
	try {
		await getEvent(writer, space, rkey);
		return true;
	} catch (e) {
		if (isAbsent(e)) return false;
		console.error(`[groups] ${writer.did}: could not tell where event ${rkey} is:`, e);
		throw new GroupEventRefused('unchecked');
	}
}

/** `ready` when members-only events can go in: the space is there and its `access`, which
 *  the host reads for every reader, does not say public. */
export type CalendarSpaceState = 'ready' | 'missing' | 'readable' | 'unchecked';

export async function calendarSpaceState(writer: GroupWriter): Promise<CalendarSpaceState> {
	let found: Record<string, unknown>;
	try {
		found = await xrpc(writer.handle, 'com.atproto.space.getRecord', {
			query: {
				space: calendarSpaceUri(writer.did),
				repo: writer.did,
				collection: GROUP_ACCESS_COLLECTION,
				rkey: GROUP_ACCESS_RKEY
			}
		});
	} catch (e) {
		if (isAbsent(e)) return 'missing';
		console.error(`[groups] ${writer.did}: the calendar space could not be checked:`, e);
		return 'unchecked';
	}
	const access = parseGroupAccess(found.value);
	if (!access) return 'unchecked';
	return access.public ? 'readable' : 'ready';
}

const SPACE_REFUSALS = {
	missing: 'no-calendar-space',
	readable: 'calendar-space-readable',
	unchecked: 'calendar-space-unchecked'
} as const;

/** A write into a space that was never made succeeds anyway, so every members-only write
 *  checks first. */
async function checkCalendarSpace(writer: GroupWriter): Promise<void> {
	const state = await calendarSpaceState(writer);
	if (state !== 'ready') throw new GroupEventRefused(SPACE_REFUSALS[state]);
}

/** Both containers create on a put and take a delete of a missing record as done, so a write
 *  sent to the wrong one would copy the event across, or report a delete that did nothing.
 *  An event found only in the other container is refused; found in neither, the write goes. */
async function checkPlacement(
	writer: GroupWriter,
	space: string | null,
	rkey: string,
	refusal: 'moved' | 'wrong-delete'
): Promise<void> {
	if (await hasEvent(writer, space, rkey)) return;
	const other = space === null ? calendarSpaceUri(writer.did) : null;
	if (await hasEvent(writer, other, rkey)) throw new GroupEventRefused(refusal);
}

export interface GroupEventInput {
	rkey: string;
	record: Record<string, unknown>;
	placement: EventPlacement;
}

/** Writes the event where its placement says. Only a public one reaches the index. */
export async function putGroupEvent(
	writer: GroupWriter,
	input: GroupEventInput
): Promise<{ uri: string; cid: string }> {
	const record = { ...input.record, $type: GROUP_EVENT_COLLECTION };
	// A PDS does not validate a lexicon it does not know, and a space record not at all.
	if (!v.safeParse(eventSchema, record).ok) throw new GroupEventRefused('not-an-event');

	const space = spaceOf(writer.did, input.placement);
	if (space !== null) await checkCalendarSpace(writer);
	await checkPlacement(writer, space, input.rkey, 'moved');

	const body = { repo: writer.did, collection: GROUP_EVENT_COLLECTION, rkey: input.rkey, record };
	if (space === null) {
		const result = await xrpc(writer.handle, 'com.atproto.repo.putRecord', { body });
		await notifyIndex(String(result.uri));
		return { uri: String(result.uri), cid: String(result.cid) };
	}
	const result = await xrpc(writer.handle, 'com.atproto.space.putRecord', {
		body: { ...body, space }
	});
	return { uri: membersOnlyEventUri(writer.did, input.rkey), cid: String(result.cid) };
}

export async function deleteGroupEvent(
	writer: GroupWriter,
	input: Omit<GroupEventInput, 'record'>
): Promise<void> {
	const space = spaceOf(writer.did, input.placement);
	await checkPlacement(writer, space, input.rkey, 'wrong-delete');
	const body = { repo: writer.did, collection: GROUP_EVENT_COLLECTION, rkey: input.rkey };
	if (space === null) {
		await xrpc(writer.handle, 'com.atproto.repo.deleteRecord', { body });
		// The index fetches the URI again, finds nothing, and drops the row.
		await notifyIndex(`at://${writer.did}/${GROUP_EVENT_COLLECTION}/${input.rkey}`);
		return;
	}
	await xrpc(writer.handle, 'com.atproto.space.deleteRecord', { body: { ...body, space } });
}

/** A members-only event as stored, read as the group, for its edit page; null when absent. */
export async function readMembersOnlyEventAsGroup(
	writer: GroupWriter,
	rkey: string
): Promise<GroupSpaceRecord | null> {
	try {
		const found = await getEvent(writer, calendarSpaceUri(writer.did), rkey);
		const value = found.value && typeof found.value === 'object' ? found.value : {};
		return {
			uri: membersOnlyEventUri(writer.did, rkey),
			cid: typeof found.cid === 'string' ? found.cid : '',
			collection: GROUP_EVENT_COLLECTION,
			rkey,
			value: value as Record<string, unknown>
		};
	} catch (e) {
		if (isAbsent(e)) return null;
		throw e;
	}
}

// A group's members-only events, written as the group into its calendar space at its group host,
// never into its public repo, so they never reach the index or a public URL. Turning them on makes
// the space, under a policy that lets the group's roles read it and no one else; writing one there
// as the group takes a grant in that space's own policy, since the host does not count a role's
// `space:` permissions for another app's space.
import * as v from '@atcute/lexicons/validations';
import {
	didSpaceHosts,
	isSpaceAccessDenied,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader, type SpaceRecord } from '#lib/spaces/server/space-read.js';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import { CALENDAR_SPACE_TYPE, calendarSpaceUri, membersOnlyEventUri } from '../calendar';
import {
	ADMIN_ROLE,
	GROUP_EVENT_COLLECTION,
	GROUP_POLICY_TYPE,
	MEMBER_ROLE,
	SPACE_SKEY
} from '../ids';
import type { GroupWriter } from './context';
import { errorKind, isLinkBroken, isRecordNotFound, isRoleRefused, xrpc, XrpcError } from './xrpc';

/** The calendar space's policy: private; admins write its events as the group; every role reads
 *  it, and writes its own records there (a member's RSVP, in their own repo), which puts them in
 *  its writer set so other readers see them. */
export const CALENDAR_POLICY = {
	$type: GROUP_POLICY_TYPE,
	publicRead: false,
	grants: [
		{
			role: ADMIN_ROLE,
			read: true,
			write: true,
			permissions: [`space:${CALENDAR_SPACE_TYPE}?collection=${GROUP_EVENT_COLLECTION}`]
		},
		{ role: MEMBER_ROLE, read: true, write: true }
	]
};

const REFUSALS = {
	'not-an-event': 'That is not a valid event, so nothing was saved.',
	'has-image': 'A members-only event takes no image, so nothing was saved.',
	'no-calendar-space':
		"Members-only events aren't turned on for this group, so the event was not saved.",
	'calendar-space-readable':
		"This group's calendar can be read by more than its members, so the members-only event was not saved.",
	'calendar-space-unchecked':
		"The group's calendar couldn't be checked, so the members-only event was not saved. Try again shortly.",
	moved: 'This event is public, and a public event stays public. Nothing was saved.'
} as const;

export type GroupEventRefusal = keyof typeof REFUSALS;

/** A write refused before it was sent, in words a page can show. */
export class GroupEventRefused extends Error {
	constructor(readonly reason: GroupEventRefusal) {
		super(REFUSALS[reason]);
		this.name = 'GroupEventRefused';
	}
}

// Not the spec's, which names no errors for com.atproto.space.*: the group host's, as the reference
// PDS also says it, and private events read it.
function isSpaceNotFound(e: unknown): boolean {
	return e instanceof XrpcError && e.error === 'SpaceNotFound';
}

/** `ready` when members-only events can go in: the space is there and its policy, as the host keeps
 *  it, does not let anyone read it. */
export type CalendarSpaceState = 'ready' | 'missing' | 'readable' | 'unchecked';

/** Read as the group, by `com.atproto.space.getSpace`, which the group host serves a group's session
 *  as a PDS serves its account's. A refused or broken link throws, as any write would; an outage is
 *  `unchecked`. */
export async function calendarSpaceState(writer: GroupWriter): Promise<CalendarSpaceState> {
	let found: Record<string, unknown>;
	try {
		found = await xrpc(writer.handle, 'com.atproto.space.getSpace', {
			query: { space: calendarSpaceUri(writer.did) }
		});
	} catch (e) {
		if (isSpaceNotFound(e)) return 'missing';
		if (isLinkBroken(e) || isRoleRefused(e)) throw e;
		console.error(`[groups] the calendar space could not be checked: ${errorKind(e)}`);
		return 'unchecked';
	}
	const policy = found.policy as { $type?: unknown; publicRead?: unknown } | undefined;
	return policy?.$type === GROUP_POLICY_TYPE && policy.publicRead !== true ? 'ready' : 'readable';
}

/** Makes the group's calendar space. One already there is not a failure, so turning it on again
 *  finishes what stopped partway, and never changes its policy. */
export async function turnOnMembersOnly(writer: GroupWriter): Promise<void> {
	try {
		await xrpc(writer.handle, 'com.atproto.space.createSpace', {
			body: { spaceType: CALENDAR_SPACE_TYPE, skey: SPACE_SKEY, policy: CALENDAR_POLICY }
		});
	} catch (e) {
		// The group host's name, as the reference PDS's; the spec names none.
		if (e instanceof XrpcError && e.error === 'SpaceAlreadyExists') return;
		throw e;
	}
}

const SPACE_REFUSALS = {
	missing: 'no-calendar-space',
	readable: 'calendar-space-readable',
	unchecked: 'calendar-space-unchecked'
} as const;

/** Whether the group's public repo has an event under `rkey`: one there stays there, since a put
 *  into the space would only copy it. */
async function isPublic(writer: GroupWriter, rkey: string): Promise<boolean> {
	try {
		await xrpc(writer.handle, 'com.atproto.repo.getRecord', {
			query: { repo: writer.did, collection: GROUP_EVENT_COLLECTION, rkey }
		});
		return true;
	} catch (e) {
		if (isRecordNotFound(e)) return false;
		if (isLinkBroken(e) || isRoleRefused(e)) throw e;
		console.error(`[groups] a members-only event's key could not be checked: ${errorKind(e)}`);
		throw new GroupEventRefused('calendar-space-unchecked');
	}
}

/** Into the calendar space, never the public repo, and nothing to the index. A write into a space
 *  that was never made would succeed anyway, so each one checks the space first. */
export async function putMembersOnlyEvent(
	writer: GroupWriter,
	input: { rkey: string; record: Record<string, unknown> }
): Promise<{ uri: string; cid: string }> {
	const record: Record<string, unknown> = { ...input.record, $type: GROUP_EVENT_COLLECTION };
	// A space record is not validated at all.
	if (!v.safeParse(eventSchema, record).ok) throw new GroupEventRefused('not-an-event');
	// A blob is public wherever its record is.
	if (Array.isArray(record.media) ? record.media.length > 0 : record.media !== undefined) {
		throw new GroupEventRefused('has-image');
	}
	const state = await calendarSpaceState(writer);
	if (state !== 'ready') throw new GroupEventRefused(SPACE_REFUSALS[state]);
	if (await isPublic(writer, input.rkey)) throw new GroupEventRefused('moved');

	const result = await xrpc(writer.handle, 'com.atproto.space.putRecord', {
		body: {
			repo: writer.did,
			space: calendarSpaceUri(writer.did),
			collection: GROUP_EVENT_COLLECTION,
			rkey: input.rkey,
			record
		}
	});
	return { uri: membersOnlyEventUri(writer.did, input.rkey), cid: String(result.cid) };
}

/** The host answers the same for an event already gone. Members' RSVPs to it stay in their own
 *  repos, answering nothing. */
export async function deleteMembersOnlyEvent(writer: GroupWriter, rkey: string): Promise<void> {
	await xrpc(writer.handle, 'com.atproto.space.deleteRecord', {
		body: {
			repo: writer.did,
			space: calendarSpaceUri(writer.did),
			collection: GROUP_EVENT_COLLECTION,
			rkey
		}
	});
}

/** A members-only event as stored, read as the group with its space credential, for its edit page;
 *  null when it is not there, or the host does not let the link read the space. */
export async function readMembersOnlyEventAsGroup(
	writer: GroupWriter,
	rkey: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<SpaceRecord | null> {
	try {
		return await credentialSpaceReader({ handle: writer.handle }, hosts).get({
			space: calendarSpaceUri(writer.did),
			repo: writer.did,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

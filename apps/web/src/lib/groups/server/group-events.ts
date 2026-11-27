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
import { grantsMembersOnly } from '../scopes';
import type { GroupWriter } from './context';
import { errorKind, isLinkBroken, isRecordNotFound, isRoleRefused, xrpc, XrpcError } from './xrpc';

/** The calendar space's policy: private; admins write its events as the group; members read it.
 *  No role has `write`, which says only who is in the space's writer set, whose own records sync
 *  to every reader: a member's RSVP goes into their own repo in the space through their own PDS,
 *  and is read back from there, so it needs no `write`, and with it every member's RSVPs would
 *  reach every other member. Writing as the group takes only `permissions`. Admins need no `read`
 *  of their own: everyone in a group holds `member`. */
export const CALENDAR_POLICY = {
	$type: GROUP_POLICY_TYPE,
	publicRead: false,
	grants: [
		{
			role: ADMIN_ROLE,
			permissions: [`space:${CALENDAR_SPACE_TYPE}?collection=${GROUP_EVENT_COLLECTION}`]
		},
		{ role: MEMBER_ROLE, read: true }
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
	'calendar-space-unusable':
		"This group's calendar wasn't set up for atmo to post members-only events to, so the event was not saved.",
	moved: 'This event is public, and a public event stays public. Nothing was saved.',
	'members-only':
		'This event is members-only, and a members-only event stays members-only. Nothing was saved.',
	'key-unchecked':
		"The group's calendar couldn't be checked for this event, so it was not saved. Try again shortly.",
	'reserved-key': 'A members-only event cannot be saved under that key. Nothing was saved.'
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
 *  it, does not let anyone read it, lets members read it and lets some role post its events as the
 *  group. `unusable` for a private space whose policy does not, such as one made some other way. */
export type CalendarSpaceState = 'ready' | 'missing' | 'readable' | 'unusable' | 'unchecked';

export interface CalendarSpace {
	state: CalendarSpaceState;
	/** The roles whose grant in the policy lets a link post events as the group; empty unless
	 *  `ready`. */
	posters: string[];
}

interface PolicyGrant {
	role?: unknown;
	read?: unknown;
	permissions?: unknown;
}

/** What posting needs of the policy: a grant whose permissions write events there as the group, as
 *  the host gives a link at its approval from the approving person's roles' grants, and members
 *  reading the space, for whom the events are. */
function checkedPolicy(groupDid: string, policy: unknown): CalendarSpace {
	const kept = policy as { $type?: unknown; publicRead?: unknown; grants?: unknown } | undefined;
	if (kept?.$type !== GROUP_POLICY_TYPE || kept.publicRead === true) {
		return { state: 'readable', posters: [] };
	}
	const grants = (Array.isArray(kept.grants) ? kept.grants : []) as PolicyGrant[];
	const posters = grants.flatMap((grant) => {
		const permissions = Array.isArray(grant.permissions)
			? grant.permissions.filter((p): p is string => typeof p === 'string')
			: [];
		return typeof grant.role === 'string' &&
			grantsMembersOnly(permissions.join(' '), groupDid).membersOnly
			? [grant.role]
			: [];
	});
	const membersRead = grants.some((grant) => grant.role === MEMBER_ROLE && grant.read === true);
	return membersRead && posters.length > 0
		? { state: 'ready', posters }
		: { state: 'unusable', posters: [] };
}

/** Read as the group, by `com.atproto.space.getSpace`. Not the spec's: the group host's own, which it
 *  serves a group's session as a PDS serves its account's. The spec's way to read a policy is the
 *  `com.atproto.space.policy` record the host publishes in the space. A refused or broken link
 *  throws, as any write would; an outage is `unchecked`. */
export async function readCalendarSpace(writer: GroupWriter): Promise<CalendarSpace> {
	let found: Record<string, unknown>;
	try {
		found = await xrpc(writer.handle, 'com.atproto.space.getSpace', {
			query: { space: calendarSpaceUri(writer.did) }
		});
	} catch (e) {
		if (isSpaceNotFound(e)) return { state: 'missing', posters: [] };
		if (isLinkBroken(e) || isRoleRefused(e)) throw e;
		console.error(`[groups] the calendar space could not be checked: ${errorKind(e)}`);
		return { state: 'unchecked', posters: [] };
	}
	return checkedPolicy(writer.did, found.policy);
}

export async function calendarSpaceState(writer: GroupWriter): Promise<CalendarSpaceState> {
	return (await readCalendarSpace(writer)).state;
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

const RESERVED_RKEY = 'self';

const SPACE_REFUSALS = {
	missing: 'no-calendar-space',
	readable: 'calendar-space-readable',
	unusable: 'calendar-space-unusable',
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
	// `self` is the key private events give the one event in a space of their own; a group event
	// under it would read there as someone's private event.
	if (input.rkey === RESERVED_RKEY) throw new GroupEventRefused('reserved-key');
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

/** Before a public save: refused when the calendar space already has a members-only event under
 *  `rkey`, which stays members-only, so no public copy is made under its key. A link that may not
 *  read the space, or a group with no calendar space, has none to find. Fails closed otherwise. */
export async function refuseMembersOnlyKey(
	writer: GroupWriter,
	rkey: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<void> {
	let found: SpaceRecord | null;
	try {
		found = await readMembersOnlyEventAsGroup(writer, rkey, hosts);
	} catch (e) {
		if (isLinkBroken(e) || isRoleRefused(e)) throw e;
		console.error(`[groups] a public event's key could not be checked: ${errorKind(e)}`);
		throw new GroupEventRefused('key-unchecked');
	}
	if (found) throw new GroupEventRefused('members-only');
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

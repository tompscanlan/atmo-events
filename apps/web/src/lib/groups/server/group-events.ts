// A group's members-only events, written as the group into its calendar space at its group host,
// never into its public repo, so they never reach the index or a public URL. Turning them on uses
// a calendar space the group already has for its members, which another app may have made, or
// else makes one, under a policy that lets the group's roles read it and no one else; writing one
// there as the group takes a grant in that space's own policy, since the host does not count a
// role's `space:` permissions for another app's space.
import * as v from '@atcute/lexicons/validations';
import {
	didSpaceHosts,
	isSpaceAccessDenied,
	type SpaceHolder,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader, type SpaceRecord } from '#lib/spaces/server/space-read.js';
import { mainSchema as eventSchema } from '../../../lexicon-types/types/community/lexicon/calendar/event';
import {
	CALENDAR_SPACE_TYPE,
	calendarSkeyOf,
	calendarSpaceUri,
	membersOnlyEventUri
} from '../calendar';
import {
	ADMIN_ROLE,
	GROUP_EVENT_COLLECTION,
	GROUP_POLICY_TYPE,
	GROUP_SPACE_INDEX_COLLECTION,
	MEMBER_ROLE,
	SPACE_SKEY
} from '../ids';
import {
	chosenCalendar,
	forgetCalendar,
	rememberCalendar,
	rememberedCalendar
} from './calendar-choice';
import type { GroupWriter } from './context';
import { membersSpace } from './roster';
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
	'calendar-space-not-granted':
		'This group already has a calendar for its members, but its settings let no role post events to it from atmo, so atmo made no second one. An admin can allow it at the group host.',
	'calendar-index-unread':
		"atmo couldn't check which calendars this group already has, so it made none rather than risk a second one.",
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
	/** The calendar space checked. */
	space: string;
}

/** And whether the policy lets members read it, which a calendar must for atmo to use it. */
interface CheckedSpace extends CalendarSpace {
	membersRead: boolean;
}

interface PolicyGrant {
	role?: unknown;
	read?: unknown;
	permissions?: unknown;
}

const EVENT_WRITES = ['create', 'update', 'delete'];

/** Whether a permission in the policy of the space keyed `skey` lets its holder write events there
 *  as the group, as the host reads one there: a `space:` scope for that type or any, the group or
 *  any authority (none is the group's own), that key or any (none is any), events or every
 *  collection, and every write (none named is all of them). */
function postsEvents(permission: string, groupDid: string, skey: string): boolean {
	if (!permission.startsWith('space:')) return false;
	const at = permission.indexOf('?');
	const kind = permission.slice('space:'.length, at === -1 ? undefined : at);
	const params = new URLSearchParams(at === -1 ? '' : permission.slice(at + 1));
	const collections = params.getAll('collection');
	const actions = params.getAll('action');
	return (
		[CALENDAR_SPACE_TYPE, '*'].includes(kind) &&
		['self', '*', groupDid].includes(params.get('authority') ?? 'self') &&
		['*', skey].includes(params.get('skey') ?? '*') &&
		(collections.includes('*') || collections.includes(GROUP_EVENT_COLLECTION)) &&
		(actions.length === 0 || EVENT_WRITES.every((action) => actions.includes(action)))
	);
}

/** What posting needs of the policy: a grant whose permissions write events there as the group, as
 *  the host gives a link at its approval from the approving person's roles' grants, and members
 *  reading the space, for whom the events are. */
function checkedPolicy(groupDid: string, space: string, policy: unknown): CheckedSpace {
	const kept = policy as { $type?: unknown; publicRead?: unknown; grants?: unknown } | undefined;
	if (kept?.$type !== GROUP_POLICY_TYPE || kept.publicRead === true) {
		return { state: 'readable', posters: [], space, membersRead: false };
	}
	const skey = calendarSkeyOf(space, groupDid) ?? SPACE_SKEY;
	const grants = (Array.isArray(kept.grants) ? kept.grants : []) as PolicyGrant[];
	const posters = grants.flatMap((grant) => {
		const permissions = Array.isArray(grant.permissions) ? grant.permissions : [];
		return typeof grant.role === 'string' &&
			permissions.some((p) => typeof p === 'string' && postsEvents(p, groupDid, skey))
			? [grant.role]
			: [];
	});
	const membersRead = grants.some((grant) => grant.role === MEMBER_ROLE && grant.read === true);
	return membersRead && posters.length > 0
		? { state: 'ready', posters, space, membersRead }
		: { state: 'unusable', posters: [], space, membersRead };
}

/** Read as the group, by `com.atproto.space.getSpace`. Not the spec's: the group host's own, which it
 *  serves a group's session as a PDS serves its account's. The spec's way to read a policy is the
 *  `com.atproto.space.policy` record the host publishes in the space. A refused or broken link
 *  throws, as any write would; an outage is `unchecked`. */
async function checkSpace(writer: GroupWriter, space: string): Promise<CheckedSpace> {
	let found: Record<string, unknown>;
	try {
		found = await xrpc(writer.handle, 'com.atproto.space.getSpace', { query: { space } });
	} catch (e) {
		if (isSpaceNotFound(e)) return { state: 'missing', posters: [], space, membersRead: false };
		if (isLinkBroken(e) || isRoleRefused(e)) throw e;
		console.error(`[groups] the calendar space could not be checked: ${errorKind(e)}`);
		return { state: 'unchecked', posters: [], space, membersRead: false };
	}
	return checkedPolicy(writer.did, space, found.policy);
}

const shown = ({ state, posters, space }: CheckedSpace): CalendarSpace => ({
	state,
	posters,
	space
});

/** The group's calendar space for members-only events, checked at the host: the one chosen when
 *  they were turned on, or `self`. One chosen that the host no longer has is forgotten, so turning
 *  them on again looks afresh. Nothing is made by looking. */
export async function readCalendarSpace(writer: GroupWriter): Promise<CalendarSpace> {
	const own = calendarSpaceUri(writer.did);
	const remembered = await rememberedCalendar(writer.did);
	const found = await checkSpace(writer, remembered ?? own);
	if (found.state !== 'missing' || !remembered) return shown(found);
	await forgetCalendar(writer.did);
	return remembered === own ? shown(found) : shown(await checkSpace(writer, own));
}

export async function calendarSpaceState(writer: GroupWriter): Promise<CalendarSpaceState> {
	return (await readCalendarSpace(writer)).state;
}

/** How many of the group's calendar spaces turning members-only events on looks at, at most. */
export const MAX_CALENDAR_CANDIDATES = 20;

/** The group's calendar spaces its index lists, each with when it was listed, read with the first
 *  of `holders` the host lets read the members space, where the index is. The spec's index, which
 *  leaves out a space whose policy is `unlisted`. Refused when none may read it; an outage throws. */
async function indexedCalendars(
	groupDid: string,
	holders: SpaceHolder[],
	hosts: SpaceHosts
): Promise<Map<string, string>> {
	for (const holder of holders) {
		let entries;
		try {
			entries = await membersSpace(holder, groupDid, hosts).list(GROUP_SPACE_INDEX_COLLECTION);
		} catch (e) {
			if (isSpaceAccessDenied(e)) continue;
			throw e;
		}
		const calendars = new Map<string, string>();
		for (const { value } of entries) {
			const { space, createdAt } = value;
			if (typeof space !== 'string' || calendarSkeyOf(space, groupDid) === null) continue;
			if (!calendars.has(space))
				calendars.set(space, typeof createdAt === 'string' ? createdAt : '');
		}
		return calendars;
	}
	throw new GroupEventRefused('calendar-index-unread');
}

/** `self` first, then the oldest listed: the one this site would have made, else the first made. */
function candidates(groupDid: string, indexed: Map<string, string>): string[] {
	const own = calendarSpaceUri(groupDid);
	const time = (space: string) => Date.parse(indexed.get(space) ?? '') || Number.POSITIVE_INFINITY;
	const others = [...indexed.keys()]
		.filter((space) => space !== own)
		.sort((a, b) => time(a) - time(b) || (a < b ? -1 : a > b ? 1 : 0));
	return [own, ...others].slice(0, MAX_CALENDAR_CANDIDATES);
}

/** Turns members-only events on: with a calendar space the group already has, private, that its
 *  members read and some role may post events to as the group (`self` first, else the oldest the
 *  group's index lists); or else with one made here, keyed `self`. The one used is remembered for
 *  every later read and write. A calendar its members read whose policy lets no role post is not
 *  passed over for a second one: it is remembered, so the page says so, and this is refused. A
 *  public calendar, or one members cannot read, is no calendar for members-only events, and is
 *  left as it is. Never changes a policy. `holders` are tried in turn to read the index after the
 *  link: the person's own sign-in, which a member reads it with. A `self` space already there that
 *  members may not use is not a failure, so turning them on again finishes what stopped partway. */
export async function turnOnMembersOnly(
	writer: GroupWriter,
	holders: SpaceHolder[] = [],
	hosts: SpaceHosts = didSpaceHosts
): Promise<CalendarSpace> {
	const indexed = await indexedCalendars(writer.did, [writer, ...holders], hosts);
	const checked: CheckedSpace[] = [];
	for (const space of candidates(writer.did, indexed)) {
		const found = await checkSpace(writer, space);
		if (found.state === 'unchecked') throw new GroupEventRefused('calendar-space-unchecked');
		if (found.state !== 'missing') checked.push(found);
	}
	const usable = checked.find((found) => found.state === 'ready');
	if (usable) {
		await rememberCalendar(writer.did, usable.space);
		return shown(usable);
	}
	const ungranted = checked.find((found) => found.state === 'unusable' && found.membersRead);
	if (ungranted) {
		await rememberCalendar(writer.did, ungranted.space);
		throw new GroupEventRefused('calendar-space-not-granted');
	}
	const own = calendarSpaceUri(writer.did);
	try {
		await xrpc(writer.handle, 'com.atproto.space.createSpace', {
			body: { spaceType: CALENDAR_SPACE_TYPE, skey: SPACE_SKEY, policy: CALENDAR_POLICY }
		});
	} catch (e) {
		// The group host's name, as the reference PDS's; the spec names none.
		if (!(e instanceof XrpcError && e.error === 'SpaceAlreadyExists')) throw e;
	}
	await rememberCalendar(writer.did, own);
	return shown(await checkSpace(writer, own));
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
	const { state, space } = await readCalendarSpace(writer);
	if (state !== 'ready') throw new GroupEventRefused(SPACE_REFUSALS[state]);
	if (await isPublic(writer, input.rkey)) throw new GroupEventRefused('moved');

	const result = await xrpc(writer.handle, 'com.atproto.space.putRecord', {
		body: { repo: writer.did, space, collection: GROUP_EVENT_COLLECTION, rkey: input.rkey, record }
	});
	return { uri: membersOnlyEventUri(writer.did, input.rkey, space), cid: String(result.cid) };
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
			space: await chosenCalendar(writer.did),
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
			space: await chosenCalendar(writer.did),
			repo: writer.did,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

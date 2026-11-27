import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { EMPTY_ONGOING, ongoingQuery } from '#lib/contrail/ongoing.js';
import {
	flattenEventRecords,
	listAuthoredEventsFromContrail,
	type FlatEventRecord
} from '#lib/contrail.js';
import { hasEnded } from '#lib/past-events.js';
import { getProfileCounts } from '#lib/server/profile-counts.js';
import { CREATE_IN_THIS_BUILD } from '#lib/groups/build.js';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import {
	listMembersOnlyEvents,
	MEMBERS_ONLY_LIST_LIMIT,
	upcoming,
	type CalendarPrivacy
} from '#lib/groups/server/calendar-read.js';
import {
	groupView,
	requireGroupWriter,
	type GroupView,
	type LinkedGroup
} from '#lib/groups/server/context.js';
import type { GroupAbilities } from '#lib/groups/scopes.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { readCalendarSpace, type CalendarSpaceState } from '#lib/groups/server/group-events.js';
import { personReader, readRolesAsPerson } from '#lib/groups/server/person.js';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { spacesServer } from '#lib/private-events/server/enabled.js';
import { holdsGuestGrant } from '#lib/private-events/scopes.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

const LINK_NOTICES = {
	linked: 'Linked.',
	created: 'Your group is made, and linked.'
} as const;

/** What a working link lets the person do here, as the page offers it. */
function linkAbilities(can: GroupAbilities): string {
	const things = [
		(can.post || can.membersOnly) && 'post its events',
		can.settings && 'change its settings',
		(can.admit || can.assign || can.remove) && 'manage its members'
	].filter((thing): thing is string => Boolean(thing));
	if (things.length === 0) return 'Your role in this group lets you see it here.';
	const all =
		things.length === 1 ? things[0] : `${things.slice(0, -1).join(', ')} and ${things.at(-1)}`;
	return `You can now ${all} here.`;
}

/** After a link, only to the person who holds it and only while it works, worded from what it
 *  may do; a made-up `?link=` is no notice. */
function linkNotice(link: string | null, linked: LinkedGroup | null): string | null {
	if (!link || !linked || !Object.hasOwn(LINK_NOTICES, link)) return null;
	// Only a build that makes groups here makes one.
	if (link === 'created' && !CREATE_IN_THIS_BUILD) return null;
	return `${LINK_NOTICES[link as keyof typeof LINK_NOTICES]} ${linkAbilities(linked.can)}`;
}

/** `unread` says why `events` is empty when they could not be read; `stoppedAt`, the limit the list
 *  stopped at with more to read, so an upcoming event may be missing. */
interface MembersOnlySlice {
	events: FlatEventRecord[];
	unread: boolean;
	stoppedAt: number | null;
	/** Whether their calendar is still for members alone, as read with them. */
	privacy: CalendarPrivacy;
}

/** The group's members-only events, for a member whose own sign-in may read them, or else through
 *  a link that may post them. Null for anyone else, so the page is the same whether the group has
 *  any or not; and null when the host lets neither read the calendar space, or it is not there. */
async function membersOnlySlice(
	group: GroupView,
	person: CallerSession | null
): Promise<MembersOnlySlice | null> {
	const own = person && group.member === true && holdsGuestGrant(person.scope) ? person : null;
	const link = !own && group.linked?.can.membersOnly && person ? person.did : null;
	if (!own && !link) return null;
	try {
		const holder = own ?? (await requireGroupWriter(group.did, link));
		const list = await listMembersOnlyEvents(holder, group.did);
		if (!list) return null;
		const stoppedAt = list.cutOff ? MEMBERS_ONLY_LIST_LIMIT : null;
		return { events: upcoming(list.events), unread: false, stoppedAt, privacy: list.privacy };
	} catch (e) {
		console.error(`[groups] members-only events unread for a group page: ${errorKind(e)}`);
		return { events: [], unread: true, stoppedAt: null, privacy: 'unknown' };
	}
}

/** As many of each kind of event as a person's profile shows of theirs. */
const PREVIEW_LIMIT = 6;

/** The group's public events, read as a person's profile reads theirs: those under way, those
 *  coming and those past, a few of each, and how many it has made. */
async function hostedEvents(actor: ActorIdentifier) {
	const client = getServerClient(env.DB);
	const now = new Date().toISOString();
	const authored = (order: 'asc' | 'desc') =>
		listAuthoredEventsFromContrail(client, {
			hydrateRsvps: 5,
			profiles: true,
			sort: 'startsAt',
			order,
			...(order === 'asc' ? { startsAtMin: now } : { startsAtMax: now }),
			actor,
			limit: PREVIEW_LIMIT + 1
		});
	const [upcomingResponse, pastResponse, ongoing] = await Promise.all([
		authored('asc'),
		authored('desc'),
		// An optional section, so a failure is an empty one, never a failed page.
		ongoingQuery(client, { actor }).catch(() => EMPTY_ONGOING)
	]);
	const upcoming = upcomingResponse ? flattenEventRecords(upcomingResponse.records) : [];
	const past = (pastResponse ? flattenEventRecords(pastResponse.records) : []).filter((e) =>
		hasEnded(e, now)
	);
	return {
		ongoingEvents: ongoing.events.slice(0, PREVIEW_LIMIT),
		ongoingTotal: ongoing.total,
		ongoingTotalIsFloor: ongoing.totalIsFloor,
		upcomingEvents: upcoming.slice(0, PREVIEW_LIMIT),
		hasMoreUpcoming: upcoming.length > PREVIEW_LIMIT,
		pastEvents: past.slice(0, PREVIEW_LIMIT),
		hasMorePast: past.length > PREVIEW_LIMIT
	};
}

/** `no-role`: the calendar is ready, but the person's roles have no grant in its policy that posts
 *  there, so approving their link again would not let it. */
type CalendarSetup = CalendarSpaceState | 'no-role';

/** Whether members-only events are on, for a link that may turn them on or post them; null for any
 *  other caller, and for a link the host refuses now. */
async function calendarState(
	group: GroupView,
	callerDid: string | null,
	person: CallerSession | null
): Promise<CalendarSetup | null> {
	const can = group.linked?.can;
	if (!can || !(can.turnOnMembersOnly || can.membersOnly)) return null;
	let space;
	try {
		space = await readCalendarSpace(await requireGroupWriter(group.did, callerDid));
	} catch (e) {
		console.warn(`[groups] the calendar space was not checked for a link: ${errorKind(e)}`);
		return null;
	}
	if (space.state !== 'ready' || can.membersOnly || !person) return space.state;
	const roles = await readRolesAsPerson(personReader(person), group.did, person.did).catch((e) => {
		console.info(`[groups] roles unread for the calendar's setup: ${errorKind(e)}`);
		return null;
	});
	return roles && !roles.some((role) => space.posters.includes(role)) ? 'no-role' : 'ready';
}

export async function load({ params, locals, url, setHeaders }) {
	requireGroupsEnabled();
	// What's on it depends on who's asking.
	setHeaders({ 'cache-control': 'no-store' });
	const person = locals.did ? await callerSession(locals.session ?? null) : null;
	const group = await groupView(params.actor, locals.did, person);
	/** A member whose own sign-in can't open members-only events. */
	const needsGuest = group.member === true && person !== null && !holdsGuestGrant(person.scope);
	const access = (group.askAccess || needsGuest) && person ? groupAccess(url, person.did) : null;
	const [events, eventCounts, membersOnly, calendar] = await Promise.all([
		hostedEvents(group.did as ActorIdentifier),
		getProfileCounts(env.DB, group.did),
		membersOnlySlice(group, person),
		calendarState(group, locals.did, person)
	]);
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		...events,
		/** How many public events it has made, as a profile counts a person's. */
		eventsCreated: eventCounts?.created ?? null,
		/** Members-only events, only for someone who may see them. */
		membersOnly,
		/** Whether members-only events are on, for a link that may turn them on or post them. */
		calendar,
		signedIn: Boolean(locals.did),
		you: locals.did,
		/** What the person's own sign-in needs before they can join or see the group as a member. */
		access,
		/** The ask is for members-only events: they are a member already. */
		accessForMembersOnly: needsGuest,
		spacesServer: access === 'refused' ? spacesServer() : null,
		notice: linkNotice(url.searchParams.get('link'), group.linked)
	};
}

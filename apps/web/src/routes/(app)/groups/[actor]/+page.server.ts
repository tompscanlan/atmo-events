import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { hostingQuery } from '#lib/contrail/queries.js';
import type { FlatEventRecord } from '#lib/contrail.js';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import { listMembersOnlyEvents, upcoming } from '#lib/groups/server/calendar-read.js';
import { groupView, requireGroupWriter, type GroupView } from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { calendarSpaceState, type CalendarSpaceState } from '#lib/groups/server/group-events.js';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { spacesServer } from '#lib/private-events/server/enabled.js';
import { holdsGuestGrant } from '#lib/private-events/scopes.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

const LINK_NOTICES = {
	linked: 'Linked. What your role allows, you can now do for this group here.',
	created: 'Your group is made, and linked. Post its events from here.'
} as const;

/** `unread` says why `events` is empty when they could not be read. */
interface MembersOnlySlice {
	events: FlatEventRecord[];
	unread: boolean;
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
		const events = await listMembersOnlyEvents(holder, group.did);
		return events && { events: upcoming(events), unread: false };
	} catch (e) {
		console.error(`[groups] members-only events unread for a group page: ${errorKind(e)}`);
		return { events: [], unread: true };
	}
}

/** Whether members-only events are on, for a link that may turn them on or post them; null for any
 *  other caller, and for a link the host refuses now. */
async function calendarState(
	group: GroupView,
	callerDid: string | null
): Promise<CalendarSpaceState | null> {
	const can = group.linked?.can;
	if (!can || !(can.turnOnMembersOnly || can.membersOnly)) return null;
	try {
		return await calendarSpaceState(await requireGroupWriter(group.did, callerDid));
	} catch (e) {
		console.warn(`[groups] the calendar space was not checked for a link: ${errorKind(e)}`);
		return null;
	}
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
	const [page, membersOnly, calendar] = await Promise.all([
		hostingQuery(getServerClient(env.DB), { actor: group.did as ActorIdentifier }, null),
		membersOnlySlice(group, person),
		calendarState(group, locals.did)
	]);
	const link = url.searchParams.get('link');
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		events: page.events,
		cursor: page.cursor,
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
		notice:
			link && Object.hasOwn(LINK_NOTICES, link)
				? LINK_NOTICES[link as keyof typeof LINK_NOTICES]
				: null
	};
}

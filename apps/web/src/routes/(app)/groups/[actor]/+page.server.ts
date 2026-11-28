import { env } from 'cloudflare:workers';
import type { ActorIdentifier } from '@atcute/lexicons';
import { getServerClient } from '#lib/contrail/index.js';
import { EMPTY_ONGOING, ongoingQuery } from '#lib/contrail/ongoing.js';
import { flattenEventRecords, listAuthoredEventsFromContrail } from '#lib/contrail.js';
import { hasEnded } from '#lib/past-events.js';
import { getProfileCounts } from '#lib/server/profile-counts.js';
import { groupView, type LinkedGroup } from '#lib/groups/server/context.js';
import type { GroupAbilities } from '#lib/groups/scopes.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';

const LINK_NOTICES = {
	linked: 'Linked.'
} as const;

/** What a working link lets the person do here, as the page offers it. */
function linkAbilities(can: GroupAbilities): string {
	const things = [can.post && 'post its events'].filter((thing): thing is string => Boolean(thing));
	if (things.length === 0) return 'Your role in this group lets you see it here.';
	const all =
		things.length === 1 ? things[0] : `${things.slice(0, -1).join(', ')} and ${things.at(-1)}`;
	return `You can now ${all} here.`;
}

/** After a link, only to the person who holds it and only while it works, worded from what it
 *  may do; a made-up `?link=` is no notice. */
function linkNotice(link: string | null, linked: LinkedGroup | null): string | null {
	if (!link || !linked || !Object.hasOwn(LINK_NOTICES, link)) return null;
	return `${LINK_NOTICES[link as keyof typeof LINK_NOTICES]} ${linkAbilities(linked.can)}`;
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

export async function load({ params, locals, url, setHeaders }) {
	requireGroupsEnabled();
	// What's on it depends on who's asking.
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals.did);
	const [events, eventCounts] = await Promise.all([
		hostedEvents(group.did as ActorIdentifier),
		getProfileCounts(env.DB, group.did)
	]);
	return {
		pageTitle: group.name,
		pageDescription: group.description ?? `Events from ${group.name}.`,
		group,
		...events,
		/** How many public events it has made, as a profile counts a person's. */
		eventsCreated: eventCounts?.created ?? null,
		signedIn: Boolean(locals.did),
		notice: linkNotice(url.searchParams.get('link'), group.linked)
	};
}

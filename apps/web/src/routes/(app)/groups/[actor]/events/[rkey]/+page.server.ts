import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { membersOnlyEventForDisplay, readMembersOnlyEvent } from '$lib/groups/server/calendar-read';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** Every caller who may not see the event, and every key the calendar space
 *  does not hold, gets this, byte for byte. */
const EVENT_NOT_FOUND = 'Event not found';

/**
 * One members-only event, read from the group's calendar space as the group.
 * This route serves members-only events only; a public event's page is the
 * person-style event page, as before.
 *
 * Membership is checked before any read of the space. The route context reads
 * the caller's standing, as every group page does, and a caller off the roster
 * stops there with the same 404 as a key the space does not hold, so the page
 * says nothing about whether the event exists. No further request goes through
 * the group's session on their behalf. (Spec: FR-117.)
 *
 * Nothing is stored between requests or read from a shared store: a member's
 * failed read is a 503 that says why, never an earlier copy, which would be
 * served to whoever asked next. The event index is not asked either, since it
 * never holds a members-only event. (Spec: FR-111a, FR-117.)
 */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const env = platform!.env;
	const db = env.DB;
	const { group, membership } = await groupRouteContext(env, db, params.actor, locals.did);

	// The roster, never the group's visibility: a public group shows itself to
	// everyone, and only its members see its members-only events.
	if (!canSeeMembers(membership)) error(404, EVENT_NOT_FOUND);

	const reader = await groupSpaceReader(env, db, group);
	const read = await readMembersOnlyEvent(membership, reader, group, params.rkey);
	if (read.status === 'hidden' || read.status === 'absent') error(404, EVENT_NOT_FOUND);
	if (read.status !== 'found') error(503, read.notice);

	// The page shows the event without its image, and the shared read keeps it.
	const shown = membersOnlyEventForDisplay(read.event);
	// A record with no start is not an event the page can show, as on the
	// person-style event page.
	if (typeof shown.value.startsAt !== 'string') error(404, EVENT_NOT_FOUND);

	// The host's name, after the event read, and only for a page that will
	// render. A profile that cannot be read leaves the host unnamed.
	let hostName: string | null = null;
	if (reader) {
		try {
			hostName = (await readGroupAbout(reader, group)).profile?.name ?? null;
		} catch (e) {
			console.error(
				`[groups] ${group.group_did}: the profile could not be read for an event's host:`,
				e
			);
		}
	}

	return {
		eventData: {
			...shown.value,
			cid: shown.cid,
			did: group.group_did,
			rkey: shown.rkey,
			uri: shown.uri,
			space: shown.space
		},
		actorDid: group.group_did,
		rkey: shown.rkey,
		/** The space form, which an RSVP to this event names. (Spec: FR-120.) */
		eventUri: shown.uri,
		spaceUri: shown.space,
		// Who is going is read as the group, member by member, once members-only
		// RSVPs land. Until then the page shows no one and reads nothing.
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		viewerRsvpStatus: null,
		viewerRsvpRkey: null,
		hostProfile: hostName ? { did: group.group_did, displayName: hostName } : null,
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};

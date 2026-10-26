import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { can } from '$lib/groups/permissions';
import { readGroupAbout } from '$lib/groups/server/about-read';
import { gateCaller } from '$lib/groups/server/caller';
import { membersOnlyEventForDisplay, readMembersOnlyEvent } from '$lib/groups/server/calendar-read';
import { readOwnMembersOnlyRsvp } from '$lib/groups/server/member-rsvp';
import { groupPath, groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** A caller off the roster and a key the calendar space does not hold get the same answer. */
const EVENT_NOT_FOUND = 'Event not found';

/** One members-only event, from the calendar space with the caller's own access; a public
 *  event's page is the person-style one. Nothing is cached, and the index is never asked. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const viewer = await gateCaller(locals.did, locals.session);
	const { group, membership, reader } = await groupRouteContext(db, params.actor, viewer, {
		signInNotice: true
	});
	if (membership.signIn) return { actorDid: group.group_did, signIn: true as const };
	if (!canSeeMembers(membership)) error(404, EVENT_NOT_FOUND);

	const read = await readMembersOnlyEvent(membership, reader, group, params.rkey);
	if (read.status === 'hidden' || read.status === 'absent') error(404, EVENT_NOT_FOUND);
	if (read.status !== 'found') error(503, read.notice);
	const shown = membersOnlyEventForDisplay(read.event);
	if (typeof shown.value.startsAt !== 'string') error(404, EVENT_NOT_FOUND);

	let hostName: string | null = null;
	if (reader) {
		try {
			hostName = (await readGroupAbout(reader, group)).profile?.name ?? null;
		} catch (e) {
			console.error(`[groups] ${group.group_did}: the profile could not be read:`, e);
		}
	}
	const own = await readOwnMembersOnlyRsvp(membership, group, viewer, shown.rkey);

	return {
		signIn: false as const,
		eventData: {
			...shown.value,
			cid: shown.cid,
			did: group.group_did,
			rkey: shown.rkey,
			uri: shown.uri,
			space: read.event.space
		},
		actorDid: group.group_did,
		rkey: shown.rkey,
		/** The space form, which an RSVP names. */
		eventUri: shown.uri,
		spaceUri: read.event.space,
		// Who is going would be read member by member with the viewer's own credential; not yet.
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		viewerRsvpStatus: own?.status ?? null,
		viewerRsvpRkey: own?.rkey ?? null,
		membersOnly: true,
		hostProfile: hostName ? { did: group.group_did, displayName: hostName } : null,
		// The link names the placement: a public event can share this key.
		...(can(membership.permissions, 'MANAGE_EVENTS')
			? { editHref: `${groupPath(group, 'events')}/${shown.rkey}/edit?placement=members` }
			: {})
	};
};

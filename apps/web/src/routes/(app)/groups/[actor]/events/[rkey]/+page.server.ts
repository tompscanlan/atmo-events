import { error } from '@sveltejs/kit';
import { membersOnlyEventUri } from '#lib/groups/ids.js';
import { readMembersOnlyEvent } from '#lib/groups/server/calendar-read.js';
import { callerSession } from '#lib/groups/server/caller.js';
import { groupView } from '#lib/groups/server/context.js';
import { readMembersOnlyRsvp } from '#lib/groups/server/member-rsvp.js';

/** Byte for byte, so a caller kept out cannot tell an event that exists from one that does not. */
const EVENT_NOT_FOUND = 'Event not found';

// A members-only event, read with the viewer's own access. Its public counterpart is the
// ordinary event page; nothing here reaches the index or a public URL.
export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	const caller = group.member ? await callerSession(locals.session ?? null) : null;
	if (!caller) error(404, EVENT_NOT_FOUND);

	const [eventData, rsvp] = await Promise.all([
		readMembersOnlyEvent(caller, group.did, params.rkey).catch((e) => {
			console.error(`[groups] ${group.did}: event ${params.rkey} unread for ${caller.did}:`, e);
			error(503, 'This event could not be read right now. Try again shortly.');
		}),
		readMembersOnlyRsvp(caller, group.did, params.rkey)
	]);
	if (!eventData) error(404, EVENT_NOT_FOUND);

	return {
		pageTitle: eventData.name,
		pageDescription: `A members-only event of ${group.name}.`,
		eventData,
		actorDid: group.did,
		rkey: params.rkey,
		hostProfile: { did: group.did, handle: group.handle ?? undefined, displayName: group.name },
		// No one else's answers are read: each sits in its member's own repo.
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		viewerRsvpStatus: rsvp,
		viewerRsvpRkey: rsvp ? params.rkey : null,
		eventUri: membersOnlyEventUri(group.did, params.rkey),
		shareable: false,
		loggedIn: true,
		group: { did: group.did, name: group.name, linked: group.linked !== null }
	};
}

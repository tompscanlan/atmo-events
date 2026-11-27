import { error } from '@sveltejs/kit';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import { membersOnlyEvent } from '#lib/groups/server/calendar-read.js';
import { groupView, requireGroupWriter } from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import {
	calendarPrivacyAsGroup,
	readMembersOnlyEventAsGroup
} from '#lib/groups/server/group-events.js';
import {
	readMembersOnlyEventPage,
	type MembersOnlyEventPage
} from '#lib/groups/server/member-rsvp.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { spacesServer } from '#lib/private-events/server/enabled.js';
import { holdsGuestGrant } from '#lib/private-events/scopes.js';
import { parseEventDescription } from '#lib/server/event-description.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

/** Byte for byte, so someone kept out can't tell an event that exists from one that doesn't. */
const EVENT_NOT_FOUND = 'Event not found';

// A group's members-only event, read with the member's own access, or as the group through a link
// that may post them. Every step before the read is the same at any key, so it says nothing about
// whether this event exists; nothing here reaches the index or a public URL.
export async function load({ params, locals, url, setHeaders }) {
	requireGroupsEnabled();
	setHeaders({ 'cache-control': 'no-store' });
	const person = locals.did ? await callerSession(locals.session ?? null) : null;
	const group = await groupView(params.actor, locals.did, person);
	const base = {
		pageTitle: 'Members-only event',
		group: { did: group.did, handle: group.handle, name: group.name }
	};
	if (!person) return { ...base, view: 'signed-out' as const };

	const reads = group.member === true && holdsGuestGrant(person.scope);
	const asGroup = !reads && Boolean(group.linked?.can.membersOnly);
	if (!reads && !asGroup) {
		// A member, or someone who could not be told one, whose own sign-in lacks what reading takes.
		if (group.member === true || group.askAccess) {
			return {
				...base,
				view: 'grant' as const,
				did: person.did,
				access: groupAccess(url, person.did),
				spacesServer: spacesServer()
			};
		}
		error(404, EVENT_NOT_FOUND);
	}

	let found: MembersOnlyEventPage | null;
	try {
		if (reads) {
			found = await readMembersOnlyEventPage(person, group.did, params.rkey);
		} else {
			const writer = await requireGroupWriter(group.did, locals.did);
			const stored = await readMembersOnlyEventAsGroup(writer, params.rkey);
			const event = stored && membersOnlyEvent(group.did, stored);
			const privacy = event ? await calendarPrivacyAsGroup(writer) : 'unknown';
			found = event ? { event, viewerStatus: null, privacy } : null;
		}
	} catch (e) {
		console.error(`[groups] a members-only event unread for its page: ${errorKind(e)}`);
		error(503, 'This event could not be read right now. Try again shortly.');
	}
	if (!found) error(404, EVENT_NOT_FOUND);

	const { event, viewerStatus, privacy } = found;
	return {
		...base,
		view: 'event' as const,
		pageTitle: event.name,
		eventData: event,
		description: parseEventDescription(event),
		actorDid: group.did,
		rkey: params.rkey,
		hostProfile: { did: group.did, handle: group.handle ?? undefined, displayName: group.name },
		// No one else's answers are read: each sits in its member's own repo.
		attendees: { going: [], interested: [], goingCount: 0, interestedCount: 0 },
		viewerRsvpStatus: viewerStatus,
		/** Shown as members-only only while its calendar is, as read now. */
		calendarPrivacy: privacy,
		viewerRsvpRkey: viewerStatus ? params.rkey : null,
		loggedIn: true,
		/** Their own sign-in may RSVP; a link's admin without it is told how. */
		canRsvp: holdsGuestGrant(person.scope),
		canEdit: Boolean(group.linked?.can.membersOnly)
	};
}

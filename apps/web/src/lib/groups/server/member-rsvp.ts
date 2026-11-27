// A member's view of a members-only event, and their RSVP to it: a community.lexicon.calendar.rsvp
// written with their own session into their repo in the group's calendar space, as a guest answers
// a private event, never into their public repo, which would publish the event's address and who
// is going. The server picks the space, the key (the event's) and the subject (the event's URI and
// CID, read with the member's own access, which also proves the host lets them see it).
import type { FlatEventRecord } from '#lib/contrail.js';
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { RSVP_COLLECTION, type RsvpStatus } from '#lib/private-events/ids.js';
import { holdsGuestGrant } from '#lib/private-events/scopes.js';
import { didSpaceHosts, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import { membersOnlyEventUri } from '../calendar';
import {
	readCalendarPrivacy,
	readMembersOnlyEvent,
	readOwnRsvp,
	type CalendarPrivacy
} from './calendar-read';
import { chosenCalendar } from './calendar-choice';
import { errorKind, isRecordNotFound, xrpc } from './xrpc';

const REFUSALS = {
	'no-grant':
		"atmo doesn't have your permission to RSVP to members-only events yet, so nothing changed.",
	'no-event': "This event isn't there for you anymore, so nothing was saved.",
	changed: 'This event changed since you opened it. Reload to see the latest, then RSVP again.',
	unchecked: "Your RSVP couldn't be saved just now. Try again shortly.",
	refused: "Your server didn't take the change, so nothing changed."
} as const;

/** In words a page can show; a server's own message is never kept. */
export class RsvpRefused extends Error {
	constructor(readonly reason: keyof typeof REFUSALS) {
		super(REFUSALS[reason]);
		this.name = 'RsvpRefused';
	}
}

export interface MembersOnlyEventPage {
	event: FlatEventRecord;
	viewerStatus: RsvpStatus | null;
	/** Whether its calendar is still for members alone, as read now. */
	privacy: CalendarPrivacy;
}

/** Null when the member may not see it, or it is not there, alike. Only their own RSVP is read: each
 *  member's sits in their own repo. */
export async function readMembersOnlyEventPage(
	caller: CallerSession,
	groupDid: string,
	rkey: string,
	hosts: SpaceHosts = didSpaceHosts
): Promise<MembersOnlyEventPage | null> {
	const reader = credentialSpaceReader(caller, hosts);
	const space = await chosenCalendar(groupDid);
	const event = await readMembersOnlyEvent(reader, groupDid, rkey, space);
	if (!event) return null;
	const [viewerStatus, privacy] = await Promise.all([
		readOwnRsvp(reader, groupDid, caller.did, rkey, space),
		readCalendarPrivacy(reader, groupDid, space)
	]);
	return { event, viewerStatus, privacy };
}

function ownRsvp(caller: CallerSession, space: string, rkey: string) {
	return { space, repo: caller.did, collection: RSVP_COLLECTION, rkey };
}

/** `cid` is the event's as the page showed it, so no one answers a version they never saw. */
export async function putMembersOnlyRsvp(
	caller: CallerSession,
	groupDid: string,
	input: { rkey: string; status: RsvpStatus; cid: string | null },
	hosts: SpaceHosts = didSpaceHosts
): Promise<void> {
	if (!holdsGuestGrant(caller.scope)) throw new RsvpRefused('no-grant');
	const reader = credentialSpaceReader(caller, hosts);
	const space = await chosenCalendar(groupDid).catch((e) => {
		console.error(`[groups] the calendar unread for an RSVP: ${errorKind(e)}`);
		throw new RsvpRefused('unchecked');
	});
	const event = await readMembersOnlyEvent(reader, groupDid, input.rkey, space).catch((e) => {
		console.error(`[groups] a members-only event unread for an RSVP: ${errorKind(e)}`);
		throw new RsvpRefused('unchecked');
	});
	if (!event?.cid) throw new RsvpRefused('no-event');
	if (input.cid !== event.cid) throw new RsvpRefused('changed');
	try {
		await xrpc(caller.handle, 'com.atproto.space.putRecord', {
			body: {
				...ownRsvp(caller, space, input.rkey),
				record: {
					$type: RSVP_COLLECTION,
					status: `${RSVP_COLLECTION}#${input.status}`,
					subject: { uri: membersOnlyEventUri(groupDid, input.rkey, space), cid: event.cid },
					createdAt: new Date().toISOString()
				}
			}
		});
	} catch (e) {
		console.error(`[groups] a members-only RSVP not saved: ${errorKind(e)}`);
		throw new RsvpRefused('refused');
	}
}

export async function deleteMembersOnlyRsvp(
	caller: CallerSession,
	groupDid: string,
	rkey: string
): Promise<void> {
	if (!holdsGuestGrant(caller.scope)) throw new RsvpRefused('no-grant');
	try {
		await xrpc(caller.handle, 'com.atproto.space.deleteRecord', {
			body: ownRsvp(caller, await chosenCalendar(groupDid), rkey)
		});
	} catch (e) {
		if (isRecordNotFound(e)) return;
		console.error(`[groups] a members-only RSVP not deleted: ${errorKind(e)}`);
		throw new RsvpRefused('refused');
	}
}

// A member's RSVP to a members-only event: a community.lexicon.calendar.rsvp written with the
// member's own session into their repo in the group's calendar space, never their public
// repo, which would publish the event's URI and who is going. The server picks the space, the
// key (the event's) and the subject (the event's space URI and its current CID, read with the
// member's own access, which also proves the host lets them see it).
import {
	calendarSpaceUri,
	GROUP_RSVP_COLLECTION,
	membersOnlyEventUri,
	RSVP_STATUSES,
	type RsvpStatus
} from '../ids';
import { holdsCalendarGrant } from '../scopes';
import { readMembersOnlyEvent } from './calendar-read';
import type { CallerSession } from './caller';
import { isRecordNotFound, xrpc } from './xrpc';

const REFUSALS = {
	'no-grant':
		"Your sign-in doesn't let atmo RSVP to members-only events yet, so nothing was saved.",
	'no-event': "This event isn't there for you anymore, so nothing was saved.",
	changed: 'This event changed since you opened it. Reload to see the latest, then RSVP again.',
	unchecked: "Your RSVP couldn't be saved just now. Try again shortly.",
	refused: "Your PDS didn't take the change to your RSVP, so nothing changed."
} as const;

/** In words a page can show; the PDS's own message is never kept. */
export class RsvpRefused extends Error {
	constructor(readonly reason: keyof typeof REFUSALS) {
		super(REFUSALS[reason]);
		this.name = 'RsvpRefused';
	}
}

function ownRsvp(caller: CallerSession, groupDid: string, rkey: string) {
	return {
		space: calendarSpaceUri(groupDid),
		repo: caller.did,
		collection: GROUP_RSVP_COLLECTION,
		rkey
	};
}

/** `cid` is the event's as the page showed it, so no one answers a version they never saw. */
export async function putMembersOnlyRsvp(
	caller: CallerSession,
	groupDid: string,
	input: { rkey: string; status: RsvpStatus; cid: string | null }
): Promise<void> {
	if (!holdsCalendarGrant(caller.scope, 'create', groupDid)) throw new RsvpRefused('no-grant');
	const event = await readMembersOnlyEvent(caller, groupDid, input.rkey).catch((e) => {
		console.error(`[groups] ${groupDid}: event ${input.rkey} unread for ${caller.did}:`, e);
		throw new RsvpRefused('unchecked');
	});
	if (!event?.cid) throw new RsvpRefused('no-event');
	if (input.cid !== event.cid) throw new RsvpRefused('changed');
	try {
		await xrpc(caller.handle, 'com.atproto.space.putRecord', {
			body: {
				...ownRsvp(caller, groupDid, input.rkey),
				record: {
					$type: GROUP_RSVP_COLLECTION,
					status: `${GROUP_RSVP_COLLECTION}#${input.status}`,
					subject: { uri: membersOnlyEventUri(groupDid, input.rkey), cid: event.cid },
					createdAt: new Date().toISOString()
				}
			}
		});
	} catch (e) {
		console.error(`[groups] ${groupDid}: ${caller.did}'s RSVP at ${input.rkey}:`, e);
		throw new RsvpRefused('refused');
	}
}

/** The PDS answers the same whether or not it was there. */
export async function deleteMembersOnlyRsvp(
	caller: CallerSession,
	groupDid: string,
	rkey: string
): Promise<void> {
	if (!holdsCalendarGrant(caller.scope, 'delete', groupDid)) throw new RsvpRefused('no-grant');
	try {
		await xrpc(caller.handle, 'com.atproto.space.deleteRecord', {
			body: ownRsvp(caller, groupDid, rkey)
		});
	} catch (e) {
		console.error(`[groups] ${groupDid}: ${caller.did}'s RSVP at ${rkey} not deleted:`, e);
		throw new RsvpRefused('refused');
	}
}

/** Null when there is none, for another event, or when it cannot be read (logged): the page
 *  then shows no RSVP rather than failing. */
export async function readMembersOnlyRsvp(
	caller: CallerSession,
	groupDid: string,
	rkey: string
): Promise<RsvpStatus | null> {
	if (!holdsCalendarGrant(caller.scope, 'read', groupDid)) return null;
	let found: Record<string, unknown>;
	try {
		found = await xrpc(caller.handle, 'com.atproto.space.getRecord', {
			query: ownRsvp(caller, groupDid, rkey)
		});
	} catch (e) {
		if (!isRecordNotFound(e)) console.error(`[groups] ${caller.did}'s RSVP at ${rkey}:`, e);
		return null;
	}
	const value = found.value as { status?: unknown; subject?: { uri?: unknown } } | undefined;
	if (value?.subject?.uri !== membersOnlyEventUri(groupDid, rkey)) return null;
	return RSVP_STATUSES.find((s) => value.status === `${GROUP_RSVP_COLLECTION}#${s}`) ?? null;
}

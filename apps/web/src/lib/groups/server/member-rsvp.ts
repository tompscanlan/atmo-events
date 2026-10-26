// A member's RSVP to a members-only event: a community.lexicon.calendar.rsvp written from the
// member's own session into their repo in the group's calendar space, never their public repo,
// which would publish the event's URI and who is going. The server picks the space, the key
// (the event's) and the subject (the event's space URI and its current cid); the page's cid is
// only compared, so no one answers a version of the event they never saw.
//
// A session without the grant is sent to sign in again once. Back from it (`reauthorized`) and
// still without the grant, the member is told their PDS can't do this yet.
import { canSeeMembers } from '../access';
import {
	GROUP_RSVP_COLLECTION,
	RSVP_STATUSES,
	groupSpaceUris,
	membersOnlyEventUri,
	spaceRecordUri,
	type RsvpStatus
} from '../ids';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { readMembersOnlyEvent } from './calendar-read';
import type { CallerSession } from './caller';
import { errorText } from './errors';
import { holdsRsvpGrant } from './member-grants';
import { describeFailure, xrpc, type XrpcAnswer } from './xrpc';

export const RSVP_NO_SPACES =
	"Your PDS can't RSVP to members-only events yet, so nothing was saved.";
export const RSVP_RETRY_LATER = "Your RSVP couldn't be saved just now. Try again in a few minutes.";
export const RSVP_REFUSED = "Your PDS didn't accept the change to your RSVP, so nothing changed.";
export const RSVP_NO_EVENT = "This event isn't there anymore, so nothing was saved.";
export const RSVP_EVENT_CHANGED =
	'This event changed since you opened it. Reload the page to see the latest, then RSVP again.';

type RsvpGroup = Pick<GroupRow, 'group_did'>;

export interface MembersOnlyRsvpTarget {
	membership: CallerMembership;
	group: RsvpGroup;
	member: CallerSession | null;
	/** The event's key, which is also the RSVP's. */
	rkey: string;
	/** The page came back from a sign-in that asked for the grant. */
	reauthorized: boolean;
	/** Starts a sign-in that asks for the grant: its URL, or null. */
	reauthorize: () => Promise<string | null>;
}

export interface MembersOnlyRsvpInput extends MembersOnlyRsvpTarget {
	status: RsvpStatus;
	/** The event's cid as the page showed it. */
	cid: string | null;
	reader: () => Promise<GroupSpaceReader | null>;
}

export type MembersOnlyRsvpFailure =
	| { ok: false; reason: 'not-member' }
	| { ok: false; reason: 'reauthorize'; url: string }
	| { ok: false; reason: 'no-spaces' | 'retry-later' | 'refused' | 'changed'; message: string };

export type MembersOnlyRsvpPut = { ok: true; uri: string } | MembersOnlyRsvpFailure;
export type MembersOnlyRsvpCancel = { ok: true } | MembersOnlyRsvpFailure;

export interface OwnMembersOnlyRsvp {
	status: RsvpStatus;
	rkey: string;
}

function rsvpPlace(group: RsvpGroup, rkey: string) {
	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	return { space, eventUri: membersOnlyEventUri(group.group_did, rkey) };
}

async function withoutGrant(target: MembersOnlyRsvpTarget): Promise<MembersOnlyRsvpFailure> {
	if (target.reauthorized) return { ok: false, reason: 'no-spaces', message: RSVP_NO_SPACES };
	const url = await target.reauthorize();
	if (url) return { ok: false, reason: 'reauthorize', url };
	return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
}

async function currentEventCid(
	input: MembersOnlyRsvpInput
): Promise<{ ok: true; cid: string } | MembersOnlyRsvpFailure> {
	const read = await readMembersOnlyEvent(
		input.membership,
		await input.reader(),
		input.group,
		input.rkey
	);
	if (read.status === 'hidden') return { ok: false, reason: 'not-member' };
	if (read.status === 'absent') return { ok: false, reason: 'refused', message: RSVP_NO_EVENT };
	if (read.status === 'no-access') return withoutGrant(input);
	if (read.status === 'unreadable' || !read.event.cid) {
		return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
	}
	return { ok: true, cid: read.event.cid };
}

function refused(
	target: MembersOnlyRsvpTarget,
	what: 'write' | 'delete',
	cause: unknown
): MembersOnlyRsvpFailure {
	console.error(
		`[groups] ${target.group.group_did}: ${target.member?.did}'s RSVP ${what} at ${target.rkey} failed: ${errorText(cause)}`
	);
	return { ok: false, reason: 'refused', message: RSVP_REFUSED };
}

/** One putRecord at the event's key, which creates the RSVP or replaces an earlier answer. */
export async function putMembersOnlyRsvp(input: MembersOnlyRsvpInput): Promise<MembersOnlyRsvpPut> {
	if (!canSeeMembers(input.membership)) return { ok: false, reason: 'not-member' };
	const { member, group, rkey } = input;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'create')) {
		return withoutGrant(input);
	}
	const event = await currentEventCid(input);
	if (!event.ok) return event;
	if (input.cid !== event.cid) return { ok: false, reason: 'changed', message: RSVP_EVENT_CHANGED };
	const { space, eventUri } = rsvpPlace(group, rkey);
	let sent: XrpcAnswer;
	try {
		sent = await xrpc(member.handle, 'com.atproto.space.putRecord', {
			body: {
				space,
				repo: member.did,
				collection: GROUP_RSVP_COLLECTION,
				rkey,
				record: {
					$type: GROUP_RSVP_COLLECTION,
					status: `${GROUP_RSVP_COLLECTION}#${input.status}`,
					subject: { uri: eventUri, cid: event.cid },
					createdAt: new Date().toISOString()
				}
			}
		});
	} catch (e) {
		return refused(input, 'write', e);
	}
	if (!sent.ok) return refused(input, 'write', describeFailure(sent));
	const uri = typeof sent.data.uri === 'string' ? sent.data.uri : null;
	return { ok: true, uri: uri ?? spaceRecordUri(space, member.did, GROUP_RSVP_COLLECTION, rkey) };
}

/** The PDS answers the same whether or not it was there. */
export async function deleteMembersOnlyRsvp(
	target: MembersOnlyRsvpTarget
): Promise<MembersOnlyRsvpCancel> {
	if (!canSeeMembers(target.membership)) return { ok: false, reason: 'not-member' };
	const { member, group, rkey } = target;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'delete')) {
		return withoutGrant(target);
	}
	const { space } = rsvpPlace(group, rkey);
	let sent: XrpcAnswer;
	try {
		sent = await xrpc(member.handle, 'com.atproto.space.deleteRecord', {
			body: { space, repo: member.did, collection: GROUP_RSVP_COLLECTION, rkey }
		});
	} catch (e) {
		return refused(target, 'delete', e);
	}
	if (!sent.ok) return refused(target, 'delete', describeFailure(sent));
	return { ok: true };
}

/** Null when there is none, when the session can't read it, or when the read fails (logged):
 *  the page then shows no RSVP rather than failing. */
export async function readOwnMembersOnlyRsvp(
	membership: CallerMembership,
	group: RsvpGroup,
	member: CallerSession | null,
	rkey: string
): Promise<OwnMembersOnlyRsvp | null> {
	if (!canSeeMembers(membership)) return null;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'read')) return null;
	const { space, eventUri } = rsvpPlace(group, rkey);
	let sent: XrpcAnswer;
	try {
		sent = await xrpc(member.handle, 'com.atproto.space.getRecord', {
			query: { space, repo: member.did, collection: GROUP_RSVP_COLLECTION, rkey }
		});
	} catch (e) {
		console.error(`[groups] ${group.group_did}: ${member.did}'s RSVP at ${rkey}:`, e);
		return null;
	}
	if (!sent.ok) {
		if (sent.error !== 'RecordNotFound') {
			console.error(
				`[groups] ${group.group_did}: ${member.did}'s RSVP at ${rkey}: ${describeFailure(sent)}`
			);
		}
		return null;
	}
	const value = sent.data.value as { status?: unknown; subject?: { uri?: unknown } } | undefined;
	if (value?.subject?.uri !== eventUri) return null;
	const status = RSVP_STATUSES.find((s) => value.status === `${GROUP_RSVP_COLLECTION}#${s}`);
	return status ? { status, rkey } : null;
}

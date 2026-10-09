// A member's RSVP to a members-only event. It is a standard
// community.lexicon.calendar.rsvp that the member writes from their own session
// into the group's calendar space, in their own repo there. It is never written
// to their public repo, and nothing falls back to one: a public RSVP would
// publish the event's URI and who is going. (Spec: FR-113.)
//
// Everything the write names is chosen here, on the server, never by the page:
// the space is the group's calendar space, the key is the event's key, and the
// subject is the event's space-form URI, the one the PDS gave the event in the
// space. With the event's key, a member holds one RSVP per event, and reading it
// back, for them or for the group, is one lookup. (Spec: FR-120.)
//
// The subject also names the version of the event the RSVP answers: its cid,
// from a read of the event as the group just before the write. An RSVP to an
// event that is gone saves nothing. The page sends the cid it showed, which is
// compared and never written: when the event has changed since, nothing is
// saved and the member is told to reload, so no one answers a version they
// never saw. A cancel reads no event, since it removes whatever the RSVP named.
//
// A request goes to the member's PDS only when their session holds the group's
// grant for it (./member-grants.ts). Without it, the member is sent to
// re-authorize once, with a marker for the page to carry through consent and
// back. Only when that marker comes back, made for this member under an earlier
// session, so that a new session has been issued since, and the session still
// lacks the grant, are they told that their PDS can't do this yet. A missing
// grant alone also describes a session from before RSVPs joined the grant, a
// link another member shared, and Back from the consent screen, and each of
// those is sent to re-authorize again. A re-authorization the PDS refuses (an
// invalid_scope on every grant set, as happens while it still holds older
// client metadata) says to try again shortly, and so does a marker that comes
// back to a session that can't be read. Nothing loops and nothing is retried.
// (Spec: FR-114.)
//
// Shared with the e2e harness, like ./roster.ts, so both run the same sequence.
import { canSeeMembers } from '../access';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import type { MemberSession } from './acceptance';
import { readMembersOnlyEvent } from './calendar-read';
import { holdsRsvpGrant } from './member-grants';

import {
	GROUP_RSVP_COLLECTION,
	RSVP_STATUSES,
	groupSpaceUris,
	membersOnlyEventUri,
	spaceRecordUri,
	type RsvpStatus
} from '../ids';

import { describeFailure, xrpc, type XrpcAnswer } from './xrpc';
/** Shown once a re-authorization that asked for the grant came back without it. */
export const RSVP_NO_SPACES =
	"Your PDS can't RSVP to members-only events yet, so nothing was saved.";
/** Shown when the PDS refused the re-authorization itself. */
export const RSVP_RETRY_LATER = "Your RSVP couldn't be saved just now. Try again in a few minutes.";
/** Shown when the member's PDS refused the write, or never answered. */
export const RSVP_REFUSED = "Your PDS didn't accept the change to your RSVP, so nothing changed.";
/** Shown when the calendar space holds no event at the key. */
export const RSVP_NO_EVENT = "This event isn't there anymore, so nothing was saved.";
/** Shown when the page showed another version of the event than the one there now. */
export const RSVP_EVENT_CHANGED =
	'This event changed since you opened it. Reload the page to see the latest, then RSVP again.';

type RsvpGroup = Pick<GroupRow, 'group_did'>;

/** What a cancel needs: who is asking and about which event. */
export interface MembersOnlyRsvpTarget {
	/** The caller's standing in the group, read the way the pages read it. */
	membership: CallerMembership;
	group: RsvpGroup;
	/** The caller's own session, or null when there is none to read. */
	member: MemberSession | null;
	/** The event's key, which is also the RSVP's. */
	rkey: string;
	/** The signed-in caller's DID, which an asked marker must name. */
	callerDid: string;
	/** A stamp of the session this request came with: when its token expires,
	 *  in milliseconds, or 0 when that is not known. A new sign-in issues a new
	 *  token, so it changes the stamp. */
	stamp: number;
	/** The marker the page carried back from a re-authorization, exactly as it
	 *  was handed out, or null. */
	asked: string | null;
	/** Starts a re-authorization that asks for the grant: the URL to send the
	 *  member to, or null when it can't be had. */
	reauthorize: () => Promise<string | null>;
}

/** What an RSVP needs: a cancel's target, the answer, and what the event is. */
export interface MembersOnlyRsvpInput extends MembersOnlyRsvpTarget {
	status: RsvpStatus;
	/** The event's cid as the page showed it, or null. Compared with the event's
	 *  current cid, never written. */
	cid: string | null;
	/** The group's own space reader, or null for a group with no session. Asked
	 *  for only once the RSVP is about to be written. */
	groupReader: () => Promise<GroupSpaceReader | null>;
}

/** Every way an RSVP or a cancel can fail, one shape each. */
export type MembersOnlyRsvpFailure =
	| { ok: false; reason: 'not-member' }
	/** `marker` is for the page to carry through consent and back as `asked`. */
	| { ok: false; reason: 'reauthorize'; url: string; marker: string }
	| {
			ok: false;
			reason: 'no-spaces' | 'retry-later' | 'refused' | 'changed';
			message: string;
	  };

export type MembersOnlyRsvpPut = { ok: true; uri: string } | MembersOnlyRsvpFailure;
export type MembersOnlyRsvpCancel = { ok: true } | MembersOnlyRsvpFailure;

/** The member's RSVP, as the event page shows it. */
export interface OwnMembersOnlyRsvp {
	status: RsvpStatus;
	rkey: string;
}

/** Where an RSVP to the event at `rkey` lives, and the event it names. */
function rsvpPlace(group: RsvpGroup, rkey: string) {
	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	return { space, eventUri: membersOnlyEventUri(group.group_did, rkey) };
}

/** An asked marker: the caller's DID and the stamp of the session it was handed
 *  out under. It is not a secret: a caller who forges one changes only what they
 *  themselves are told. */
const MARKER = /^(did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048})~(0|[1-9][0-9]{0,15})$/;

function askedMarker(target: MembersOnlyRsvpTarget): string {
	return `${target.callerDid}~${target.stamp}`;
}

/** Whether the page's marker says this caller went through a re-authorization
 *  that asked for the grant: it names them, and a new session has been issued
 *  since it was handed out. A malformed marker says nothing. */
function askedSince(target: MembersOnlyRsvpTarget): boolean {
	const parts = target.asked === null ? null : MARKER.exec(target.asked);
	return !!parts && parts[1] === target.callerDid && Number(parts[2]) !== target.stamp;
}

/** The answer when the session lacks the grant, or can't be read: after a
 *  re-authorization that asked for it, the no-spaces message, or try again
 *  later when there is no session to tell; otherwise one re-authorization. */
async function withoutGrant(target: MembersOnlyRsvpTarget): Promise<MembersOnlyRsvpFailure> {
	if (askedSince(target)) {
		return target.member
			? { ok: false, reason: 'no-spaces', message: RSVP_NO_SPACES }
			: { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
	}
	const url = await target.reauthorize();
	if (url) return { ok: false, reason: 'reauthorize', url, marker: askedMarker(target) };
	return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
}

/** The event's current cid, read as the group, or the failure that stops the
 *  write: no event at the key, or one that could not be read. */
async function currentEventCid(
	input: MembersOnlyRsvpInput
): Promise<{ ok: true; cid: string } | MembersOnlyRsvpFailure> {
	const read = await readMembersOnlyEvent(
		input.membership,
		await input.groupReader(),
		input.group,
		input.rkey
	);
	if (read.status === 'hidden') return { ok: false, reason: 'not-member' };
	if (read.status === 'absent') return { ok: false, reason: 'refused', message: RSVP_NO_EVENT };
	if (read.status === 'unlinked') {
		console.error(
			`[groups] ${input.group.group_did}: no group session to read the event an RSVP names`
		);
		return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
	}
	// The read logged its own failure.
	if (read.status === 'unreadable') {
		return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
	}
	// A cid is what an RSVP cites the event by, so a host that gave none gives
	// the RSVP nothing to cite.
	if (!read.event.cid) {
		console.error(
			`[groups] ${input.group.group_did}: the host gave the event an RSVP names no cid`
		);
		return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
	}
	return { ok: true, cid: read.event.cid };
}

/** A refused or unanswered write, logged as the group's. Never retried. */
function refused(
	target: MembersOnlyRsvpTarget,
	what: 'write' | 'delete',
	cause: unknown
): MembersOnlyRsvpFailure {
	const detail =
		typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : String(cause);
	console.error(
		`[groups] ${target.group.group_did}: ${target.member?.did}'s RSVP ${what} at ${target.rkey} failed: ${detail}`
	);
	return { ok: false, reason: 'refused', message: RSVP_REFUSED };
}

/** Writes the member's RSVP into the calendar space at the event's key: one
 *  putRecord, which creates it or replaces an earlier answer, citing the
 *  version of the event the group reads just before. */
export async function putMembersOnlyRsvp(input: MembersOnlyRsvpInput): Promise<MembersOnlyRsvpPut> {
	if (!canSeeMembers(input.membership)) return { ok: false, reason: 'not-member' };
	const { member, group, rkey } = input;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'put')) {
		return await withoutGrant(input);
	}
	const event = await currentEventCid(input);
	if (!event.ok) return event;
	if (input.cid !== event.cid) {
		return { ok: false, reason: 'changed', message: RSVP_EVENT_CHANGED };
	}
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

/** Deletes the member's RSVP from the calendar space: one deleteRecord at the
 *  same space, collection and key. The PDS answers the same whether or not it
 *  was there. */
export async function deleteMembersOnlyRsvp(
	target: MembersOnlyRsvpTarget
): Promise<MembersOnlyRsvpCancel> {
	if (!canSeeMembers(target.membership)) return { ok: false, reason: 'not-member' };
	const { member, group, rkey } = target;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'delete')) {
		return await withoutGrant(target);
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

/** The member's own RSVP to the event at `rkey`, read through their session:
 *  one getRecord in their repo in the calendar space. Null when they have none,
 *  when their session can't read it (no session, or no read grant, and then
 *  nothing is sent), or when the read fails, which is logged: the page shows no
 *  RSVP rather than failing. A record at the key that names another event, or
 *  a status this page doesn't know, is not an RSVP to this event. */
export async function readOwnMembersOnlyRsvp(
	membership: CallerMembership,
	group: RsvpGroup,
	member: MemberSession | null,
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
		console.error(
			`[groups] ${group.group_did}: ${member.did}'s RSVP at ${rkey} could not be read:`,
			e
		);
		return null;
	}
	if (!sent.ok) {
		if (sent.error === 'RecordNotFound') return null;
		console.error(
			`[groups] ${group.group_did}: ${member.did}'s RSVP at ${rkey} could not be read: ${describeFailure(sent)}`
		);
		return null;
	}
	const value = sent.data.value as { status?: unknown; subject?: { uri?: unknown } } | undefined;
	if (value?.subject?.uri !== eventUri) return null;
	const status = RSVP_STATUSES.find((s) => value.status === `${GROUP_RSVP_COLLECTION}#${s}`);
	return status ? { status, rkey } : null;
}

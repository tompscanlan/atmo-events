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
// A request goes to the member's PDS only when their session holds the group's
// grant for it (./member-grants.ts). Without it, the member is sent to
// re-authorize once. Only after a re-authorization that asked for the grant
// comes back still without it are they told that their PDS can't do this yet,
// since a missing grant alone also describes a session from before RSVPs
// joined the grant. A re-authorization the PDS refuses (an invalid_scope on
// every grant set, as happens while it still holds older client metadata) says
// to try again shortly. Nothing loops and nothing is retried. (Spec: FR-114.)
//
// Shared with the e2e harness, like ./roster.ts, so both run the same sequence.
import { canSeeMembers } from '../access';
import type { CallerMembership, GroupRow } from '../types';
import type { MemberSession } from './acceptance';
import { holdsRsvpGrant } from './member-grants';
import { groupSpaceUris } from './space-uris';

const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';
const EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** Shown once a re-authorization that asked for the grant came back without it. */
export const RSVP_NO_SPACES =
	"Your PDS can't RSVP to members-only events yet, so nothing was saved.";
/** Shown when the PDS refused the re-authorization itself. */
export const RSVP_RETRY_LATER = "Your RSVP couldn't be saved just now. Try again in a few minutes.";
/** Shown when the member's PDS refused the write, or never answered. */
export const RSVP_REFUSED = "Your PDS didn't accept the change to your RSVP, so nothing changed.";

export type MembersOnlyRsvpStatus = 'going' | 'interested' | 'notgoing';
const STATUSES: readonly MembersOnlyRsvpStatus[] = ['going', 'interested', 'notgoing'];

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
	/** Whether the page says a re-authorization asked for the grant. */
	asked: boolean;
	/** Starts a re-authorization that asks for the grant: the URL to send the
	 *  member to, or null when it can't be had. */
	reauthorize: () => Promise<string | null>;
}

/** What an RSVP needs: a cancel's target, and the answer. */
export interface MembersOnlyRsvpInput extends MembersOnlyRsvpTarget {
	status: MembersOnlyRsvpStatus;
}

/** Every way an RSVP or a cancel can fail, one shape each. */
export type MembersOnlyRsvpFailure =
	| { ok: false; reason: 'not-member' }
	| { ok: false; reason: 'reauthorize'; url: string }
	| { ok: false; reason: 'no-spaces' | 'retry-later' | 'refused'; message: string };

export type MembersOnlyRsvpPut = { ok: true; uri: string } | MembersOnlyRsvpFailure;
export type MembersOnlyRsvpCancel = { ok: true } | MembersOnlyRsvpFailure;

/** The member's RSVP, as the event page shows it. */
export interface OwnMembersOnlyRsvp {
	status: MembersOnlyRsvpStatus;
	rkey: string;
}

/** Where an RSVP to the event at `rkey` lives, and the event it names. */
function rsvpPlace(group: RsvpGroup, rkey: string) {
	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	return { space, eventUri: `${space}/${group.group_did}/${EVENT_COLLECTION}/${rkey}` };
}

type Sent =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; status: number; error: string | null };

/** One request to the member's PDS, as the member: a procedure with `body`, or
 *  a query with `query`. */
async function send(
	member: MemberSession,
	nsid: string,
	request: { body: Record<string, unknown> } | { query: Record<string, string> }
): Promise<Sent> {
	const res =
		'body' in request
			? await member.handle(`/xrpc/${nsid}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(request.body)
				})
			: await member.handle(`/xrpc/${nsid}?${new URLSearchParams(request.query)}`, {
					method: 'GET'
				});
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (res.ok) return { ok: true, data: data ?? {} };
	return {
		ok: false,
		status: res.status,
		error: typeof data?.error === 'string' ? data.error : null
	};
}

/** What a PDS answer says, for a log line. */
function answer(sent: Exclude<Sent, { ok: true }>): string {
	return `${sent.status}${sent.error ? ` ${sent.error}` : ''}`;
}

/** The answer when the session lacks the grant: the no-spaces message after a
 *  re-authorization that asked for it, otherwise one re-authorization. */
async function withoutGrant(target: MembersOnlyRsvpTarget): Promise<MembersOnlyRsvpFailure> {
	if (target.asked) return { ok: false, reason: 'no-spaces', message: RSVP_NO_SPACES };
	const url = await target.reauthorize();
	if (url) return { ok: false, reason: 'reauthorize', url };
	return { ok: false, reason: 'retry-later', message: RSVP_RETRY_LATER };
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
 *  putRecord, which creates it or replaces an earlier answer. */
export async function putMembersOnlyRsvp(input: MembersOnlyRsvpInput): Promise<MembersOnlyRsvpPut> {
	if (!canSeeMembers(input.membership)) return { ok: false, reason: 'not-member' };
	const { member, group, rkey } = input;
	if (!member || !holdsRsvpGrant(member.scope, group.group_did, 'put')) {
		return await withoutGrant(input);
	}
	const { space, eventUri } = rsvpPlace(group, rkey);
	let sent: Sent;
	try {
		sent = await send(member, 'com.atproto.space.putRecord', {
			body: {
				space,
				repo: member.did,
				collection: RSVP_COLLECTION,
				rkey,
				record: {
					$type: RSVP_COLLECTION,
					status: `${RSVP_COLLECTION}#${input.status}`,
					subject: { uri: eventUri },
					createdAt: new Date().toISOString()
				}
			}
		});
	} catch (e) {
		return refused(input, 'write', e);
	}
	if (!sent.ok) return refused(input, 'write', answer(sent));
	const uri = typeof sent.data.uri === 'string' ? sent.data.uri : null;
	return { ok: true, uri: uri ?? `${space}/${member.did}/${RSVP_COLLECTION}/${rkey}` };
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
	let sent: Sent;
	try {
		sent = await send(member, 'com.atproto.space.deleteRecord', {
			body: { space, repo: member.did, collection: RSVP_COLLECTION, rkey }
		});
	} catch (e) {
		return refused(target, 'delete', e);
	}
	if (!sent.ok) return refused(target, 'delete', answer(sent));
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
	let sent: Sent;
	try {
		sent = await send(member, 'com.atproto.space.getRecord', {
			query: { space, repo: member.did, collection: RSVP_COLLECTION, rkey }
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
			`[groups] ${group.group_did}: ${member.did}'s RSVP at ${rkey} could not be read: ${answer(sent)}`
		);
		return null;
	}
	const value = sent.data.value as { status?: unknown; subject?: { uri?: unknown } } | undefined;
	if (value?.subject?.uri !== eventUri) return null;
	const status = STATUSES.find((s) => value.status === `${RSVP_COLLECTION}#${s}`);
	return status ? { status, rkey } : null;
}

// The names and addresses the groups feature shares between its server code and
// its pages: record collections, RSVP statuses, the host's read-policy names, and
// space and record URIs. Values only, with no transport, so any module, client
// or server, can import them without importing another's dependencies.
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

/** A group's events, public in its repo or members-only in its calendar space. */
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** An RSVP to an event. A members-only event's RSVPs live in the calendar space. */
export const GROUP_RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/** The answers an RSVP can give, as the lexicon's `status` token suffixes. */
export const RSVP_STATUSES = ['going', 'interested', 'notgoing'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const POLICY_PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
export const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy';

/** Every space is keyed `self`, the atproto singleton convention. A group owns
 *  one space of each type, so its space URIs follow from the DID alone. Never key
 *  a space on a user-chosen name, which can change or collide. */
export const SPACE_SKEY = 'self';

/** The PDS builds a space URI from owner, type and skey with no lookup. So an
 *  existing space's URI can be computed, which makes provisioning idempotent. */
export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

export interface GroupSpaceUris {
	aboutSpaceUri: string;
	membersSpaceUri: string;
	/** No column holds it: it follows from the DID, like the other two.
	 *  (Spec: FR-101a.) */
	calendarSpaceUri: string;
}

/** Every space URI from the DID alone, for a cache rebuild. */
export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY),
		calendarSpaceUri: spaceUri(groupDid, CALENDAR_SPACE_TYPE, SPACE_SKEY)
	};
}

/** A space record's URI, in the form `getRecord` returns. A rule citation uses it. */
export function spaceRecordUri(
	space: string,
	repo: string,
	collection: string,
	rkey: string
): string {
	return `${space}/${repo}/${collection}/${rkey}`;
}

/** A space record URI is `at://<owner>/space/<type>/<skey>/<repo>/<collection>/<rkey>`.
 *  Collection and rkey are the last two segments in both it and the plain form. */
export function splitRecordUri(uri: string): { collection: string; rkey: string } {
	const segments = uri.split('/');
	return {
		collection: segments[segments.length - 2] ?? '',
		rkey: segments[segments.length - 1] ?? ''
	};
}

/** A members-only event's URI: the group's own record in its calendar space. An
 *  RSVP to the event names it. (Spec: FR-120.) */
export function membersOnlyEventUri(groupDid: string, rkey: string): string {
	const { calendarSpaceUri } = groupSpaceUris(groupDid);
	return spaceRecordUri(calendarSpaceUri, groupDid, GROUP_EVENT_COLLECTION, rkey);
}

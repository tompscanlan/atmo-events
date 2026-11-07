// Collections, space types and URIs for groups, as the opensocial.group proposal names them.
// Values only, so the contrail config and the pages can import them.

/** In the group's public repo while its meta space is public and it is listed. */
export const GROUP_DECLARATION_COLLECTION = 'group.opensocial.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export const META_SPACE_TYPE = 'group.opensocial.meta';
export const GROUP_PROFILE_COLLECTION = 'group.opensocial.profile';
export const GROUP_PROFILE_RKEY = 'self';
export const GROUP_ACCESS_COLLECTION = 'group.opensocial.access';
export const GROUP_ACCESS_RKEY = 'self';

/** One `membership` per member, keyed by their DID; each member's own `acceptance` sits in
 *  their repo in the same space. */
export const MEMBERS_SPACE_TYPE = 'group.opensocial.members';
export const GROUP_MEMBERSHIP_COLLECTION = 'group.opensocial.membership';
export const GROUP_ROLE_COLLECTION = 'group.opensocial.role';
export const GROUP_PERMISSIONS_COLLECTION = 'group.opensocial.permissions';
export const GROUP_PERMISSIONS_RKEY = 'self';
export const GROUP_ACCEPTANCE_COLLECTION = 'group.opensocial.acceptance';
export const GROUP_ACCEPTANCE_RKEY = 'self';

/** A group's public events are ordinary events in its public repo. */
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** atmo's own space type, for a group's members-only events and its members' RSVPs to them,
 *  each RSVP in the member's own repo. It is in every URI in the space, so a rename strands
 *  what was written under the old name, and it must resolve wherever a scope names it. */
export const CALENDAR_SPACE_TYPE = 'rsvp.atmo.group.calendar';
export const GROUP_RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';

/** The lexicon's `status` token suffixes. */
export const RSVP_STATUSES = ['going', 'interested', 'notgoing'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** Every group space is keyed `self`, so its URI follows from the group's DID alone. */
export const SPACE_SKEY = 'self';

export function spaceUri(ownerDid: string, type: string, skey = SPACE_SKEY): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

export function metaSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, META_SPACE_TYPE);
}

export function declarationUri(groupDid: string): string {
	return `at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
}

export function groupDeclarationRecord(groupDid: string): Record<string, unknown> {
	return { $type: GROUP_DECLARATION_COLLECTION, meta: metaSpaceUri(groupDid) };
}

export function membersSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, MEMBERS_SPACE_TYPE);
}

export function calendarSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, CALENDAR_SPACE_TYPE);
}

/** A space record's URI, in the form `getRecord` returns. */
export function spaceRecordUri(
	space: string,
	repo: string,
	collection: string,
	rkey: string
): string {
	return `${space}/${repo}/${collection}/${rkey}`;
}

/** The group's own record in its calendar space: the URI an RSVP to the event names. */
export function membersOnlyEventUri(groupDid: string, rkey: string): string {
	return spaceRecordUri(calendarSpaceUri(groupDid), groupDid, GROUP_EVENT_COLLECTION, rkey);
}

/** Collection and rkey are the last two segments of a plain and a space record URI alike. */
export function splitRecordUri(uri: string): { collection: string; rkey: string } {
	const segments = uri.split('/');
	return {
		collection: segments[segments.length - 2] ?? '',
		rkey: segments[segments.length - 1] ?? ''
	};
}

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

/** A group's public events are ordinary events in its public repo. */
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

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

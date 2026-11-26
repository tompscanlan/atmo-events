// Collections, space types and URIs for groups, as the Atmosphere Groups spec names them.
// Values only, so the contrail config and the pages can import them.

/** In the group's public repo while its meta space is public and it is listed. */
export const GROUP_DECLARATION_COLLECTION = 'org.atgrp.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export const META_SPACE_TYPE = 'org.atgrp.meta';
export const GROUP_ABOUT_COLLECTION = 'org.atgrp.about';
export const GROUP_ABOUT_RKEY = 'self';
/** Who may join, as the meta space's config says it. */
export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];
/** Where the host publishes a space's `org.atgrp.policy`, which says whether it is public. */
export const SPACE_POLICY_COLLECTION = 'com.atproto.space.policy';
export const SPACE_POLICY_RKEY = 'self';

/** A group's public events are ordinary events in its public repo. */
export const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** Every group space is keyed `self`, so its URI follows from the group's DID alone. */
export const SPACE_SKEY = 'self';

/** In the `at:space/` form. lib/spaces/uri, which private events share, still writes
 *  `at://…/space/…`. */
export function spaceUri(ownerDid: string, type: string, skey = SPACE_SKEY): string {
	return `at:space/${ownerDid}/${type}/${skey}`;
}

export function metaSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, META_SPACE_TYPE);
}

export function declarationUri(groupDid: string): string {
	return `at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
}

/** Empty: the group's meta space is always at `org.atgrp.meta/self`. */
export function groupDeclarationRecord(): Record<string, unknown> {
	return { $type: GROUP_DECLARATION_COLLECTION };
}

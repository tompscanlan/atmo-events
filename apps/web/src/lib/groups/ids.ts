// Collections, space types and URIs for groups, as the Atmosphere Groups spec names them.
// Values only, so the contrail config and the pages can import them.

/** In the group's public repo while its meta space is public and it is listed. */
export const GROUP_DECLARATION_COLLECTION = 'org.atgrp.declaration';
export const GROUP_DECLARATION_RKEY = 'self';

export const META_SPACE_TYPE = 'org.atgrp.meta';
export const GROUP_ABOUT_COLLECTION = 'org.atgrp.about';
export const GROUP_ABOUT_RKEY = 'self';
/** Who may join, in the meta space. */
export const GROUP_CONFIG_COLLECTION = 'org.atgrp.config';
export const GROUP_CONFIG_RKEY = 'self';
export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];
/** Who is in the group: the group's memberships, and each member's own confirmation. */
export const MEMBERS_SPACE_TYPE = 'org.atgrp.members';
/** In the group's repo in the members space, keyed by the member's DID: `{roles, createdAt}`. */
export const GROUP_MEMBERSHIP_COLLECTION = 'org.atgrp.membership';
/** In the group's repo in the members space, keyed by the role's ID: `{displayName, permissions,
 *  canAssign, …}`. A new group has `admin` and `member`. */
export const GROUP_ROLE_COLLECTION = 'org.atgrp.role';
/** Everyone in a group holds `member`; the group host refuses a membership without it. */
export const MEMBER_ROLE = 'member';
/** The role a new group gives its founder, with every permission. */
export const ADMIN_ROLE = 'admin';
/** In the member's own repo in the members space: `{createdAt}`, their side of the membership. */
export const GROUP_CONFIRMATION_COLLECTION = 'org.atgrp.confirmation';
export const GROUP_CONFIRMATION_RKEY = 'self';
/** In the group's repo in the members space, one for each space the group lists: `{space,
 *  createdAt}`. The host writes them as it makes, ends and unlists spaces, and takes no other
 *  writes. A space whose policy is `unlisted` has none. */
export const GROUP_SPACE_INDEX_COLLECTION = 'org.atgrp.space';
/** The `$type` of a group space's policy, which `com.atproto.space.updateSpace` takes whole. */
export const GROUP_POLICY_TYPE = 'org.atgrp.policy';
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

export function membersSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, MEMBERS_SPACE_TYPE);
}

/** A membership's record key: the member's DID, with a did:web port's `%3A` written as `:`, as the
 *  group host keys it. */
export function membershipRkey(memberDid: string): string {
	return memberDid.replaceAll('%3A', ':');
}

/** The member's DID from a membership's record key: a did:web whose host is followed by a port, all
 *  digits, has it encoded again, as the group host reads the key. */
export function membershipDid(rkey: string): string {
	const match = /^did:web:([^:]+):(\d+)((?::.*)?)$/.exec(rkey);
	return match ? `did:web:${match[1]}%3A${match[2]}${match[3]}` : rkey;
}

export function declarationUri(groupDid: string): string {
	return `at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
}

/** Empty: the group's meta space is always at `org.atgrp.meta/self`. */
export function groupDeclarationRecord(): Record<string, unknown> {
	return { $type: GROUP_DECLARATION_COLLECTION };
}

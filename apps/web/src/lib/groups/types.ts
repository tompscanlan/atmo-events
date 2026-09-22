// Row shapes and the small vocabularies that go with them. Kept out of
// `server/` so the pages can type their props without pulling a D1 import.
import type { GroupPermission, GroupRoleName } from './permissions';

/** A group has no publication lifecycle: it exists, and a group that exists is
 *  published. `draft` used to be the column DEFAULT, so every group was created
 *  invisible to browse, and the only other value — `pending` — was an operator
 *  approval queue nothing implemented. Index-side moderation, if it is ever
 *  wanted, is a property of OUR DIRECTORY and belongs in a table about
 *  listings, not in the group's own row. (Spec: FR-016c.)
 *
 *  Visibility is two values for a related reason. `unlisted` promised
 *  "reachable by link but not listed", which needs a flag an indexer honors —
 *  and the only anonymously readable per-group artifact is the `declaration`,
 *  which carries a space pointer and no listing hint. So an unlisted group that
 *  published one could be listed by any peer regardless, i.e. it was only ever
 *  unlisted in our own browse. If the affordance comes back it comes back as a
 *  record field, the way upstream does it for events
 *  (`packages/ui/src/editor/types.ts` `showInDiscovery`). (Spec: FR-016d.) */
export const GROUP_VISIBILITIES = ['public', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** The two space TYPES an openmeet group owns.
 *
 *  `community.opensocial.*` was the first candidate and does not serve. The
 *  published suite under that namespace is a community-management product's
 *  XRPC surface and carries no space type at all; the `about` / `members` space
 *  names live only in a design draft. The namespace also does not resolve —
 *  there is no `_lexicon` TXT record for it, where `community.lexicon.*` has
 *  one — and the domain belongs to someone else, with its ownership still an
 *  open question. Writing under an authority we do not hold, for names nobody
 *  publishes, buys nothing.
 *
 *  So these are ours, under a domain we hold, with an eventual proposal to the
 *  community lexicon in mind — which is why the leaves match the draft's names.
 *  Migrating then is a prefix change rather than a reshape.
 *
 *  The segment is `space`, NOT `group`, because `net.openmeet.group.*` is
 *  already the XRPC method prefix the Spaces provider serves. Nesting space
 *  types inside the method namespace would make one name mean two things
 *  permanently.
 *
 *  Host-side kinds, not record lexicons: the RECORDS inside a space are the
 *  cross-app `community.lexicon.*` ones. */
export const ABOUT_SPACE_TYPE = 'net.openmeet.space.about';
export const MEMBERS_SPACE_TYPE = 'net.openmeet.space.members';

/** `groups` row, verbatim. Snake_case because it is what D1 returns — mapping
 *  it to camelCase here would only add a layer that can drift from the SQL. */
export interface GroupRow {
	id: string;
	group_did: string;
	owner_did: string;
	name: string;
	description: string | null;
	visibility: GroupVisibility;
	require_approval: number;
	image_cid: string | null;
	image_mime: string | null;
	image_size: number | null;
	location_name: string | null;
	location_address: string | null;
	location_lat: number | null;
	location_lng: number | null;
	location_timezone: string | null;
	/** at://<group_did>/space/<type>/self, or NULL before provisioning. Two
	 *  columns and no `space_type`: a space URI already carries its type, and
	 *  the type is now a constant per space, not per group. */
	about_space_uri: string | null;
	members_space_uri: string | null;
	created_at: number;
	updated_at: number;
}

export interface MemberRow {
	membership_id: string;
	did: string;
	role: GroupRoleName;
	status: MembershipStatus;
	created_at: number;
}

/** ONE ROSTER ROW AS A PAGE RENDERS IT, from either source — a `membership`
 *  record or the `memberships` cache (`server/members-read.ts`). No
 *  `membership_id`: that is a D1 surrogate with no record counterpart, and the
 *  identity a roster row actually has is the member DID, which is unique per
 *  group in both places (`UNIQUE (group_id, did)`; the record is keyed by it).
 *  `created_at` stays epoch ms in both, so the two orders are the same order.
 *
 *  `status` is always `active` when the source is records: a suspension deletes
 *  the membership record, so a suspended member is only ever visible in the
 *  cache. */
export interface RosterEntry {
	did: string;
	role: GroupRoleName;
	status: MembershipStatus;
	created_at: number;
}

export interface JoinRequestRow {
	id: string;
	did: string;
	status: JoinRequestStatus;
	message: string | null;
	created_at: number;
}

/** What the caller is to a group, as the pages need it: the roster row if any,
 *  a pending request if any, and the resolved permission union. `permissions`
 *  is the STORED union — including the inert names — because the members page
 *  shows a role's whole bundle; gate on `can()`, never on `.has()`. */
export interface CallerMembership {
	did: string | null;
	role: GroupRoleName | null;
	status: MembershipStatus | null;
	pendingRequestId: string | null;
	permissions: ReadonlySet<GroupPermission>;
}

/** An event record the group authored, as read back out of the group DID's
 *  public repo. `uri`'s authority is always the GROUP did — that is the whole
 *  point of the write gate. */
export interface GroupEventRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: Record<string, unknown>;
}

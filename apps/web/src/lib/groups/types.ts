// Row shapes and the small vocabularies that go with them. Kept out of
// `server/` so the pages can type their props without pulling a D1 import.
import type { GroupPermission, GroupRoleName } from './permissions';

/** Two visibilities. There is no `unlisted` ("reachable by link but not
 *  listed"): that needs a flag an indexer honors, and the only per-group record
 *  an anonymous reader can see is the `declaration`, which carries a space
 *  pointer and no listing hint, so any peer could list an "unlisted" group. If
 *  unlisted groups are wanted, the flag belongs on a record, the way upstream
 *  does it for events (`preferences.showInDiscovery`, set in
 *  `packages/ui/src/editor/save.ts`). */
export const GROUP_VISIBILITIES = ['public', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

/** One value: there is no suspension, and removing a member deletes the row.
 *  migrations/0001_groups.sql pins the column to `active` with a CHECK. */
export const MEMBERSHIP_STATUSES = ['active'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** The two space types a group owns.
 *
 *  They are ours, under a domain we hold, and not under `community.opensocial.*`.
 *  The suite published under that namespace carries no space type (the `about`
 *  and `members` names exist only in a design draft), the namespace does not
 *  resolve (it has no `_lexicon` TXT record), and the domain belongs to someone
 *  else. The leaves match the draft's names, so moving to a community lexicon
 *  later is a prefix change, not a reshape.
 *
 *  The segment is `space`, not `group`, because `net.openmeet.group.*` is
 *  already the XRPC method prefix the Spaces provider serves. Nesting space
 *  types inside it would make one name mean two things.
 *
 *  These are host-side space kinds, not record lexicons. */
export const ABOUT_SPACE_TYPE = 'net.openmeet.space.about';
export const MEMBERS_SPACE_TYPE = 'net.openmeet.space.members';

/** `groups` row, verbatim. Snake_case because it is what D1 returns: mapping
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
	/** at://<group_did>/space/<type>/self, or NULL before provisioning. Two
	 *  columns and no `space_type`: a space URI already carries its type, and
	 *  the type is fixed per space, not per group. */
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

/** One roster row as a page renders it, from either source: a `membership`
 *  record or the `memberships` cache (`server/members-read.ts`). No
 *  `membership_id`: that is a D1 surrogate with no record counterpart. A roster
 *  row's identity is the member DID, which is unique per group in both places
 *  (`UNIQUE (group_id, did)`; the record is keyed by it). `created_at` is epoch
 *  ms in both, so the two sort the same way.
 *
 *  `status` is always `active`, from either source: there is no suspension. */
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
 *  is the stored union, because the members page shows a role's whole bundle.
 *  Gate on `can()`, never on `.has()`. */
export interface CallerMembership {
	did: string | null;
	role: GroupRoleName | null;
	status: MembershipStatus | null;
	pendingRequestId: string | null;
	permissions: ReadonlySet<GroupPermission>;
	/** On the roster: the only question the read gate asks. Taken from the
	 *  caller's `membership` record when the members space reads clean and holds
	 *  authz records, whatever the row says; from the row when the group has no
	 *  records yet or its space cannot be read. `role` above is always the row's. */
	onRoster: boolean;
}

/** An event record the group authored, as read back out of the group DID's
 *  public repo. `uri`'s authority is always the group DID, which is what the
 *  write gate guarantees. */
export interface GroupEventRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: Record<string, unknown>;
}

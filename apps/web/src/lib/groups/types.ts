// Row shapes and their vocabularies, kept out of `server/` so pages need no D1 import.
import type { GroupPermission, GroupRoleName } from './permissions';

/** Not a column. A group's visibility is its about space's read policy at the host
 *  (`readGroupVisibility`), and whether its public repo holds a declaration. There is
 *  no `unlisted`: the declaration has no listing hint, so any peer could list one. */
export const GROUP_VISIBILITIES = ['public', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

/** There is no suspension. Removing a member deletes the row. */
export const MEMBERSHIP_STATUSES = ['active'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** Host-side space kinds, not record lexicons. The prefix is ours for the reason in
 *  ./about-record.ts; `net.openmeet.group.*` is kept for XRPC methods. */
export const ABOUT_SPACE_TYPE = 'net.openmeet.space.about';
export const MEMBERS_SPACE_TYPE = 'net.openmeet.space.members';

/** A `groups` row as D1 returns it. No `visibility`: see `GroupVisibility`. */
export interface GroupRow {
	id: string;
	group_did: string;
	owner_did: string;
	name: string;
	description: string | null;
	require_approval: number;
	image_cid: string | null;
	image_mime: string | null;
	image_size: number | null;
	location_name: string | null;
	/** at://<group_did>/space/<type>/self, or NULL before provisioning. */
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

/** One roster row, from a `membership` record or the `memberships` cache. */
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

/** What the caller is to a group. Gate on `can()`, never on `permissions.has()`. */
export interface CallerMembership {
	did: string | null;
	role: GroupRoleName | null;
	status: MembershipStatus | null;
	pendingRequestId: string | null;
	permissions: ReadonlySet<GroupPermission>;
	/** The only question the read gate asks. From the caller's `membership` record
	 *  when the members space can be read, from the row when it cannot be asked, and
	 *  false when it errors (`readStanding`). `role` is always the row's. */
	onRoster: boolean;
	/** The read error when the members space failed. `permissions` is then unknown. */
	unreadable?: string;
}

/** A DID as a page shows it. Display only: links and forms keep the DID. A null
 *  `handle` means none resolved, and the page shows the DID instead. */
export interface Person {
	did: string;
	handle: string | null;
	displayName: string | null;
	avatar: string | null;
}

/** An event read from the group DID's public repo, so `uri`'s authority is that DID. */
export interface GroupEventRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: Record<string, unknown>;
}

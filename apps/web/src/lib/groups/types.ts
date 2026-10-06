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

/** Host-side space kinds, not record lexicons: the standard's two well-known spaces.
 *  The about space is the one it calls `meta`, which holds the group's profile and
 *  rules. The D1 column keeps the name `about_space_uri`. */
export const ABOUT_SPACE_TYPE = 'group.opensocial.meta';
export const MEMBERS_SPACE_TYPE = 'group.opensocial.members';
/** The group's third space, ours rather than the standard's: it holds the group's
 *  members-only calendar records. A members-only event is the same event record
 *  as a public one, placed here instead of the public repo, so this adds a
 *  container and no record type. The name is provisional, for devnet only until
 *  it is settled. It is part of every URI in the space, so a rename strands what
 *  was written under the old one, and it lives in this one constant so that a
 *  rename is one line. (Spec: FR-102.) */
export const CALENDAR_SPACE_TYPE = 'net.openmeet.space.calendar';

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
	/** Whether the member wrote their acceptance: `true` confirmed, `false`
	 *  unconfirmed, `null` when it was not read. It never changes access. */
	confirmed: boolean | null;
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
	/** Set when the group has a members space and its owner has not linked the
	 *  group's account, so the space cannot be read. `permissions` is then
	 *  unknown, and only the owner's link fixes it. */
	unlinked?: true;
}

/** A DID as a page shows it. Display only: links and forms keep the DID. A null
 *  `handle` means none resolved, and the page shows the DID instead. */
export interface Person {
	did: string;
	handle: string | null;
	displayName: string | null;
	avatar: string | null;
}

/** One of the group's events. A public event is read from the group DID's public
 *  repo, so `uri` is the plain form under that DID. A members-only event is read
 *  from the group's calendar space, so `uri` is the space form and `space` names
 *  the calendar space. */
export interface GroupEventRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: Record<string, unknown>;
	/** The space the event was read from, or absent for the public repo. Its
	 *  presence is what makes an event members-only. */
	space?: string;
}

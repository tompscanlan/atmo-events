// Row shapes and the small vocabularies that go with them. Kept out of
// `server/` so the pages can type their props without pulling a D1 import.
import type { GroupPermission, GroupRoleName } from './permissions';

export const GROUP_STATUSES = ['draft', 'pending', 'published'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export const GROUP_VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** The space TYPE every openmeet group uses. Space types are host-side kinds,
 *  so this matches the live fixture on pds.opnmt.net; the RECORDS inside the
 *  space are the cross-app `community.lexicon.calendar.*` lexicons. */
export const OPENMEET_SPACE_TYPE = 'net.openmeet.group';

/** `groups` row, verbatim. Snake_case because it is what D1 returns — mapping
 *  it to camelCase here would only add a layer that can drift from the SQL. */
export interface GroupRow {
	id: string;
	group_did: string;
	owner_did: string;
	name: string;
	slug: string;
	description: string | null;
	status: GroupStatus;
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
	space_uri: string | null;
	space_type: string;
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

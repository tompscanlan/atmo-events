// Row shapes and their vocabularies, kept out of `server/` so pages need no D1 import.
import type { GroupPermission } from './permissions';
import type { WriteGrants } from './scopes';

/** Not a column: the meta space's `access` at the host says it. */
export const GROUP_VISIBILITIES = ['public', 'private'] as const;
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** The proposal's two spaces. atmo calls `meta` the about space, as its column does. */
export const ABOUT_SPACE_TYPE = 'group.opensocial.meta';
export const MEMBERS_SPACE_TYPE = 'group.opensocial.members';

export interface GroupRow {
	id: string;
	group_did: string;
	name: string;
	description: string | null;
	/** at://<group_did>/space/<type>/self, or NULL before the create finished. */
	about_space_uri: string | null;
	members_space_uri: string | null;
	created_at: number;
	updated_at: number;
}

/** What any visitor may be shown of a row. */
export type PublicGroup = Pick<
	GroupRow,
	'group_did' | 'name' | 'description' | 'about_space_uri' | 'members_space_uri'
>;

export function publicGroup(row: GroupRow): PublicGroup {
	return {
		group_did: row.group_did,
		name: row.name,
		description: row.description,
		about_space_uri: row.about_space_uri,
		members_space_uri: row.members_space_uri
	};
}

export interface MemberRow {
	membership_id: string;
	did: string;
	role: string;
	created_at: number;
}

export interface RosterEntry {
	did: string;
	role: string;
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
	role: string | null;
	pendingRequestId: string | null;
	permissions: ReadonlySet<GroupPermission>;
	grants: WriteGrants;
	/** The only question the read gate asks: from the caller's own `membership` record,
	 *  never from a row. */
	onRoster: boolean;
	/** The read error when the members space failed. `permissions` is then unknown. */
	unreadable?: string;
	/** Signed in, but the sign-in reads no spaces: nothing is read for them. */
	noSpaceAccess?: true;
	/** The row lists the caller, but their sign-in cannot read the group's spaces, so
	 *  the pages ask them to sign in again. */
	signIn?: true;
}

/** A DID as a page shows it; a null `handle` means none resolved. */
export interface Person {
	did: string;
	handle: string | null;
	displayName: string | null;
	avatar: string | null;
}

/** One of the group's public events, from its repo. */
export interface GroupEventRecord {
	uri: string;
	cid: string;
	rkey: string;
	value: Record<string, unknown>;
}

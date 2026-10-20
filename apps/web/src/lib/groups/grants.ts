// What a member may do in a group, from its records alone: the scopes their roles
// hold in `permissions` and in each space's `access`, and the roles those grants may
// assign. The write gate (./server/group-write.ts) asks it of a write to this
// site's own rows, and pages ask it which controls to show; the group host decides
// every write as the group. (Spec: FR-213.)
import { GROUP_PROFILE_COLLECTION } from './about-record';
import { SPACE_SKEY } from './ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	type GroupAccessFields
} from './members-record';
import { COMMUNITY_PERMISSIONS, type CommunityPermission } from './permissions';
import {
	allowsWrite,
	writeGrants,
	type RoleGrant,
	type SpaceWrite,
	type WriteAction,
	type WriteGrants
} from './scopes';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type CallerMembership } from './types';

/** A record write into the group's space of `spaceType`. Every group space is keyed
 *  `self`. */
export function spaceWrite(spaceType: string, collection: string, action: WriteAction): SpaceWrite {
	return { spaceType, skey: SPACE_SKEY, collection, action };
}

/** Changing who may see the group: the about space's `access`, which its read
 *  policy and its declaration follow (Spec: FR-214). */
export const VISIBILITY_WRITE: SpaceWrite = spaceWrite(
	ABOUT_SPACE_TYPE,
	GROUP_ACCESS_COLLECTION,
	'update'
);

/** Where every `membership` lives. */
export const MEMBERSHIP_SPACE = {
	spaceType: MEMBERS_SPACE_TYPE,
	skey: SPACE_SKEY,
	collection: GROUP_MEMBERSHIP_COLLECTION
} as const;

/** A member's grants, from the `permissions` record and the members and about
 *  spaces' `access` records. A record not read adds nothing here; the write gate
 *  reads a target space's record when it needs it. */
export function memberGrants(input: {
	roles: Iterable<string>;
	permissions: readonly RoleGrant[] | null;
	membersAccess?: GroupAccessFields | null;
	aboutAccess?: GroupAccessFields | null;
}): WriteGrants {
	return writeGrants({
		roles: input.roles,
		permissions: input.permissions ?? [],
		// Only the records read, so the gate can tell a space whose record it has
		// not read yet from one whose record grants nothing.
		access: {
			...(input.membersAccess ? { [MEMBERS_SPACE_TYPE]: input.membersAccess.grants } : {}),
			...(input.aboutAccess ? { [ABOUT_SPACE_TYPE]: input.aboutAccess.grants } : {})
		}
	});
}

/** A roster act: the scope for its `membership` write and some role to assign. The
 *  gate checks the roles a write touches when it runs. */
function rosterAct(grants: WriteGrants, groupDid: string, action: WriteAction): boolean {
	if (grants.group) return true;
	return (
		grants.assignable.size > 0 && allowsWrite(grants, groupDid, { ...MEMBERSHIP_SPACE, action })
	);
}

/** Each community name, as the question it asks of a member's grants. Settings are
 *  what the settings form writes: the profile, and the about space's `access`,
 *  which the read policy and the declaration follow. */
const ASKS: Readonly<
	Record<CommunityPermission, (grants: WriteGrants, groupDid: string) => boolean>
> = {
	MANAGE_GROUP: (grants, groupDid) =>
		allowsWrite(
			grants,
			groupDid,
			spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update')
		) && allowsWrite(grants, groupDid, VISIBILITY_WRITE),
	ADMIT_MEMBERS: (grants, groupDid) => rosterAct(grants, groupDid, 'create'),
	EJECT_MEMBERS: (grants, groupDid) => rosterAct(grants, groupDid, 'delete'),
	ASSIGN_ROLES: (grants, groupDid) => rosterAct(grants, groupDid, 'update')
};

/** Whether a member's roles let them write anything as the group, which is who
 *  may hold a group session (TS, 2026-10-15). A grant to read only does not. */
export function grantsAnyWrite(grants: WriteGrants): boolean {
	if (grants.group) return true;
	return [...grants.anywhere, ...Object.values(grants.inSpace).flat()].some(
		(p) => p.manage.length > 0 || p.actions.some((a) => a !== 'read' && a !== 'read_self')
	);
}

/** Whether the caller may link a group session: their roles grant some write,
 *  by scope or by a named permission (`eventPermissions` grants event writes no
 *  scope names yet). */
export function mayHoldGroupSession(
	membership: Pick<CallerMembership, 'permissions' | 'grants'>
): boolean {
	return membership.permissions.size > 0 || grantsAnyWrite(membership.grants);
}

/** The community names `grants` answer yes to, in vocabulary order. */
export function communityPermissions(grants: WriteGrants, groupDid: string): CommunityPermission[] {
	return COMMUNITY_PERMISSIONS.filter((permission) => ASKS[permission](grants, groupDid));
}

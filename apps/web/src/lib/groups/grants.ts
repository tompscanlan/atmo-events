// What a member may do in a group, from its records alone: the scopes their roles hold
// in `permissions` and in each space's `access`, and the roles they may assign.
import { GROUP_PROFILE_COLLECTION } from './about-record';
import { GROUP_EVENT_COLLECTION, SPACE_SKEY } from './ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	type GroupAccessFields
} from './members-record';
import { GROUP_PERMISSIONS, type GroupPermission } from './permissions';
import {
	allowsRepoWrite,
	allowsWrite,
	writeGrants,
	type RoleGrant,
	type SpaceWrite,
	type WriteAction,
	type WriteGrants
} from './scopes';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type CallerMembership } from './types';

export function spaceWrite(spaceType: string, collection: string, action: WriteAction): SpaceWrite {
	return { spaceType, skey: SPACE_SKEY, collection, action };
}

/** The meta space's `access`, which its read policy and its declaration follow. */
export const VISIBILITY_WRITE: SpaceWrite = spaceWrite(
	ABOUT_SPACE_TYPE,
	GROUP_ACCESS_COLLECTION,
	'update'
);

export const MEMBERSHIP_SPACE = {
	spaceType: MEMBERS_SPACE_TYPE,
	skey: SPACE_SKEY,
	collection: GROUP_MEMBERSHIP_COLLECTION
} as const;

/** A record not read adds nothing; the write gate reads a target space's record when it needs it. */
export function memberGrants(input: {
	roles: Iterable<string>;
	permissions: readonly RoleGrant[] | null;
	membersAccess?: GroupAccessFields | null;
	aboutAccess?: GroupAccessFields | null;
}): WriteGrants {
	return writeGrants({
		roles: input.roles,
		permissions: input.permissions ?? [],
		access: {
			...(input.membersAccess ? { [MEMBERS_SPACE_TYPE]: input.membersAccess.grants } : {}),
			...(input.aboutAccess ? { [ABOUT_SPACE_TYPE]: input.aboutAccess.grants } : {})
		}
	});
}

function rosterAct(grants: WriteGrants, groupDid: string, action: WriteAction): boolean {
	if (grants.group) return true;
	return (
		grants.assignable.size > 0 && allowsWrite(grants, groupDid, { ...MEMBERSHIP_SPACE, action })
	);
}

const ASKS: Readonly<Record<GroupPermission, (grants: WriteGrants, groupDid: string) => boolean>> =
	{
		MANAGE_GROUP: (grants, groupDid) =>
			allowsWrite(
				grants,
				groupDid,
				spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update')
			) && allowsWrite(grants, groupDid, VISIBILITY_WRITE),
		ADMIT_MEMBERS: (grants, groupDid) => rosterAct(grants, groupDid, 'create'),
		EJECT_MEMBERS: (grants, groupDid) => rosterAct(grants, groupDid, 'delete'),
		ASSIGN_ROLES: (grants, groupDid) => rosterAct(grants, groupDid, 'update'),
		CREATE_EVENT: (grants) => allowsRepoWrite(grants, GROUP_EVENT_COLLECTION, 'create'),
		MANAGE_EVENTS: (grants) =>
			allowsRepoWrite(grants, GROUP_EVENT_COLLECTION, 'update') &&
			allowsRepoWrite(grants, GROUP_EVENT_COLLECTION, 'delete')
	};

/** Whether a member's roles let them write anything as the group, which is who may
 *  hold a group session. A grant to read only does not. */
export function grantsAnyWrite(grants: WriteGrants): boolean {
	if (grants.group) return true;
	return (
		grants.repo.length > 0 ||
		[...grants.anywhere, ...Object.values(grants.inSpace).flat()].some(
			(p) => p.manage.length > 0 || p.actions.some((a) => a !== 'read' && a !== 'read_self')
		)
	);
}

export function mayHoldGroupSession(membership: Pick<CallerMembership, 'grants'>): boolean {
	return grantsAnyWrite(membership.grants);
}

/** The names `grants` answer yes to, in vocabulary order. */
export function permissionsFor(grants: WriteGrants, groupDid: string): Set<GroupPermission> {
	return new Set(GROUP_PERMISSIONS.filter((permission) => ASKS[permission](grants, groupDid)));
}

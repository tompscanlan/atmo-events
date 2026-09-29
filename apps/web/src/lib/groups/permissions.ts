// The permission vocabulary is fixed in code. Which role holds which permission is
// data, per group. The four community names are published in a `permissions` record
// under the draft community standard's identifiers. The two modality names are ours,
// since the standard leaves events to the app, and travel in `eventPermissions`.
// There is no read permission: the host's read policy decides who may read.

export const COMMUNITY_PERMISSIONS = [
	'MANAGE_GROUP',
	'ADMIT_MEMBERS',
	'EJECT_MEMBERS',
	'ASSIGN_ROLES'
] as const;

export const MODALITY_PERMISSIONS = ['MANAGE_EVENTS', 'CREATE_EVENT'] as const;

export const GROUP_PERMISSIONS = [...COMMUNITY_PERMISSIONS, ...MODALITY_PERMISSIONS] as const;

export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];
export type CommunityPermission = (typeof COMMUNITY_PERMISSIONS)[number];

/** Our name -> the identifier a record publishes. The only bridge between the two, so
 *  an upstream rename is an edit here plus a record replay. */
export const PUBLISHED_ACTION: Readonly<Record<GroupPermission, string>> = {
	MANAGE_GROUP: 'community.configure',
	ADMIT_MEMBERS: 'admit',
	EJECT_MEMBERS: 'eject',
	ASSIGN_ROLES: 'role.assign',
	MANAGE_EVENTS: 'manageEvents',
	CREATE_EVENT: 'createEvent'
};

/** Which record an action travels in. */
export type PermissionAltitude = 'community' | 'modality';

const ALTITUDE: Readonly<Record<PermissionAltitude, readonly GroupPermission[]>> = {
	community: COMMUNITY_PERMISSIONS,
	modality: MODALITY_PERMISSIONS
};

/** Derived from `PUBLISHED_ACTION`, so the two directions cannot disagree. */
const PERMISSION_BY_ACTION: Readonly<Record<PermissionAltitude, Record<string, GroupPermission>>> =
	{
		community: Object.fromEntries(
			COMMUNITY_PERMISSIONS.map((p) => [PUBLISHED_ACTION[p], p])
		) as Record<string, GroupPermission>,
		modality: Object.fromEntries(
			MODALITY_PERMISSIONS.map((p) => [PUBLISHED_ACTION[p], p])
		) as Record<string, GroupPermission>
	};

/** Ours -> what one altitude's record publishes. Names of the other altitude are
 *  dropped, so a caller can pass a whole bundle. */
export function publishedActions(
	altitude: PermissionAltitude,
	permissions: Iterable<string>
): string[] {
	const held = new Set(permissions);
	// Vocabulary order, so the same bundle always publishes the same record.
	return ALTITUDE[altitude].filter((p) => held.has(p)).map((p) => PUBLISHED_ACTION[p]);
}

/** What a record publishes -> ours. Each record is a closed set, so an action this
 *  altitude does not define grants nothing. */
export function permissionsFromActions(
	altitude: PermissionAltitude,
	actions: Iterable<unknown>
): GroupPermission[] {
	const table = PERMISSION_BY_ACTION[altitude];
	const held: GroupPermission[] = [];
	for (const action of actions) {
		if (typeof action !== 'string') continue;
		const permission = table[action];
		if (permission && !held.includes(permission)) held.push(permission);
	}
	return held;
}

const IN_VOCABULARY: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

/** Most privileged first, which is also the display order. A pending applicant is a
 *  join request, never a role. */
export const GROUP_ROLES = ['owner', 'admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** Default bundle per role. `owner` and `admin` match on purpose: the owner is set
 *  apart by SQL triggers on `groups.owner_did`, not by a grant. `member` holds
 *  nothing beyond membership itself. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<GroupRoleName, readonly GroupPermission[]>> =
	{
		owner: [
			'MANAGE_GROUP',
			'ADMIT_MEMBERS',
			'EJECT_MEMBERS',
			'ASSIGN_ROLES',
			'MANAGE_EVENTS',
			'CREATE_EVENT'
		],
		admin: [
			'MANAGE_GROUP',
			'ADMIT_MEMBERS',
			'EJECT_MEMBERS',
			'ASSIGN_ROLES',
			'MANAGE_EVENTS',
			'CREATE_EVENT'
		],
		member: []
	};

export type EnforcedGroupPermission = GroupPermission;

const IS_ENFORCED: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

export function isGroupPermission(value: string): value is GroupPermission {
	return IN_VOCABULARY[value] === true;
}

export function isEnforced(permission: string): permission is EnforcedGroupPermission {
	return IS_ENFORCED[permission] === true;
}

/** Union of the bundles a caller's roles grant. No deny rows, no hierarchy. Names
 *  outside the vocabulary are dropped, since an older seeder may have written them. */
export function resolvePermissions(grants: Iterable<Iterable<string>>): Set<GroupPermission> {
	const resolved = new Set<GroupPermission>();
	for (const grant of grants) {
		for (const permission of grant) {
			if (isGroupPermission(permission)) resolved.add(permission);
		}
	}
	return resolved;
}

/** The single gate every handler asks. `isEnforced` always passes today. It is kept
 *  so a name added to the vocabulary before its handler exists fails closed. */
export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	if (!isEnforced(permission)) return false;
	return granted.has(permission);
}

/** Roles an `ASSIGN_ROLES` holder may assign. Never `owner`, which SQL triggers pin. */
export const ASSIGNABLE_ROLES: readonly Exclude<GroupRoleName, 'owner'>[] = GROUP_ROLES.filter(
	(r): r is Exclude<GroupRoleName, 'owner'> => r !== 'owner'
);

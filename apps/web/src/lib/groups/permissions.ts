// Each name is a question asked of the scopes a member's roles hold (./grants.ts).

export const COMMUNITY_PERMISSIONS = [
	'MANAGE_GROUP',
	'ADMIT_MEMBERS',
	'EJECT_MEMBERS',
	'ASSIGN_ROLES'
] as const;

export const EVENT_PERMISSIONS = ['MANAGE_EVENTS', 'CREATE_EVENT'] as const;

export const GROUP_PERMISSIONS = [...COMMUNITY_PERMISSIONS, ...EVENT_PERMISSIONS] as const;

export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];

export const GROUP_ROLES = ['admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	return granted.has(permission);
}

export const ASSIGNABLE_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

/** The strongest known role, else the first named. */
export function primaryRole(roles: readonly string[]): string | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

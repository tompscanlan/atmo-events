// What atmo lets a member do in a group, by name. Each name is a question asked of the
// scopes the member's roles hold (./grants.ts); the group host decides every write.

export const COMMUNITY_PERMISSIONS = [
	'MANAGE_GROUP',
	'ADMIT_MEMBERS',
	'EJECT_MEMBERS',
	'ASSIGN_ROLES'
] as const;

export const EVENT_PERMISSIONS = ['MANAGE_EVENTS', 'CREATE_EVENT'] as const;

export const GROUP_PERMISSIONS = [...COMMUNITY_PERMISSIONS, ...EVENT_PERMISSIONS] as const;

export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];

/** The group host's two roles, most privileged first, which is also the display order. */
export const GROUP_ROLES = ['admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** The single gate every handler asks. */
export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	return granted.has(permission);
}

/** The roles the roster's picker offers. A role another app added is kept, not offered. */
export const ASSIGNABLE_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

/** The role a roster shows for a member: the strongest known one, else the first named. */
export function primaryRole(roles: readonly string[]): string | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? roles[0] ?? null;
}

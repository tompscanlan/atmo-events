// The group permission MODEL: vocabulary fixed in code, bundles stored as data
// (bead om-0f0yu, decided 2026-09-08). Roles and their permission bundles are
// D1 rows so an operator can retune one group without a deploy; the set of
// permission NAMES is not data, because every name that means anything has a
// handler behind it and a row naming a permission no handler reads is a lie.
//
// The 17 names are carried verbatim from the legacy API's `GroupPermission`
// enum (openmeet-api/src/core/constants/constant.ts:23-41) so a migration of
// existing tenants is a copy, not a translation.

export const GROUP_PERMISSIONS = [
	'MANAGE_GROUP',
	'DELETE_GROUP',
	'MANAGE_MEMBERS',
	'MANAGE_EVENTS',
	'MANAGE_DISCUSSIONS',
	'MANAGE_REPORTS',
	'MANAGE_BILLING',
	'CREATE_EVENT',
	'MESSAGE_DISCUSSION',
	'MESSAGE_MEMBER',
	'CONTACT_MEMBERS',
	'CONTACT_ADMINS',
	'RECEIVE_CONTACT_MESSAGES',
	'SEE_MEMBERS',
	'SEE_EVENTS',
	'SEE_DISCUSSIONS',
	'SEE_GROUP'
] as const;

export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];

// Static membership tables, not runtime sets: the vocabulary and the enforced
// subset are both fixed at build time.
const IN_VOCABULARY: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

/** The five legacy roles, most privileged first. The order is the display order
 *  and the order `ASSIGNABLE_ROLES` offers, so it is not incidental. */
export const GROUP_ROLES = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** Default bundle per role, carried verbatim from the legacy seeder
 *  (openmeet-api/src/database/seeds/relational/group-role/group-role.service.ts:31-86):
 *  owner 16, admin 14, moderator 7, member 7, guest 1. Note that owner does NOT
 *  hold MESSAGE_MEMBER and admin does NOT hold DELETE_GROUP in legacy either —
 *  those gaps are copied, not corrected, so parity is checkable. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<GroupRoleName, readonly GroupPermission[]>> =
	{
		owner: [
			'MANAGE_GROUP',
			'DELETE_GROUP',
			'MANAGE_MEMBERS',
			'MANAGE_EVENTS',
			'MANAGE_DISCUSSIONS',
			'MESSAGE_DISCUSSION',
			'MANAGE_REPORTS',
			'MANAGE_BILLING',
			'CREATE_EVENT',
			'CONTACT_MEMBERS',
			'CONTACT_ADMINS',
			'RECEIVE_CONTACT_MESSAGES',
			'SEE_GROUP',
			'SEE_EVENTS',
			'SEE_DISCUSSIONS',
			'SEE_MEMBERS'
		],
		admin: [
			'MANAGE_GROUP',
			'MANAGE_MEMBERS',
			'MANAGE_EVENTS',
			'MANAGE_DISCUSSIONS',
			'MANAGE_REPORTS',
			'CREATE_EVENT',
			'MESSAGE_DISCUSSION',
			'CONTACT_MEMBERS',
			'CONTACT_ADMINS',
			'RECEIVE_CONTACT_MESSAGES',
			'SEE_GROUP',
			'SEE_EVENTS',
			'SEE_DISCUSSIONS',
			'SEE_MEMBERS'
		],
		moderator: [
			'MANAGE_DISCUSSIONS',
			'MESSAGE_DISCUSSION',
			'CONTACT_ADMINS',
			'SEE_GROUP',
			'SEE_EVENTS',
			'SEE_DISCUSSIONS',
			'SEE_MEMBERS'
		],
		member: [
			'MESSAGE_DISCUSSION',
			'MESSAGE_MEMBER',
			'CONTACT_ADMINS',
			'SEE_MEMBERS',
			'SEE_EVENTS',
			'SEE_DISCUSSIONS',
			'SEE_GROUP'
		],
		guest: ['CONTACT_ADMINS']
	};

/** The permissions v1 actually gates on. Everything else in the vocabulary is
 *  STORED BUT INERT: the rows exist so a tenant's bundles survive the move and
 *  so the surfaces that need them (discussions, reports, billing, contact) can
 *  be switched on by adding a handler — not by editing data. Until then `can()`
 *  refuses them, so no handler can accidentally grant on a permission whose
 *  behaviour has never been written. */
export const V1_ENFORCED_PERMISSIONS = [
	'MANAGE_GROUP',
	'MANAGE_MEMBERS',
	'MANAGE_EVENTS',
	'CREATE_EVENT',
	'SEE_MEMBERS',
	'SEE_EVENTS',
	'SEE_GROUP'
] as const satisfies readonly GroupPermission[];

export type EnforcedGroupPermission = (typeof V1_ENFORCED_PERMISSIONS)[number];

const IS_ENFORCED: Record<string, true> = Object.fromEntries(
	V1_ENFORCED_PERMISSIONS.map((p) => [p, true])
);

/** The ten permissions that are persisted but have no handler in v1. Derived,
 *  never hand-listed, so adding a name to `V1_ENFORCED_PERMISSIONS` cannot
 *  leave a stale copy behind. */
export const V1_INERT_PERMISSIONS: readonly GroupPermission[] = GROUP_PERMISSIONS.filter(
	(p) => !IS_ENFORCED[p]
);

export function isGroupPermission(value: string): value is GroupPermission {
	return IN_VOCABULARY[value] === true;
}

export function isEnforced(permission: string): permission is EnforcedGroupPermission {
	return IS_ENFORCED[permission] === true;
}

/** Union the permission bundles a caller's roles grant. There are no deny rows
 *  and no role hierarchy: a permission is held if ANY grant names it. Rows
 *  outside the vocabulary are dropped rather than trusted — the table is
 *  writable by a seeder that may be older than this build. */
export function resolvePermissions(grants: Iterable<Iterable<string>>): Set<GroupPermission> {
	const resolved = new Set<GroupPermission>();
	for (const grant of grants) {
		for (const permission of grant) {
			if (isGroupPermission(permission)) resolved.add(permission);
		}
	}
	return resolved;
}

/** The single gate every v1 handler asks. Fails closed on the ten inert
 *  permissions EVEN WHEN THE ROLE HOLDS THEM: a role row saying MANAGE_BILLING
 *  describes an intent, not a capability this build implements, and a handler
 *  that treated it as one would be granting access to behaviour nobody wrote. */
export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	if (!isEnforced(permission)) return false;
	return granted.has(permission);
}

/** Roles a caller holding MANAGE_MEMBERS may assign. `owner` is never among
 *  them: it is pinned to `groups.owner_did` by SQL triggers, so offering it
 *  would only produce a constraint error. */
export const ASSIGNABLE_ROLES: readonly Exclude<GroupRoleName, 'owner'>[] = GROUP_ROLES.filter(
	(r): r is Exclude<GroupRoleName, 'owner'> => r !== 'owner'
);

// What atmo lets a member do in a group, by name. The four community names are not
// grants. Each is a question asked of the scopes the member's roles hold in the
// group's records (./grants.ts), and every write as the group is checked against
// those scopes, not a name (Spec: FR-213). The names remain because atmo still
// publishes its own roles' grants from bundles of them (`PUBLISHED_SCOPES`). The two
// modality names are ours, since the standard leaves a modality's authz to the
// modality's own space, and travel in `eventPermissions`. There is no read
// permission: the host's read policy decides who may read.

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

export type ModalityPermission = (typeof MODALITY_PERMISSIONS)[number];

/** A write of `membership` records in the members space, the one record admitting,
 *  assigning and ejecting all write. */
const membershipWrite = (action: 'create' | 'update' | 'delete') =>
	`space:group.opensocial.members?collection=group.opensocial.membership&action=${action}`;

/** Our community name -> the scopes a `permissions` grant publishes for it, when
 *  atmo writes its own roles' grants. Group settings are the standard's `configure`
 *  and `manageSpaces` permission sets, plus its raw grant for `access` in every
 *  space, since `manageSpaces` reaches only meta and members and the calendar space
 *  has an `access` too (`proposal.md:206-212`). Admitting, assigning and ejecting
 *  are creating, updating and deleting a `membership`. (Spec: FR-213.) */
export const PUBLISHED_SCOPES: Readonly<Record<CommunityPermission, readonly string[]>> = {
	MANAGE_GROUP: [
		'include:group.opensocial.configure',
		'include:group.opensocial.manageSpaces',
		'space:*?collection=group.opensocial.access'
	],
	ADMIT_MEMBERS: [membershipWrite('create')],
	EJECT_MEMBERS: [membershipWrite('delete')],
	ASSIGN_ROLES: [membershipWrite('update')]
};

/** Our modality name -> the action `eventPermissions` publishes. */
export const PUBLISHED_ACTION: Readonly<Record<ModalityPermission, string>> = {
	MANAGE_EVENTS: 'manageEvents',
	CREATE_EVENT: 'createEvent'
};

/** Which record a name travels in. */
export type PermissionAltitude = 'community' | 'modality';

/** Derived from `PUBLISHED_ACTION`, so the two directions cannot disagree. */
const PERMISSION_BY_ACTION: Readonly<Record<string, ModalityPermission>> = Object.fromEntries(
	MODALITY_PERMISSIONS.map((p) => [PUBLISHED_ACTION[p], p])
);

/** Ours -> the scopes one role's `permissions` grant publishes. Modality names are
 *  dropped, so a caller can pass a whole bundle. */
export function publishedScopes(permissions: Iterable<string>): string[] {
	const held = new Set(permissions);
	// Vocabulary order, so the same bundle always publishes the same grant.
	const scopes = COMMUNITY_PERMISSIONS.filter((p) => held.has(p)).flatMap(
		(p) => PUBLISHED_SCOPES[p]
	);
	return [...new Set(scopes)];
}

/** Ours -> the actions `eventPermissions` publishes. Community names are dropped,
 *  so a caller can pass a whole bundle. */
export function publishedActions(permissions: Iterable<string>): string[] {
	const held = new Set(permissions);
	// Vocabulary order, so the same bundle always publishes the same record.
	return MODALITY_PERMISSIONS.filter((p) => held.has(p)).map((p) => PUBLISHED_ACTION[p]);
}

/** What `eventPermissions` publishes -> ours. The record is a closed set, so an
 *  action it does not define grants nothing. */
export function permissionsFromActions(actions: Iterable<unknown>): ModalityPermission[] {
	const held: ModalityPermission[] = [];
	for (const action of actions) {
		if (typeof action !== 'string') continue;
		const permission = PERMISSION_BY_ACTION[action];
		if (permission && !held.includes(permission)) held.push(permission);
	}
	return held;
}

const IN_VOCABULARY: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

/** The group host's two roles, most privileged first, which is also the display
 *  order. The creator is an ordinary `admin`. A pending applicant is a join request,
 *  never a role. */
export const GROUP_ROLES = ['admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** Default bundle per role. `member` holds nothing beyond membership itself. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<GroupRoleName, readonly GroupPermission[]>> =
	{
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

/** The roles each role may assign and eject, published as the standard's
 *  `assignable`. An admin may assign and eject any admin, the creator included, as
 *  at the group host. */
export const ASSIGNABLE_BY_ROLE: Readonly<Record<GroupRoleName, readonly GroupRoleName[]>> = {
	admin: ['admin', 'member'],
	member: []
};

/** The roles a member is admitted with, published as `default` on each one's `role`
 *  record. */
export const DEFAULT_ROLES: readonly GroupRoleName[] = ['member'];

export function isGroupPermission(value: string): value is GroupPermission {
	return IN_VOCABULARY[value] === true;
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

/** The single gate every handler asks. */
export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	return granted.has(permission);
}

/** A role an `ASSIGN_ROLES` holder may assign: any of them. */
export type AssignableRole = GroupRoleName;

export const ASSIGNABLE_ROLES: readonly AssignableRole[] = GROUP_ROLES;

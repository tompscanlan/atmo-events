// The group permission model: the vocabulary is fixed in code, and which role
// holds which permission is stored as data, per group.
//
// Six names at two altitudes, and deliberately no third:
//
//   COMMUNITY (4): what the draft community standard calls community-scoped
//   actions. These are the only names a `permissions` record may publish, and
//   it publishes the standard's identifiers, not these spellings. The spellings
//   stay ours, so if the published form changes upstream we edit
//   PUBLISHED_ACTION and replay the records, and nothing in the app is renamed.
//
//   MODALITY (2): the standard leaves "who may create an event" to the
//   modality's own lexicon, so these two are ours. They travel in the group's
//   `eventPermissions` record, never in `permissions`.
//
// There is no read permission. Who may read is decided by the access record
// plus the space read policy the host enforces, and the roster is members-only
// as a membership test, not as a grant a group can withhold. A `SEE_*` name
// would be a second source of truth for something the host decides.

/** The four the community standard defines. A `permissions` record carries
 *  these and nothing else. */
export const COMMUNITY_PERMISSIONS = [
	'MANAGE_GROUP',
	'ADMIT_MEMBERS',
	'EJECT_MEMBERS',
	'ASSIGN_ROLES'
] as const;

/** Ours, because the standard says modality is the app's. These live in
 *  `eventPermissions`. */
export const MODALITY_PERMISSIONS = ['MANAGE_EVENTS', 'CREATE_EVENT'] as const;

export const GROUP_PERMISSIONS = [...COMMUNITY_PERMISSIONS, ...MODALITY_PERMISSIONS] as const;

export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];
export type CommunityPermission = (typeof COMMUNITY_PERMISSIONS)[number];

/** Our name -> the identifier a record publishes. This is the only bridge
 *  between the two, so an upstream rename lands here and in a replay of the
 *  records, not at every call site. The community four carry the draft
 *  standard's own identifiers; the modality two carry ours, since the standard
 *  defines none. */
export const PUBLISHED_ACTION: Readonly<Record<GroupPermission, string>> = {
	MANAGE_GROUP: 'community.configure',
	ADMIT_MEMBERS: 'admit',
	EJECT_MEMBERS: 'eject',
	ASSIGN_ROLES: 'role.assign',
	MANAGE_EVENTS: 'manageEvents',
	CREATE_EVENT: 'createEvent'
};

/** Which record an action travels in. The two altitudes are two records, so a
 *  translation in either direction only makes sense with one named:
 *  `createEvent` in a `permissions` record is not a misplaced modality grant, it
 *  is a name that record may not carry. */
export type PermissionAltitude = 'community' | 'modality';

const ALTITUDE: Readonly<Record<PermissionAltitude, readonly GroupPermission[]>> = {
	community: COMMUNITY_PERMISSIONS,
	modality: MODALITY_PERMISSIONS
};

/** Published action -> ours, per altitude, derived from the one mapping above
 *  so the two directions cannot disagree. */
const PERMISSION_BY_ACTION: Readonly<Record<PermissionAltitude, Record<string, GroupPermission>>> =
	{
		community: Object.fromEntries(
			COMMUNITY_PERMISSIONS.map((p) => [PUBLISHED_ACTION[p], p])
		) as Record<string, GroupPermission>,
		modality: Object.fromEntries(
			MODALITY_PERMISSIONS.map((p) => [PUBLISHED_ACTION[p], p])
		) as Record<string, GroupPermission>
	};

/** Ours -> what the record publishes, for one altitude. A name belonging to
 *  the other altitude is dropped rather than translated: the record is a closed
 *  set, so a bundle holding all six yields four actions in `permissions` and
 *  two in `eventPermissions` with no caller having to split it first. */
export function publishedActions(
	altitude: PermissionAltitude,
	permissions: Iterable<string>
): string[] {
	const held = new Set(permissions);
	// Vocabulary order, not the caller's: two groups with the same bundle must
	// publish the same record rather than one that differs by iteration order.
	return ALTITUDE[altitude].filter((p) => held.has(p)).map((p) => PUBLISHED_ACTION[p]);
}

/** What the record publishes -> ours, for one altitude. An action this
 *  altitude does not define is dropped: each record is a closed set, and this
 *  applies it where the record is read. A `permissions` record naming
 *  `createEvent` grants nothing, and neither does one naming `takedown`. */
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

// Static membership tables, not runtime sets: the vocabulary and the enforced
// subset are both fixed at build time.
const IN_VOCABULARY: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

/** Three roles, most privileged first. The order is the display order and the
 *  order `ASSIGNABLE_ROLES` offers, so it is not incidental. There are no
 *  others because a seeded role that grants nothing distinct from `member`
 *  still publishes a `role` record, which a peer app must interpret and we
 *  cannot honor. A pending applicant is a pending join request, never a role. */
export const GROUP_ROLES = ['owner', 'admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** Default bundle per role.
 *
 *  `owner` and `admin` are identical on purpose. The owner is distinguished
 *  structurally, not by an extra grant: it is pinned to `groups.owner_did` by
 *  SQL trigger and never assignable. There is no DELETE_GROUP: deleting a group
 *  means deleting a `did:plc` and its spaces, which is custody, not a bundle
 *  entry.
 *
 *  `member` is empty on purpose. Membership itself is what a member holds (the
 *  roster, a private group's page, the group's events). A group that wants
 *  members to post events grants CREATE_EVENT to a role; the bundles are data,
 *  per group, with no deploy. */
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

/** Every name in the vocabulary is enforced, and must stay so: a name nothing
 *  enforces is a grant that does nothing, and once the lexicon is published it
 *  is a name a peer app reads and honors. */
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

/** Union the permission bundles a caller's roles grant. There are no deny rows
 *  and no role hierarchy: a permission is held if any grant names it. Rows
 *  outside the vocabulary are dropped, not trusted, because the table may be
 *  written by a seeder older than this build. */
export function resolvePermissions(grants: Iterable<Iterable<string>>): Set<GroupPermission> {
	const resolved = new Set<GroupPermission>();
	for (const grant of grants) {
		for (const permission of grant) {
			if (isGroupPermission(permission)) resolved.add(permission);
		}
	}
	return resolved;
}

/** The single gate every handler asks. The enforcement check always passes
 *  while the two sets are equal, and is kept for when they are not: a name
 *  added to the vocabulary before its handler exists must fail closed. */
export function can(granted: ReadonlySet<GroupPermission>, permission: GroupPermission): boolean {
	if (!isEnforced(permission)) return false;
	return granted.has(permission);
}

/** Roles an `ASSIGN_ROLES` holder may assign. `owner` is never among them: it
 *  is pinned to `groups.owner_did` by SQL triggers, so offering it would only
 *  produce a constraint error. */
export const ASSIGNABLE_ROLES: readonly Exclude<GroupRoleName, 'owner'>[] = GROUP_ROLES.filter(
	(r): r is Exclude<GroupRoleName, 'owner'> => r !== 'owner'
);

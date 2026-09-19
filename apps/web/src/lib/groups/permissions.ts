// The group permission MODEL: the vocabulary is fixed in code, the bundles are
// stored as data (decided 2026-09-08), and the vocabulary was cut to the
// standard's altitudes on 2026-09-19.
//
// SIX names in two altitudes, and deliberately no third:
//
//   COMMUNITY (4) — what the draft community standard calls community-scoped
//   actions. These are the only names a `permissions` record may publish, and
//   it publishes the STANDARD's identifiers rather than these spellings. The
//   spellings stay ours so that settling the published form upstream is an
//   edit to PUBLISHED_ACTION plus a replay, never a rename through the app.
//
//   MODALITY (2) — the standard leaves "who may create an event" to the
//   modality's own lexicon, so these two are ours by its own carve-out. They
//   travel in the group's `eventPermissions` record, never in `permissions`.
//
// There is NO read permission. Who may read is the access record plus the
// space read policy the host enforces, and the roster is members-only as a
// membership test rather than as a grant a group can withhold — a `SEE_*` name
// would be a second source of truth for something the host decides. The three
// we used to carry were our own invention: legacy gated reads with a
// visibility guard and no read route ever carried a `SEE_*` decorator.
// (Spec: FR-005a, FR-005b, FR-005d.)

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

/** Ours → what a record publishes: the single bridge FR-005a fixes, so an
 *  upstream rename lands here and in a replay rather than in every call site.
 *  The community four carry the draft standard's own identifiers; the modality
 *  two carry ours, the standard defining none. */
export const PUBLISHED_ACTION: Readonly<Record<GroupPermission, string>> = {
	MANAGE_GROUP: 'community.configure',
	ADMIT_MEMBERS: 'admit',
	EJECT_MEMBERS: 'eject',
	ASSIGN_ROLES: 'role.assign',
	MANAGE_EVENTS: 'manageEvents',
	CREATE_EVENT: 'createEvent'
};

// Static membership tables, not runtime sets: the vocabulary and the enforced
// subset are both fixed at build time.
const IN_VOCABULARY: Record<string, true> = Object.fromEntries(
	GROUP_PERMISSIONS.map((p) => [p, true])
);

/** Three roles, most privileged first. The order is the display order and the
 *  order `ASSIGNABLE_ROLES` offers, so it is not incidental. `moderator` and
 *  `guest` are gone: with the ten inert names dropped neither granted anything
 *  a member did not, and a seeded role that grants nothing distinct publishes
 *  a `role` record a peer app must interpret and we cannot honour. A pending
 *  applicant is a PENDING join request, never a role. (FR-005c.) */
export const GROUP_ROLES = ['owner', 'admin', 'member'] as const;

export type GroupRoleName = (typeof GROUP_ROLES)[number];

/** Default bundle per role.
 *
 *  `owner` and `admin` are identical on purpose. Owner is distinguished
 *  STRUCTURALLY — pinned to `groups.owner_did` by SQL trigger and never
 *  assignable — not by an extra grant; the one name it held alone was
 *  DELETE_GROUP, and deleting a group means deleting a `did:plc` and its
 *  spaces, which is custody rather than a bundle entry.
 *
 *  `member` is EMPTY, and that is the model rather than an oversight:
 *  membership itself is what a member holds — the roster, a private group's
 *  page, the group's events — and legacy gave a member no enforced permission
 *  either, its seven being read gates plus discussion and contact names that
 *  are all dropped. A group that wants members to post events grants
 *  CREATE_EVENT to a role; the bundles are data, per group, no deploy. */
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

/** The vocabulary and the enforced set are now the SAME list, and FR-005a
 *  requires they stay so: a name nothing enforces is a grant that does
 *  nothing, and once `om-ecgc6` publishes the lexicon it is a name a peer app
 *  reads and honours. Both exports survive the convergence because
 *  `V1_INERT_PERMISSIONS` being empty BY DERIVATION is the check that they
 *  have not drifted apart again. */
export const V1_ENFORCED_PERMISSIONS = GROUP_PERMISSIONS;

export type EnforcedGroupPermission = GroupPermission;

const IS_ENFORCED: Record<string, true> = Object.fromEntries(
	V1_ENFORCED_PERMISSIONS.map((p) => [p, true])
);

/** Empty, and derived rather than hand-listed so it can only stay empty by
 *  being true. */
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
 *  writable by a seeder that may be older than this build, and after the 09-19
 *  paring a stale row naming MANAGE_MEMBERS or SEE_MEMBERS is exactly that. */
export function resolvePermissions(grants: Iterable<Iterable<string>>): Set<GroupPermission> {
	const resolved = new Set<GroupPermission>();
	for (const grant of grants) {
		for (const permission of grant) {
			if (isGroupPermission(permission)) resolved.add(permission);
		}
	}
	return resolved;
}

/** The single gate every handler asks. The enforcement check is vacuous while
 *  the two sets are equal and is kept for the moment they are not: a name
 *  added to the vocabulary ahead of its handler must fail closed, which is the
 *  failure the ten inert names used to represent. */
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

// The members space as records: the roster (one `membership` per member, one `access`
// for the space), the authz config it resolves against (`role`, `permissions`,
// `eventPermissions`), and the index of the group's spaces (`space`). A membership is
// keyed by the member's DID, so `getRecord(did)` answers "is this DID a member" in one
// call. There is no `status` and no suspension: a grant is revoked by deleting the
// record that made it.
//
// All but `eventPermissions` are the opensocial.group proposal's records, as in
// ./about-record.ts. The standard leaves who may create an event to the modality's
// own lexicon and defines no record for it. The calendar space holds only
// members-only events, while the event actions cover public events too, so they keep
// a record of their own here, beside the standard's `permissions`.
import {
	ASSIGNABLE_BY_ROLE,
	DEFAULT_ROLES,
	GROUP_ROLES,
	permissionsFromActions,
	publishedActions,
	type GroupPermission,
	type GroupRoleName,
	type PermissionAltitude
} from './permissions';

export const GROUP_MEMBERSHIP_COLLECTION = 'group.opensocial.membership';
export const GROUP_ACCESS_COLLECTION = 'group.opensocial.access';
export const GROUP_ROLE_COLLECTION = 'group.opensocial.role';
export const GROUP_PERMISSIONS_COLLECTION = 'group.opensocial.permissions';
export const GROUP_EVENT_PERMISSIONS_COLLECTION = 'rsvp.atmo.group.eventPermissions';
export const GROUP_SPACE_COLLECTION = 'group.opensocial.space';

/** The member's side of a membership, written by the member into their own repo in
 *  the members space. It decides how the roster shows them, never what they may
 *  read. */
export const GROUP_ACCEPTANCE_COLLECTION = 'group.opensocial.acceptance';

/** A member has one acceptance per group, at `self`. */
export const GROUP_ACCEPTANCE_RKEY = 'self';

/** The member's acceptance. `$type` is stamped by the writer, as for the group's
 *  records (./server/acceptance.ts). */
export function groupAcceptanceRecord(input: { createdAt?: string } = {}): Record<string, unknown> {
	return { createdAt: input.createdAt || new Date().toISOString() };
}

/** Every space's access record is `self`, in that space. */
export const GROUP_ACCESS_RKEY = 'self';

/** Both binding records are `self`. They are two collections, not one record, so the
 *  standard's record carries only the standard's actions. */
export const GROUP_PERMISSIONS_RKEY = 'self';

/** Every role may read the members space. Derived, so a new role does not lose its read. */
export const MEMBERS_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

/** Every role may read the about space too: a private group's profile and rules are
 *  for its members, and the space's member list mirrors the whole roster. */
export const ABOUT_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

export class MembershipKeyError extends Error {
	constructor(readonly did: string) {
		super(`${did} cannot be a record key, so it cannot key a membership record`);
		this.name = 'MembershipKeyError';
	}
}

/** The atproto record-key syntax. A `did:plc` fits; a `did:web` with a percent-encoded
 *  port does not. */
const RECORD_KEY = /^[a-zA-Z0-9_~.:-]{1,512}$/;

export function isMembershipKey(did: string): boolean {
	return RECORD_KEY.test(did) && did !== '.' && did !== '..';
}

/** The member DID, used verbatim as the rkey. Every DID-to-key conversion goes
 *  through this check. */
export function membershipRkey(did: string): string {
	if (!isMembershipKey(did)) throw new MembershipKeyError(did);
	return did;
}

/** A role name we know, or null. Unknown names are dropped, as in `resolvePermissions`. */
function asRole(value: unknown): GroupRoleName | null {
	return typeof value === 'string' && (GROUP_ROLES as readonly string[]).includes(value)
		? (value as GroupRoleName)
		: null;
}

/** Known roles, de-duplicated, most privileged first. */
function asRoles(value: unknown): GroupRoleName[] {
	const raw = Array.isArray(value) ? value : [];
	const found = new Set<GroupRoleName>();
	for (const entry of raw) {
		const role = asRole(entry);
		if (role) found.add(role);
	}
	return GROUP_ROLES.filter((role) => found.has(role));
}

export interface GroupMembershipFields {
	subject: string;
	/** Empty means no access, not a default role. */
	roles: GroupRoleName[];
	createdAt: string | null;
}

export interface GroupMembershipInput {
	subject: string;
	roles: readonly GroupRoleName[];
	/** Preserved so a promotion does not restamp the date the member joined. */
	createdAt?: string;
}

/** One membership. `roles` holds our role ids, the same strings `role` records are
 *  keyed by. The subject is written as `member`, which repeats the record key so a
 *  record lifted out of its key (a `listRecords` page, a CAR export) is not
 *  anonymous. The key still wins. */
export function groupMembershipRecord(input: GroupMembershipInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		member: input.subject,
		roles: [...asRoles(input.roles)],
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A membership record -> its fields, or null. A valid rkey wins over `member`. */
export function parseGroupMembership(value: unknown, rkey?: string): GroupMembershipFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const keyed = rkey && isMembershipKey(rkey) ? rkey : '';
	const claimed = typeof raw.member === 'string' ? raw.member.trim() : '';
	const subject = keyed || claimed;
	if (!subject) return null;
	return {
		subject,
		roles: asRoles(raw.roles),
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

export interface GroupAccessFields {
	/** The roles that may read the space. */
	roles: GroupRoleName[];
	public: boolean;
}

/** A space's access record: whether anyone may read it, and which roles may. It
 *  grants no OAuth scopes, since no authorization server for a group DID exists yet.
 *  A simplespace host enforces the space's read policy and member list, never this
 *  record, so it is written to agree with them: the members space is never public,
 *  and the about space is public exactly when its read policy is. */
export function groupAccessRecord(input: {
	roles: readonly GroupRoleName[];
	public: boolean;
}): Record<string, unknown> {
	return {
		public: input.public,
		readRoles: [...asRoles(input.roles)],
		grants: []
	};
}

export function parseGroupAccess(value: unknown): GroupAccessFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.readRoles)) return null;
	return { roles: asRoles(raw.readRoles), public: raw.public === true };
}

/** Whether a read access record says what `isPublic` says. A missing one never does. */
export function accessSays(access: GroupAccessFields | null, isPublic: boolean): boolean {
	return access !== null && access.public === isPublic;
}

/** One entry in the group's index of its own spaces. The standard wants exactly one
 *  per space, the about and members spaces included. It is keyed by TID, so a put
 *  cannot land on an existing entry: a writer lists the index and adds only what
 *  is missing. `createdAt` is the standard's. */
export function groupSpaceRecord(input: {
	space: string;
	createdAt?: string;
}): Record<string, unknown> {
	return { space: input.space, createdAt: input.createdAt || new Date().toISOString() };
}

export function parseGroupSpace(value: unknown): { space: string } | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const space = typeof raw.space === 'string' ? raw.space.trim() : '';
	return space ? { space } : null;
}

// The authz config. `role` declares that a role exists, so adding one is a record, not
// a deploy. `permissions` binds roles to the four community actions and
// `eventPermissions` to the two modality actions. A role's grant is the union across
// both binding records.

/** A role record's key is its id. Unknown ids are dropped at parse. */
export interface GroupRoleFields {
	id: GroupRoleName;
}

/** One role's existence. The standard requires a display name, and ours is the id
 *  with a capital, so `owner` shows as "Owner". */
export function groupRoleRecord(input: { id: GroupRoleName }): Record<string, unknown> {
	return { displayName: input.id.charAt(0).toUpperCase() + input.id.slice(1) };
}

/** The id is the key, since the key is what the host addresses. */
export function parseGroupRole(value: unknown, rkey?: string): GroupRoleFields | null {
	if (!value || typeof value !== 'object') return null;
	const id = asRole(rkey);
	return id ? { id } : null;
}

/** One role's bundle, in our names. Published identifiers exist only on the wire. */
export interface GroupRoleBinding {
	role: GroupRoleName;
	permissions: GroupPermission[];
}

export interface GroupBindingsFields {
	altitude: PermissionAltitude;
	bindings: GroupRoleBinding[];
}

/**
 * The binding record for one altitude. A list of `{ role, actions }` pairs, not a
 * map, because a lexicon has no open-map type. A role that grants nothing is still
 * written with empty `actions`, since "bound to nothing" differs from "not bound".
 *
 * The community record is the standard's `permissions`: `{ roles, defaultRoles }`,
 * where each binding also lists the roles it may assign and eject. Every role it
 * names is one it binds, since a reader must reject an unknown role. The modality
 * record is `eventPermissions`, which is ours: `{ bindings, createdAt }`.
 */
export function groupBindingsRecord(input: {
	altitude: PermissionAltitude;
	bundles: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
	createdAt?: string;
}): Record<string, unknown> {
	const bound = GROUP_ROLES.filter((role) => input.bundles[role] !== undefined);
	const actions = (role: GroupRoleName) =>
		publishedActions(input.altitude, input.bundles[role] ?? []);

	if (input.altitude === 'community') {
		const declared = (roles: readonly GroupRoleName[]) =>
			roles.filter((role) => bound.includes(role));
		return {
			roles: bound.map((role) => ({
				role,
				actions: actions(role),
				assignable: declared(ASSIGNABLE_BY_ROLE[role])
			})),
			defaultRoles: declared(DEFAULT_ROLES)
		};
	}
	return {
		bindings: bound.map((role) => ({ role, actions: actions(role) })),
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A binding record -> its bundles, in our names. The altitude comes from the
 *  collection the caller read, not from the record, and says which of the two
 *  shapes to read. */
export function parseGroupBindings(
	altitude: PermissionAltitude,
	value: unknown
): GroupBindingsFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const entries = altitude === 'community' ? raw.roles : raw.bindings;
	if (!Array.isArray(entries)) return null;

	const bindings: GroupRoleBinding[] = [];
	const seen = new Set<GroupRoleName>();
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const role = asRole(row.role);
		// A second binding for the same role is unioned, since there is no precedence.
		if (!role) continue;
		const permissions = permissionsFromActions(
			altitude,
			Array.isArray(row.actions) ? row.actions : []
		);
		if (seen.has(role)) {
			const existing = bindings.find((binding) => binding.role === role);
			if (existing) {
				for (const permission of permissions) {
					if (!existing.permissions.includes(permission)) existing.permissions.push(permission);
				}
			}
			continue;
		}
		seen.add(role);
		bindings.push({ role, permissions });
	}

	return { altitude, bindings };
}

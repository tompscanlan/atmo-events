// The members space as records: the roster (one `membership` per member, one `access`
// for the space) and the authz config it resolves against (`role`, `permissions`,
// `eventPermissions`). A membership is keyed by the member's DID, so `getRecord(did)`
// answers "is this DID a member" in one call. There is no `status` and no suspension:
// a grant is revoked by deleting the record that made it.
//
// All but `eventPermissions` are the opensocial.group proposal's records, as in
// ./about-record.ts. The standard puts a modality's authz in the modality's own
// space, and a group has no events space yet, so the event actions keep a record of
// their own here.
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
export const GROUP_EVENT_PERMISSIONS_COLLECTION = 'net.openmeet.group.eventPermissions';

export const GROUP_ACCESS_RKEY = 'self';

/** Both binding records are `self`. They are two collections, not one record, so the
 *  standard's record carries only the standard's actions. */
export const GROUP_PERMISSIONS_RKEY = 'self';

/** Every role may read the members space. Derived, so a new role does not lose its read. */
export const MEMBERS_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

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

/** The members space's access record: which roles may read it. It is never public,
 *  and it grants no OAuth scopes, since no authorization server for a group DID
 *  exists yet. It does not carry the group's visibility, which is the about space's
 *  read policy. */
export function groupAccessRecord(input: {
	roles: readonly GroupRoleName[];
}): Record<string, unknown> {
	return {
		public: false,
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

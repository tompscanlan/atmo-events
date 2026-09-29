// The members space as records: the roster (one `membership` per member, one `access`
// for the space) and the authz config it resolves against (`role`, `permissions`,
// `eventPermissions`). A membership is keyed by the member's DID, so `getRecord(did)`
// answers "is this DID a member" in one call. There is no `status` and no suspension:
// a grant is revoked by deleting the record that made it.
import {
	GROUP_ROLES,
	permissionsFromActions,
	publishedActions,
	type GroupPermission,
	type GroupRoleName,
	type PermissionAltitude
} from './permissions';

export const GROUP_MEMBERSHIP_COLLECTION = 'net.openmeet.group.membership';
export const GROUP_ACCESS_COLLECTION = 'net.openmeet.group.access';
export const GROUP_ROLE_COLLECTION = 'net.openmeet.group.role';
export const GROUP_PERMISSIONS_COLLECTION = 'net.openmeet.group.permissions';
export const GROUP_EVENT_PERMISSIONS_COLLECTION = 'net.openmeet.group.eventPermissions';

export const GROUP_ACCESS_RKEY = 'self';

/** Both binding records are `self`. They are two collections, not one record, so the
 *  community half can move onto an upstream collection name without the modality half. */
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
 *  keyed by. `subject` repeats the record key so a record lifted out of its key (a
 *  `listRecords` page, a CAR export) is not anonymous. The key still wins. */
export function groupMembershipRecord(input: GroupMembershipInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		subject: input.subject,
		roles: [...asRoles(input.roles)],
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A membership record -> its fields, or null. A valid rkey wins over `subject`. */
export function parseGroupMembership(value: unknown, rkey?: string): GroupMembershipFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const keyed = rkey && isMembershipKey(rkey) ? rkey : '';
	const claimed = typeof raw.subject === 'string' ? raw.subject.trim() : '';
	const subject = keyed || claimed;
	if (!subject) return null;
	return {
		subject,
		roles: asRoles(raw.roles),
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

export interface GroupAccessFields {
	roles: GroupRoleName[];
	createdAt: string | null;
}

/** The access record for a space: which roles may read it. The draft's per-role OAuth
 *  scopes are omitted, since no authorization server for a community DID exists yet.
 *  It does not carry visibility, which is the about space's read policy. */
export function groupAccessRecord(input: {
	roles: readonly GroupRoleName[];
	createdAt?: string;
}): Record<string, unknown> {
	return {
		roles: [...asRoles(input.roles)],
		createdAt: input.createdAt || new Date().toISOString()
	};
}

export function parseGroupAccess(value: unknown): GroupAccessFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.roles)) return null;
	return {
		roles: asRoles(raw.roles),
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

// The authz config. `role` declares that a role exists, so adding one is a record, not
// a deploy. `permissions` binds roles to the four community actions and
// `eventPermissions` to the two modality actions. A role's grant is the union across
// both binding records.

/** A role record's key is its id. Unknown ids are dropped at parse. */
export interface GroupRoleFields {
	id: GroupRoleName;
	createdAt: string | null;
}

/** One role's existence. `id` repeats the key, like `membership.subject`. */
export function groupRoleRecord(input: {
	id: GroupRoleName;
	createdAt?: string;
}): Record<string, unknown> {
	return {
		id: input.id,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** The rkey wins over a disagreeing `id`, since the key is what the host addresses. */
export function parseGroupRole(value: unknown, rkey?: string): GroupRoleFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const id = asRole(rkey) ?? asRole(raw.id);
	return id ? { id, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null } : null;
}

/** One role's bundle, in our names. Published identifiers exist only on the wire. */
export interface GroupRoleBinding {
	role: GroupRoleName;
	permissions: GroupPermission[];
}

export interface GroupBindingsFields {
	altitude: PermissionAltitude;
	bindings: GroupRoleBinding[];
	createdAt: string | null;
}

/** The binding record for one altitude. A list of `{ role, actions }` pairs, not a
 *  map, because a lexicon has no open-map type. A role that grants nothing is still
 *  written with empty `actions`, since "bound to nothing" differs from "not bound". */
export function groupBindingsRecord(input: {
	altitude: PermissionAltitude;
	bundles: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
	createdAt?: string;
}): Record<string, unknown> {
	const bindings = GROUP_ROLES.filter((role) => input.bundles[role] !== undefined).map((role) => ({
		role,
		actions: publishedActions(input.altitude, input.bundles[role] ?? [])
	}));
	return {
		bindings,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A binding record -> its bundles, in our names. The altitude comes from the
 *  collection the caller read, not from the record. */
export function parseGroupBindings(
	altitude: PermissionAltitude,
	value: unknown
): GroupBindingsFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.bindings)) return null;

	const bindings: GroupRoleBinding[] = [];
	const seen = new Set<GroupRoleName>();
	for (const entry of raw.bindings) {
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

	return {
		altitude,
		bindings,
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

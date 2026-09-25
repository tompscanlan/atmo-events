// The members space as records: the roster (one `membership` per member, one
// `access` for the space they live in) and the authz config it is resolved
// against (one `role` per role the group has, and the two records that bind
// those roles to actions).
//
// The standard's sentence the roster half implements: "the community creates a
// membership record in the members space", keyed by the member's DID, granting
// that member a role set. The member's own half, `acceptance` (which gates
// appearing in the roster rather than access), is not written by this app, so
// nothing here is member-authored.
//
// KEYED BY THE MEMBER DID, following prior art: Tangled keys
// `sh.tangled.repo.collaboratorInvite` on the counterparty DID so both halves
// of a two-sided relationship are `getRecord`-addressable with no index. That
// is the shape the acceptance half will need. It is also why a membership is
// one record per member and not a list on one record: a list cannot be written
// by two authors, and `getRecord(did)` answers "is this DID a member" in one
// call instead of a list-and-scan.
//
// A DID IS A LEGAL RECORD KEY, and that is checked, not assumed: the key syntax
// allows `[a-zA-Z0-9_~.:-]` up to 512 characters (atproto record-key spec), so
// `did:plc:…` passes and a percent-encoded `did:web:…` does not. The refusal is
// `MembershipKeyError` rather than a PDS 400 three layers down.
//
// NO `status` FIELD, AND NO SUSPENSION. A grant is revoked by deleting the
// record that made it (an eject or a leave), and that is the whole lifecycle.
// Suspension is in neither the community draft nor permissioned data. A
// published status would force a second app to know our lifecycle before it
// could safely grant access, and the record is the source of truth so that
// reading it is enough. If "listed but without access" is ever needed, the
// protocol's own shape for it is `simplespace.putMember`'s read/write booleans,
// not a field here.
//
// Pure, like ./about-record.ts and ./event-record.ts: shape only, no D1 and no
// PDS. The gate, the credential and the transport are ./server/members-writer.ts;
// reading them back is ./server/members-read.ts.
import {
	GROUP_ROLES,
	permissionsFromActions,
	publishedActions,
	type GroupPermission,
	type GroupRoleName,
	type PermissionAltitude
} from './permissions';

/** Every collection this space holds, and all of them only here, so a prefix
 *  change is one edit. */
export const GROUP_MEMBERSHIP_COLLECTION = 'net.openmeet.group.membership';
export const GROUP_ACCESS_COLLECTION = 'net.openmeet.group.access';
export const GROUP_ROLE_COLLECTION = 'net.openmeet.group.role';
export const GROUP_PERMISSIONS_COLLECTION = 'net.openmeet.group.permissions';
export const GROUP_EVENT_PERMISSIONS_COLLECTION = 'net.openmeet.group.eventPermissions';

/** One access record per space, so it is the singleton key every `self`-keyed
 *  record uses. A membership's key is the member's DID instead, and a role's
 *  is its role id. */
export const GROUP_ACCESS_RKEY = 'self';

/** Both binding records are one per community, so both are `self`. They are
 *  two collections rather than one record with two fields because the
 *  community half must stay swappable onto an upstream collection name, and a
 *  modality field riding on it would travel into a schema that may refuse it,
 *  or be dropped by the replay. */
export const GROUP_PERMISSIONS_RKEY = 'self';

/** The roster is members-only at every visibility, and read is not a
 *  permission a group configures, so the roles that may read a group's members
 *  space are simply all of them. Derived from the vocabulary rather than
 *  hand-listed: a fourth role must not silently lose its read. */
export const MEMBERS_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

/** A DID that cannot be a record key, so it cannot key a membership record. */
export class MembershipKeyError extends Error {
	constructor(readonly did: string) {
		super(`${did} cannot be a record key, so it cannot key a membership record`);
		this.name = 'MembershipKeyError';
	}
}

/** The record-key syntax, verbatim from the atproto spec: alphanumerics plus
 *  `.-_:~`, 1–512 characters, and never `.` or `..`. A `did:plc` is inside it;
 *  a `did:web` carrying a percent-encoded port is not. */
const RECORD_KEY = /^[a-zA-Z0-9_~.:-]{1,512}$/;

export function isMembershipKey(did: string): boolean {
	return RECORD_KEY.test(did) && did !== '.' && did !== '..';
}

/** The member DID, used verbatim as the rkey. A function rather than an inline
 *  expression because the check is the point: every call site that turns a DID
 *  into a key goes through this one. */
export function membershipRkey(did: string): string {
	if (!isMembershipKey(did)) throw new MembershipKeyError(did);
	return did;
}

/** A role name we know, or nothing. Rows and records can both be written by
 *  something older than this build, so an unknown name is dropped, not
 *  trusted: the same rule `resolvePermissions` applies to permissions. */
function asRole(value: unknown): GroupRoleName | null {
	return typeof value === 'string' && (GROUP_ROLES as readonly string[]).includes(value)
		? (value as GroupRoleName)
		: null;
}

/** Known roles, de-duplicated, in vocabulary order. That order is most
 *  privileged first, so `roles[0]` is the role a single-role projection keeps. */
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
	/** The member. Duplicates the record key on purpose (see below). */
	subject: string;
	/** Most privileged first. Empty means the record grants nothing, which a
	 *  reader must treat as no access rather than as a default role. */
	roles: GroupRoleName[];
	createdAt: string | null;
}

export interface GroupMembershipInput {
	subject: string;
	roles: readonly GroupRoleName[];
	/** Preserved across a role change so a promotion does not restamp the date
	 *  the member joined. */
	createdAt?: string;
}

/**
 * One membership.
 *
 * `roles` is the draft's own "grants that member a role set", carrying our role
 * ids (`owner`/`admin`/`member`). These are the same strings `role` records are
 * keyed by, because a membership naming a role the role records do not declare
 * would be unresolvable. Unlike the permission vocabulary there is no published
 * identifier to translate to: the draft standardizes actions, not role names.
 *
 * `subject` repeats the record key on purpose. A record lifted out of its key
 * (a `listRecords` page, an export, a CAR replay) is otherwise anonymous. The
 * cost of the duplication is one string; the cost of losing it is a membership
 * that grants roles to nobody in particular. A reader must still prefer the key
 * when the two disagree, because the key is what the host addresses.
 *
 * There is no `status` (see this file's header): removing a member deletes the
 * record.
 */
export function groupMembershipRecord(input: GroupMembershipInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		subject: input.subject,
		roles: [...asRoles(input.roles)],
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A membership record -> its fields, or null when the value is not one.
 *
 *  `subject` falls back to the rkey the record came under, which is the
 *  authority on who the membership is for. A record with neither is not a
 *  membership. */
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
	/** The roles that may read the space this record sits in. */
	roles: GroupRoleName[];
	createdAt: string | null;
}

/**
 * The access record for a space.
 *
 * The draft's `access` is "which roles may read this space", plus the OAuth
 * scopes each role may request for the community DID. The scopes are omitted
 * on purpose: no authorization server for a community DID exists yet, so a
 * scope list here would describe a capability nothing can issue and nothing can
 * check.
 *
 * It does not carry `groups.visibility`. Visibility narrows browse and the
 * group page and has no upstream equivalent. It also cannot be derived from a
 * role list: `public` and `private` have the same readers of the same records,
 * since the roles that may read the space do not change when the group stops
 * being listed. It stays app-local.
 */
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

// ---------------------------------------------------------------------------
// THE AUTHZ CONFIG: `role`, `permissions`, `eventPermissions`.
//
// Three records rather than one, because the draft standard splits them and
// the split is what makes a role data:
//
//   role                declares that a role exists, keyed by its id. Carries
//                       no permissions, so adding one is a record, not a
//                       deploy.
//   permissions         binds roles to the four community actions, under the
//                       standard's own identifiers.
//   eventPermissions    binds the same roles to the two modality actions,
//                       under ours, since the standard defines none.
//
// A role's effective grant is the union across the two binding records. There
// are no deny rules and no precedence. Reading only the first record would
// silently drop every event grant.

/** A role record's key is its id. There is no `membershipRkey`-style check,
 *  because a role id is not a DID: the vocabulary is this build's own three,
 *  all legal record-key syntax. A name from outside it is dropped at parse
 *  rather than refused at write. */
export interface GroupRoleFields {
	id: GroupRoleName;
	createdAt: string | null;
}

/**
 * One role's existence.
 *
 * `id` repeats the record key for the same reason `membership.subject` does: a
 * record lifted out of its key is otherwise anonymous, and a reader still
 * prefers the key when the two disagree.
 *
 * There is no display name. The draft publishes no such field, and we add
 * fields only as declared extensions. A role id is already human-readable, and
 * rendering it is the app's business.
 */
export function groupRoleRecord(input: {
	id: GroupRoleName;
	createdAt?: string;
}): Record<string, unknown> {
	return {
		id: input.id,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A role record -> its fields, or null when the value is not one. The rkey
 *  wins over a disagreeing `id` because the key is what the host addresses. */
export function parseGroupRole(value: unknown, rkey?: string): GroupRoleFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const id = asRole(rkey) ?? asRole(raw.id);
	return id ? { id, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null } : null;
}

/** One role's bundle, in our names. The published identifiers exist only on
 *  the wire: everything inside the app speaks the enum, which keeps the bridge
 *  to one table. */
export interface GroupRoleBinding {
	role: GroupRoleName;
	permissions: GroupPermission[];
}

export interface GroupBindingsFields {
	altitude: PermissionAltitude;
	bindings: GroupRoleBinding[];
	createdAt: string | null;
}

/**
 * The binding record for one altitude: role -> the actions it grants.
 *
 * A list of pairs, not a map keyed by role id, because in the standard role
 * ids are per-group instances (a group may define `greeter`), and a lexicon has
 * no open-map type to declare that in. An array of `{ role, actions }` is a
 * shape a lexicon can publish, so it is the shape written now.
 *
 * A role that grants nothing is still written, with an empty `actions`. In the
 * default bundles `member` holds nothing at either altitude, and "bound to
 * nothing" is a different statement from "not bound", which a reader would
 * otherwise have to guess. It also keeps the two binding records and the `role`
 * records listing the same roles.
 *
 * Actions are the published identifiers, filtered to this altitude: a bundle
 * holding all six yields four actions here and two in the other record, and a
 * caller never has to split a bundle itself.
 */
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

/**
 * A binding record -> its bundles, in our names.
 *
 * The altitude is the caller's, taken from the collection it read, not from
 * anything in the record. An action the altitude does not define is dropped,
 * so a `permissions` record naming `createEvent` grants nothing, and neither
 * does one naming `takedown` (a real action of the standard that we do not
 * adopt). Each record is a closed set, and this applies it where the record is
 * read.
 */
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
		// A second binding for a role already bound is unioned, not overwritten:
		// the model has no precedence, so "the last one wins" would be a rule this
		// record does not get to invent.
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

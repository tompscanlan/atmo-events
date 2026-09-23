// The MEMBERS space as records: the roster — one `membership` per member, one
// `access` for the space they live in — and the authz config it is resolved
// against: one `role` per role the group has, and the two records that bind
// those roles to actions.
//
// The standard's sentence the roster half implements: "the community creates a
// membership record in the members space", keyed by the member's DID, granting
// that member a role set. The member's own half — `acceptance`, which gates
// appearing in the roster rather than access — is iteration 2 (`om-kp7ss.5`),
// so nothing here is member-authored. (Spec: FR-005, FR-006.)
//
// KEYED BY THE MEMBER DID, which is prior art rather than a preference:
// Tangled keys `sh.tangled.repo.collaboratorInvite` on the counterparty DID so
// both halves of a two-sided relationship are `getRecord`-addressable with no
// index. That is exactly the shape the acceptance half will need, and it is why
// a membership is one record per member rather than a list on one record: a
// list cannot be written by two authors, and `getRecord(did)` answers "is this
// DID a member" in one call instead of a list-and-scan.
//
// A DID IS A LEGAL RECORD KEY and that is checked, not assumed: the key syntax
// allows `[a-zA-Z0-9_~.:-]` up to 512 characters (atproto record-key spec), so
// `did:plc:…` passes and a percent-encoded `did:web:…` does not. The refusal is
// `MembershipKeyError` rather than a PDS 400 three layers down.
//
// NO `status` FIELD, AND NO SUSPENSION. A grant is revoked by deleting the
// record that made it — an eject or a leave — and that is the whole lifecycle.
// Suspension was removed 2026-09-23: it is in neither the opensocial.community
// draft nor permissioned data, and publishing a status would mean a second app
// had to know our lifecycle to avoid granting access, when the point of the
// record being the source of truth is that reading it is enough. If "listed
// but without access" is ever needed, the protocol-native shape is
// `simplespace.putMember`'s read/write booleans, not a field here.
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

/** Every collection this space holds, and all of them only here — a prefix
 *  change is one edit (`contracts/records.md`, FR-013). */
export const GROUP_MEMBERSHIP_COLLECTION = 'net.openmeet.group.membership';
export const GROUP_ACCESS_COLLECTION = 'net.openmeet.group.access';
export const GROUP_ROLE_COLLECTION = 'net.openmeet.group.role';
export const GROUP_PERMISSIONS_COLLECTION = 'net.openmeet.group.permissions';
export const GROUP_EVENT_PERMISSIONS_COLLECTION = 'net.openmeet.group.eventPermissions';

/** One access record per space, so it is the singleton key every `self`-keyed
 *  record uses. A membership's key is the member's DID instead, and a role's
 *  is its role id. */
export const GROUP_ACCESS_RKEY = 'self';

/** Both binding records are one-per-community, so both are `self`. They are
 *  two collections rather than one record with two fields because the
 *  community half must stay swappable onto an upstream collection name
 *  (FR-013) and a modality field riding on it would travel into a schema that
 *  may refuse it — or be dropped by the replay. (FR-005a.) */
export const GROUP_PERMISSIONS_RKEY = 'self';

/** The roster is members-only at every visibility (FR-016b) and read is not a
 *  permission a group configures (FR-005d), so the roles that may read a
 *  group's members space are simply all of them. Derived from the vocabulary
 *  rather than hand-listed: a fourth role must not silently lose its read. */
export const MEMBERS_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

/** A DID that cannot be a record key, so it cannot key a membership record. */
export class MembershipKeyError extends Error {
	constructor(readonly did: string) {
		super(`${did} cannot be a record key, so it cannot key a membership record`);
		this.name = 'MembershipKeyError';
	}
}

/** The record-key syntax, verbatim from the spec: alphanumerics plus
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

/** A role name we know, or nothing. Rows and records are both writable by
 *  something older than this build, so an unknown name is dropped rather than
 *  trusted — the same discipline `resolvePermissions` applies to permissions. */
function asRole(value: unknown): GroupRoleName | null {
	return typeof value === 'string' && (GROUP_ROLES as readonly string[]).includes(value)
		? (value as GroupRoleName)
		: null;
}

/** Known roles, de-duplicated, in vocabulary order — which is most-privileged
 *  first, so `roles[0]` is the role a single-role projection keeps. */
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
	/** The member. Duplicates the record key on purpose — see below. */
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
 * `roles` is the draft's own "grants that member a role set", carrying OUR role
 * ids (`owner`/`admin`/`member`) — the same strings `role` records are keyed by
 * (T013), because a membership naming a role the role records do not declare
 * would be unresolvable. Unlike the permission vocabulary there is no published
 * identifier to translate to: the draft standardises actions, not role names.
 *
 * `subject` REPEATS THE RECORD KEY, deliberately. A record lifted out of its
 * key — a `listRecords` page, a roster export (`om-my8ev`), a CAR replay — is
 * otherwise anonymous, and the cost of the duplication is one string while the
 * cost of losing it is a membership that grants roles to nobody in particular.
 * A reader must still prefer the KEY when the two disagree, because the key is
 * what the host addresses.
 *
 * `status` is absent by design (see this file's header): suspension revokes the
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
export function parseGroupMembership(
	value: unknown,
	rkey?: string
): GroupMembershipFields | null {
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
 * scopes each role may request for the community DID. THE SCOPES ARE OMITTED,
 * not forgotten: an authorization server for a community DID does not exist in
 * anyone's code yet (`om-jc4lh`, OQ-C), so a scope list here would describe a
 * capability nothing can issue and nothing can check.
 *
 * It does NOT carry `groups.visibility`. Visibility is a browse-and-page
 * narrowing with no upstream analogue (FR-005d), and it does not invert from a
 * role list either — `public` and `private` name the same set of readers of the
 * same records, since the roles that may read the space do not change when the
 * group stops being listed. It stays app-local cache, which `data-model.md`
 * prices.
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
// the split is what makes a role DATA:
//
//   role                declares that a role EXISTS, keyed by its id. Carries
//                       no permissions, so adding one is a record, not a
//                       deploy.
//   permissions         binds roles to the four COMMUNITY actions, under the
//                       standard's own identifiers.
//   eventPermissions    binds the same roles to the two MODALITY actions,
//                       under ours, the standard defining none.
//
// A role's effective grant is the UNION across the two binding records. There
// are no deny rules and no precedence — reading only the first silently drops
// every event grant, which is the one way to get this wrong quietly.
// (Spec: FR-005, FR-005a.)

/** A role record's key IS its id — no `membershipRkey`-style check, because a
 *  role id is not a DID: the vocabulary is this build's own three (FR-005c),
 *  every one of them legal record-key syntax. A name from outside it is
 *  dropped at parse rather than refused at write. */
export interface GroupRoleFields {
	id: GroupRoleName;
	createdAt: string | null;
}

/**
 * One role's existence.
 *
 * `id` REPEATS THE RECORD KEY for the reason `membership.subject` repeats its
 * own: a record lifted out of its key is otherwise anonymous, and a reader
 * still prefers the key when the two disagree.
 *
 * There is no display name, and that is the declared-extension rule rather
 * than an omission: the source publishes no such field, so adding one would
 * make a third entry in `contracts/records.md` § Declared extensions. A role
 * id is already human-readable, and rendering it is the app's business.
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

/** One role's bundle, in OUR names. The published identifiers exist only on
 *  the wire: everything inside the app speaks the enum, which is what keeps
 *  the bridge to one table. */
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
 * A LIST OF PAIRS, not a map keyed by role id, because role ids are per-group
 * instances — a group may mint `greeter` — and a lexicon has no open-map type
 * to declare that in. The shape that can be published (`om-ecgc6`) is an array
 * of `{ role, actions }`, so it is the shape written now.
 *
 * A ROLE THAT GRANTS NOTHING IS STILL WRITTEN, with an empty `actions`. Under
 * the pared seed `member` holds nothing at either altitude, and "bound to
 * nothing" is a different statement from "not bound", which is what a reader
 * would otherwise have to guess. It also keeps the two binding records and the
 * `role` records listing the same roles.
 *
 * Actions are the PUBLISHED identifiers, filtered to this altitude: a bundle
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
 * The altitude is the CALLER's, taken from the collection it read, not from
 * anything in the record: an action the altitude does not define is dropped,
 * so a `permissions` record naming `createEvent` grants nothing and a
 * `permissions` record naming `takedown` — a real action of the standard we
 * deliberately do not adopt — grants nothing either. That is FR-005a's closed
 * set applied at the read edge.
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
		// A second binding for a role already bound is UNIONED rather than
		// overwritten: the model has no precedence, so "the last one wins" would
		// be a rule this record does not get to invent.
		if (!role) continue;
		const permissions = permissionsFromActions(altitude, Array.isArray(row.actions) ? row.actions : []);
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

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
	publishedScopes,
	type GroupPermission,
	type GroupRoleName,
	type PermissionAltitude
} from './permissions';
import type { RoleGrant } from './scopes';

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
 *  for its members, and its host lets in every member by this grant. */
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

/** Every role id in a list, de-duplicated, in list order. */
function roleIds(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [];
	return [...new Set(raw.filter((entry): entry is string => typeof entry === 'string' && !!entry))];
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
	/** Every role the record names, known here or not, in record order. The write
	 *  gate checks these, since a role this build does not know still has grants
	 *  and still bounds who may eject its holder. (Spec: FR-213.) */
	roleIds: string[];
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
		roleIds: roleIds(raw.roles),
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

export interface GroupAccessFields {
	/** The roles that may read the space. */
	roles: GroupRoleName[];
	public: boolean;
	/** Every grant as written, for the write gate. */
	grants: RoleGrant[];
}

/** The scope that lets a role read a space of this type, and nothing more. */
export function spaceReadScope(spaceType: string): string {
	return `space:${spaceType}?action=read`;
}

/** Whether a scope reads the space: a `space:` scope with no `action`, which grants
 *  every action, or one whose actions include `read`. */
function readsSpace(scope: unknown): boolean {
	if (typeof scope !== 'string' || !scope.startsWith('space:')) return false;
	const query = scope.indexOf('?');
	const actions = query < 0 ? [] : new URLSearchParams(scope.slice(query + 1)).getAll('action');
	return actions.length === 0 || actions.includes('read');
}

/** A space's access record: whether anyone may read it, and the roles granted
 *  `read` there, one grant each. It is the space's policy. A simplespace host
 *  enforces its own read policy instead, so atmo derives that from this record
 *  (./server/spaces.ts). The members space is never public. (Spec: FR-214.) */
export function groupAccessRecord(input: {
	spaceType: string;
	roles: readonly GroupRoleName[];
	public: boolean;
}): Record<string, unknown> {
	return {
		public: input.public,
		grants: asRoles(input.roles).map((role) => ({
			role,
			scopes: [spaceReadScope(input.spaceType)]
		}))
	};
}

/** An access record -> whether it is public, which known roles may read, and its
 *  grants. Null when there is no `grants` list at all, rather than defaulting to
 *  open. */
export function parseGroupAccess(value: unknown): GroupAccessFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const grants = parseGroupGrants(value);
	if (!grants) return null;
	const readers = grants.filter((grant) => grant.scopes.some(readsSpace));
	return {
		roles: asRoles(readers.map((grant) => grant.role)),
		public: raw.public === true,
		grants
	};
}

/** The `grants` of a `permissions` or `access` record, as written: any role id, its
 *  scopes, and (in `permissions`) its `assignable`. An entry with no role is
 *  dropped. Null when there is no `grants` list. */
export function parseGroupGrants(value: unknown): RoleGrant[] | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.grants)) return null;
	const grants: RoleGrant[] = [];
	for (const entry of raw.grants) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.role !== 'string' || !row.role) continue;
		grants.push({
			role: row.role,
			scopes: Array.isArray(row.scopes) ? row.scopes : [],
			...(Array.isArray(row.assignable) ? { assignable: row.assignable } : {})
		});
	}
	return grants;
}

/** Whether a read access record says what `isPublic` says. A missing one never does. */
export function accessSays(access: GroupAccessFields | null, isPublic: boolean): boolean {
	return access !== null && access.public === isPublic;
}

/** Whether an access record grants `read` to any of `roleIds`, a role atmo does not
 *  know included. A missing record grants no one. */
export function accessGrantsRead(
	access: GroupAccessFields | null,
	roleIds: readonly string[]
): boolean {
	if (!access) return false;
	return access.grants.some(
		(grant) => roleIds.includes(grant.role) && grant.scopes.some(readsSpace)
	);
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
// a deploy. `permissions` grants roles scopes on the group DID, and `eventPermissions`
// binds them to the two modality actions. What a member may do is the union over
// their roles of both.

/** A role record's key is its id. Unknown ids are dropped at parse. */
export interface GroupRoleFields {
	id: GroupRoleName;
}

/** One role's existence. The standard requires a display name, and ours is the id
 *  with a capital, so `owner` shows as "Owner". A role a new member is admitted
 *  with says `default`, which is left out, as false, on the rest. */
export function groupRoleRecord(input: { id: GroupRoleName }): Record<string, unknown> {
	const displayName = input.id.charAt(0).toUpperCase() + input.id.slice(1);
	return DEFAULT_ROLES.includes(input.id) ? { displayName, default: true } : { displayName };
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
 * The binding record for one altitude. A list with one entry per role, not a map,
 * because a lexicon has no open-map type. A role that grants nothing is still
 * written, with nothing in it, since "bound to nothing" differs from "not bound".
 *
 * The community record is the standard's `permissions`: `{ grants }`, each grant a
 * role's `scopes` and the roles it may assign and eject (`assignable`). Every role
 * it names is one it binds, since a reader must reject an unknown role. The
 * default role is not here but on its `role` record. The modality record is
 * `eventPermissions`, which is ours: `{ bindings, createdAt }`, each binding a
 * role's `actions`.
 */
export function groupBindingsRecord(input: {
	altitude: PermissionAltitude;
	bundles: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
	createdAt?: string;
}): Record<string, unknown> {
	const bound = GROUP_ROLES.filter((role) => input.bundles[role] !== undefined);
	const bundle = (role: GroupRoleName) => input.bundles[role] ?? [];

	if (input.altitude === 'community') {
		return {
			grants: bound.map((role) => ({
				role,
				scopes: publishedScopes(bundle(role)),
				assignable: ASSIGNABLE_BY_ROLE[role].filter((other) => bound.includes(other))
			}))
		};
	}
	return {
		bindings: bound.map((role) => ({ role, actions: publishedActions(bundle(role)) })),
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** An `eventPermissions` record -> its bundles, in our names. The record is ours
 *  and a closed set, so an action it does not define grants nothing. The
 *  standard's `permissions` is read as scopes instead (`parseGroupGrants`). */
export function parseEventBindings(value: unknown): GroupBindingsFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.bindings)) return null;

	const bindings: GroupRoleBinding[] = [];
	for (const entry of raw.bindings) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const role = asRole(row.role);
		if (!role) continue;
		const permissions: GroupPermission[] = permissionsFromActions(
			Array.isArray(row.actions) ? row.actions : []
		);
		// A second binding for the same role is unioned, since there is no precedence.
		const existing = bindings.find((binding) => binding.role === role);
		if (!existing) {
			bindings.push({ role, permissions });
			continue;
		}
		for (const permission of permissions) {
			if (!existing.permissions.includes(permission)) existing.permissions.push(permission);
		}
	}

	return { altitude: 'modality', bindings };
}

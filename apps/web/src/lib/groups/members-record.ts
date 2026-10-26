// The members space as records: one `membership` per member, keyed by the member's
// DID, the space's `access`, and the authz config (`role`, `permissions`). Each member's
// own `acceptance` sits in their repo in the same space.
import { GROUP_ROLES, type GroupRoleName } from './permissions';
import type { RoleGrant } from './scopes';

export const GROUP_MEMBERSHIP_COLLECTION = 'group.opensocial.membership';
export const GROUP_ACCESS_COLLECTION = 'group.opensocial.access';
export const GROUP_ROLE_COLLECTION = 'group.opensocial.role';
export const GROUP_PERMISSIONS_COLLECTION = 'group.opensocial.permissions';
export const GROUP_ACCEPTANCE_COLLECTION = 'group.opensocial.acceptance';

export const GROUP_ACCESS_RKEY = 'self';
export const GROUP_PERMISSIONS_RKEY = 'self';
export const GROUP_ACCEPTANCE_RKEY = 'self';

export const ABOUT_SPACE_READER_ROLES: readonly GroupRoleName[] = GROUP_ROLES;

export class MembershipKeyError extends Error {
	constructor(readonly did: string) {
		super(`${did} cannot be a record key, so it cannot key a membership record`);
		this.name = 'MembershipKeyError';
	}
}

// A `did:web` with a percent-encoded port is not a valid record key.
const RECORD_KEY = /^[a-zA-Z0-9_~.:-]{1,512}$/;

export function isMembershipKey(did: string): boolean {
	return RECORD_KEY.test(did) && did !== '.' && did !== '..';
}

export function membershipRkey(did: string): string {
	if (!isMembershipKey(did)) throw new MembershipKeyError(did);
	return did;
}

function roleIds(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [];
	return [...new Set(raw.filter((entry): entry is string => typeof entry === 'string' && !!entry))];
}

export interface GroupMembershipFields {
	subject: string;
	/** Every role the record names, known here or not. Empty means no access. */
	roles: string[];
	createdAt: string | null;
}

export function groupMembershipRecord(input: {
	subject: string;
	roles: readonly string[];
	createdAt?: string;
}): Record<string, unknown> {
	return {
		member: input.subject,
		roles: roleIds(input.roles),
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/** A valid rkey wins over `member`. */
export function parseGroupMembership(value: unknown, rkey?: string): GroupMembershipFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const keyed = rkey && isMembershipKey(rkey) ? rkey : '';
	const claimed = typeof raw.member === 'string' ? raw.member.trim() : '';
	const subject = keyed || claimed;
	if (!subject) return null;
	return {
		subject,
		roles: roleIds(raw.roles),
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

export interface GroupAccessFields {
	public: boolean;
	grants: RoleGrant[];
}

export function spaceReadScope(spaceType: string): string {
	return `space:${spaceType}?action=read`;
}

export function groupAccessRecord(input: {
	spaceType: string;
	roles: readonly string[];
	public: boolean;
}): Record<string, unknown> {
	return {
		public: input.public,
		grants: input.roles.map((role) => ({ role, scopes: [spaceReadScope(input.spaceType)] }))
	};
}

/** Null when there is no `grants` list at all, rather than defaulting to open. */
export function parseGroupAccess(value: unknown): GroupAccessFields | null {
	const grants = parseGroupGrants(value);
	if (!grants) return null;
	return { public: (value as Record<string, unknown>).public === true, grants };
}

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

export function accessSays(access: GroupAccessFields | null, isPublic: boolean): boolean {
	return access !== null && access.public === isPublic;
}

export function parseGroupRole(value: unknown, rkey?: string): { id: string } | null {
	if (!value || typeof value !== 'object' || !rkey) return null;
	return { id: rkey };
}

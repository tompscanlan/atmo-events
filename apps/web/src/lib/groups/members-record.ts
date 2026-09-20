// A group's ROSTER as records: one `membership` per member, one `access` for
// the space they live in.
//
// The standard's sentence this implements: "the community creates a membership
// record in the members space", keyed by the member's DID, granting that member
// a role set. The member's own half — `acceptance`, which gates appearing in
// the roster rather than access — is iteration 2 (`om-kp7ss.5`), so nothing
// here is member-authored. (Spec: FR-006.)
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
// SUSPENSION IS THE ABSENCE OF A RECORD, not a field on one. A suspended member
// has no access, so their grant is revoked — and a grant is revoked by deleting
// the record that made it, exactly as an eject is. What survives suspension is
// the D1 row, which is the app-local memo that lets one click restore the role;
// the records say only what is true at the protocol layer, which is that this
// DID is not currently a member. This is why no `status` field appears below:
// publishing one would mean a second app had to know our lifecycle to avoid
// granting a suspended member access, and the whole point of the record being
// the source of truth is that reading it is enough. (`data-model.md` prices
// what a rebuild can therefore restore.)
//
// Pure, like ./about-record.ts and ./event-record.ts: shape only, no D1 and no
// PDS. The gate, the credential and the transport are ./server/members-writer.ts;
// reading them back is ./server/members-read.ts.
import { GROUP_ROLES, type GroupRoleName } from './permissions';

/** Both collections, and both only here — a prefix change is one edit
 *  (`contracts/records.md`, FR-013). */
export const GROUP_MEMBERSHIP_COLLECTION = 'net.openmeet.group.membership';
export const GROUP_ACCESS_COLLECTION = 'net.openmeet.group.access';

/** One access record per space, so it is the singleton key every `self`-keyed
 *  record uses. A membership's key is the member's DID instead. */
export const GROUP_ACCESS_RKEY = 'self';

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
 * role list either — `public` and `unlisted` name the same set of readers of
 * the same records. It stays app-local cache, which `data-model.md` prices.
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

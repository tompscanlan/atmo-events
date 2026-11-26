// Who is in a group, as its members space keeps it: one `org.atgrp.membership` per member, in the
// group's repo, keyed by the member's DID and holding `{roles, createdAt}`, and the group's
// `org.atgrp.role` records, keyed by role ID. Values and pure functions only, so the members page
// can import them.
import { ADMIN_ROLE, GROUP_MEMBERSHIP_COLLECTION, MEMBER_ROLE } from './ids';

export interface RosterRole {
	id: string;
	/** The role record's `displayName`, or its ID when it has none, as the spec defaults it. */
	name: string;
}

export interface RosterEntry {
	did: string;
	/** Verified both ways, or null. */
	handle: string | null;
	/** Every role the membership names, known here or not. */
	roles: string[];
	createdAt: string | null;
	/** Whether the member's own confirmation is in their repo; null when it was not read. */
	confirmed: boolean | null;
}

export interface JoinRequestView {
	did: string;
	handle: string | null;
	message: string | null;
	createdAt: string;
}

/** A membership's roles, each once, in the order written; null for a record without a list. */
export function membershipRoles(value: unknown): string[] | null {
	const roles = (value as { roles?: unknown } | null)?.roles;
	if (!Array.isArray(roles)) return null;
	return [...new Set(roles.filter((role): role is string => typeof role === 'string' && !!role))];
}

export function isAdmin(roles: readonly string[]): boolean {
	return roles.includes(ADMIN_ROLE);
}

/** The roles after making a member an admin, or an admin a member again: `member` always, as the
 *  group host requires, and every other role kept as it was. */
export function rolesWithAdmin(roles: readonly string[], admin: boolean): string[] {
	const others = roles.filter((role) => role !== MEMBER_ROLE && role !== ADMIN_ROLE);
	return [MEMBER_ROLE, ...(admin ? [ADMIN_ROLE] : []), ...others];
}

/** A membership as the spec has it: no `member` field, since its key names the member. */
export function membershipRecord(
	roles: readonly string[],
	createdAt: string
): Record<string, unknown> {
	return { $type: GROUP_MEMBERSHIP_COLLECTION, roles: [...roles], createdAt };
}

export function roleOf(value: unknown, id: string): RosterRole {
	const displayName = (value as { displayName?: unknown } | null)?.displayName;
	const name = typeof displayName === 'string' ? displayName.trim() : '';
	return { id, name: name || id };
}

/** The roles a member holds beyond `member`, by name, for a badge each. */
export function shownRoles(entry: Pick<RosterEntry, 'roles'>, roles: readonly RosterRole[]) {
	return entry.roles
		.filter((role) => role !== MEMBER_ROLE)
		.map((id) => roles.find((role) => role.id === id) ?? { id, name: id });
}

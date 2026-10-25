// Who may see what. Reading is roster membership, not a permission, and always the
// caller's own record, never a row: a removal whose row delete failed opens nothing.
import type { CallerMembership, GroupVisibility } from './types';

export function canSeeGroup(visibility: GroupVisibility, membership: CallerMembership): boolean {
	return visibility === 'public' || membership.onRoster;
}

/** The roster is members-only at every visibility. */
export function canSeeMembers(membership: CallerMembership): boolean {
	return membership.onRoster;
}

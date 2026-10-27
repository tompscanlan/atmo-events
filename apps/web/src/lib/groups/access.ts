import type { CallerMembership, GroupVisibility } from './types';

export function canSeeGroup(visibility: GroupVisibility, membership: CallerMembership): boolean {
	return visibility === 'public' || membership.onRoster;
}

export function canSeeMembers(membership: CallerMembership): boolean {
	return membership.onRoster;
}

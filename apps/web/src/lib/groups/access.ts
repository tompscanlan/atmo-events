// Who may see what. Read is not a permission. Here it is roster membership. The
// page gate does not hide a private group's events: they live in its public repo.
import type { CallerMembership, GroupVisibility } from './types';

/** `onRoster`, never `role`: a revocation whose row delete failed must not keep a
 *  private group open to the DID it removed. */
function isActiveMember(membership: CallerMembership): boolean {
	return membership.onRoster;
}

/** A private group is visible only to its roster. There is no secret address to
 *  rely on: its DID and handle are in the public PLC audit log from genesis. */
export function canSeeGroup(visibility: GroupVisibility, membership: CallerMembership): boolean {
	if (visibility === 'public') return true;
	return isActiveMember(membership);
}

/** The roster is members-only at every visibility, including public. */
export function canSeeMembers(membership: CallerMembership): boolean {
	return isActiveMember(membership);
}

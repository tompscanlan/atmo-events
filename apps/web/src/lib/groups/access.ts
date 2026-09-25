// Who may see what. Pure, so the pages and the loaders ask the same question.
//
// READ IS NOT A PERMISSION. The community standard has no "see" action: who may
// read a space is the `access` record plus the space read policy the host
// enforces. The app stands in for that host here (the members space keeps an
// empty member list, so the app is its only reader), and these two predicates
// are that policy expressed as membership, not as a grant a group can withhold.
//
// Two kinds of data, two rules:
//
//   APP-OWNED data (the roster) is only ever visible to a member. Only the app
//   serves it, so the gate is real.
//
//   PROTOCOL-PUBLIC data (events in the group DID's public repo) is served
//   anonymously by the PDS to anyone who knows the DID. The app gates the page
//   for a private group, but that does not hide the records: group events are
//   written to the public repo, so a private group's events are not private at
//   the protocol layer.
import type { CallerMembership, GroupRow } from './types';

/** On the roster, as the loader decided it (`getCallerMembership`): the
 *  caller's membership record when the group's records can answer, the row only
 *  when they cannot. Asking `role` here instead would let a revocation whose row
 *  delete failed keep a private group open to the DID it removed. */
function isActiveMember(membership: CallerMembership): boolean {
	return membership.onRoster;
}

/** A private group is invisible to anyone off its roster; a public one is
 *  visible to everyone. There is no secret address to rely on: the group's DID
 *  and handle are published to plc.directory's audit log at genesis, so anyone
 *  who reads that log can enumerate them. That is why the gate has to be
 *  membership. `listGroups` applies the same rule when it hydrates a declared
 *  row, so browse cannot name a group its page would refuse. */
export function canSeeGroup(group: GroupRow, membership: CallerMembership): boolean {
	if (group.visibility !== 'private') return true;
	return isActiveMember(membership);
}

/** The roster is app data, and members-only at every visibility, including
 *  public. There is no visibility branch here on purpose. */
export function canSeeMembers(membership: CallerMembership): boolean {
	return isActiveMember(membership);
}

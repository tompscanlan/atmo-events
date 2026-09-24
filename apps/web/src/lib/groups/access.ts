// Who may see what. Pure, so the pages and the loaders ask the same question.
//
// READ IS NOT A PERMISSION (FR-005d, decided 2026-09-19). The community
// standard has no "see" action: who may read a space is the `access` record
// plus the space read policy the host enforces. Iteration 1 emulates that host
// — the members space keeps an empty member list (FR-006a), so the app is its
// only reader — and these two predicates are that policy expressed as
// MEMBERSHIP rather than as a grant a group can withhold. The three `SEE_*`
// names they used to consult were our own invention; legacy gated group reads
// with a visibility guard and no read route carried such a decorator.
//
// Two kinds of data, two rules:
//
//   APP-OWNED data (the roster) is only ever visible to a member. It lives in
//   D1 and nothing else serves it, so the gate is real.
//
//   PROTOCOL-PUBLIC data (events in the group DID's public repo) is served
//   anonymously by the PDS to anyone who knows the DID. The app gates the PAGE
//   for a private group, but must not pretend that hides the records: v1
//   writes only the public slice, so a private group's events are NOT private
//   at the protocol layer. The members-only slice is the space, and that lands
//   with the space integration, not here. This is the loudest narrowing in the
//   groups v1 model.
import type { CallerMembership, GroupRow } from './types';

/** On the roster, as the loader decided it: the caller's membership RECORD
 *  when the group's records can answer, the row only when they cannot
 *  (`getCallerMembership`, FR-005d). Asking `role` here instead would let a
 *  revocation whose row delete failed keep a private group open to the DID it
 *  removed. */
function isActiveMember(membership: CallerMembership): boolean {
	return membership.onRoster;
}

/** A private group is invisible to anyone off its roster; a public one is
 *  visible to everyone. There is no third value and no secret address to trade
 *  on: the group's DID and its handle are published to plc.directory's audit
 *  log at genesis, so both are enumerable by anyone willing to read that log,
 *  which is exactly why the gate has to be membership and cannot rest on
 *  nobody knowing where the group lives. This is the same rule `listGroups`
 *  applies when it hydrates a declared row, so browse cannot name a group its
 *  page would refuse. */
export function canSeeGroup(group: GroupRow, membership: CallerMembership): boolean {
	if (group.visibility !== 'private') return true;
	return isActiveMember(membership);
}

/** The roster is app data, and members-only at EVERY visibility including
 *  public — there is no visibility branch here on purpose (FR-016b). */
export function canSeeMembers(membership: CallerMembership): boolean {
	return isActiveMember(membership);
}

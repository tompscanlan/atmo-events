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

/** On the roster and not suspended. Suspension keeps the row and removes the
 *  access, which is the whole of what suspending a member means. */
function isActiveMember(membership: CallerMembership): boolean {
	return membership.role !== null && membership.status === 'active';
}

/** A private group is invisible to anyone off its roster — including the
 *  existence of the slug. Unlisted is reachable by URL but never listed. This
 *  is now exactly the rule `listGroups` applies (`server/repo.ts:242`), so the
 *  browse query and the page predicate no longer diverge. */
export function canSeeGroup(group: GroupRow, membership: CallerMembership): boolean {
	if (group.visibility !== 'private') return true;
	return isActiveMember(membership);
}

/** The roster is app data, and members-only at EVERY visibility including
 *  public — there is no visibility branch here on purpose (FR-016b). */
export function canSeeMembers(membership: CallerMembership): boolean {
	return isActiveMember(membership);
}

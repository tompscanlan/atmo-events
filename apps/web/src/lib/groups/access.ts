// Who may see what. Pure, so the pages and the loaders ask the same question.
//
// Two kinds of data, two rules:
//
//   APP-OWNED data (the roster) is only ever visible to a member whose role
//   grants SEE_MEMBERS. It lives in D1 and nothing else serves it, so the gate
//   is real.
//
//   PROTOCOL-PUBLIC data (events in the group DID's public repo) is served
//   anonymously by the PDS to anyone who knows the DID. The app gates the PAGE
//   for a private group, but must not pretend that hides the records: v1 writes
//   only the public slice, so a private group's events are NOT private at the
//   protocol layer. The members-only slice is the space, and that lands with
//   the space integration, not here. This is the loudest narrowing in the
//   groups v1 model.
import { can } from './permissions';
import type { CallerMembership, GroupRow } from './types';

/** A private group is invisible to anyone off its roster — including the
 *  existence of the slug. Unlisted is reachable by URL but never listed. */
export function canSeeGroup(group: GroupRow, membership: CallerMembership): boolean {
	if (group.visibility !== 'private') return true;
	return can(membership.permissions, 'SEE_GROUP');
}

/** The roster is app data: membership + SEE_MEMBERS, always. Legacy did the
 *  same, which is why `guest` (CONTACT_ADMINS only) cannot see it either. */
export function canSeeMembers(membership: CallerMembership): boolean {
	return can(membership.permissions, 'SEE_MEMBERS');
}

/** Public/unlisted groups: the public slice is anonymously readable at the PDS,
 *  so the page is too. Private groups: SEE_EVENTS. */
export function canSeeGroupEvents(group: GroupRow, membership: CallerMembership): boolean {
	if (group.visibility !== 'private') return true;
	return can(membership.permissions, 'SEE_EVENTS');
}

// A PDS hands an `include:` back expanded and drops each parameter left at its default:
// no `action` is all four, no `authority` the signer's own repo, never a group's, and no
// `collection` allows reads only, which are collection-independent.
import { GROUP_RSVP_COLLECTION } from '../ids';
import { GROUP_ACCEPTANCE_COLLECTION } from '../members-record';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

export type SpaceAction = 'read' | 'create' | 'update' | 'delete';

const DEFAULT_ACTIONS: readonly string[] = ['read', 'create', 'update', 'delete'];

function spaceGrants(scope: string, spaceType: string, groupDid: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${spaceType}?`) || token.startsWith('space:*?'))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => params.get('authority') === '*' || params.get('authority') === groupDid);
}

function actionsOf(params: URLSearchParams): readonly string[] {
	const actions = params.getAll('action');
	return actions.length > 0 ? actions : DEFAULT_ACTIONS;
}

function readsSpace(scope: string, spaceType: string, groupDid: string): boolean {
	return spaceGrants(scope, spaceType, groupDid).some((params) =>
		actionsOf(params).includes('read')
	);
}

function holdsCollectionGrant(
	scope: string,
	spaceType: string,
	groupDid: string,
	collection: string,
	action: SpaceAction
): boolean {
	return spaceGrants(scope, spaceType, groupDid).some((params) => {
		const collections = params.getAll('collection');
		return (
			actionsOf(params).includes(action) &&
			(action === 'read' || collections.includes('*') || collections.includes(collection))
		);
	});
}

/** A stock PDS drops a space grant it does not know, so this also means spaces support. */
export function holdsMetaRead(scope: string): boolean {
	return readsSpace(scope, ABOUT_SPACE_TYPE, '*');
}

export function readsMembersSpace(scope: string, groupDid: string): boolean {
	return readsSpace(scope, MEMBERS_SPACE_TYPE, groupDid);
}

export function readsCalendarSpace(scope: string, groupDid: string): boolean {
	return readsSpace(scope, CALENDAR_SPACE_TYPE, groupDid);
}

/** Sign-in's grant for a member's RSVPs to members-only events, in any group. */
export function holdsRsvpGrant(scope: string, groupDid: string, action: SpaceAction): boolean {
	return holdsCollectionGrant(scope, CALENDAR_SPACE_TYPE, groupDid, GROUP_RSVP_COLLECTION, action);
}

/** The `participate` set's grant for the member's own acceptance, in any group. */
export function holdsAcceptanceGrant(
	scope: string,
	groupDid: string,
	action: 'create' | 'delete'
): boolean {
	return holdsCollectionGrant(
		scope,
		MEMBERS_SPACE_TYPE,
		groupDid,
		GROUP_ACCEPTANCE_COLLECTION,
		action
	);
}

// A PDS hands an `include:` back expanded and drops each parameter left at its default:
// no `action` is all four, no `authority` the signer's own repo, never a group's.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

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

/** A stock PDS drops a space grant it does not know, so this also means spaces support. */
export function holdsMetaRead(scope: string): boolean {
	return readsSpace(scope, ABOUT_SPACE_TYPE, '*');
}

export function readsMembersSpace(scope: string, groupDid: string): boolean {
	return readsSpace(scope, MEMBERS_SPACE_TYPE, groupDid);
}

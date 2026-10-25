// Read by parameter: a PDS hands an `include:` back expanded, in its own order.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

function readsSpace(scope: string, spaceType: string, groupDid: string): boolean {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${spaceType}?`) || token.startsWith('space:*?'))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.some(
			(params) =>
				(params.get('authority') === '*' || params.get('authority') === groupDid) &&
				params.getAll('action').includes('read')
		);
}

/** A stock PDS drops a space grant it does not know, so this also means spaces support. */
export function holdsMetaRead(scope: string): boolean {
	return readsSpace(scope, ABOUT_SPACE_TYPE, '*');
}

export function readsMembersSpace(scope: string, groupDid: string): boolean {
	return readsSpace(scope, MEMBERS_SPACE_TYPE, groupDid);
}

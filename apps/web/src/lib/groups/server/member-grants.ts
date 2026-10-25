// What a person's own sign-in lets them read of a group's spaces. Read by parameter,
// since a PDS hands an `include:` back expanded, its parameters in its own order.
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

/** A stock PDS drops a space grant it does not know, so no meta read also means the
 *  holder's PDS serves no spaces. */
export function holdsMetaRead(scope: string): boolean {
	return readsSpace(scope, ABOUT_SPACE_TYPE, '*');
}

/** Without it, the holder's own PDS refuses them the members space before the host is asked. */
export function readsMembersSpace(scope: string, groupDid: string): boolean {
	return readsSpace(scope, MEMBERS_SPACE_TYPE, groupDid);
}

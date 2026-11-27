// The permissions groups need: a session signed in as a group, read from the scope its group host
// granted it. The host narrows what this site asks for to what the approving person's roles allow,
// and gives back a concrete scope (`authority=self` becomes the group's DID), so the granted scope,
// not the asked one, says which controls a page offers. The host checks the person's roles again
// at each write, so a role taken away since the approval is still refused then. Values and pure
// checks only, so the OAuth config, pages and tests can import them.
import { GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION, META_SPACE_TYPE } from './ids';

const META_SELF = `space:${META_SPACE_TYPE}?authority=self&skey=self`;

/** A group session's read of the group's meta space, its own scope so that a member whose roles
 *  grant no writes keeps it. It names the space's key, which is always `self`: the host's approval
 *  page shows one row per space type, owner and key, and two rows for the one space, one with the
 *  key and one without, break it. */
export const GROUP_META_READ_SCOPE = `${META_SELF}&action=read`;

const RECORD_WRITES = ['create', 'update', 'delete'] as const;

/** `repo:<collection>` or `repo?collection=…`, with the actions it names: all, when it names none. */
function repoGrants(scope: string): { collections: string[]; actions: string[] }[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith('repo:') || token.startsWith('repo?'))
		.map((token) => {
			const at = token.indexOf('?');
			const resource = token.slice('repo'.length, at === -1 ? undefined : at);
			const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
			const collections = resource.startsWith(':')
				? [decodeURIComponent(resource.slice(1))]
				: params.getAll('collection');
			return { collections, actions: params.getAll('action') };
		});
}

/** Whether `scope` lets a session make, change and delete records of `collection` in its repo. */
export function grantsRepoWrites(scope: string, collection: string): boolean {
	const grants = repoGrants(scope).filter(
		(grant) => grant.collections.includes('*') || grant.collections.includes(collection)
	);
	return RECORD_WRITES.every((action) =>
		grants.some((grant) => grant.actions.length === 0 || grant.actions.includes(action))
	);
}

/** What the page offers someone who linked the group. */
export interface GroupAbilities {
	/** Post, edit and delete the group's public events. */
	post: boolean;
	/** Add the group to the groups list, or take it off. */
	list: boolean;
}

export function groupAbilities(scope: string): GroupAbilities {
	return {
		post: grantsRepoWrites(scope, GROUP_EVENT_COLLECTION),
		list: grantsRepoWrites(scope, GROUP_DECLARATION_COLLECTION)
	};
}

/** Whether a link holds every ability this site offers. */
export function holdsEveryAbility(can: GroupAbilities): boolean {
	return Object.values(can).every((held) => held);
}

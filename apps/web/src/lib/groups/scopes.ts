// The permissions groups need: the person's own sign-in, to make a group, and a session signed in
// as a group, read from the scope its group host granted it. The host narrows what this site asks
// for to what the approving person's roles allow, and gives back a concrete scope (`authority=self`
// becomes the group's DID), so the granted scope, not the asked one, says which controls a page
// offers. The host checks the person's roles again at each write, so a role taken away since the
// approval is still refused then. Values and pure checks only, so the OAuth config, pages and tests
// can import them.
import { GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION } from './ids';

/** The group host's own method for making a group, not the spec's (bluesky-social/group-host's
 *  `org.atgrp.internal.createGroup`). The spec's way is OAuth `prompt=create` at the host, which
 *  this host does not take. */
export const CREATE_GROUP_NSID = 'org.atgrp.internal.createGroup';

/** The person's own permission to have their PDS vouch for them to the group host when they make a
 *  group. Any audience: the host's DID is learned from the host when the group is made, so the
 *  client metadata names no deployment's host. */
export const CREATE_GROUP_SCOPE = `rpc:${CREATE_GROUP_NSID}?aud=*`;

/** Declared in the person's client metadata while groups are on; asked for only when they set out
 *  to make a group, never at sign-in. */
export const GROUP_PERSON_SCOPES: readonly string[] = [CREATE_GROUP_SCOPE];

/** Whether the person's granted scope lets their PDS vouch for them to make a group: an rpc grant
 *  for the method, written `rpc:<method>` or `rpc?lxm=<method>`, for any audience. */
export function holdsCreateGroup(scope: string): boolean {
	return scope.split(' ').some((token) => {
		if (!token.startsWith('rpc:') && !token.startsWith('rpc?')) return false;
		const at = token.indexOf('?');
		const resource = token.slice('rpc'.length, at === -1 ? undefined : at);
		const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
		const methods = resource.startsWith(':')
			? [decodeURIComponent(resource.slice(1))]
			: params.getAll('lxm');
		return methods.includes(CREATE_GROUP_NSID) && params.getAll('aud').length > 0;
	});
}

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

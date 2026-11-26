// The permissions groups need: the person's own sign-in, to make a group, and a session signed in
// as a group, read from the scope its group host granted it. The host narrows what this site asks
// for to what the approving person's roles allow, and gives back a concrete scope (`authority=self`
// becomes the group's DID), so the granted scope, not the asked one, says which controls a page
// offers. The host checks the person's roles again at each write, so a role taken away since the
// approval is still refused then. Values and pure checks only, so the OAuth config, pages and tests
// can import them.
import {
	GROUP_ABOUT_COLLECTION,
	GROUP_CONFIG_COLLECTION,
	GROUP_DECLARATION_COLLECTION,
	GROUP_EVENT_COLLECTION,
	META_SPACE_TYPE
} from './ids';

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

const META_SELF = `space:${META_SPACE_TYPE}?authority=self&skey=self`;
const META_RECORD_WRITES = 'action=read&action=create&action=update';

/** What a group's settings write as the group, each its own scope, since its host keeps or drops
 *  each whole: the about record, the config (who may join), and the meta space's policy, which says
 *  whether it is public. Only what the settings write: not the spec's `authManageAdmin` set, which
 *  also covers the members space, invites and moderation. */
export const GROUP_SETTINGS_SCOPES: readonly string[] = [
	`${META_SELF}&collection=${GROUP_ABOUT_COLLECTION}&${META_RECORD_WRITES}`,
	`${META_SELF}&collection=${GROUP_CONFIG_COLLECTION}&${META_RECORD_WRITES}`,
	`${META_SELF}&manage=update`
];

/** The meta-space grants in a granted scope, for the group's own meta space: the host gives back
 *  `authority=self` as the group's DID. */
function metaGrants(scope: string, groupDid: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${META_SPACE_TYPE}?`))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => {
			const authority = params.get('authority') ?? 'self';
			const skey = params.get('skey') ?? '*';
			return [groupDid, 'self', '*'].includes(authority) && ['self', '*'].includes(skey);
		});
}

function writesMetaRecord(grants: URLSearchParams[], collection: string): boolean {
	return grants.some((grant) => {
		const collections = grant.getAll('collection');
		const actions = grant.getAll('action');
		return (
			(collections.includes('*') || collections.includes(collection)) &&
			['create', 'update'].every((action) => actions.includes(action))
		);
	});
}

/** Whether the granted scope lets the session change the group's settings: its about record and
 *  config, and the meta space's policy. */
export function grantsSettings(scope: string, groupDid: string): boolean {
	const grants = metaGrants(scope, groupDid);
	return (
		writesMetaRecord(grants, GROUP_ABOUT_COLLECTION) &&
		writesMetaRecord(grants, GROUP_CONFIG_COLLECTION) &&
		grants.some((grant) => grant.getAll('manage').includes('update'))
	);
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
	/** Change its name, description, website, who may join and whether it is public. */
	settings: boolean;
}

export function groupAbilities(scope: string, groupDid: string): GroupAbilities {
	const list = grantsRepoWrites(scope, GROUP_DECLARATION_COLLECTION);
	return {
		post: grantsRepoWrites(scope, GROUP_EVENT_COLLECTION),
		list,
		// Making a group public or private moves its listing too.
		settings: list && grantsSettings(scope, groupDid)
	};
}

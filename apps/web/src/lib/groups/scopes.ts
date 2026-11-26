// The permissions groups need: the person's own sign-in, to make a group and to join one, and a
// session signed in as a group, read from the scope its group host granted it. The host narrows
// what this site asks for to what the approving person's roles allow, and gives back a concrete
// scope (`authority=self` becomes the group's DID), so the granted scope, not the asked one, says
// which controls a page offers. The host checks the person's roles again at each write, so a role taken away since the
// approval is still refused then. Values and pure checks only, so the OAuth config, pages and tests
// can import them.
import {
	GROUP_ABOUT_COLLECTION,
	GROUP_CONFIG_COLLECTION,
	GROUP_CONFIRMATION_COLLECTION,
	GROUP_DECLARATION_COLLECTION,
	GROUP_EVENT_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	MEMBERS_SPACE_TYPE,
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

/** The spec's methods for a person's own membership, each by their service auth for the host. */
export const REQUEST_JOIN_NSID = 'org.atgrp.requestJoin';
export const CANCEL_JOIN_REQUEST_NSID = 'org.atgrp.cancelJoinRequest';
export const LEAVE_GROUP_NSID = 'org.atgrp.leaveGroup';

/** The group host's own method listing the groups a person is in, not the spec's, which has none
 *  (bluesky-social/group-host's `org.atgrp.internal.getActorGroups`). */
export const ACTOR_GROUPS_NSID = 'org.atgrp.internal.getActorGroups';

/** The spec's permission set for a person's own sessions: read any group's meta space, write their
 *  own confirmation in a group's members space, and join, cancel a request and leave. */
export const PARTICIPATE_SCOPE = 'include:org.atgrp.authParticipate';

/** "Your groups", by the host's own method, which the spec's set does not name. Any audience, as
 *  for making a group. */
export const YOUR_GROUPS_SCOPE = `rpc:${ACTOR_GROUPS_NSID}?aud=*`;

/** What a person is asked for at their first group action: joining, or seeing their groups. */
export const PARTICIPATE_SCOPES: readonly string[] = [PARTICIPATE_SCOPE, YOUR_GROUPS_SCOPE];

/** Declared in the person's client metadata while groups are on; each asked for only when they set
 *  out to make a group, or first act in one, never at sign-in. */
export const GROUP_PERSON_SCOPES: readonly string[] = [CREATE_GROUP_SCOPE, ...PARTICIPATE_SCOPES];

/** Whether the person's granted scope lets their PDS vouch for them to call `nsid`: an rpc grant
 *  for the method, written `rpc:<method>` or `rpc?lxm=<method>`, for any audience. */
export function holdsRpc(scope: string, nsid: string): boolean {
	return scope.split(' ').some((token) => {
		if (!token.startsWith('rpc:') && !token.startsWith('rpc?')) return false;
		const at = token.indexOf('?');
		const resource = token.slice('rpc'.length, at === -1 ? undefined : at);
		const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
		const methods = resource.startsWith(':')
			? [decodeURIComponent(resource.slice(1))]
			: params.getAll('lxm');
		return methods.includes(nsid) && params.getAll('aud').length > 0;
	});
}

export function holdsCreateGroup(scope: string): boolean {
	return holdsRpc(scope, CREATE_GROUP_NSID);
}

// A PDS hands an `include:` back expanded, and drops each parameter left at its default: no
// `action` is all four, no `skey` any key, and no `authority` the signer's own, never a group's.
const DEFAULT_ACTIONS: readonly string[] = ['read', 'create', 'update', 'delete'];

/** A person's grants in a space type: those for any group, or also for `groupDid` when given. */
function personSpaceGrants(scope: string, spaceType: string, groupDid?: string) {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${spaceType}?`) || token.startsWith('space:*?'))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => {
			const authority = params.get('authority');
			const skey = params.get('skey') ?? '*';
			return (
				(authority === '*' || (groupDid !== undefined && authority === groupDid)) &&
				['self', '*'].includes(skey)
			);
		});
}

function actionsOf(params: URLSearchParams): readonly string[] {
	const actions = params.getAll('action');
	return actions.length > 0 ? actions : DEFAULT_ACTIONS;
}

/** Any group's meta space. A PDS without spaces drops a space grant it does not know, so this also
 *  says the person's PDS has spaces. */
export function holdsMetaRead(scope: string): boolean {
	return personSpaceGrants(scope, META_SPACE_TYPE).some((p) => actionsOf(p).includes('read'));
}

/** The person's own confirmation in a group's members space, in any group's when `groupDid` is
 *  left out. */
export function holdsConfirmationGrant(
	scope: string,
	action: 'create' | 'delete',
	groupDid?: string
): boolean {
	return personSpaceGrants(scope, MEMBERS_SPACE_TYPE, groupDid).some((p) => {
		const collections = p.getAll('collection');
		return (
			actionsOf(p).includes(action) &&
			(collections.includes('*') || collections.includes(GROUP_CONFIRMATION_COLLECTION))
		);
	});
}

/** Whether the person's sign-in holds all a group page asks of it: the participate set, as their
 *  PDS expanded it, and "your groups". */
export function holdsParticipate(scope: string): boolean {
	return (
		holdsMetaRead(scope) &&
		holdsConfirmationGrant(scope, 'create') &&
		holdsConfirmationGrant(scope, 'delete') &&
		[REQUEST_JOIN_NSID, CANCEL_JOIN_REQUEST_NSID, LEAVE_GROUP_NSID, ACTOR_GROUPS_NSID].every(
			(nsid) => holdsRpc(scope, nsid)
		)
	);
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

/** The spec's methods a group session calls for its join requests. */
export const LIST_JOIN_REQUESTS_NSID = 'org.atgrp.listJoinRequests';
export const DENY_JOIN_REQUEST_NSID = 'org.atgrp.denyJoinRequest';

const MEMBERSHIPS_SELF = `space:${MEMBERS_SPACE_TYPE}?authority=self&skey=self&collection=${GROUP_MEMBERSHIP_COLLECTION}&action=read`;

/** What the members page writes and calls as the group, each its own scope, since the host keeps
 *  or drops each whole by what the approving person's roles may do: admit (a membership's create,
 *  with the join requests' two methods), change roles (its update) and remove (its delete). Only
 *  what the page uses: not the spec's `authManageMembers` set, which also covers invites. */
export const ROSTER_SCOPES: readonly string[] = [
	`${MEMBERSHIPS_SELF}&action=create`,
	`${MEMBERSHIPS_SELF}&action=update`,
	`${MEMBERSHIPS_SELF}&action=delete`,
	`rpc:${LIST_JOIN_REQUESTS_NSID}?aud=*`,
	`rpc:${DENY_JOIN_REQUEST_NSID}?aud=*`
];

/** The members-space grants in a granted scope for memberships in the group's own members space,
 *  each as the actions it allows. */
function membershipGrants(scope: string, groupDid: string): (readonly string[])[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${MEMBERS_SPACE_TYPE}?`))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => {
			const authority = params.get('authority') ?? 'self';
			const skey = params.get('skey') ?? '*';
			const collections = params.getAll('collection');
			return (
				[groupDid, 'self', '*'].includes(authority) &&
				['self', '*'].includes(skey) &&
				(collections.includes('*') || collections.includes(GROUP_MEMBERSHIP_COLLECTION))
			);
		})
		.map(actionsOf);
}

export interface RosterAbilities {
	/** Admit or deny those asking to join. */
	admit: boolean;
	/** Make a member an admin, or an admin a member again. */
	assign: boolean;
	/** Put a member out. */
	remove: boolean;
}

export function grantsRoster(scope: string, groupDid: string): RosterAbilities {
	const grants = membershipGrants(scope, groupDid);
	const writes = (action: string) => grants.some((actions) => actions.includes(action));
	return {
		admit:
			writes('create') &&
			holdsRpc(scope, LIST_JOIN_REQUESTS_NSID) &&
			holdsRpc(scope, DENY_JOIN_REQUEST_NSID),
		assign: writes('update'),
		remove: writes('delete')
	};
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
export interface GroupAbilities extends RosterAbilities {
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
		settings: list && grantsSettings(scope, groupDid),
		...grantsRoster(scope, groupDid)
	};
}

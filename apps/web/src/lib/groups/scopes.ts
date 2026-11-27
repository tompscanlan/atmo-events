// The permissions groups need: the person's own sign-in, to join a group, and a session signed in
// as a group, read from the scope its group host granted it. The host narrows what this site asks
// for to what the approving person's roles allow, and gives back a concrete scope (`authority=self`
// becomes the group's DID), so the granted scope, not the asked one, says which controls a page
// offers. The host checks the person's roles again at each write, so a role taken away since the
// approval is still refused then. Values and pure checks only, so the OAuth config, pages and tests
// can import them.
import {
	GROUP_CONFIRMATION_COLLECTION,
	GROUP_EVENT_COLLECTION,
	MEMBERS_SPACE_TYPE,
	META_SPACE_TYPE,
	SPACE_SKEY
} from './ids';

/** The spec's methods for a person's own membership, each by their service auth for the host. */
export const REQUEST_JOIN_NSID = 'org.atgrp.requestJoin';
export const CANCEL_JOIN_REQUEST_NSID = 'org.atgrp.cancelJoinRequest';
export const LEAVE_GROUP_NSID = 'org.atgrp.leaveGroup';

/** The group host's own method listing the groups a person is in, not the spec's, which has none
 *  (bluesky-social/group-host's `org.atgrp.internal.getActorGroups`). */
export const ACTOR_GROUPS_NSID = 'org.atgrp.internal.getActorGroups';

// ---- the person's own permissions, all of them here ----
//
// Each is what the code calls, no more. The spec's `org.atgrp.authParticipate` permission set is
// the wider alternative: as an `include:` it would also grant the person's invite inbox (read, and
// making it), the spec's three moderation methods (submitReport, submitAppeal, querySelfHistory)
// and the confirmation's update. Every rpc grant is for any audience, since a group may live at
// any group host; each call's service auth is still minted for the one host being called, its
// did:web (./server/host-api.ts).

/** Any group's meta space, read with their own access: its name, how it takes members, and whether
 *  it is public. */
export const PERSON_META_SCOPE = `space:${META_SPACE_TYPE}?authority=*&skey=${SPACE_SKEY}&action=read`;

/** Their own confirmation in any group's members space: written when they join, deleted when they
 *  leave; and that space read, for whether they are a member. */
export const PERSON_CONFIRMATION_SCOPE = `space:${MEMBERS_SPACE_TYPE}?authority=*&skey=${SPACE_SKEY}&collection=${GROUP_CONFIRMATION_COLLECTION}&action=read&action=create&action=delete`;

/** The spec's join, cancel a request and leave. */
export const MEMBERSHIP_RPC_SCOPE = `rpc?lxm=${REQUEST_JOIN_NSID}&lxm=${CANCEL_JOIN_REQUEST_NSID}&lxm=${LEAVE_GROUP_NSID}&aud=*`;

/** "Your groups", by the host's own method, which the spec does not have. */
export const YOUR_GROUPS_SCOPE = `rpc:${ACTOR_GROUPS_NSID}?aud=*`;

/** What a person is asked for at their first group action: joining, or seeing their groups. */
export const PARTICIPATE_SCOPES: readonly string[] = [
	PERSON_META_SCOPE,
	PERSON_CONFIRMATION_SCOPE,
	MEMBERSHIP_RPC_SCOPE,
	YOUR_GROUPS_SCOPE
];

/** Declared in the person's client metadata while groups are on; each asked for only when they
 *  first act in a group, never at sign-in. */
export const GROUP_PERSON_SCOPES: readonly string[] = [...PARTICIPATE_SCOPES];

/** Whether the person's granted scope lets their PDS vouch for them to call `nsid`: an rpc grant
 *  for the method, written `rpc:<method>` or `rpc?lxm=<method>`, for `audience` or any audience;
 *  for any audience at all when `audience` is left out. */
export function holdsRpc(scope: string, nsid: string, audience?: string): boolean {
	return scope.split(' ').some((token) => {
		if (!token.startsWith('rpc:') && !token.startsWith('rpc?')) return false;
		const at = token.indexOf('?');
		const resource = token.slice('rpc'.length, at === -1 ? undefined : at);
		const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
		const methods = resource.startsWith(':')
			? [decodeURIComponent(resource.slice(1))]
			: params.getAll('lxm');
		const auds = params.getAll('aud');
		const forAudience =
			audience === undefined
				? auds.length > 0
				: auds.some((aud) => aud === '*' || aud.toLowerCase() === audience.toLowerCase());
		return methods.includes(nsid) && forAudience;
	});
}

// A PDS drops each parameter left at its default, as it hands an `include:` back expanded too: no
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

/** Whether the person's sign-in holds all a group page asks of it: the participate grants as asked,
 *  or the spec's set as a PDS hands it back expanded, with "your groups". */
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
}

export function groupAbilities(scope: string): GroupAbilities {
	return {
		post: grantsRepoWrites(scope, GROUP_EVENT_COLLECTION)
	};
}

/** Whether a link holds every ability this site offers. */
export function holdsEveryAbility(can: GroupAbilities): boolean {
	return Object.values(can).every((held) => held);
}

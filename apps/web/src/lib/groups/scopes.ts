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
	GROUP_SPACE_INDEX_COLLECTION,
	MEMBERS_SPACE_TYPE,
	META_SPACE_TYPE,
	SPACE_SKEY
} from './ids';
import { GUEST_SCOPE, GUEST_SCOPES } from '#lib/private-events/scopes.js';
import { CALENDAR_SPACE_TYPE } from './calendar';
import { CREATE_IN_THIS_BUILD, ROSTER_IN_THIS_BUILD, SETTINGS_IN_THIS_BUILD } from './build';

/** The group host's own method for making a group, not the spec's (bluesky-social/group-host's
 *  `org.atgrp.internal.createGroup`). The spec's way is OAuth `prompt=create` at the host, which
 *  this host does not take. */
export const CREATE_GROUP_NSID = 'org.atgrp.internal.createGroup';

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

/** Their server vouches for them to the group host when they make a group. */
export const CREATE_GROUP_SCOPE = `rpc:${CREATE_GROUP_NSID}?aud=*`;

/** Any group's meta space, read with their own access: its name, how it takes members, and whether
 *  it is public. */
export const PERSON_META_SCOPE = `space:${META_SPACE_TYPE}?authority=*&skey=${SPACE_SKEY}&action=read`;

/** Their own confirmation in any group's members space: written when they join, deleted when they
 *  leave; and that space read, for whether they are a member and who else is. */
export const PERSON_CONFIRMATION_SCOPE = `space:${MEMBERS_SPACE_TYPE}?authority=*&skey=${SPACE_SKEY}&collection=${GROUP_CONFIRMATION_COLLECTION}&action=read&action=create&action=delete`;

/** The spec's join, cancel a request and leave. */
export const MEMBERSHIP_RPC_SCOPE = `rpc?lxm=${REQUEST_JOIN_NSID}&lxm=${CANCEL_JOIN_REQUEST_NSID}&lxm=${LEAVE_GROUP_NSID}&aud=*`;

/** "Your groups", by the host's own method, which the spec does not have. */
export const YOUR_GROUPS_SCOPE = `rpc:${ACTOR_GROUPS_NSID}?aud=*`;

/** What making a group asks for: making it, and the person's groups at the host, by which a group
 *  they made whose answer never came is told from someone else's. */
export const CREATE_SCOPES: readonly string[] = [CREATE_GROUP_SCOPE, YOUR_GROUPS_SCOPE];

/** What a person is asked for at their first group action: joining, or seeing their groups. */
export const PARTICIPATE_SCOPES: readonly string[] = [
	PERSON_META_SCOPE,
	PERSON_CONFIRMATION_SCOPE,
	MEMBERSHIP_RPC_SCOPE,
	YOUR_GROUPS_SCOPE
];

/** A member reads the group's members-only events, and RSVPs to them in their own repo in its
 *  calendar space, with private events' guest scope: the calendar space has their type. */
export const MEMBERS_ONLY_PERSON_SCOPES: readonly string[] = GUEST_SCOPES;

/** What joining a group asks for: the participate grants, and what seeing the group's members-only
 *  events takes. */
export const JOIN_SCOPES: readonly string[] = [
	...PARTICIPATE_SCOPES,
	...MEMBERS_ONLY_PERSON_SCOPES
];

/** Declared in the person's client metadata while groups are on; each asked for only when they set
 *  out to make a group, or first act in one, never at sign-in. Making a group is declared only in a
 *  build that has the create page (./build.ts). */
export function groupPersonScopes(create: boolean): readonly string[] {
	return [...(create ? [CREATE_GROUP_SCOPE] : []), ...PARTICIPATE_SCOPES, GUEST_SCOPE];
}

export const GROUP_PERSON_SCOPES: readonly string[] = groupPersonScopes(CREATE_IN_THIS_BUILD);

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

/** For the group host at `audience`: a grant for another audience is not one this site can use, so
 *  the person is asked again. */
export function holdsCreateGroup(scope: string, audience: string): boolean {
	return holdsRpc(scope, CREATE_GROUP_NSID, audience);
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
/** No `create`: the host makes a group's about record and config with the group, keeps them, and
 *  takes a put of a record that is there as its update. */
const META_RECORD_WRITES = 'action=read&action=update';

/** A group session's read of the group's meta space, its own scope so that a member whose roles
 *  grant no writes keeps it. It names the space's key, which is always `self`, as the settings'
 *  writes do: the host's approval page shows one row per space type, owner and key, and two rows
 *  for the one space, one with the key and one without, break it. */
export const GROUP_META_READ_SCOPE = `${META_SELF}&action=read`;

/** A write of the meta space's policy, which says whether the group is public: one of the
 *  settings' scopes, and alone what setting up a group made here needs, to make it public. */
export const GROUP_POLICY_SCOPE = `${META_SELF}&manage=update`;

/** What a group's settings write as the group, each its own scope, since its host keeps or drops
 *  each whole: the about record, the config (who may join), and the meta space's policy, which says
 *  whether it is public. Only what the settings write: not the spec's `authManageAdmin` set, which
 *  also covers the members space, invites and moderation. */
export const GROUP_SETTINGS_SCOPES: readonly string[] = [
	`${META_SELF}&collection=${GROUP_ABOUT_COLLECTION}&${META_RECORD_WRITES}`,
	`${META_SELF}&collection=${GROUP_CONFIG_COLLECTION}&${META_RECORD_WRITES}`,
	GROUP_POLICY_SCOPE
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
			(collections.includes('*') || collections.includes(collection)) && actions.includes('update')
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
 *  what the page uses: not the spec's `authManageMembers` set, which also covers invites. Each
 *  also reads memberships, as the group: a role change reads the membership it rewrites that way,
 *  and the group host gives a session a credential for the members space only when its scope
 *  reads it. */
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

/** A read of the group's index of its spaces, the `org.atgrp.space` records in its members space,
 *  for which calendars it already has before turning members-only events on. Read only, and named
 *  to that collection, though a group host gives a credential for the whole space, so the link
 *  reads the rest of the members space too. Keyed `self`, as every members-space scope here is, for
 *  the host's approval page. The host keeps it for a member whose roles read the members space,
 *  which every member's do, and gives a session a credential for that space only while its scope
 *  reads it. */
export const GROUP_SPACE_INDEX_SCOPE = `space:${MEMBERS_SPACE_TYPE}?authority=self&skey=${SPACE_SKEY}&collection=${GROUP_SPACE_INDEX_COLLECTION}&action=read`;

/** Whether a granted scope reads the group's index of its spaces: a members-space read for the
 *  group, its key, and that collection or every one. */
export function grantsSpaceIndexRead(scope: string, groupDid: string): boolean {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${MEMBERS_SPACE_TYPE}?`))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.some((params) => {
			const authority = params.get('authority') ?? 'self';
			const skey = params.get('skey') ?? '*';
			const collections = params.getAll('collection');
			return (
				[groupDid, 'self', '*'].includes(authority) &&
				[SPACE_SKEY, '*'].includes(skey) &&
				(collections.length === 0 ||
					collections.includes('*') ||
					collections.includes(GROUP_SPACE_INDEX_COLLECTION)) &&
				actionsOf(params).includes('read')
			);
		});
}

/** The group's calendar spaces at any key: the one used may be one another app made, under a key
 *  of its own, and a client's metadata names its scopes once for every group. Both name no key, so
 *  every scope for the type names the same one, as the host's approval page needs. */
const CALENDAR_ANY_KEY = `space:${CALENDAR_SPACE_TYPE}?authority=self`;

/** Making the group's calendar space, and its events there, read, written and deleted as the group;
 *  and reading which calendar spaces the group has, before making one.
 *  Its own type only, not every space (`space:*`). The host keeps the second only while one of the
 *  group's calendar spaces is there at the approval whose own policy lets the approving person's
 *  roles post events, so a link approved before there was one is approved once more after; each
 *  write is still checked against the policy of the space it goes to. */
export const MEMBERS_ONLY_SCOPES: readonly string[] = [
	`${CALENDAR_ANY_KEY}&manage=create`,
	`${CALENDAR_ANY_KEY}&collection=${GROUP_EVENT_COLLECTION}&action=read&action=create&action=update&action=delete`,
	GROUP_SPACE_INDEX_SCOPE
];

/** The calendar-space grants in a granted scope, for the group's own calendar space. */
function calendarGrants(scope: string, groupDid: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${CALENDAR_SPACE_TYPE}?`))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => {
			const authority = params.get('authority') ?? 'self';
			const skey = params.get('skey') ?? '*';
			return [groupDid, 'self', '*'].includes(authority) && ['self', '*'].includes(skey);
		});
}

export interface MembersOnlyAbilities {
	/** Make the group's calendar space, which turns members-only events on. */
	turnOnMembersOnly: boolean;
	/** Read, post, edit and delete the group's members-only events. */
	membersOnly: boolean;
	/** Read which calendars the group already has, before turning them on. */
	readSpaceIndex: boolean;
}

export function grantsMembersOnly(scope: string, groupDid: string): MembersOnlyAbilities {
	const grants = calendarGrants(scope, groupDid);
	return {
		turnOnMembersOnly: grants.some((grant) => grant.getAll('manage').includes('create')),
		membersOnly: grants.some((grant) => {
			const collections = grant.getAll('collection');
			return (
				(collections.includes('*') || collections.includes(GROUP_EVENT_COLLECTION)) &&
				DEFAULT_ACTIONS.every((action) => actionsOf(grant).includes(action))
			);
		}),
		readSpaceIndex: grantsSpaceIndexRead(scope, groupDid)
	};
}

/** What the page offers someone who linked the group. */
export interface GroupAbilities extends RosterAbilities, MembersOnlyAbilities {
	/** Post, edit and delete the group's public events. */
	post: boolean;
	/** Add the group to the groups list, or take it off. */
	list: boolean;
	/** Change its name, description, website, who may join and whether it is public. */
	settings: boolean;
}

const NO_ROSTER: RosterAbilities = { admit: false, assign: false, remove: false };

/** `roster` and `settings`: whether the members page and the settings page are in this build;
 *  without one a link holds none of its acts, whatever its scope grants. */
export function groupAbilities(
	scope: string,
	groupDid: string,
	roster: boolean = ROSTER_IN_THIS_BUILD,
	settings: boolean = SETTINGS_IN_THIS_BUILD
): GroupAbilities {
	const list = grantsRepoWrites(scope, GROUP_DECLARATION_COLLECTION);
	return {
		post: grantsRepoWrites(scope, GROUP_EVENT_COLLECTION),
		list,
		// Making a group public or private moves its listing too.
		settings: settings && list && grantsSettings(scope, groupDid),
		...(roster ? grantsRoster(scope, groupDid) : NO_ROSTER),
		...grantsMembersOnly(scope, groupDid)
	};
}

/** Whether a link holds every ability this build offers: the roster's count only while the
 *  members page is in it, and the settings only while the settings page is, so a link is never
 *  asked to be approved again for what nothing uses. */
export function holdsEveryAbility(
	can: GroupAbilities,
	roster: boolean = ROSTER_IN_THIS_BUILD,
	settings: boolean = SETTINGS_IN_THIS_BUILD
): boolean {
	return Object.entries(can).every(
		([ability, held]) =>
			held ||
			(!roster && Object.hasOwn(NO_ROSTER, ability)) ||
			(!settings && ability === 'settings')
	);
}

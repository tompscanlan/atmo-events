// Space provisioning, and the one change a space's configuration gets later.
//
// A group's control plane (profile, rules, roles, membership, access) lives in
// the standard's places rather than in our database columns, so a group is
// portable and another app can read it. That place is a space: an owner-scoped,
// policy-gated container on the owner's own PDS. This module creates the two
// spaces a group needs, at create time, under the group's DID. Two, because the
// read policies differ and a space has exactly one:
//
//   about    by visibility      the group's face (profile, rules): public read
//                               for a public group, member-list read for a
//                               private one
//   members  member-list read   roles, membership, access, whatever the
//                               visibility
//
// The about space's read policy is how the host, rather than our pages, keeps a
// private group's face from strangers. So it follows the group's visibility at
// create, and a settings save that changes the visibility moves it with
// `updateSpace` (`setAboutSpaceReadPolicy`). The owner is exempt from its own
// read policy, and the app reads as the group, so what the app renders does not
// change with it.
//
// It is also where the app reads a group's visibility back from
// (`readGroupVisibility`, with `getSpace`). The page gate, the group page, the
// join refusal, the settings save and Repair all ask the host, because the host
// is what every other app is held to. The row holds no copy.
//
// The write policy is member-list on both. The vocabulary
// (com.atproto.simplespace.defs) has no "only the owner" policy, and none is
// needed: the write policy governs whether other users' writes are tracked and
// forwarded, the owner always writes as the owner, and nothing member-authored
// is written yet. Both member lists start empty. The about space's list then
// mirrors the roster (./member-list.ts): the create lists the owner, and every
// later entry and exit follows, so under member-list read a member reads the
// group's face with their own credential. The members space's list stays empty
// for good (./members-writer.ts says why). Either way the app reads these
// spaces back as the group, the owner, whom no list governs. A
// managingAppPolicy would need a managing-app DID and a checkUserAccess
// endpoint. App access is `open`: an allowList of client ids would decide which
// other apps may read a group, and `open` leaves that decision to later.
import {
	ABOUT_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type GroupRow,
	type GroupVisibility
} from '../types';
import type { GroupSpaceReader } from './about-read';
import { resolveGroupCredential, type GroupCredential } from './credentials';
import { GroupCredentialError, requireGroupPermission, type GroupGateInput } from './event-writer';
import { groupClient } from './session';

const POLICY_PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy';
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open';

/** The read policies this app sets on a space. The third one the vocabulary
 *  has, `managingAppPolicy`, needs a managing-app DID and a checkUserAccess
 *  endpoint, and nothing here uses it. */
export type SpaceReadPolicy = typeof POLICY_PUBLIC | typeof POLICY_MEMBER_LIST;

/** Who may read a group's about space, from its visibility: anyone signed in
 *  for a public group, the space's own member list for a private one.
 *
 *  The create and the settings save both ask this one function, so the policy a
 *  group is provisioned with and the policy a later change moves it to cannot
 *  disagree. Anything but `public` reads as member-list, so a value this
 *  function does not know closes the space rather than opening it. */
export function aboutSpaceReadPolicy(visibility: GroupVisibility): SpaceReadPolicy {
	return visibility === 'public' ? POLICY_PUBLIC : POLICY_MEMBER_LIST;
}

/** The inverse: a group's visibility, from the read policy its about space
 *  reports. `publicPolicy` is public and `memberListPolicy` is private.
 *
 *  Any other policy reads as private too. A `managingAppPolicy`, or a variant
 *  this app has never heard of, was not set by this app, and treating it as
 *  public would open a group on the strength of a value nobody here chose. It
 *  is the same rule `aboutSpaceReadPolicy` applies in the other direction. */
export function visibilityFromReadPolicy(readPolicy: string): GroupVisibility {
	return readPolicy === POLICY_PUBLIC ? 'public' : 'private';
}

/** A group's visibility as its host enforces it: `getSpace` on the about space,
 *  through `visibilityFromReadPolicy`. The only source: the row holds none.
 *
 *  It throws when it cannot ask: a group whose about space was never recorded
 *  (provisioning did not finish), or a host that does not answer. "Could not
 *  ask" must not come back as either visibility, and each caller decides what
 *  a failure means for it. The page gate answers a 503, a save stops before its
 *  first write, and Repair stops before it aligns anything to the host. */
export async function readGroupVisibility(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupVisibility> {
	const space = group.about_space_uri;
	if (!space) {
		throw new GroupSpaceError(
			`${group.group_did} has no about space yet, so its visibility cannot be read from its PDS`,
			ABOUT_SPACE_TYPE
		);
	}
	const { readPolicy } = await reader.getSpace(space);
	return visibilityFromReadPolicy(readPolicy);
}

/** The space key is a constant, `self`, as the proposal's space table gives it
 *  for both `about` and `members`. A space URI is already scoped to the owner
 *  DID and the space type, and a group owns one space of each type, so the key
 *  carries no extra information. Keying it on a name the user chose would make
 *  the URI depend on a string that can change and can collide, and
 *  provisioning would have to wait until that string was proven free. With
 *  `self` the URI is a function of the DID alone, so provisioning can run as
 *  soon as the DID exists. Do not tie it to any user-supplied string. `self` is
 *  also the atproto convention for a singleton (`app.bsky.actor.profile/self`). */
const SPACE_SKEY = 'self';

/** The space host refused to create the space. Distinct from a record error so
 *  a half-provisioned group is not reported as a bad record. */
export class GroupSpaceError extends Error {
	constructor(
		message: string,
		readonly spaceType: string
	) {
		super(message);
		this.name = 'GroupSpaceError';
	}
}

export interface SpaceProvision {
	/** Space type NSID, one of the two constants in ../types. */
	type: string;
	/** Space key, always `SPACE_SKEY`. Part of the shape because `createSpace`
	 *  takes it and the URI derivation needs it, not because it varies. */
	skey: string;
	/** The about space's follows the group's visibility
	 *  (`aboutSpaceReadPolicy`); the members space's is always member-list. */
	readPolicy: SpaceReadPolicy;
}

/** The transport half. Injectable, like `GroupRepoWriter`, so the provisioning
 *  decision and the policy choice can be tested without a live PDS. */
export type GroupSpaceProvisioner = (space: SpaceProvision) => Promise<{ uri: string }>;

/** A space's URI is fully determined by owner + type + skey: the reference PDS
 *  builds it as `new SpaceRef(ownerDid, type, skey)` and does no lookup. So the
 *  URI of an existing space can be computed rather than fetched, which is what
 *  makes provisioning idempotent below. */
export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

/** The real transport: the group's own session, then `createSpace`.
 *
 *  `SpaceAlreadyExists` is treated as success. Otherwise a create flow that
 *  failed after the first space could not be repeated: the group would hold one
 *  space it cannot re-create and one it never got. The URI is deterministic, so
 *  returning it on that error is not a guess. It does not check the existing
 *  space's read policy. That is harmless at create, because the visibility
 *  cannot change between one attempt and its retry. */
export function pdsProvisioner(cred: GroupCredential, groupDid: string): GroupSpaceProvisioner {
	return async (space) => {
		const { handle } = await groupClient(cred, groupDid);
		const res = await handle('/xrpc/com.atproto.simplespace.createSpace', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				type: space.type,
				skey: space.skey,
				readPolicy: { $type: space.readPolicy },
				writePolicy: { $type: POLICY_MEMBER_LIST },
				appAccess: { $type: APP_ACCESS_OPEN }
			})
		});
		const body: unknown = await res.json().catch(() => null);

		if (!res.ok) {
			const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
			if (code === 'SpaceAlreadyExists') {
				return { uri: spaceUri(groupDid, space.type, space.skey) };
			}
			throw new GroupSpaceError(
				`createSpace failed for ${space.type}: ${res.status} ${JSON.stringify(body)}`,
				space.type
			);
		}

		if (!(body && typeof body === 'object' && 'uri' in body && typeof body.uri === 'string')) {
			throw new GroupSpaceError(`createSpace returned no space uri for ${space.type}`, space.type);
		}
		return { uri: body.uri };
	};
}

export interface GroupSpaceUris {
	aboutSpaceUri: string;
	membersSpaceUri: string;
}

/** Both of a group's space URIs, computed from its DID alone, since `self` keys
 *  every space and the types are constants. A cache rebuild uses this to
 *  restore the two space URI columns. */
export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY)
	};
}

/** Creates both spaces for a group. Sequential, not `Promise.all`: they share
 *  one cached session, and if the first call fails the second must not run.
 *
 *  `visibility` is the choice made at create. It sets the about space's read
 *  policy and nothing else: the members space is member-list read for every
 *  group, because it holds the roster. */
export async function provisionGroupSpaces(
	provisioner: GroupSpaceProvisioner,
	visibility: GroupVisibility
): Promise<GroupSpaceUris> {
	const about = await provisioner({
		type: ABOUT_SPACE_TYPE,
		skey: SPACE_SKEY,
		readPolicy: aboutSpaceReadPolicy(visibility)
	});
	const members = await provisioner({
		type: MEMBERS_SPACE_TYPE,
		skey: SPACE_SKEY,
		readPolicy: POLICY_MEMBER_LIST
	});
	return { aboutSpaceUri: about.uri, membersSpaceUri: members.uri };
}

/** A read-policy change on an existing space. Injectable, like the
 *  provisioner. The about space is the only space whose policy ever changes,
 *  so a failure is reported against that space type. */
export type GroupSpaceUpdater = (update: {
	space: string;
	readPolicy: SpaceReadPolicy;
}) => Promise<void>;

/** The real transport: the group's own session, then `updateSpace`.
 *
 *  The body is the space and the read policy and nothing else. The host
 *  replaces only the fields it is sent, so the write policy and the app access
 *  stay as they were provisioned. The group's app password is the space
 *  owner's own credential, which is what `updateSpace` requires; no OAuth scope
 *  is involved. The procedure has no output, so success is the status alone. */
export function pdsSpaceUpdater(cred: GroupCredential, groupDid: string): GroupSpaceUpdater {
	return async ({ space, readPolicy }) => {
		const { handle } = await groupClient(cred, groupDid);
		const res = await handle('/xrpc/com.atproto.simplespace.updateSpace', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ space, readPolicy: { $type: readPolicy } })
		});
		if (!res.ok) {
			const body: unknown = await res.json().catch(() => null);
			throw new GroupSpaceError(
				`updateSpace failed for ${space}: ${res.status} ${JSON.stringify(body)}`,
				ABOUT_SPACE_TYPE
			);
		}
	};
}

export interface SetAboutSpaceReadPolicyInput extends GroupGateInput {
	/** The visibility the group is moving to: the settings form's choice. */
	visibility: GroupVisibility;
	/** Overrides the PDS transport. When absent, it is built from the group's
	 *  stored credential. */
	updater?: GroupSpaceUpdater;
}

/** Moves a group's about space to the read policy `visibility` names
 *  (`aboutSpaceReadPolicy`). The settings save calls this only when the
 *  visibility changed.
 *
 *  It touches the about space only. The members space's policy and its own
 *  member list are not visibility's business: the members space is member-list
 *  read for every group.
 *
 *  Gated like every other write the app makes as a group: MANAGE_GROUP, the
 *  permission for the group's own face. */
export async function setAboutSpaceReadPolicy(input: SetAboutSpaceReadPolicyInput): Promise<void> {
	await requireGroupPermission(input, 'MANAGE_GROUP');
	const space = input.group.about_space_uri;
	if (!space) {
		throw new GroupSpaceError(
			`${input.group.group_did} has no about space yet, so its read policy cannot be changed`,
			ABOUT_SPACE_TYPE
		);
	}
	let updater = input.updater;
	if (!updater) {
		const cred = await resolveGroupCredential(input.env, input.db, input.group.group_did);
		if (!cred) throw new GroupCredentialError(input.group.group_did);
		updater = pdsSpaceUpdater(cred, input.group.group_did);
	}
	await updater({ space, readPolicy: aboutSpaceReadPolicy(input.visibility) });
}

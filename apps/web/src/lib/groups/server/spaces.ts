// Space provisioning.
//
// A group's control plane (profile, rules, roles, membership, access) lives in
// the standard's places rather than in our database columns, so a group is
// portable and another app can read it. That place is a space: an owner-scoped,
// policy-gated container on the owner's own PDS. This module creates the two
// spaces a group needs, at create time, under the group's DID. Two, because the
// read policies differ and a space has exactly one:
//
//   about    public read        the group's public face (profile, rules)
//   members  member-list read   roles, membership, access
//
// The write policy is member-list on both. The vocabulary
// (com.atproto.simplespace.defs) has no "only the owner" policy, and none is
// needed: the write policy governs whether other users' writes are tracked and
// forwarded, the owner always writes as the owner, and nothing member-authored
// is written yet. The space member list also starts empty, so the app reads
// these spaces back as the group. A managingAppPolicy would need a managing-app
// DID and a checkUserAccess endpoint. App access is `open`: an allowList of
// client ids would decide which other apps may read a group, and `open` leaves
// that decision to later.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import type { GroupCredential } from './credentials';
import { groupClient } from './session';

const POLICY_PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy';
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open';

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
	/** `true` for the about space; the members space is member-list read. */
	publicRead: boolean;
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
 *  returning it on that error is not a guess. */
export function pdsProvisioner(cred: GroupCredential, groupDid: string): GroupSpaceProvisioner {
	return async (space) => {
		const { handle } = await groupClient(cred, groupDid);
		const res = await handle('/xrpc/com.atproto.simplespace.createSpace', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				type: space.type,
				skey: space.skey,
				readPolicy: { $type: space.publicRead ? POLICY_PUBLIC : POLICY_MEMBER_LIST },
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
 *  one cached session, and if the first call fails the second must not run. */
export async function provisionGroupSpaces(
	provisioner: GroupSpaceProvisioner
): Promise<GroupSpaceUris> {
	const about = await provisioner({
		type: ABOUT_SPACE_TYPE,
		skey: SPACE_SKEY,
		publicRead: true
	});
	const members = await provisioner({
		type: MEMBERS_SPACE_TYPE,
		skey: SPACE_SKEY,
		publicRead: false
	});
	return { aboutSpaceUri: about.uri, membersSpaceUri: members.uri };
}

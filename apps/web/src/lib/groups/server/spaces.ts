// SPACE PROVISIONING.
//
// A group's control plane — profile, rules, roles, membership, access — belongs
// in the standard's places rather than in our database columns, so that a group
// is portable and another app can read it. The standard's place is a SPACE: an
// owner-scoped, policy-gated container on the owner's own PDS. This module
// creates the two a group needs, at group-create, under the GROUP's DID.
//
// Two spaces, because the read policies differ and a space carries exactly one:
//
//   about    public read        the group's public face (profile, rules)
//   members  member-list read   roles, membership, access — the gated half
//
// WRITE POLICY IS member-list ON BOTH, which is how "only the group writes" is
// expressed today rather than a fourth policy that does not exist. The
// vocabulary is publicPolicy / memberListPolicy / managingAppPolicy
// (com.atproto.simplespace.defs) — there is no "nobody but the owner" variant,
// and there does not need to be: the write policy governs whether OTHER users'
// writes are tracked and forwarded, the owner writes as the owner regardless,
// and nothing member-authored is written yet. Because the space member list
// also starts empty until member acceptance ships, member-list read means the
// app reads these back as the GROUP, which is all that is claimed right now.
// A managingAppPolicy would need a managing-app DID and a checkUserAccess
// endpoint — cost with no behaviour behind it yet.
//
// APP ACCESS IS `open`. The alternative is an allowList of client ids, which is
// a decision about which other apps may read a group; `open` leaves that
// question open instead of answering it by default.
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import type { GroupCredential } from './credentials';
import { groupClient } from './session';

const POLICY_PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy';
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open';

/** THE SPACE KEY IS A CONSTANT, and it is the standard's own: the proposal's
 *  space table gives `self` as the skey for both `about` and `members`. It
 *  briefly held a user-supplied name for the group here "so the URI is legible
 *  in a log", which was a divergence that cost more than legibility — a space
 *  URI is already scoped to the owner DID and the space type, a group owns
 *  exactly one of each, so the skey can only ever take one value per group per
 *  type and carries no disambiguating information. Keying it on anything the
 *  user picked made the URI depend on a mutable, collidable string, which
 *  forced provisioning to run after whatever step proved that string free. With
 *  `self` the URI is a function of the DID alone, so provisioning can run the
 *  moment the DID exists — and NOTHING may re-couple it to a user-supplied
 *  string, whatever that string is called next. `self` is also the atproto
 *  convention for a singleton (`app.bsky.actor.profile/self`). */
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
	/** Space type NSID — one of the two constants in ../types. */
	type: string;
	/** Space key — always `SPACE_SKEY`. Part of the shape because `createSpace`
	 *  takes it and the URI derivation needs it, not because it varies. */
	skey: string;
	/** `true` for the about space; the members space is member-list read. */
	publicRead: boolean;
}

/** The transport half, injectable for the same reason `GroupRepoWriter` is: the
 *  provisioning decision and the policy choice can then be asserted without a
 *  live PDS, and the live probe asserts the same object the unit test does. */
export type GroupSpaceProvisioner = (space: SpaceProvision) => Promise<{ uri: string }>;

/** A space's URI is fully determined by owner + type + skey — the reference PDS
 *  builds it as `new SpaceRef(ownerDid, type, skey)` and does no lookup. So the
 *  URI of an already-existing space can be computed rather than fetched, which
 *  is what makes provisioning idempotent below. */
export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

/** The real transport: the group's own session, then `createSpace`.
 *
 *  `SpaceAlreadyExists` is treated as success. A create flow that failed after
 *  the first space would otherwise be unrepeatable — the group would hold one
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

/** Both of a group's space URIs, computed from its DID alone — what a rebuild
 *  restores in place of the two columns, since `self` keys every space and the
 *  types are constants (Tier 2 in `data-model.md`). */
export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY)
	};
}

/** Creates both spaces for a group. Sequential, not `Promise.all`: they share
 *  one cached session, and the second call's only job on a failed first is to
 *  not happen. */
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

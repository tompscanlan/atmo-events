// A group's two spaces, owned by the group's DID. A space has one read policy,
// so a group needs two:
//
//   about    by visibility      profile and rules: public read for a public
//                               group, member-list read for a private one
//   members  member-list read   roles, membership and access
//
// The about space's read policy is the group's visibility, and the host enforces
// it for every app. The app always acts as the group, the space owner, whom no
// policy governs. So the write policy is member-list on both spaces: the
// vocabulary has no owner-only policy, and none is needed.
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

export type SpaceReadPolicy = typeof POLICY_PUBLIC | typeof POLICY_MEMBER_LIST;

/** The about space's read policy for a visibility. Anything but `public` is
 *  member-list, so an unknown value closes the space rather than opening it. */
export function aboutSpaceReadPolicy(visibility: GroupVisibility): SpaceReadPolicy {
	return visibility === 'public' ? POLICY_PUBLIC : POLICY_MEMBER_LIST;
}

/** The inverse. Any policy but `publicPolicy` reads as private, so a policy this
 *  app did not set never opens a group. */
export function visibilityFromReadPolicy(readPolicy: string): GroupVisibility {
	return readPolicy === POLICY_PUBLIC ? 'public' : 'private';
}

/** A group's visibility as its host enforces it. D1 does not store it. Throws
 *  when it cannot ask, so "could not ask" never reads as either visibility. */
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

/** Every space is keyed `self`, the atproto singleton convention. A group owns
 *  one space of each type, so its space URIs follow from the DID alone. Never key
 *  a space on a user-chosen name, which can change or collide. */
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

/** The host does not serve Spaces. A stock PDS forwards an unknown method to
 *  its appview, which answers 501, or refuses it when it has no appview (400)
 *  or cannot reach it (502). */
export class SpacesUnsupportedError extends GroupSpaceError {
	constructor(spaceType: string, status: number) {
		super(`the group PDS does not support Spaces (createSpace answered ${status})`, spaceType);
		this.name = 'SpacesUnsupportedError';
	}
}

function hostLacksSpaces(status: number, code: unknown, message: unknown): boolean {
	if (status === 501) return code === 'MethodNotImplemented';
	if (status === 502) return code === 'UpstreamFailure';
	return (
		status === 400 &&
		code === 'InvalidRequest' &&
		typeof message === 'string' &&
		message.startsWith('No service configured for')
	);
}

export interface SpaceProvision {
	type: string;
	/** Always `SPACE_SKEY`. */
	skey: string;
	readPolicy: SpaceReadPolicy;
}

/** Injectable, like `GroupRepoWriter`, so provisioning can be tested without a PDS. */
export type GroupSpaceProvisioner = (space: SpaceProvision) => Promise<{ uri: string }>;

/** The PDS builds a space URI from owner, type and skey with no lookup. So an
 *  existing space's URI can be computed, which makes provisioning idempotent. */
export function spaceUri(ownerDid: string, type: string, skey: string): string {
	return `at://${ownerDid}/space/${type}/${skey}`;
}

/** `SpaceAlreadyExists` counts as success, so a create that failed after the
 *  first space can be retried. The existing space's read policy is not checked:
 *  the visibility cannot change between an attempt and its retry. */
export function pdsProvisioner(cred: GroupCredential, groupDid: string): GroupSpaceProvisioner {
	return async (space) => {
		const { handle } = await groupClient(cred, groupDid);
		const res = await handle('/xrpc/com.atproto.simplespace.createSpace', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				spaceType: space.type,
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
			const message =
				body && typeof body === 'object' && 'message' in body ? body.message : undefined;
			if (hostLacksSpaces(res.status, code, message)) {
				throw new SpacesUnsupportedError(space.type, res.status);
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

/** Both space URIs from the DID alone, for a cache rebuild. */
export function groupSpaceUris(groupDid: string): GroupSpaceUris {
	return {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, SPACE_SKEY),
		membersSpaceUri: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY)
	};
}

/** Creates both spaces in sequence: they share one cached session, and the
 *  second must not run if the first fails. `visibility` sets only the about
 *  space's read policy. */
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

/** A read-policy change on an existing space. Injectable, like the provisioner. */
export type GroupSpaceUpdater = (update: {
	space: string;
	readPolicy: SpaceReadPolicy;
}) => Promise<void>;

/** The host replaces only the fields it is sent, so the write policy and app
 *  access stay as provisioned. `updateSpace` needs the space owner's session,
 *  which the group's own session is. */
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
	visibility: GroupVisibility;
	updater?: GroupSpaceUpdater;
}

/** Moves the about space to the read policy for `visibility`, gated on
 *  MANAGE_GROUP. The members space's policy never changes. */
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
		const cred = await resolveGroupCredential(input.env, input.group.group_did);
		if (!cred) throw new GroupCredentialError(input.group.group_did);
		updater = pdsSpaceUpdater(cred, input.group.group_did);
	}
	await updater({ space, readPolicy: aboutSpaceReadPolicy(input.visibility) });
}

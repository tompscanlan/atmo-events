// A group's three spaces, owned by the group's DID. A space has one read policy,
// so a group needs one space per audience:
//
//   about     by visibility      profile and rules: public read for a public
//                                group, member-list read for a private one
//   members   member-list read   roles, membership and access
//   calendar  member-list read   members-only events, whatever the visibility
//
// Each space's `access` record is its policy, and the read policy follows it:
// public exactly when `access.public` is. So the group's visibility is the about
// space's `access.public`, and the host enforces it for every app. atmo writes
// the other two spaces' records not public. (Spec: FR-214.)
//
// No moment may find a space more open than its `access` says. So a change that
// narrows a space moves its read policy first, and one that widens it writes
// `access` first. A new space starts member-list and opens only once its
// `access` says public.
//
// The app always acts as the group, the space owner, whom no policy governs. So
// the write policy is member-list on every space: the vocabulary has no
// owner-only policy, and none is needed.
import {
	ABOUT_SPACE_TYPE,
	CALENDAR_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type GroupRow,
	type GroupVisibility
} from '../types';
import type { GroupAccessFields } from '../members-record';
import { readAboutAccess, type GroupSpaceReader } from './about-read';

import { groupClient, type GroupCredential, standInHostCredential } from './session';
import { describeFailure, xrpc } from './xrpc';

import {
	POLICY_MEMBER_LIST,
	POLICY_PUBLIC,
	SPACE_SKEY,
	spaceUri,
	type GroupSpaceUris
} from '../ids';

import { requireGroupWrite, type GroupGateInput } from './group-write';
import { isHostGroup } from './host-kind';
import { VISIBILITY_WRITE } from '../grants';
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open';

export type SpaceReadPolicy = typeof POLICY_PUBLIC | typeof POLICY_MEMBER_LIST;

/** The about space's read policy for a visibility. Anything but `public` is
 *  member-list, so an unknown value closes the space rather than opening it. */
export function aboutSpaceReadPolicy(visibility: GroupVisibility): SpaceReadPolicy {
	return visibility === 'public' ? POLICY_PUBLIC : POLICY_MEMBER_LIST;
}

/** The read policy a space's `access` record calls for. A missing record, like
 *  any record that does not say public, calls for member-list. */
export function readPolicyFor(access: GroupAccessFields | null): SpaceReadPolicy {
	return access?.public === true ? POLICY_PUBLIC : POLICY_MEMBER_LIST;
}

/** The visibility a read policy enforces. Any policy but `publicPolicy` reads as
 *  private, so a policy this app did not set never opens a group. */
export function visibilityFromReadPolicy(readPolicy: string): GroupVisibility {
	return readPolicy === POLICY_PUBLIC ? 'public' : 'private';
}

/** The visibility an about space's `access` record gives. Missing reads as private. */
export function visibilityFromAccess(access: GroupAccessFields | null): GroupVisibility {
	return access?.public === true ? 'public' : 'private';
}

/** A group's visibility: its about space's `access.public`. D1 does not store it.
 *  Throws when it cannot read the record, so "could not ask" never reads as
 *  either visibility. (Spec: FR-214.) */
export async function readGroupVisibility(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'about_space_uri'>
): Promise<GroupVisibility> {
	if (!group.about_space_uri) {
		throw new GroupSpaceError(
			`${group.group_did} has no about space yet, so its visibility cannot be read from its PDS`,
			ABOUT_SPACE_TYPE
		);
	}
	return visibilityFromAccess(await readAboutAccess(reader, group));
}

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
	/** The space's `access` record, which a real host makes the space with and
	 *  reads its policy from (`group.opensocial.createSpace`). The stand-in
	 *  sets the read policy instead and writes the record after. */
	access?: {
		public?: boolean;
		grants: { role: string; scopes: string[] }[];
	};
}

/** Injectable, like `GroupRepoWriter`, so provisioning can be tested without a PDS. */
export type GroupSpaceProvisioner = (space: SpaceProvision) => Promise<{ uri: string }>;

/** `SpaceAlreadyExists` counts as success, so a create that failed after the
 *  first space can be retried. The existing space's read policy is not checked:
 *  the visibility cannot change between an attempt and its retry. */
export function pdsProvisioner(cred: GroupCredential, groupDid: string): GroupSpaceProvisioner {
	return async (space) => {
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, 'com.atproto.simplespace.createSpace', {
			body: {
				spaceType: space.type,
				skey: space.skey,
				readPolicy: { $type: space.readPolicy },
				writePolicy: { $type: POLICY_MEMBER_LIST },
				appAccess: { $type: APP_ACCESS_OPEN }
			}
		});

		if (!answer.ok) {
			if (answer.error === 'SpaceAlreadyExists') {
				return { uri: spaceUri(groupDid, space.type, space.skey) };
			}
			if (hostLacksSpaces(answer.status, answer.error, answer.message)) {
				throw new SpacesUnsupportedError(space.type, answer.status);
			}
			throw new GroupSpaceError(
				`createSpace failed for ${space.type}: ${describeFailure(answer)}`,
				space.type
			);
		}

		const { uri } = answer.data;
		if (typeof uri !== 'string') {
			throw new GroupSpaceError(`createSpace returned no space uri for ${space.type}`, space.type);
		}
		return { uri };
	};
}

/** Creates the three spaces in sequence: they share one cached session, and a
 *  later one must not run if an earlier one fails. Every space starts
 *  member-list, a public group's about space included: it holds no `access`
 *  record yet, and opens once one says public. */
export async function provisionGroupSpaces(
	provisioner: GroupSpaceProvisioner
): Promise<GroupSpaceUris> {
	const about = await provisioner({
		type: ABOUT_SPACE_TYPE,
		skey: SPACE_SKEY,
		readPolicy: POLICY_MEMBER_LIST
	});
	const members = await provisioner({
		type: MEMBERS_SPACE_TYPE,
		skey: SPACE_SKEY,
		readPolicy: POLICY_MEMBER_LIST
	});
	// Member-list read whatever the visibility, never the about space's policy:
	// for a public group that policy is public, which would let any signed-in
	// account read every members-only event. (Spec: FR-101.)
	const calendar = await provisioner({
		type: CALENDAR_SPACE_TYPE,
		skey: SPACE_SKEY,
		readPolicy: POLICY_MEMBER_LIST
	});
	return {
		aboutSpaceUri: about.uri,
		membersSpaceUri: members.uri,
		calendarSpaceUri: calendar.uri
	};
}

/** A read-policy change on an existing space. Injectable, like the provisioner. */
export type GroupSpaceUpdater = (update: {
	space: string;
	readPolicy: SpaceReadPolicy;
}) => Promise<void>;

/** The space type a space URI names, for an error about it. */
function spaceTypeOf(space: string): string {
	return space.split('/space/')[1]?.split('/')[0] ?? ABOUT_SPACE_TYPE;
}

/** The host replaces only the fields it is sent, so the write policy and app
 *  access stay as provisioned. `updateSpace` needs the space owner's session,
 *  which the group's own session is. */
export function pdsSpaceUpdater(cred: GroupCredential, groupDid: string): GroupSpaceUpdater {
	return async ({ space, readPolicy }) => {
		const { handle } = await groupClient(cred, groupDid);
		const answer = await xrpc(handle, 'com.atproto.simplespace.updateSpace', {
			body: { space, readPolicy: { $type: readPolicy } }
		});
		if (!answer.ok) {
			throw new GroupSpaceError(
				`updateSpace failed for ${space}: ${describeFailure(answer)}`,
				spaceTypeOf(space)
			);
		}
	};
}

/** A group host keeps each space's policy from its `access` record itself, and
 *  refuses `updateSpace` from anyone else, so there is nothing to move. */
const hostKeepsPolicy: GroupSpaceUpdater = async () => {};

/** The updater for a group, unless one is given: through the session the stand-in
 *  host acts on, since a space's read policy follows its `access` record on the
 *  host's side, which a real host keeps itself. */
export async function groupSpaceUpdater(
	input: Pick<GroupGateInput, 'env' | 'group'> & { updater?: GroupSpaceUpdater }
): Promise<GroupSpaceUpdater> {
	if (input.updater) return input.updater;
	if (await isHostGroup(input.env, input.group.group_did)) return hostKeepsPolicy;
	const cred = await standInHostCredential(input.env, input.group);
	return pdsSpaceUpdater(cred, input.group.group_did);
}

export interface SetAboutSpaceReadPolicyInput extends GroupGateInput {
	visibility: GroupVisibility;
	updater?: GroupSpaceUpdater;
}

/** Moves the about space to the read policy for `visibility`, gated on the scope
 *  that writes the about space's `access`, which the policy follows. A caller
 *  narrowing the space calls this before it writes `access`; one widening it,
 *  after. */
export async function setAboutSpaceReadPolicy(input: SetAboutSpaceReadPolicyInput): Promise<void> {
	await requireGroupWrite(input, VISIBILITY_WRITE);
	const space = input.group.about_space_uri;
	if (!space) {
		throw new GroupSpaceError(
			`${input.group.group_did} has no about space yet, so its read policy cannot be changed`,
			ABOUT_SPACE_TYPE
		);
	}
	const updater = await groupSpaceUpdater(input);
	await updater({ space, readPolicy: aboutSpaceReadPolicy(input.visibility) });
}

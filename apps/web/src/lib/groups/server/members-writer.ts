// Writes a group's roster and its event bindings into its members space. Each
// roster intent needs its own grant, so a member who may admit still cannot eject
// or promote. The group host writes the rest of the members space at create.
//
// Nothing here writes a space's member list: the group's host lets a member into
// a space by the roles its `access` record grants, and keeps no list apart from
// the records. (Spec: FR-101b.)
import {
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	groupBindingsRecord,
	groupMembershipRecord,
	membershipRkey
} from '../members-record';
import type { GroupPermission, GroupRoleName } from '../permissions';
import { spaceWrite } from '../grants';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';

import {
	GroupPermissionError,
	GroupRecordError,
	gatedWriter,
	permissionRequired,
	requireGroupWrite,
	requireMembershipWrite,
	type GroupRepoWriter,
	ownSpace
} from './group-write';

import { type CredentialStoreEnv } from './session';

const membersSpace = (group: GroupRow) =>
	ownSpace(group, 'members', group.members_space_uri, 'its roster records cannot be written');

export interface WriteGroupMembersInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

/** Named intents rather than a boolean, because each needs its own permission. */
export type MembershipPut = 'admit' | 'assign' | 'join';
export type MembershipDrop = 'eject' | 'leave';
export type MembershipIntent = MembershipPut | MembershipDrop;

/** Authorized by identity, not by a grant: the caller must be the subject. A
 *  plain member holds no roster grant but may join and leave. `join` does not
 *  apply the join policy here; the group's host does. */
const SELF_SERVICE: readonly MembershipIntent[] = ['join', 'leave'];

/** The gate for one roster intent. `roles` is what the record will hold, and an
 *  exit holds none. A join or a leave must be the caller's own; anything else
 *  the group's host checks against the caller's scopes and `assignable`
 *  (Spec: FR-213). */
async function authorizeMembership(
	input: WriteGroupMembersInput & {
		subject: string;
		intent: MembershipIntent;
		roles?: readonly string[];
	}
): Promise<void> {
	if (SELF_SERVICE.includes(input.intent)) {
		// Name the grant needed to act on somebody else.
		if (!input.callerDid || input.callerDid !== input.subject) {
			throw new GroupPermissionError(
				permissionRequired(input.intent === 'join' ? 'ADMIT_MEMBERS' : 'EJECT_MEMBERS'),
				input.group.group_did
			);
		}
		return;
	}
	await requireMembershipWrite(input, input.roles ?? []);
}

export interface MembershipWriteResult {
	uri: string;
	cid: string;
	rkey: string;
}

/** Puts the `membership` record granting `subject` its roles. A role change
 *  rewrites it in place, so a member keeps one record and one URI. */
export async function putGroupMembership(
	input: WriteGroupMembersInput & {
		subject: string;
		roles: readonly GroupRoleName[];
		intent: MembershipPut;
		createdAt?: string;
	}
): Promise<MembershipWriteResult> {
	// The space first: a group with nowhere to put the record says so, rather than
	// that nobody may write it.
	const space = membersSpace(input.group);
	await authorizeMembership(input);
	if (input.roles.length === 0) {
		// A membership that grants nothing reads as no membership at all.
		throw new GroupRecordError(
			`a membership record for ${input.subject} must grant at least one role`
		);
	}

	const rkey = membershipRkey(input.subject);
	const record = {
		...groupMembershipRecord({
			subject: input.subject,
			roles: input.roles,
			createdAt: input.createdAt
		}),
		$type: GROUP_MEMBERSHIP_COLLECTION
	};

	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey,
		record,
		intent: 'update',
		space
	});
	return { uri: result.uri, cid: result.cid, rkey };
}

/** Deletes the `membership` record, which revokes access. Idempotent: the host
 *  returns `{}` for a missing record, so the D1 delete that follows still runs. */
export async function dropGroupMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipDrop }
): Promise<{ uri: string; rkey: string }> {
	const space = membersSpace(input.group);
	await authorizeMembership(input);
	const rkey = membershipRkey(input.subject);
	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey,
		record: {},
		intent: 'delete',
		space
	});
	return { uri: result.uri, rkey };
}

/**
 * Writes `eventPermissions` alone, for a group whose roles and `permissions` are
 * someone else's: a group host writes those at create, in the proposal's own roles,
 * and this app adds only its event bindings for them. Needs a scope to write
 * `permissions` in the members space. That covers `eventPermissions` too, which no
 * scope names: whoever may write `permissions` may grant any scope at all
 * (`proposal.md:59`). Idempotent: a put.
 */
export async function writeEventPermissions(
	input: WriteGroupMembersInput & {
		bundles: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
		createdAt?: string;
	}
): Promise<{ uri: string; cid: string }> {
	await requireGroupWrite(
		input,
		spaceWrite(MEMBERS_SPACE_TYPE, GROUP_PERMISSIONS_COLLECTION, 'update')
	);
	const writer = await gatedWriter(input);
	const record = groupBindingsRecord({
		altitude: 'modality',
		bundles: input.bundles,
		createdAt: input.createdAt
	});
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_EVENT_PERMISSIONS_COLLECTION,
		rkey: GROUP_PERMISSIONS_RKEY,
		record: { ...record, $type: GROUP_EVENT_PERMISSIONS_COLLECTION },
		intent: 'update',
		space: membersSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

// Writes a group's roster into its members space. The host lets a member into a space
// by the roles its `access` grants, and keeps no member list apart from the records.
import {
	GROUP_MEMBERSHIP_COLLECTION,
	groupMembershipRecord,
	membershipRkey
} from '../members-record';
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	GroupRecordError,
	gatedWriter,
	requireMembershipWrite,
	type GroupRepoWriter,
	ownSpace
} from './group-write';
import type { CredentialStoreEnv } from './session';

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

/** A role change rewrites the record in place, so a member keeps one record and one URI. */
export async function putGroupMembership(
	input: WriteGroupMembersInput & {
		subject: string;
		roles: readonly string[];
		intent: 'admit' | 'assign';
		createdAt?: string;
	}
): Promise<{ uri: string; cid: string; rkey: string }> {
	// The space first: a group with nowhere to put the record says so.
	const space = membersSpace(input.group);
	await requireMembershipWrite(input, input.roles);
	if (input.roles.length === 0) {
		throw new GroupRecordError(
			`a membership record for ${input.subject} must grant at least one role`
		);
	}
	const rkey = membershipRkey(input.subject);
	const writer = await gatedWriter(input);
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey,
		record: {
			...groupMembershipRecord({
				subject: input.subject,
				roles: input.roles,
				createdAt: input.createdAt
			}),
			$type: GROUP_MEMBERSHIP_COLLECTION
		},
		intent: 'update',
		space
	});
	return { uri: result.uri, cid: result.cid, rkey };
}

/** Idempotent: the host answers the same for a missing record, so the row delete still runs. */
export async function dropGroupMembership(
	input: WriteGroupMembersInput & { subject: string; intent: 'eject' }
): Promise<{ uri: string; rkey: string }> {
	const space = membersSpace(input.group);
	await requireMembershipWrite(input, []);
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

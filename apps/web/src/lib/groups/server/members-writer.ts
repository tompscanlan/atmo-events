// Writing a group's ROSTER into its members space.
//
// Same gate, same credential, same transport as the event and about writers —
// `groupWriter` + `requireGroupPermission` from ./event-writer.ts. What is
// different about this record class is the permission, and it is different per
// intent rather than fixed:
//
//   admit / reinstate   a member gains access      ADMIT_MEMBERS / EJECT_MEMBERS
//   assign              a member's roles change    ASSIGN_ROLES
//   eject / suspend     a member loses access      EJECT_MEMBERS
//   leave               the SUBJECT removes self   no grant at all
//
// The three names are the split `MANAGE_MEMBERS` became (FR-005b), so a greeter
// who may admit still cannot eject or promote. `reinstate` and `suspend` are
// both the EJECT grant deliberately: suspension is a partial removal in both
// directions, which is the rule the roster form already applies, and a second
// name for "undo the thing you were allowed to do" would be a grant nobody
// holds.
//
// `leave` IS AUTHORISED BY IDENTITY, NOT BY A GRANT. A plain member holds none
// of the three and may still leave, so gating self-removal on EJECT_MEMBERS
// would make leaving an admin-only act. The check is therefore that the caller
// IS the subject — and it is a real check: without it, `leave` would be an
// unguarded eject reachable by any member.
//
// THE MEMBERS SPACE'S OWN MEMBER LIST IS NEVER TOUCHED (FR-006a). Nothing here
// calls putMember, and that is a requirement rather than an omission: the list
// is the space's PDS-side read policy, a read policy is space-wide, so a listed
// DID could read every membership, role and permission record straight from the
// PDS with its own credential — bypassing the app's roster gate. The list stays
// empty and the app stays the space's only reader (FR-007).
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	groupAccessRecord,
	groupMembershipRecord,
	membershipRkey
} from '../members-record';
import type { GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupPermissionError,
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter
} from './event-writer';

export interface WriteGroupMembersInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Overrides the PDS transport. Tests and the live probe pass this. */
	writer?: GroupRepoWriter;
}

/** A membership record appears (`put`) or disappears (`drop`). Both directions
 *  are enumerated rather than inferred from a boolean, because the permission
 *  each one needs is not the same. */
export type MembershipPut = 'admit' | 'assign' | 'reinstate' | 'join';
export type MembershipDrop = 'eject' | 'suspend' | 'leave';
export type MembershipIntent = MembershipPut | MembershipDrop;

/** THE TWO SELF-SERVICE INTENTS, authorised by identity rather than by a grant:
 *  the caller must BE the subject. A plain member holds none of the three roster
 *  grants and may still join an open group and leave any group, so gating these
 *  on a grant would make joining and leaving admin-only acts. The identity check
 *  is not a formality — without it, `leave` is an unguarded eject and `join` an
 *  unguarded admit, both reachable by anyone signed in.
 *
 *  What keeps `join` honest about the group's JOIN POLICY is that it never
 *  decides one: `requestJoin` (`./repo.ts`) applies the policy in SQL and only
 *  returns `joined` when the roster row was really created, so this write
 *  records a membership the database already granted. */
const SELF_SERVICE: readonly MembershipIntent[] = ['join', 'leave'];

/** Intent -> the grant it requires. The self-service pair is absent on purpose,
 *  and a lookup miss is what routes them to the identity check instead. */
const PERMISSION_FOR: Readonly<
	Record<
		Exclude<MembershipIntent, 'join' | 'leave'>,
		'ADMIT_MEMBERS' | 'ASSIGN_ROLES' | 'EJECT_MEMBERS'
	>
> = {
	admit: 'ADMIT_MEMBERS',
	assign: 'ASSIGN_ROLES',
	reinstate: 'EJECT_MEMBERS',
	eject: 'EJECT_MEMBERS',
	suspend: 'EJECT_MEMBERS'
};

/** `at://<group did>/space/<members type>/self` — the space every roster record
 *  lands in. Read off the row rather than recomputed for the reason
 *  `about-writer.ts` gives: a NULL is a real state (provisioning did not
 *  finish), and saying so beats writing to a URI the PDS never heard of. */
function membersSpace(group: GroupRow): string {
	if (!group.members_space_uri) {
		throw new GroupRecordError(
			`${group.slug} has no members space yet, so its roster records cannot be written`
		);
	}
	return group.members_space_uri;
}

/** The gate, for one roster intent. Returns nothing: it either passes or
 *  throws, exactly like `requireGroupPermission`. */
async function authoriseMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipIntent }
): Promise<void> {
	if (SELF_SERVICE.includes(input.intent)) {
		// The refusal names the grant an admin would have needed, because that is
		// what the caller is missing when the subject is somebody else.
		if (!input.callerDid || input.callerDid !== input.subject) {
			throw new GroupPermissionError(
				input.intent === 'join' ? 'ADMIT_MEMBERS' : 'EJECT_MEMBERS',
				input.group.slug
			);
		}
		return;
	}
	await requireGroupPermission(
		input.db,
		input.group,
		input.callerDid,
		PERMISSION_FOR[input.intent as Exclude<MembershipIntent, 'join' | 'leave'>]
	);
}

export interface MembershipWriteResult {
	uri: string;
	cid: string;
	rkey: string;
}

/** Writes the `membership` record that grants `subject` its roles.
 *
 *  `putRecord`, not `createRecord`: a role change rewrites the record in place,
 *  so the member keeps one membership with one URI rather than accumulating a
 *  record per promotion. `createdAt` is threaded from the existing record by
 *  the caller for the same reason `writeGroupProfile` threads it — only the
 *  caller knows whether it already read the record. */
export async function putGroupMembership(
	input: WriteGroupMembersInput & {
		subject: string;
		roles: readonly GroupRoleName[];
		intent: MembershipPut;
		createdAt?: string;
	}
): Promise<MembershipWriteResult> {
	await authoriseMembership(input);
	if (input.roles.length === 0) {
		// A membership granting nothing is indistinguishable from no membership to
		// every reader, so writing one would publish a member with no access and
		// call it a member.
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

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey,
		record,
		intent: 'update',
		space: membersSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid, rkey };
}

/** Deletes the `membership` record, which is how access is revoked — by an
 *  eject, by a suspension, or by the member leaving.
 *
 *  Idempotent, because the host is: `com.atproto.space.deleteRecord` returns
 *  `{}` for a record that is not there (verified in the reference PDS, which
 *  skips the write when `hasRecord` is false). So ejecting a member whose
 *  record predates this code is a no-op rather than a 400, and the D1 delete
 *  that follows is not left stranded behind a failed record write. */
export async function dropGroupMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipDrop }
): Promise<{ uri: string; rkey: string }> {
	await authoriseMembership(input);
	const rkey = membershipRkey(input.subject);
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey,
		record: {},
		intent: 'delete',
		space: membersSpace(input.group)
	});
	return { uri: result.uri, rkey };
}

/** Writes the members space's `access` record: the roles that may read it.
 *
 *  Its permission is MANAGE_GROUP rather than one of the three roster grants —
 *  this is the space's configuration, not a member's standing, which is the
 *  same reason the profile and rules writers take MANAGE_GROUP.
 *
 *  Called at create and idempotent thereafter (`self`, `putRecord`). Iteration
 *  1 has nothing that changes the answer: the roles are the whole vocabulary,
 *  so the record is rewritten identically rather than conditionally. */
export async function writeGroupAccess(
	input: WriteGroupMembersInput & { roles?: readonly GroupRoleName[]; createdAt?: string }
): Promise<{ uri: string; cid: string }> {
	await requireGroupPermission(input.db, input.group, input.callerDid, 'MANAGE_GROUP');

	const record = {
		...groupAccessRecord({
			roles: input.roles ?? MEMBERS_SPACE_READER_ROLES,
			createdAt: input.createdAt
		}),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record,
		intent: 'update',
		space: membersSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

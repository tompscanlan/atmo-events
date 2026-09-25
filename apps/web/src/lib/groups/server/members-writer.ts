// Writes a group's roster and its authz config into its members space.
//
// The roster half is per member and per intent. The authz half (`role`,
// `permissions`, `eventPermissions`, see `writeGroupAuthz` at the bottom) is per
// group and needs MANAGE_GROUP, like every other configuration write.
//
// Same gate, credential and transport as the event and about writers
// (`groupWriter` and `requireGroupPermission` from ./event-writer.ts). What
// differs is the permission, which depends on the intent:
//
//   admit               a member gains access      ADMIT_MEMBERS
//   assign              a member's roles change    ASSIGN_ROLES
//   eject               a member loses access      EJECT_MEMBERS
//   join                the subject adds self      no grant (identity check)
//   leave               the subject removes self   no grant (identity check)
//
// These are three separate grants, so a greeter who may admit still cannot
// eject or promote.
//
// WE NEVER TOUCH THE MEMBERS SPACE'S OWN MEMBER LIST. Nothing here calls
// putMember, on purpose. That list is the space's PDS-side read policy, and a
// read policy covers the whole space, so a listed DID could read every
// membership, role and permission record straight from the PDS with its own
// credential, around the app's roster gate. The list stays empty and the app
// is the space's only reader.
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord,
	membershipRkey
} from '../members-record';
import {
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
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
	/** Overrides the PDS transport (tests, and callers that already built one). */
	writer?: GroupRepoWriter;
	/** Overrides the members-space reader the gate resolves from. */
	reader?: GroupSpaceReader | null;
}

/** A membership record appears (`put`) or disappears (`drop`). The intents are
 *  named rather than a boolean, because each needs a different permission. */
export type MembershipPut = 'admit' | 'assign' | 'join';
export type MembershipDrop = 'eject' | 'leave';
export type MembershipIntent = MembershipPut | MembershipDrop;

/** The two self-service intents, authorized by identity rather than by a
 *  grant: the caller must be the subject. A plain member holds none of the three
 *  roster grants and may still join an open group and leave any group, so a
 *  grant check would make joining and leaving admin-only. Without the identity
 *  check, `leave` would be an unguarded eject and `join` an unguarded admit,
 *  open to anyone signed in.
 *
 *  `join` does not apply the group's join policy here. `requestJoin`
 *  (`./repo.ts`) applies it in SQL and returns `joined` only when the roster row
 *  was really created, so this write records a membership the database already
 *  granted. */
const SELF_SERVICE: readonly MembershipIntent[] = ['join', 'leave'];

/** Intent -> the grant it requires. The self-service pair is not listed; they
 *  go through the identity check instead. */
const PERMISSION_FOR: Readonly<
	Record<
		Exclude<MembershipIntent, 'join' | 'leave'>,
		'ADMIT_MEMBERS' | 'ASSIGN_ROLES' | 'EJECT_MEMBERS'
	>
> = {
	admit: 'ADMIT_MEMBERS',
	assign: 'ASSIGN_ROLES',
	eject: 'EJECT_MEMBERS'
};

/** `at://<group did>/space/<members type>/self`, the space every roster record
 *  goes to. Read from the row rather than recomputed: NULL is a real state
 *  (provisioning did not finish), and failing with that message is better than
 *  writing to a URI the PDS does not know. */
function membersSpace(group: GroupRow): string {
	if (!group.members_space_uri) {
		throw new GroupRecordError(
			`${group.group_did} has no members space yet, so its roster records cannot be written`
		);
	}
	return group.members_space_uri;
}

/** The gate for one roster intent. Returns nothing: it passes or throws, like
 *  `requireGroupPermission`. */
async function authoriseMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipIntent }
): Promise<void> {
	if (SELF_SERVICE.includes(input.intent)) {
		// The refusal names the grant an admin would need, because that is what
		// the caller is missing when the subject is somebody else.
		if (!input.callerDid || input.callerDid !== input.subject) {
			throw new GroupPermissionError(
				input.intent === 'join' ? 'ADMIT_MEMBERS' : 'EJECT_MEMBERS',
				input.group.group_did
			);
		}
		return;
	}
	await requireGroupPermission(
		input,
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
 *  so the member keeps one membership with one URI instead of one record per
 *  promotion. The caller passes `createdAt` from the existing record, because
 *  only the caller knows whether it already read it. */
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
		// To every reader, a membership that grants nothing looks the same as no
		// membership, so writing one would publish a "member" with no access.
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

/** Deletes the `membership` record. This is how access is revoked, by an eject
 *  or by the member leaving.
 *
 *  Idempotent, because the host is: `com.atproto.space.deleteRecord` returns
 *  `{}` for a record that is not there (the reference PDS skips the write when
 *  `hasRecord` is false). So ejecting a member who has no record is a no-op
 *  rather than a 400, and the D1 delete that follows still runs. */
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
 *  Needs MANAGE_GROUP rather than one of the three roster grants, because this
 *  is the space's configuration, not a member's standing (the profile and rules
 *  writers need MANAGE_GROUP for the same reason).
 *
 *  Called at create, and idempotent after that (`self`, `putRecord`). By
 *  default the roles are the whole vocabulary, so the record is rewritten the
 *  same way each time rather than conditionally. */
export async function writeGroupAccess(
	input: WriteGroupMembersInput & { roles?: readonly GroupRoleName[]; createdAt?: string }
): Promise<{ uri: string; cid: string }> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

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

/** What one authz write landed as, so a caller reporting a partial failure can
 *  say which records exist. */
export interface AuthzWriteResult {
	roles: { role: GroupRoleName; uri: string; cid: string }[];
	permissions: { uri: string; cid: string };
	eventPermissions: { uri: string; cid: string };
}

/**
 * Writes the group's authz config into its members space: one `role` record
 * per role, then the two binding records.
 *
 * One function for all three on purpose. A role's effective grant is the union
 * across `permissions` and `eventPermissions`, so a caller that wrote one and
 * not the other would publish a role with half its bundle. A `role` record with
 * no binding, or a binding naming a role no record declares, is a config a peer
 * app cannot resolve. The records are split for transport, not so callers can
 * write them separately.
 *
 * Needs MANAGE_GROUP, like the profile, the rules and the access record: this
 * is the group's configuration, not a member's standing. At create this means
 * it must run after the INSERT, because `requireGroupPermission` reads the
 * owner's membership row (the profile write has the same constraint).
 *
 * Idempotent: every key is fixed (`self`, or the role id) and every write is a
 * put, so running it again rewrites rather than duplicates.
 */
export async function writeGroupAuthz(
	input: WriteGroupMembersInput & {
		/** Defaults to the seeded bundles, the same constant `createGroup` seeds
		 *  `role_permissions` from, so the records and the cache agree at
		 *  creation. A caller with edited bundles passes them. */
		bundles?: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
		createdAt?: string;
	}
): Promise<AuthzWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const bundles = input.bundles ?? DEFAULT_ROLE_PERMISSIONS;
	const space = membersSpace(input.group);
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const put = (collection: string, rkey: string, record: Record<string, unknown>) =>
		writer({
			repo: input.group.group_did,
			collection,
			rkey,
			record: { ...record, $type: collection },
			intent: 'update',
			space
		});

	const roles: AuthzWriteResult['roles'] = [];
	// Vocabulary order, and only roles the bundles name: a `role` record the
	// bindings do not mention would declare a role whose grant no reader can
	// resolve.
	for (const role of GROUP_ROLES) {
		if (bundles[role] === undefined) continue;
		const result = await put(
			GROUP_ROLE_COLLECTION,
			role,
			groupRoleRecord({ id: role, createdAt: input.createdAt })
		);
		roles.push({ role, uri: result.uri, cid: result.cid });
	}

	const permissions = await put(
		GROUP_PERMISSIONS_COLLECTION,
		GROUP_PERMISSIONS_RKEY,
		groupBindingsRecord({ altitude: 'community', bundles, createdAt: input.createdAt })
	);
	const eventPermissions = await put(
		GROUP_EVENT_PERMISSIONS_COLLECTION,
		GROUP_PERMISSIONS_RKEY,
		groupBindingsRecord({ altitude: 'modality', bundles, createdAt: input.createdAt })
	);

	return { roles, permissions, eventPermissions };
}

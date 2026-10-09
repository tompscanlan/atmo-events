// Writes a group's roster, its authz config and the index of its spaces into its
// members space, and the calendar space's access record into that space. Each
// roster intent needs its own grant, so a member who may admit still cannot eject
// or promote. The other records need MANAGE_GROUP, like any configuration write.
//
// Nothing here writes the members space's own member list. A read policy covers
// the whole space, so a listed DID could read every roster record from the PDS,
// around the app's gate. The list stays empty. The about space's list mirrors
// the roster instead (./roster.ts). The calendar space's list stays empty too:
// the app reads that space as the group, so listing members would only let
// their own apps read members-only events around the gate. (Spec: FR-101b.)
import { now as tidNow } from '@atcute/tid';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord,
	groupSpaceRecord,
	membershipRkey
} from '../members-record';
import {
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import { type GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';

import type { GroupSpaceIndexEntry } from './members-read';

import {
	GroupPermissionError,
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter,
	ownSpace
} from './group-write';

const membersSpace = (group: GroupRow) =>
	ownSpace(group, 'members', group.members_space_uri, 'its roster records cannot be written');
const aboutSpace = (group: GroupRow) =>
	ownSpace(group, 'about', group.about_space_uri, 'its space index cannot be written');
const calendarSpace = (group: GroupRow, space: string) =>
	ownSpace(group, 'calendar', space, 'its calendar space records cannot be written');
import { type CredentialStoreEnv } from './session';
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
 *  apply the join policy here; `requestJoin` (./repo.ts) already did. */
const SELF_SERVICE: readonly MembershipIntent[] = ['join', 'leave'];

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

/** Read off the row, and checked like `aboutSpace` in ./about-writer.ts. */

/** The calendar space a caller passed, checked like `membersSpace`. No column
 *  holds it, so it comes from the caller, which today is only the create. */

/** The gate for one roster intent. Exported because the roster must refuse the
 *  caller before it edits the about space's member list. */
export async function authorizeMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipIntent }
): Promise<void> {
	if (SELF_SERVICE.includes(input.intent)) {
		// Name the grant needed to act on somebody else.
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

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
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

/** Deletes the `membership` record, which revokes access. Idempotent: the host
 *  returns `{}` for a missing record, so the D1 delete that follows still runs. */
export async function dropGroupMembership(
	input: WriteGroupMembersInput & { subject: string; intent: MembershipDrop }
): Promise<{ uri: string; rkey: string }> {
	await authorizeMembership(input);
	const rkey = membershipRkey(input.subject);
	const writer = input.writer ?? (await groupWriter(input.env, input.group));
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

/** Puts a members-read space's `access` record: not public, and the roles that
 *  may read it. The members space, unless `space` names the group's calendar
 *  space, whose record says the same. The create names it and the repair does
 *  not: a group made before the calendar space existed has none for a record to
 *  describe. Never the about space, whose record says the visibility
 *  (`writeAboutAccess`). Needs MANAGE_GROUP, since it is configuration.
 *  Idempotent, keyed `self`. */
export async function writeGroupAccess(
	input: WriteGroupMembersInput & { space?: string }
): Promise<{ uri: string; cid: string }> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const members = membersSpace(input.group);
	const space =
		input.space === undefined || input.space === members
			? members
			: calendarSpace(input.group, input.space);
	const record = {
		...groupAccessRecord({ roles: MEMBERS_SPACE_READER_ROLES, public: false }),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record,
		intent: 'update',
		space
	});
	return { uri: result.uri, cid: result.cid };
}

export interface SpaceIndexWriteResult {
	/** The spaces this call indexed. */
	added: string[];
	/** The keys of the entries it deleted, each a second entry for a space. */
	removed: string[];
}

/**
 * Leaves exactly one `space` entry for each space it is given: the about and
 * members spaces always, and the calendar space when the caller passes it. It
 * adds one for a space with none, and deletes all but the oldest for a space with
 * several. An entry for any other space is left alone. The create passes the
 * calendar space and the repair does not, since a group made before that space
 * existed has none to index; a calendar entry the repair finds stays as it is.
 * `existing` is passed in, as for rules, so a new group passes `[]` and reads
 * nothing. Needs MANAGE_GROUP, since it is configuration.
 */
export async function writeGroupSpaceIndex(
	input: WriteGroupMembersInput & {
		existing: readonly GroupSpaceIndexEntry[];
		calendarSpace?: string;
		createdAt?: string;
	}
): Promise<SpaceIndexWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const members = membersSpace(input.group);
	const spaces = [aboutSpace(input.group), members];
	if (input.calendarSpace !== undefined) {
		spaces.push(calendarSpace(input.group, input.calendarSpace));
	}
	const writer = input.writer ?? (await groupWriter(input.env, input.group));
	const oldestFirst = [...input.existing].sort((a, b) => a.rkey.localeCompare(b.rkey));
	const result: SpaceIndexWriteResult = { added: [], removed: [] };

	for (const space of spaces) {
		const [kept, ...extra] = oldestFirst.filter((entry) => entry.space === space);
		if (!kept) {
			await writer({
				repo: input.group.group_did,
				collection: GROUP_SPACE_COLLECTION,
				rkey: tidNow(),
				record: {
					...groupSpaceRecord({ space, createdAt: input.createdAt }),
					$type: GROUP_SPACE_COLLECTION
				},
				intent: 'create',
				space: members
			});
			result.added.push(space);
		}
		for (const entry of extra) {
			await writer({
				repo: input.group.group_did,
				collection: GROUP_SPACE_COLLECTION,
				rkey: entry.rkey,
				record: {},
				intent: 'delete',
				space: members
			});
			result.removed.push(entry.rkey);
		}
	}
	return result;
}

/** What landed, so a partial failure can say which records exist. */
export interface AuthzWriteResult {
	roles: { role: GroupRoleName; uri: string; cid: string }[];
	permissions: { uri: string; cid: string };
	eventPermissions: { uri: string; cid: string };
}

/**
 * Writes one `role` record per role, then the two binding records. One function,
 * because a role's grant is the union of both bindings, and writing one alone
 * would publish a role with half its bundle. Needs MANAGE_GROUP, so at create it
 * runs after the owner's membership row exists. Idempotent: every write is a put.
 */
export async function writeGroupAuthz(
	input: WriteGroupMembersInput & {
		/** Defaults to the bundles `createGroup` seeds D1 with, so records and cache agree. */
		bundles?: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
		/** Only `eventPermissions` carries a date. */
		createdAt?: string;
	}
): Promise<AuthzWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const bundles = input.bundles ?? DEFAULT_ROLE_PERMISSIONS;
	const space = membersSpace(input.group);
	const writer = input.writer ?? (await groupWriter(input.env, input.group));
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
	// Only roles the bindings name, since no reader could resolve any other.
	for (const role of GROUP_ROLES) {
		if (bundles[role] === undefined) continue;
		const result = await put(GROUP_ROLE_COLLECTION, role, groupRoleRecord({ id: role }));
		roles.push({ role, uri: result.uri, cid: result.cid });
	}

	const permissions = await put(
		GROUP_PERMISSIONS_COLLECTION,
		GROUP_PERMISSIONS_RKEY,
		groupBindingsRecord({ altitude: 'community', bundles })
	);
	const eventPermissions = await put(
		GROUP_EVENT_PERMISSIONS_COLLECTION,
		GROUP_PERMISSIONS_RKEY,
		groupBindingsRecord({ altitude: 'modality', bundles, createdAt: input.createdAt })
	);

	return { roles, permissions, eventPermissions };
}

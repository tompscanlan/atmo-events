// Writes a group's roster, its authz config and the index of its spaces into its
// members space, and the calendar space's access record into that space. Each
// roster intent needs its own grant, so a member who may admit still cannot eject
// or promote. The other records need MANAGE_GROUP, like any configuration write.
//
// Nothing here writes a space's member list: the group's host lets a member into
// a space by the roles its `access` record grants, and keeps no list apart from
// the records. (Spec: FR-101b.)
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
import { spaceWrite } from '../grants';
import { CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';

import type { GroupSpaceIndexEntry } from './members-read';

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
 *  apply the join policy here; `requestJoin` (./db/roster.ts) already did. */
const SELF_SERVICE: readonly MembershipIntent[] = ['join', 'leave'];

/** Read off the row, and checked like `aboutSpace` in ./about-writer.ts. */

/** The calendar space a caller passed, checked like `membersSpace`. No column
 *  holds it, so it comes from the caller, which today is only the create. */

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

/** Puts a members-read space's `access` record: not public, and the roles that
 *  may read it. The members space, unless `space` names the group's calendar
 *  space, whose record says the same. Never the about space, whose record says the visibility
 *  (`writeAboutAccess`). Needs a scope to write `access` in that space.
 *  Idempotent, keyed `self`. */
export async function writeGroupAccess(
	input: WriteGroupMembersInput & { space?: string }
): Promise<{ uri: string; cid: string }> {
	const members = membersSpace(input.group);
	const space =
		input.space === undefined || input.space === members
			? members
			: calendarSpace(input.group, input.space);
	const spaceType = space === members ? MEMBERS_SPACE_TYPE : CALENDAR_SPACE_TYPE;
	await requireGroupWrite(input, spaceWrite(spaceType, GROUP_ACCESS_COLLECTION, 'update'));

	const record = {
		...groupAccessRecord({
			spaceType,
			roles: MEMBERS_SPACE_READER_ROLES,
			public: false
		}),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = await gatedWriter(input);
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
 * several. An entry for any other space is left alone. The create and the repair
 * both pass the calendar space.
 * `existing` is passed in, as for rules, so a new group passes `[]` and reads
 * nothing. Needs a scope for each kind of write it makes: creating an entry,
 * deleting one, or neither when the index is already whole.
 */
export async function writeGroupSpaceIndex(
	input: WriteGroupMembersInput & {
		existing: readonly GroupSpaceIndexEntry[];
		calendarSpace?: string;
		createdAt?: string;
	}
): Promise<SpaceIndexWriteResult> {
	const members = membersSpace(input.group);
	const spaces = [aboutSpace(input.group), members];
	if (input.calendarSpace !== undefined) {
		spaces.push(calendarSpace(input.group, input.calendarSpace));
	}
	const oldestFirst = [...input.existing].sort((a, b) => a.rkey.localeCompare(b.rkey));
	const plan = spaces.map((space) => {
		const [kept, ...extra] = oldestFirst.filter((entry) => entry.space === space);
		return { space, add: !kept, extra };
	});
	// Only the writes the plan makes, each checked before any is sent.
	if (plan.some((step) => step.add)) {
		await requireGroupWrite(
			input,
			spaceWrite(MEMBERS_SPACE_TYPE, GROUP_SPACE_COLLECTION, 'create')
		);
	}
	if (plan.some((step) => step.extra.length > 0)) {
		await requireGroupWrite(
			input,
			spaceWrite(MEMBERS_SPACE_TYPE, GROUP_SPACE_COLLECTION, 'delete')
		);
	}

	const writer = await gatedWriter(input);
	const result: SpaceIndexWriteResult = { added: [], removed: [] };
	for (const { space, add, extra } of plan) {
		if (add) {
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
 * would publish a role with half its bundle. Needs a scope to write `role` and
 * `permissions` in the members space. That covers `eventPermissions` too, which no
 * scope names: whoever may write `permissions` may grant any scope at all
 * (`proposal.md:59`). Idempotent: every write is a put.
 */
export async function writeGroupAuthz(
	input: WriteGroupMembersInput & {
		/** Defaults to the bundles `createGroup` seeds D1 with, so records and cache agree. */
		bundles?: Readonly<Partial<Record<GroupRoleName, readonly GroupPermission[]>>>;
		/** Only `eventPermissions` carries a date. */
		createdAt?: string;
	}
): Promise<AuthzWriteResult> {
	await requireGroupWrite(input, spaceWrite(MEMBERS_SPACE_TYPE, GROUP_ROLE_COLLECTION, 'update'));
	await requireGroupWrite(
		input,
		spaceWrite(MEMBERS_SPACE_TYPE, GROUP_PERMISSIONS_COLLECTION, 'update')
	);

	const bundles = input.bundles ?? DEFAULT_ROLE_PERMISSIONS;
	const space = membersSpace(input.group);
	const writer = await gatedWriter(input);
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
	const eventPermissions = await writeEventPermissions({ ...input, bundles, writer });

	return { roles, permissions, eventPermissions };
}

/**
 * Writes `eventPermissions` alone, for a group whose roles and `permissions` are
 * someone else's: a group host writes those at create, in the proposal's own roles,
 * and this app adds only its event bindings for them. Needs the scope that writes
 * `permissions`, as `writeGroupAuthz` does. Idempotent: a put.
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

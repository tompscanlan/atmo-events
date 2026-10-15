// Repairs a group whose records, host settings and D1 cache have drifted
// apart, from the settings page, behind MANAGE_GROUP. Four steps, in order:
//
//   1. Write the records the row is certain of, if missing: the three spaces'
//      `access`, the index of the three spaces, the owner's `membership`, and
//      the authz config. The create makes the three spaces together and
//      records their URIs only once all three exist, so a group the repair can
//      reach has a calendar space. A missing about space `access` is written
//      private, which is what a missing one already means.
//   2. Make each space's read policy, and the declaration, agree with the
//      space's `access`. A space more open than its record closes here,
//      before anything else changes at the host. (Spec: FR-214.)
//   3. Make each space's member list equal the members whose roles its
//      `access` grants read. A pending join request holds no entry, so the
//      requests in D1 are not read. (Spec: FR-206, FR-214, SC-205.)
//   4. Rebuild the cache from the records.
//
// Step 1 exists because a create that fails after the INSERT leaves the
// roster only in the rows. That works until the next roster act writes one
// record: the gate then resolves from records, and everyone else holds nothing.
//
// Only gaps are filled. Another member's row without a record may be a
// removal whose row delete failed, so it is reported, never written, and step
// 2 lists DIDs from the records only. The authz config is written only when
// none of it exists and no such member is waiting, since a member with no
// record loses access once it exists.
//
// Steps 2 and 3 never write a record: `access` is the policy, so the host
// follows it. A second run writes nothing. The repair cannot help a group whose
// authz config exists while the owner has no membership record, because
// MANAGE_GROUP then refuses the owner too.
import { declarationRequired } from '../declaration-record';
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import { MEMBERS_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';
import { groupSpaceReader, readAboutAccess, type GroupSpaceReader } from './about-read';
import { writeAboutAccess } from './about-writer';

import {
	dropDeclarationFromIndex,
	groupDeclared,
	reconcileGroupDeclaration
} from './declaration-writer';

import {
	alignSpaceMembers,
	GROUP_SPACE_KINDS,
	groupMemberList,
	groupSpaces,
	readSpaceAccess,
	type GroupSpaceAccess,
	type GroupSpaceKind,
	type SpaceMemberAlignment
} from './member-list';
import { readGroupMembers, readGroupSpaceIndex, type GroupMembers } from './members-read';
import {
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from './members-writer';
import { rebuildGroup, type GroupRebuildResult } from './rebuild';

import {
	groupSpaceUpdater,
	readPolicyFor,
	visibilityFromAccess,
	type GroupSpaceUpdater,
	type SpaceReadPolicy
} from './spaces';

import { actingPerson, requireGroupWrite } from './group-write';
import { spaceWrite } from '../grants';
import { type CredentialStoreEnv, GroupCredentialError } from './session';
import { groupSpaceUris, POLICY_PUBLIC } from '../ids';
import {
	accessGrantsRead,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_PERMISSIONS_COLLECTION,
	parseGroupAccess
} from '../members-record';
import { rolePermissions } from './db/groups';
import { listMembers } from './db/roster';
export interface RepairGroupInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** The route's reader, for the gate and every step. Built from the
	 *  credential if absent. */
	reader?: GroupSpaceReader | null;
	/** Moves a space's read policy. Built from the credential if absent. */
	updater?: GroupSpaceUpdater;
}

export interface GroupRepairResult {
	/** What step 1 wrote. `false` means it was already there, or held back.
	 *  `spaceIndex` means an entry was added or a second one deleted. */
	wrote: {
		access: boolean;
		calendarAccess: boolean;
		/** The about space's, written private. */
		aboutAccess: boolean;
		spaceIndex: boolean;
		ownerMembership: boolean;
		authz: boolean;
	};
	/** Active members, other than the owner, with no membership record. */
	unrecordedMembers: string[];
	/** Why the authz config was not written, when it was missing. */
	authzHeldBack: 'partial' | 'unrecorded-members' | null;
	/** What step 2 changed to match the access records. */
	policy: PolicyAlignment;
	/** What step 3 changed on each space's member list. */
	lists: Record<GroupSpaceKind, SpaceMemberAlignment>;
	rebuild: GroupRebuildResult;
}

export interface PolicyAlignment {
	/** The group's visibility: the about space's `access.public`. */
	visibility: GroupVisibility;
	/** Each space whose read policy disagreed with its `access`, and the
	 *  policy it was moved to. */
	readPolicies: Partial<Record<GroupSpaceKind, SpaceReadPolicy>>;
	/** What changed, or null when the declaration already agreed. */
	declaration: 'declared' | 'withdrawn' | null;
}

export async function repairGroup(input: RepairGroupInput): Promise<GroupRepairResult> {
	const { db, env, group } = input;
	// Repair reads as the group until the real host (TS, 2026-10-15), through the
	// caller's own group session; an anonymous caller is refused by the gate.
	const reader =
		input.reader !== undefined
			? input.reader
			: input.callerDid
				? await groupSpaceReader(env, group, input.callerDid)
				: null;
	// Repair rewrites the authz config and the member lists, so it takes the scope
	// that writes `permissions`, which can grant anything (`proposal.md:59`). Each
	// record write it makes is checked again on its own.
	await requireGroupWrite(
		{ ...input, reader },
		spaceWrite(MEMBERS_SPACE_TYPE, GROUP_PERMISSIONS_COLLECTION, 'update')
	);
	// The caller has linked no group session, which only they can fix.
	if (!reader) throw new GroupCredentialError(group.group_did, actingPerson(input));

	const members = await readGroupMembers(reader, group);
	// The row's creation instant, as a create stamps its records.
	const createdAt = new Date(group.created_at).toISOString();
	const write = { ...input, reader };
	const wrote: GroupRepairResult['wrote'] = {
		access: false,
		calendarAccess: false,
		aboutAccess: false,
		spaceIndex: false,
		ownerMembership: false,
		authz: false
	};

	// Create's order: the authz config goes last (see ../create-group.ts).
	if (!members.access) {
		await writeGroupAccess(write);
		wrote.access = true;
	}
	const calendarSpace = groupSpaceUris(group.group_did).calendarSpaceUri;
	const calendarAccess = await reader.get({
		space: calendarSpace,
		repo: group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});
	if (!calendarAccess || !parseGroupAccess(calendarAccess.value)) {
		await writeGroupAccess({ ...write, space: calendarSpace });
		wrote.calendarAccess = true;
	}
	if (!(await readAboutAccess(reader, group))) {
		await writeAboutAccess({ ...write, visibility: 'private' });
		wrote.aboutAccess = true;
	}

	const index = await writeGroupSpaceIndex({
		...write,
		existing: await readGroupSpaceIndex(reader, group),
		calendarSpace,
		createdAt
	});
	wrote.spaceIndex = index.added.length > 0 || index.removed.length > 0;

	const recorded = new Set(members.memberships.map((record) => record.subject));
	const unrecordedMembers: string[] = [];
	for (const row of await listMembers(db, group.id)) {
		if (recorded.has(row.did)) continue;
		if (row.did !== group.owner_did) {
			unrecordedMembers.push(row.did);
			continue;
		}
		await putGroupMembership({
			...write,
			subject: row.did,
			roles: ['owner'],
			intent: 'admit',
			createdAt: new Date(row.created_at).toISOString()
		});
		wrote.ownerMembership = true;
	}

	let authzHeldBack: GroupRepairResult['authzHeldBack'] = null;
	const authz = authzState(members);
	if (authz === 'partial') authzHeldBack = 'partial';
	else if (authz === 'none' && unrecordedMembers.length > 0) authzHeldBack = 'unrecorded-members';
	else if (authz === 'none') {
		await writeGroupAuthz({ ...write, bundles: await bundlesFromRows(db, group.id), createdAt });
		wrote.authz = true;
	}

	// The access records are read after step 1, which may have written them.
	const access = await readSpaceAccess(reader, group);
	const policy = await alignToAccess({ ...write, createdAt }, access);

	// Step 3. `members` was read before step 1, so add the owner if step 1 wrote
	// them. An exit deletes the record first, so one that stopped partway is
	// finished here: its DID is no longer recorded, and comes off every list.
	const roleIds = new Map(members.memberships.map((record) => [record.subject, record.roleIds]));
	if (wrote.ownerMembership) roleIds.set(group.owner_did, ['owner']);
	const list = await groupMemberList(env, group);
	const lists = {} as GroupRepairResult['lists'];
	for (const kind of GROUP_SPACE_KINDS) {
		const holders = new Set(
			[...roleIds].filter(([, roles]) => accessGrantsRead(access[kind], roles)).map(([did]) => did)
		);
		lists[kind] = await alignSpaceMembers(list, group, kind, holders);
	}

	const rebuild = await rebuildGroup(db, reader, group.group_did);

	return { wrote, unrecordedMembers, authzHeldBack, lists, policy, rebuild };
}

/** Step 2. Moves each space's read policy to what its `access` calls for, then
 *  publishes or withdraws the declaration by the about space's. Writes only on a
 *  disagreement, and never a record. The read policies go first, so a space the
 *  record has closed is closed before anything else. */
async function alignToAccess(
	input: RepairGroupInput & { reader: GroupSpaceReader; createdAt: string },
	access: GroupSpaceAccess
): Promise<PolicyAlignment> {
	const spaces = groupSpaces(input.group);
	const readPolicies: PolicyAlignment['readPolicies'] = {};
	let updater: GroupSpaceUpdater | undefined;
	for (const kind of GROUP_SPACE_KINDS) {
		const want = readPolicyFor(access[kind]);
		const { readPolicy } = await input.reader.getSpace(spaces[kind]);
		if (readPolicy === want) continue;
		updater ??= await groupSpaceUpdater(input);
		await updater({ space: spaces[kind], readPolicy: want });
		readPolicies[kind] = want;
	}

	const visibility = visibilityFromAccess(access.about);
	const declared = await groupDeclared(input.env, input.group.group_did, actingPerson(input));
	const required = declarationRequired(visibility);
	await reconcileGroupDeclaration({ ...input, visibility, declared });
	// A withdrawal whose index notice was lost leaves browse listing a private
	// group, and the repo no longer says so. Telling the index again drops it.
	if (!required && !declared) await dropDeclarationFromIndex(input.db, input.group.group_did);
	const declaration: PolicyAlignment['declaration'] =
		declared === required ? null : declared ? 'withdrawn' : 'declared';
	return { visibility, readPolicies, declaration };
}

/** Whether the space holds all of the authz config, none of it, or some. */
function authzState(members: GroupMembers): 'all' | 'none' | 'partial' {
	const present = [
		members.roles.length > 0,
		members.permissions !== null,
		members.eventPermissions !== null
	].filter(Boolean).length;
	return present === 3 ? 'all' : present === 0 ? 'none' : 'partial';
}

/** The group's own bundles, from its `role_permissions` rows, not the seeded
 *  defaults, so edited bundles are kept. */
async function bundlesFromRows(
	db: D1Database,
	groupId: string
): Promise<Partial<Record<GroupRoleName, GroupPermission[]>>> {
	const rows = await rolePermissions(db, groupId);
	const bundles: Partial<Record<GroupRoleName, GroupPermission[]>> = {};
	for (const role of GROUP_ROLES) {
		if (rows[role] !== undefined) bundles[role] = rows[role];
	}
	return bundles;
}

/** What the repair did, in sentences an owner can read. */
export function describeRepair(result: GroupRepairResult): string {
	const { wrote } = result;
	const written = [
		wrote.ownerMembership && "owner's membership record",
		wrote.access && "members space's access record",
		wrote.calendarAccess && "calendar space's access record",
		wrote.aboutAccess && "about space's access record",
		wrote.spaceIndex && 'space index',
		wrote.authz && 'permission config'
	].filter((part): part is string => typeof part === 'string');
	const sentences = [
		written.length > 0
			? `Wrote the missing ${joinList(written)}.`
			: 'No records were missing that could be written.'
	];
	if (wrote.aboutAccess) {
		sentences.push(
			'With no access record for its about space, the group was already private, and the new record says so. Saving the settings as public opens it.'
		);
	}
	for (const kind of GROUP_SPACE_KINDS) {
		const { added, removed } = result.lists[kind];
		const changes = [
			added.length > 0 && `added ${countOf(added.length)}`,
			removed.length > 0 && `removed ${countOf(removed.length)}`
		].filter((part): part is string => typeof part === 'string');
		if (changes.length > 0) {
			sentences.push(
				`Brought the ${kind} space's member list at the group's PDS in line with the membership records and the space's access record: ${joinList(changes)}.`
			);
		}
	}
	const { policy } = result;
	const aligned = [
		...GROUP_SPACE_KINDS.filter((kind) => policy.readPolicies[kind]).map(
			(kind) =>
				`${policy.readPolicies[kind] === POLICY_PUBLIC ? 'opened' : 'closed'} the ${kind} space ${
					policy.readPolicies[kind] === POLICY_PUBLIC ? 'to everyone' : 'to all but its members'
				}`
		),
		policy.declaration === 'withdrawn' && 'withdrew its declaration',
		policy.declaration === 'declared' && 'published its declaration'
	].filter((part): part is string => typeof part === 'string');
	if (aligned.length > 0) {
		sentences.push(
			`Brought the group's PDS in line with its access records, which make it ${policy.visibility}: ${joinList(aligned)}.`
		);
	}
	sentences.push(
		result.rebuild.path === 'repaired' && result.rebuild.profile === 'no-profile'
			? "Rebuilt this site's copy of the roster from its records. The group has no profile record, so its name and description here were left as they were."
			: "Rebuilt this site's copy of the group from its records."
	);
	const waiting = result.unrecordedMembers.length;
	if (waiting > 0 && result.authzHeldBack === null) {
		// The authz config exists, so a row with no record grants nothing, and a
		// role change is refused: only Remove finishes it (./roster.ts).
		sentences.push(
			`${waiting} member${waiting === 1 ? ' has' : 's have'} no membership record, so a removal or an addition stopped partway. ${waiting === 1 ? 'They are' : 'They are each'} taken off the group's member lists and listed under "Not finished" on the members page, where Remove finishes it. To keep someone, remove them, then add them again.`
		);
	} else if (waiting > 0) {
		sentences.push(
			`${waiting} member${waiting === 1 ? ' has' : 's have'} no membership record and ${waiting === 1 ? 'was' : 'were'} left alone, because this site cannot tell a failed admission from a failed removal. Changing ${waiting === 1 ? 'their' : "each one's"} role on the members page writes it.`
		);
	}
	if (result.authzHeldBack === 'unrecorded-members') {
		sentences.push(
			'The permission config was not written yet: those members would lose access the moment it exists. Run the repair again once they have records.'
		);
	} else if (result.authzHeldBack === 'partial') {
		sentences.push(
			"The permission config is only partly present, so it was left as it is rather than completed from this site's copy."
		);
	}
	return sentences.join(' ');
}

function countOf(n: number): string {
	return `${n} member${n === 1 ? '' : 's'}`;
}

function joinList(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

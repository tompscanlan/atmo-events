// Repairs a group whose records and D1 cache have drifted apart, from the
// settings page, behind MANAGE_GROUP. Four steps, in order:
//
//   1. Write the members-space records the row is certain of, if missing:
//      `access`, the index of the two spaces, the owner's `membership`, and
//      the authz config.
//   2. Make the about space's member list equal the membership records, and
//      the members space's write-only list equal those plus the pending join
//      requests. Requests live only in D1 (spec 003 SC-205), so a requester
//      keeps their entry while D1 holds the request.
//   3. Make the about space's access record and the declaration agree with
//      its read policy.
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
// Step 3 never changes the host's read policy: it holds the owner's last
// choice that got through, so the records follow it. A second run writes
// nothing. The repair cannot
// help a group whose authz config exists while the owner has no membership
// record, because MANAGE_GROUP then refuses the owner too.
import { declarationRequired } from '../declaration-record';
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import type { GroupRow, GroupVisibility } from '../types';
import { groupSpaceReader, readAboutAccess, type GroupSpaceReader } from './about-read';
import { alignAboutAccess } from './about-writer';

import { groupDeclared, reconcileGroupDeclaration } from './declaration-writer';

import {
	alignAboutMembers,
	alignMemberWriters,
	groupMemberList,
	type GroupMemberList,
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

import { readGroupVisibility } from './spaces';

import { GroupRecordError, requireGroupPermission, type GroupRepoWriter } from './group-write';
import { type CredentialStoreEnv } from './session';
import { rolePermissions } from './db/groups';
import { listJoinRequests, listMembers } from './db/roster';
export interface RepairGroupInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Overrides the PDS transport. Tests pass this. */
	writer?: GroupRepoWriter;
	/** Overrides the space reader, for the gate, step 1 and step 3. */
	reader?: GroupSpaceReader | null;
	/** Overrides step 3's check of whether the public repo holds the declaration. */
	declared?: () => Promise<boolean>;
	/** Overrides the member-list transport, for both spaces. */
	memberList?: GroupMemberList;
}

export interface GroupRepairResult {
	/** What step 1 wrote. `false` means it was already there, or held back.
	 *  `spaceIndex` means an entry was added or a second one deleted. */
	wrote: { access: boolean; spaceIndex: boolean; ownerMembership: boolean; authz: boolean };
	/** Active members, other than the owner, with no membership record. */
	unrecordedMembers: string[];
	/** Why the authz config was not written, when it was missing. */
	authzHeldBack: 'partial' | 'unrecorded-members' | null;
	/** What step 2 changed on the about space's member list. */
	memberList: SpaceMemberAlignment;
	/** What step 2 changed on the members space's write-only list. */
	writers: SpaceMemberAlignment;
	/** What step 3 found at the host and changed to match it. */
	host: HostAlignment;
	rebuild: GroupRebuildResult;
}

export interface HostAlignment {
	/** The group's visibility, as the about space's read policy gives it. */
	visibility: GroupVisibility;
	/** What changed, or null when the declaration already agreed. */
	declaration: 'declared' | 'withdrawn' | null;
	/** Whether the about space's access record was missing or said otherwise,
	 *  and was rewritten. */
	access: boolean;
}

export async function repairGroup(input: RepairGroupInput): Promise<GroupRepairResult> {
	const { db, env, group } = input;
	const reader = input.reader !== undefined ? input.reader : await groupSpaceReader(env, group);
	await requireGroupPermission({ ...input, reader }, 'MANAGE_GROUP');
	if (!reader) {
		throw new GroupRecordError(`${group.group_did} is not linked, so its records cannot be read`);
	}

	const members = await readGroupMembers(reader, group);
	// The row's creation instant, as a create stamps its records.
	const createdAt = new Date(group.created_at).toISOString();
	const write = { ...input, reader };
	const wrote: GroupRepairResult['wrote'] = {
		access: false,
		spaceIndex: false,
		ownerMembership: false,
		authz: false
	};

	// Create's order: the authz config goes last (see ../create-group.ts).
	if (!members.access) {
		await writeGroupAccess(write);
		wrote.access = true;
	}

	const index = await writeGroupSpaceIndex({
		...write,
		existing: await readGroupSpaceIndex(reader, group),
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

	// Step 2. `members` was read before step 1, so add the owner if step 1 wrote them.
	const holders = new Set(recorded);
	if (wrote.ownerMembership) holders.add(group.owner_did);
	const list = input.memberList ?? (await groupMemberList(env, group));
	const memberList = await alignAboutMembers(list, group, holders);
	const writers = new Set(holders);
	for (const request of await listJoinRequests(db, group.id)) writers.add(request.did);
	const writerList = await alignMemberWriters(list, group, writers);

	const declared = input.declared ?? (() => groupDeclared(env, group.group_did));
	const host = await alignToHost({ ...write, createdAt }, declared);

	const rebuild = await rebuildGroup(db, reader, group.group_did);

	return {
		wrote,
		unrecordedMembers,
		authzHeldBack,
		memberList,
		writers: writerList,
		host,
		rebuild
	};
}

/** Step 3. Writes only on a disagreement, and never to the host or the row. A
 *  declared group's access must say public, so the access record goes before a
 *  declaration is published and after one is withdrawn. */
async function alignToHost(
	input: RepairGroupInput & { reader: GroupSpaceReader; createdAt: string },
	declaredOnHost: () => Promise<boolean>
): Promise<HostAlignment> {
	const visibility = await readGroupVisibility(input.reader, input.group);
	const [declared, access] = await Promise.all([
		declaredOnHost(),
		readAboutAccess(input.reader, input.group)
	]);

	const required = declarationRequired(visibility);
	const alignAccess = () => alignAboutAccess({ ...input, visibility }, access);

	let accessWritten = required ? await alignAccess() : false;
	await reconcileGroupDeclaration({ ...input, visibility, declared });
	const declaration: HostAlignment['declaration'] =
		declared === required ? null : declared ? 'withdrawn' : 'declared';
	if (!required) accessWritten = await alignAccess();
	return { visibility, declaration, access: accessWritten };
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
		wrote.access && 'access record',
		wrote.spaceIndex && 'space index',
		wrote.authz && 'permission config'
	].filter((part): part is string => typeof part === 'string');
	const sentences = [
		written.length > 0
			? `Wrote the missing ${joinList(written)}.`
			: 'No records were missing that could be written.'
	];
	const { added, removed } = result.memberList;
	if (added.length > 0 || removed.length > 0) {
		const changes = [
			added.length > 0 && `added ${countOf(added.length)}`,
			removed.length > 0 && `removed ${countOf(removed.length)}`
		].filter((part): part is string => typeof part === 'string');
		sentences.push(
			`Brought the group's member list at its PDS in line with the membership records: ${joinList(changes)}.`
		);
	}
	const writerChanges = [
		result.writers.added.length > 0 && `added ${countOf(result.writers.added.length)}`,
		result.writers.removed.length > 0 && `removed ${countOf(result.writers.removed.length)}`
	].filter((part): part is string => typeof part === 'string');
	if (writerChanges.length > 0) {
		sentences.push(
			`Brought the list of whose writes the group's PDS tracks in line with its members and pending requests: ${joinList(writerChanges)}.`
		);
	}
	const { host } = result;
	const aligned = [
		host.declaration === 'withdrawn' && 'withdrew its declaration',
		host.declaration === 'declared' && 'published its declaration',
		host.access && `rewrote its access record to say ${host.visibility}`
	].filter((part): part is string => typeof part === 'string');
	if (aligned.length > 0) {
		sentences.push(
			`Brought the group in line with its PDS, which reads it as ${host.visibility}: ${joinList(aligned)}.`
		);
	}
	sentences.push(
		result.rebuild.path === 'repaired' && result.rebuild.profile === 'no-profile'
			? "Rebuilt this site's copy of the roster from its records. The group has no profile record, so its name and description here were left as they were."
			: "Rebuilt this site's copy of the group from its records."
	);
	const waiting = result.unrecordedMembers.length;
	if (waiting > 0) {
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

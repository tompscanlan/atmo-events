// Repairs a group whose records and D1 cache have drifted apart, from the
// settings page, behind MANAGE_GROUP. Four steps, in order:
//
//   1. Write the members-space records the row is certain of, if missing:
//      `access`, the owner's `membership`, and the authz config.
//   2. Make the about space's member list equal the membership records.
//   3. Make the declaration agree with the about space's read policy.
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
// choice that got through. A second run writes nothing. The repair cannot
// help a group whose authz config exists while the owner has no membership
// record, because MANAGE_GROUP then refuses the owner too.
import { declarationRequired } from '../declaration-record';
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import type { GroupRow, GroupVisibility } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import type { CredentialStoreEnv } from './credentials';
import { reconcileGroupDeclaration } from './declaration-writer';
import { GroupRecordError, requireGroupPermission, type GroupRepoWriter } from './event-writer';
import {
	alignAboutMembers,
	groupMemberList,
	type AboutMemberAlignment,
	type GroupMemberList
} from './member-list';
import { readGroupMembers, type GroupMembers } from './members-read';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './members-writer';
import {
	groupRebuildSources,
	rebuildGroup,
	type GroupRebuildResult,
	type GroupRebuildSources
} from './rebuild';
import { listMembers, rolePermissions } from './repo';
import { readGroupVisibility } from './spaces';

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
	/** Overrides where the rebuild reads from, and step 3's declaration probe. */
	sources?: GroupRebuildSources | null;
	/** Overrides the about space's member-list transport. */
	memberList?: GroupMemberList;
}

export interface GroupRepairResult {
	/** What step 1 wrote. `false` means it was already there, or held back. */
	wrote: { access: boolean; ownerMembership: boolean; authz: boolean };
	/** Active members, other than the owner, with no membership record. */
	unrecordedMembers: string[];
	/** Why the authz config was not written, when it was missing. */
	authzHeldBack: 'partial' | 'unrecorded-members' | null;
	/** What step 2 changed on the about space's member list. */
	memberList: AboutMemberAlignment;
	/** What step 3 found at the host and changed to match it. */
	host: HostAlignment;
	rebuild: GroupRebuildResult;
}

export interface HostAlignment {
	/** The group's visibility, as the about space's read policy gives it. */
	visibility: GroupVisibility;
	/** What changed, or null when the declaration already agreed. */
	declaration: 'declared' | 'withdrawn' | null;
}

export async function repairGroup(input: RepairGroupInput): Promise<GroupRepairResult> {
	const { db, env, group } = input;
	const reader = input.reader !== undefined ? input.reader : await groupSpaceReader(env, db, group);
	await requireGroupPermission({ ...input, reader }, 'MANAGE_GROUP');
	if (!reader) {
		throw new GroupRecordError(
			`this deployment holds no credential for ${group.group_did}, so its records cannot be read`
		);
	}

	const members = await readGroupMembers(reader, group);
	// The row's creation instant, as a create stamps its records.
	const createdAt = new Date(group.created_at).toISOString();
	const write = { ...input, reader };
	const wrote: GroupRepairResult['wrote'] = { access: false, ownerMembership: false, authz: false };

	// Create's order: the authz config goes last (see ../create-group.ts).
	if (!members.access) {
		await writeGroupAccess({ ...write, createdAt });
		wrote.access = true;
	}

	const recorded = new Set(members.memberships.map((record) => record.subject));
	const unrecordedMembers: string[] = [];
	for (const row of await listMembers(db, group.id)) {
		if (row.status !== 'active' || recorded.has(row.did)) continue;
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
	const memberList = await alignAboutMembers(
		input.memberList ?? (await groupMemberList(env, db, group)),
		group,
		holders
	);

	const sources =
		input.sources !== undefined
			? input.sources
			: await groupRebuildSources(env, db, group.group_did);
	if (!sources) {
		throw new GroupRecordError(
			`this deployment holds no credential for ${group.group_did}, so it cannot be rebuilt`
		);
	}

	const host = await alignToHost({ ...write, createdAt }, sources);

	const rebuild = await rebuildGroup(db, sources, group.group_did);

	return { wrote, unrecordedMembers, authzHeldBack, memberList, host, rebuild };
}

/** Step 3. Writes only on a disagreement, and never to the host or the row. */
async function alignToHost(
	input: RepairGroupInput & { reader: GroupSpaceReader; createdAt: string },
	sources: GroupRebuildSources
): Promise<HostAlignment> {
	const visibility = await readGroupVisibility(input.reader, input.group);
	const declared = await sources.declared();

	let declaration: HostAlignment['declaration'] = null;
	if (declared !== declarationRequired(visibility)) {
		await reconcileGroupDeclaration({ ...input, visibility });
		declaration = declared ? 'withdrawn' : 'declared';
	}
	return { visibility, declaration };
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
	const { host } = result;
	if (host.declaration) {
		sentences.push(
			`Brought the group in line with its PDS, which reads it as ${host.visibility}: ${
				host.declaration === 'withdrawn' ? 'withdrew its declaration' : 'published its declaration'
			}.`
		);
	}
	sentences.push("Rebuilt this site's copy of the group from its records.");
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

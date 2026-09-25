// Repairing a group whose records and cache have drifted apart. It runs from the
// group's settings page, behind MANAGE_GROUP, in two steps, always in this
// order:
//
//   1. Complete the members space, as far as the row can say for certain: the
//      `access` record, the owner's `membership`, and the authz config, each
//      only if it does not exist.
//   2. Rebuild the cache from the records (`rebuildGroup`, the repair path).
//
// WHY STEP 1. A create writes the group's row before its records
// (`../create-group.ts`), so a PDS failure after the INSERT leaves a roster
// that lives only in the database. That works while the members space is
// empty, because every reader falls back to the rows. But the next roster act
// writes one member's record, the gate starts resolving from records, and
// everyone else, owner included, holds nothing.
//
// IT ONLY FILLS GAPS, and only with what the row is certain of. A record that
// exists is never rewritten.
//
//   * The owner's membership is certain: `groups.owner_did` pins the owner and
//     the schema refuses to delete or change the owner's row.
//   * Any other member's row without a record is not. A grant whose record
//     write failed leaves it, and so does a revocation whose row delete failed.
//     Writing it could re-grant someone who was removed, so it is reported and
//     never written. A role change on the members page writes it.
//   * The authz config is written only when the space holds none of it and no
//     such member is waiting: once it exists the gate resolves from records,
//     and a member with no record would lose access. A partial config is
//     reported, not completed, because completing it from the row would
//     overwrite the part that exists.
//
// Idempotent: a second run writes nothing, and its rebuild is a no-op.
//
// It cannot help a group whose authz config exists while the owner has no
// membership record: MANAGE_GROUP resolves from records, so the owner is
// refused here too. A create cannot leave that shape (it writes the owner's
// record before the config); only an edit of the config itself could.
import { GROUP_ROLES, type GroupPermission, type GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import type { CredentialStoreEnv } from './credentials';
import { GroupRecordError, requireGroupPermission, type GroupRepoWriter } from './event-writer';
import { readGroupMembers, type GroupMembers } from './members-read';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './members-writer';
import {
	groupRebuildSources,
	rebuildGroup,
	type GroupRebuildResult,
	type GroupRebuildSources
} from './rebuild';
import { listMembers, rolePermissions } from './repo';

export interface RepairGroupInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Overrides the PDS transport. Tests pass this. */
	writer?: GroupRepoWriter;
	/** Overrides the members-space reader, for both the gate and step 1. */
	reader?: GroupSpaceReader | null;
	/** Overrides where the rebuild reads from. */
	sources?: GroupRebuildSources | null;
}

export interface GroupRepairResult {
	/** What step 1 wrote. `false` means it was already there, or held back. */
	wrote: { access: boolean; ownerMembership: boolean; authz: boolean };
	/** Active members, other than the owner, with no membership record. Never
	 *  written from the row (see the header). */
	unrecordedMembers: string[];
	/** Why the authz config was not written, when it was missing. */
	authzHeldBack: 'partial' | 'unrecorded-members' | null;
	rebuild: GroupRebuildResult;
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
	// One instant for every record this writes, the row's own, which is also
	// what a create stamps its records with.
	const createdAt = new Date(group.created_at).toISOString();
	const write = { ...input, reader };
	const wrote: GroupRepairResult['wrote'] = { access: false, ownerMembership: false, authz: false };

	// Create's own order: access, then memberships, then the authz config. The
	// config goes last because once it exists the gate resolves from records,
	// and a member with no record yet would hold nothing for the writes after it.
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

	const sources =
		input.sources !== undefined
			? input.sources
			: await groupRebuildSources(env, db, group.group_did);
	if (!sources) {
		throw new GroupRecordError(
			`this deployment holds no credential for ${group.group_did}, so it cannot be rebuilt`
		);
	}
	const rebuild = await rebuildGroup(db, sources, group.group_did);

	return { wrote, unrecordedMembers, authzHeldBack, rebuild };
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

/** The group's own bundles, from its `role_permissions` rows. Not the seeded
 *  defaults: a group whose bundles were edited must not have them overwritten
 *  by the constant it started from. */
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
			: 'No records were missing that could be written.',
		"Rebuilt this site's copy of the group from its records."
	];
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

function joinList(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

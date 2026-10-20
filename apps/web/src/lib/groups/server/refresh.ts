// Refreshes this site's copy of a group from its host, from the settings page.
// It rebuilds the D1 cache (the profile columns and the roster) from the group's
// records, read with the caller's own access like every other read, and writes
// nothing at the host. A second run finds nothing to change.
//
// The cached roster decides which groups a sign-in asks grants for and a
// person's groups on browse, and a join made at the host through another app
// reaches it only through this, until this site syncs it on its own (TS,
// 2026-10-20). A leave does not: the rebuild adds and updates rows but never
// deletes one, so a member who left elsewhere keeps their row (om-7vdxg).
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { rebuildGroup, type GroupRebuildResult } from './rebuild';
import { actingPerson, requireGroupWrite } from './group-write';
import { spaceWrite } from '../grants';
import { type CredentialStoreEnv, GroupCredentialError } from './session';
import { GROUP_PERMISSIONS_COLLECTION } from '../members-record';

export interface RefreshGroupInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** The caller's own reader, for the gate and the rebuild. Null when their
	 *  sign-in reads no spaces. */
	reader: GroupSpaceReader | null;
}

/** Rebuilds the group's copy behind the gate the authz config's writes take. It
 *  writes only this app's rows, which the host never sees, so the gate checks it
 *  at a group host too. */
export async function refreshGroup(input: RefreshGroupInput): Promise<GroupRebuildResult> {
	const { reader } = input;
	await requireGroupWrite(
		input,
		spaceWrite(MEMBERS_SPACE_TYPE, GROUP_PERMISSIONS_COLLECTION, 'update'),
		{ appOnly: true }
	);
	if (!reader) throw new GroupCredentialError(input.group.group_did, actingPerson(input));
	return rebuildGroup(input.db, reader, input.group.group_did);
}

/** What the refresh did, in sentences an owner can read. */
export function describeRefresh(result: GroupRebuildResult): string {
	const sentences = [
		"Re-read the group from its host into this site's copy. Nothing at the host was changed."
	];
	if (result.path === 'repaired' && result.profile === 'no-profile') {
		sentences.push(
			'The group has no profile record, so its name and description here were left as they were.'
		);
	}
	return sentences.join(' ');
}

// The settings save, as a plain function.
//
// It lives here rather than in `groups.remote.ts` for the same reason as
// ./create-group.ts: the Vite plugin rejects non-remote exports from
// `*.remote.ts`, so a handler that only exists inside `form()` cannot be called
// by a test. `updateGroupForm` is the thin wrapper that resolves the group and
// the caller and checks MANAGE_GROUP first.
import type { CredentialStoreEnv } from './server/credentials';
import { updateGroup } from './server/repo';
import { groupWriter } from './server/event-writer';
import { groupFace, splitRuleLines } from './about-record';
import { groupSpaceReader, readGroupAbout } from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { formError } from './form-error';
import type { GroupFormResult } from './form-result';
import type { GroupRow, GroupVisibility } from './types';

/** The validated form payload. `updateGroupForm`'s valibot schema is checked
 *  against this shape at the callsite, so the two cannot drift silently. */
export interface UpdateGroupData {
	name: string;
	description?: string;
	visibility: GroupVisibility;
	/** Always supplied by the form: `checkboxField` parses an unticked box as
	 *  `false`, not as missing. */
	requireApproval: boolean;
	/** One rule per non-empty line. */
	rules?: string;
}

export async function runUpdateGroup(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow,
	callerDid: string,
	data: UpdateGroupData
): Promise<GroupFormResult> {
	try {
		await updateGroup(db, group.id, {
			name: data.name,
			description: data.description || null,
			visibility: data.visibility,
			requireApproval: data.requireApproval
		});
	} catch (e) {
		return formError(e);
	}

	// Then the records, which are the source of truth for the fields above.
	// The row is written first only because the schema refuses a private group
	// that does not require approval (a trigger in migrations/0001_groups.sql).
	// A record written for a configuration the database then refused would
	// describe a group that cannot exist.
	try {
		// The row we just updated, without re-reading it. The profile must
		// describe the group as it is now, and `joinPolicy` is derived from
		// the visibility and approval columns.
		const fresh = {
			...group,
			name: data.name,
			description: data.description || null,
			visibility: data.visibility,
			require_approval: data.requireApproval ? 1 : 0
		};
		const reader = await groupSpaceReader(env, db, group);
		const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
		const writer = await groupWriter(env, db, fresh);
		await writeGroupProfile({
			db,
			env,
			group: fresh,
			callerDid,
			writer,
			profile: {
				name: data.name,
				description: data.description || null,
				// Not on the settings form, so it is kept rather than cleared. It
				// comes from the record when there is one, so a stale row cannot be
				// written back into it.
				locationName: groupFace(about.profile, group).locationName,
				// Preserved, so editing a group does not restamp its creation date.
				createdAt: about.profile?.createdAt ?? undefined
			}
		});
		await setGroupRules({
			db,
			env,
			group: fresh,
			callerDid,
			writer,
			desired: splitRuleLines(data.rules),
			existing: about.rules
		});
		// The public declaration. Visibility is on this form, so this edit
		// can hide a group. A group switched to private has its declaration
		// deleted, not just left alone: the declaration is the only record an
		// anonymous peer can see, and a stale one keeps announcing a group
		// that asked not to be announced. Switching back declares it again,
		// dated from the group's creation date (taken from the profile, so no
		// extra read), because the declaration says when the group was
		// created, not when its visibility last changed.
		await reconcileGroupDeclaration({
			db,
			env,
			group: fresh,
			callerDid,
			writer,
			createdAt: about.profile?.createdAt ?? undefined
		});
	} catch (e) {
		return {
			ok: false,
			error: `Settings were saved, but this group's records were not updated: ${
				e instanceof Error ? e.message : String(e)
			}`
		};
	}
	return { ok: true };
}

// The settings save, as a plain function.
//
// It lives here rather than in `groups.remote.ts` for the same reason as
// ./create-group.ts: the Vite plugin rejects non-remote exports from
// `*.remote.ts`, so a handler that only exists inside `form()` cannot be called
// by a test. `updateGroupForm` is the thin wrapper that resolves the group and
// the caller and checks MANAGE_GROUP first.
//
// THE ORDER MATTERS. Each failure between two writes leaves a different
// half-state behind, so the sequence is:
//
//   row -> host (only when the visibility changed) -> declaration -> profile -> rules
//
// The row goes first because the schema refuses a private group that does not
// require approval (a trigger in migrations/0001_groups.sql), and neither the
// host nor a record may change for a configuration the database then refuses.
// The host goes next: the about space's read policy is what actually keeps a
// private group's face from strangers, and if the host refuses the change,
// nothing after it may claim the change happened. A visibility change that
// fails anywhere between the row and the host puts the row's visibility and
// approval back, so the next save sees the change again and retries it. The
// declaration comes before the profile and the rules, so a group that has just
// gone private stops being announced even when a later write fails.
import type { CredentialStoreEnv } from './server/credentials';
import { updateGroup } from './server/repo';
import { groupWriter, type GroupRepoWriter } from './server/event-writer';
import { groupFace, splitRuleLines } from './about-record';
import { groupSpaceReader, readGroupAbout, type GroupAbout } from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { setAboutSpaceReadPolicy } from './server/spaces';
import { formError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
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

const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A write to the group's records failed after the row was saved. */
function recordsNotUpdated(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `Settings were saved, but this group's records were not updated: ${describeError(e)}`
	};
}

/** A visibility change that failed before the host took it.
 *
 *  The row goes back to its previous visibility and approval pair. Left at the
 *  new pair, the row would claim a visibility the host is not enforcing, and
 *  the next save would compare against it, find nothing to change, skip the
 *  host and report success. Put back, the next save sees the change again and
 *  retries it. The pair is one the schema accepted before, so the trigger that
 *  refuses a private group without approval cannot refuse putting it back. */
async function visibilityNotApplied(
	db: D1Database,
	group: GroupRow,
	to: GroupVisibility,
	e: unknown
): Promise<GroupFormFailure> {
	try {
		await updateGroup(db, group.id, {
			visibility: group.visibility,
			requireApproval: group.require_approval !== 0
		});
	} catch (restoreError) {
		return {
			ok: false,
			error: `The visibility change did not reach the group's PDS (${describeError(
				e
			)}), and this site could not put the group's previous visibility back either (${describeError(
				restoreError
			)}). This site may now show the group as ${to} while its PDS does not enforce that. The group's declaration, profile and rules were not updated.`
		};
	}
	return {
		ok: false,
		error: `The visibility change did not reach the group's PDS: ${describeError(
			e
		)}. The group's visibility was not changed, and saving again will retry it. Its declaration, profile and rules were not updated.`
	};
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

	// The row we just updated, without re-reading it. The records must describe
	// the group as it is now: the declaration and the about space's read policy
	// follow its visibility, and the profile's `joinPolicy` is derived from the
	// visibility and approval columns.
	const fresh: GroupRow = {
		...group,
		name: data.name,
		description: data.description || null,
		visibility: data.visibility,
		require_approval: data.requireApproval ? 1 : 0
	};

	// Only a change of visibility moves the about space's read policy, and a
	// save that keeps it does not call the host at all.
	const flipped = fresh.visibility !== group.visibility;

	// Every read comes before the first write to the PDS, so the writes below
	// run back to back in their order and a failed read changes nothing there.
	// On a visibility change, a failed read also puts the row back.
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	try {
		const reader = await groupSpaceReader(env, db, group);
		about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
		writer = await groupWriter(env, db, fresh);
	} catch (e) {
		return flipped ? visibilityNotApplied(db, group, fresh.visibility, e) : recordsNotUpdated(e);
	}

	// The host. A failure here, including the permission read in front of it,
	// stops the save and puts the row back: the declaration, profile and rules
	// would otherwise be written for a visibility the host is not enforcing.
	if (flipped) {
		try {
			await setAboutSpaceReadPolicy({ db, env, group: fresh, callerDid });
		} catch (e) {
			return visibilityNotApplied(db, group, fresh.visibility, e);
		}
	}

	try {
		// The public declaration, first of the records. Visibility is on this
		// form, so this edit can hide a group. A group switched to private has
		// its declaration deleted, not just left alone: the declaration is the
		// only record an anonymous peer can see, and a stale one keeps
		// announcing a group that asked not to be announced. Switching back
		// declares it again, dated from the group's creation date (taken from
		// the profile, so no extra read), because the declaration says when the
		// group was created, not when its visibility last changed.
		await reconcileGroupDeclaration({
			db,
			env,
			group: fresh,
			callerDid,
			writer,
			createdAt: about.profile?.createdAt ?? undefined
		});
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
	} catch (e) {
		return recordsNotUpdated(e);
	}
	return { ok: true };
}

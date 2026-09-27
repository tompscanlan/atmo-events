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
//   reads -> host (only when the visibility changes) -> row -> declaration -> profile -> rules
//
// Every read comes first, the host's read policy among them, so a read that
// fails writes nothing anywhere. Whether the visibility changes is decided
// against the host, not the row, because the host is what the group's pages
// read it from (`groupRouteContext`).
//
// The host goes first of the writes because it is the group's visibility. If
// it refuses the change, nothing else is written: the host, the row and the
// records all still describe the group as it was, so saving again finds the
// same change and retries it. Once the host has taken the change, nothing puts
// it back. A later failure leaves the host ahead of the row or the records,
// the message says which writes landed, and saving again or "Repair this
// group" (./server/repair.ts) brings the rest in line with the host.
//
// The row goes next, while it still has its visibility column. The schema
// refuses a private group that does not require approval (a trigger in
// migrations/0001_groups.sql), and no record may be written for a
// configuration the database then refuses. A refusal there comes after the
// host, so a switch to private that the row refuses still leaves the group
// private at its host: more private than the row says, never less. The
// declaration comes before the profile and the rules, so a group that has just
// gone private stops being announced even when a later write fails.
import type { CredentialStoreEnv } from './server/credentials';
import { updateGroup } from './server/repo';
import { GroupCredentialError, groupWriter, type GroupRepoWriter } from './server/event-writer';
import { groupFace, splitRuleLines } from './about-record';
import { groupSpaceReader, readGroupAbout, type GroupAbout } from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { readGroupVisibility, setAboutSpaceReadPolicy } from './server/spaces';
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

/** The save stopped before its first write. Nothing landed anywhere, so the
 *  next save sees the same change and makes it. `to` is the visibility the save
 *  was moving the host to, when it was moving it. */
function nothingSaved(e: unknown, to: GroupVisibility | null): GroupFormFailure {
	return {
		ok: false,
		error: to
			? `The visibility change did not reach the group's PDS: ${describeError(
					e
				)}. Nothing was saved, so the group's visibility was not changed, and saving again will retry it.`
			: `Nothing was saved: ${describeError(e)}. Saving again will retry it.`
	};
}

/** The host took the visibility change and the row did not. The host is what
 *  the group's pages read, so the group already has the new visibility. */
function rowNotSaved(e: unknown, to: GroupVisibility): GroupFormFailure {
	return {
		ok: false,
		error: `The group's PDS now reads it as ${to}, but this site did not save the change: ${describeError(
			e
		)}. The group's declaration, profile and rules were not updated either. Saving again, or "Repair this group", brings them in line with its PDS.`
	};
}

/** A write to the group's records failed after the row was saved, and after the
 *  host when `to` names the visibility it took. */
function recordsNotUpdated(e: unknown, to: GroupVisibility | null): GroupFormFailure {
	const landed = to
		? `Settings were saved and the group's PDS now reads it as ${to}`
		: 'Settings were saved';
	return {
		ok: false,
		error: `${landed}, but this group's records were not updated: ${describeError(e)}`
	};
}

export async function runUpdateGroup(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow,
	callerDid: string,
	data: UpdateGroupData
): Promise<GroupFormResult> {
	// The group as this save describes it. The records must describe the group
	// as it is after the save: the declaration and the about space's read policy
	// follow its visibility, and the profile's `joinPolicy` is derived from the
	// visibility and approval columns.
	const fresh: GroupRow = {
		...group,
		name: data.name,
		description: data.description || null,
		visibility: data.visibility,
		require_approval: data.requireApproval ? 1 : 0
	};

	// Every read before the first write. Only a change of visibility moves the
	// about space's read policy, and a save that keeps it does not write to the
	// host at all. The change is measured against the host, so a row that a
	// failed save left behind cannot hide one.
	let flipped = false;
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	try {
		const reader = await groupSpaceReader(env, db, group);
		if (!reader) throw new GroupCredentialError(group.group_did);
		flipped = (await readGroupVisibility(reader, group)) !== data.visibility;
		about = await readGroupAbout(reader, group);
		writer = await groupWriter(env, db, fresh);
	} catch (e) {
		return nothingSaved(e, flipped ? data.visibility : null);
	}

	// The host. A failure here, including the permission read in front of it,
	// stops the save before anything is written.
	if (flipped) {
		try {
			await setAboutSpaceReadPolicy({ db, env, group: fresh, callerDid });
		} catch (e) {
			return nothingSaved(e, data.visibility);
		}
	}

	try {
		await updateGroup(db, group.id, {
			name: data.name,
			description: data.description || null,
			visibility: data.visibility,
			requireApproval: data.requireApproval
		});
	} catch (e) {
		// Without a flip nothing has landed, and the row's refusal is the whole
		// answer.
		return flipped ? rowNotSaved(e, data.visibility) : formError(e);
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
		return recordsNotUpdated(e, flipped ? data.visibility : null);
	}
	return { ok: true };
}

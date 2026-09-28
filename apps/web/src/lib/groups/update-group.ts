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
//   refuse -> reads -> host (only when the visibility changes) -> row ->
//   declaration -> profile -> rules
//
// A private group open to join is refused from the form's own two fields,
// before anything else (`approvalRefusal`). No trigger can refuse it, because
// the visibility is the host's. Then every read comes first, the host's read
// policy among them, so a read that fails writes nothing anywhere. Whether the
// visibility changes is decided against the host, the only place that holds
// it: the page gate and the settings form read it there too.
//
// The host goes first of the writes because it is the group's visibility. If
// it refuses the change, nothing else is written: the host, the row and the
// records all still describe the group as it was, so saving again finds the
// same change and retries it. Once the host has taken the change, nothing puts
// it back. A later failure leaves the host ahead of the records, and the
// message says which writes landed. Saving again finishes it: the form shows
// what the host enforces, so the next save has no host change to make and
// writes the rest. "Repair this group" (./server/repair.ts) also brings the
// declaration in line with the host.
//
// The row goes next. It holds the profile's columns and the approval setting,
// and no visibility. The declaration comes before the profile and the rules,
// so a group that has just gone private stops being announced even when a
// later write fails.
import type { CredentialStoreEnv } from './server/credentials';
import { updateGroup } from './server/repo';
import { GroupCredentialError, groupWriter, type GroupRepoWriter } from './server/event-writer';
import { approvalRefusal, groupFace, splitRuleLines } from './about-record';
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

/** Said after a switch to private that stopped before the declaration was
 *  withdrawn: browse lists what is declared, so the group is still in it. */
const STILL_LISTED = 'Its declaration was not withdrawn, so it is still listed in browse.';

/** A read failed, before the first write. Nothing landed anywhere, so saving
 *  again retries it. `failed` names the read, because the host refusing the
 *  change is a different failure with its own message (`hostRefused`). */
function nothingSaved(failed: string, e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `Nothing was saved, because ${failed}: ${describeError(e)}. Saving again will retry it.`
	};
}

/** The host refused the visibility change, the first write, so nothing else
 *  was written either. */
function hostRefused(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `The visibility change did not reach the group's PDS: ${describeError(
			e
		)}. Nothing was saved, so the group's visibility was not changed, and saving again will retry it.`
	};
}

/** The host took the visibility change and the row did not. The host is what
 *  the group's pages read, so the group already has the new visibility, and
 *  the form now shows it: saving again has no host change to make and writes
 *  the rest. */
function rowNotSaved(e: unknown, to: GroupVisibility): GroupFormFailure {
	return {
		ok: false,
		error: `The group's PDS now reads it as ${to}, but this site did not save the change: ${describeError(
			e
		)}. The group's declaration, profile and rules were not updated either.${
			to === 'private' ? ` ${STILL_LISTED}` : ''
		} Saving the settings again finishes it.`
	};
}

/** A write to the group's records failed after the row was saved, and after the
 *  host when `to` names the visibility it took. `withdrawn` says whether a
 *  switch to private got its declaration withdrawn before the failure. */
function recordsNotUpdated(
	e: unknown,
	to: GroupVisibility | null,
	withdrawn: boolean
): GroupFormFailure {
	const landed = to
		? `Settings were saved and the group's PDS now reads it as ${to}`
		: 'Settings were saved';
	const listed = to === 'private' && !withdrawn ? ` ${STILL_LISTED}` : '';
	return {
		ok: false,
		error: `${landed}, but this group's records were not updated: ${describeError(e)}.${listed}`
	};
}

export async function runUpdateGroup(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow,
	callerDid: string,
	data: UpdateGroupData
): Promise<GroupFormResult> {
	// A private group requires approval to join. The form sends both halves of
	// that pair, so it is refused from them, before any read or write.
	const approval = approvalRefusal(data.visibility, data.requireApproval);
	if (approval) return { ok: false, error: approval };

	// The group as this save describes it. The records must describe the group
	// as it is after the save: the declaration and the about space's read policy
	// follow the chosen visibility, and the profile's `joinPolicy` is derived
	// from that choice and the approval setting.
	const fresh: GroupRow = {
		...group,
		name: data.name,
		description: data.description || null,
		require_approval: data.requireApproval ? 1 : 0
	};

	// Every read before the first write, the host's visibility among them.
	// `failed` names the read in progress, so a failure says which one it was.
	const noCredential = 'this site holds no credential it can use for the group';
	let failed = noCredential;
	let host: GroupVisibility;
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	try {
		const reader = await groupSpaceReader(env, db, group);
		if (!reader) throw new GroupCredentialError(group.group_did);
		failed = "the group's PDS did not say which visibility it enforces";
		host = await readGroupVisibility(reader, group);
		failed = "the group's profile and rules could not be read from its PDS";
		about = await readGroupAbout(reader, group);
		failed = noCredential;
		writer = await groupWriter(env, db, fresh);
	} catch (e) {
		return nothingSaved(failed, e);
	}

	// Only a change of visibility moves the about space's read policy, and a
	// save that keeps it does not write to the host at all. The change is
	// measured against the host, which is the only place that holds it.
	const flipped = host !== data.visibility;

	// The host. A failure here, including the permission read in front of it,
	// stops the save before anything is written.
	if (flipped) {
		try {
			await setAboutSpaceReadPolicy({
				db,
				env,
				group: fresh,
				callerDid,
				visibility: data.visibility
			});
		} catch (e) {
			return hostRefused(e);
		}
	}

	try {
		await updateGroup(db, group.id, {
			name: data.name,
			description: data.description || null,
			requireApproval: data.requireApproval
		});
	} catch (e) {
		// Without a flip nothing has landed, and the row's refusal is the whole
		// answer.
		return flipped ? rowNotSaved(e, data.visibility) : formError(e);
	}

	// Whether the declaration step finished, so a failure after it can say the
	// group is no longer listed.
	let declarationDone = false;
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
			visibility: data.visibility,
			callerDid,
			writer,
			createdAt: about.profile?.createdAt ?? undefined
		});
		declarationDone = true;
		await writeGroupProfile({
			db,
			env,
			group: fresh,
			visibility: data.visibility,
			callerDid,
			writer,
			profile: {
				name: data.name,
				description: data.description || null,
				// Not on the settings form, so it is kept rather than cleared. It
				// comes from the record when there is one, so a stale row cannot be
				// written back into it.
				locationName: groupFace(about.profile, group, host).locationName,
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
		return recordsNotUpdated(e, flipped ? data.visibility : null, declarationDone);
	}
	return { ok: true };
}

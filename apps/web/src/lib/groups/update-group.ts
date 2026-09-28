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
//   refuse -> reads -> decide the visibility -> host (only when the owner
//   changed it) -> then, by where the group ends up:
//
//     private   withdraw the declaration -> row -> profile -> rules
//     public    row -> read the host again -> declaration -> profile -> rules
//
// A private group open to join is refused from the form's own two fields,
// before anything else (`approvalRefusal`). No trigger can refuse it, because
// the visibility is the host's. Then every read comes first, the host's read
// policy among them, so a read that fails writes nothing anywhere.
//
// WHICH VISIBILITY. The host is the only place that holds it, and any client
// can move it while a settings tab sits open, so the form's choice alone
// cannot say whether the owner changed it: a tab opened before someone else
// made the group private still shows public, and saving it untouched would
// make the group public again. So the form also sends the visibility it
// showed, and only a difference between the two is a change the owner asked
// for. Against the host, read in the read phase:
//
//   chosen = shown           untouched, so the host's value stands
//   chosen != shown = host   a change, so the host takes the choice
//   chosen != shown != host  the host has already moved to the choice (there
//                            are two values), so there is nothing to change
//   nothing shown            the page could not read the host when it opened,
//                            or predates this field. A choice that matches
//                            the host now is untouched; one that differs is
//                            refused before any write, because a change and a
//                            stale default look alike
//
// Every later step (the declaration, the profile, the rules) follows the
// visibility that decision settles on, never the form's choice by itself.
// There is no lock around it, which is why the public side reads the host
// again below. The approval control is drawn for the chosen visibility, so
// when the save settles on the other one the row's approval stands, for the
// row and for the profile's join policy alike.
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
// After the host, where the group ends up sets the order, because browse
// shows a declared group's name and description from the row: the
// declaration holds only a pointer and a date. A group ending up private
// withdraws its declaration before the row takes the new text, so a
// withdrawal that fails leaves browse showing what strangers already saw, not
// text written for members. A group ending up public writes the row first, so
// it is announced with its new text in place.
//
// Announcing needs a fresh answer. The public side reads the host again just
// before the declaration, and declares only when that read says public; the
// only step between the two is the permission check in front of every group
// write. When the read says private, someone moved the host while this save
// ran, so the declaration is withdrawn instead and the profile follows that
// read. That save still succeeds: the owner's own fields were saved, and the
// visibility is someone else's change. When the read fails, nothing is
// declared or withdrawn, and the message says so. The moment left between
// that read and the write is Repair's to heal.
//
// On both sides the declaration comes before the profile and the rules, so a
// group that has just gone private stops being announced even when a later
// write fails. The row holds the profile's columns and the approval setting,
// and no visibility.
import type { CredentialStoreEnv } from './server/credentials';
import { updateGroup } from './server/repo';
import { GroupCredentialError, groupWriter, type GroupRepoWriter } from './server/event-writer';
import { approvalRefusal, groupFace, splitRuleLines } from './about-record';
import {
	groupSpaceReader,
	readGroupAbout,
	type GroupAbout,
	type GroupSpaceReader
} from './server/about-read';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { declarationRequired } from './declaration-record';
import { readGroupVisibility, setAboutSpaceReadPolicy } from './server/spaces';
import { formError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import type { GroupRow, GroupVisibility } from './types';

/** The validated form payload. `updateGroupForm`'s valibot schema is checked
 *  against this shape at the callsite, so the two cannot drift silently. */
export interface UpdateGroupData {
	name: string;
	description?: string;
	/** The visibility chosen on the form. */
	visibility: GroupVisibility;
	/** The visibility the form showed when the page opened: the host's, as the
	 *  page read it. Absent when the page could not read it, and from a form
	 *  that predates this field; both mean "shown unknown". Only a choice that
	 *  differs from it changes the visibility. */
	shownVisibility?: GroupVisibility;
	/** Always supplied by the form: `checkboxField` parses an unticked box as
	 *  `false`, not as missing. */
	requireApproval: boolean;
	/** One rule per non-empty line. */
	rules?: string;
}

const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Said after a save that left the group private but could not withdraw its
 *  declaration: browse lists what is declared, so the group is still in it. */
const STILL_LISTED = 'Its declaration was not withdrawn, so it is still listed in browse.';

/** The form sent no shown visibility, because its page could not read the
 *  host or was rendered before the form carried one, and the choice differs
 *  from what the host holds now. A change the owner made and a default the
 *  host has since left behind look the same from here, so nothing is written. */
const SHOWN_UNKNOWN =
	'This save cannot tell which visibility the page showed: either the page could not read it when it opened, or the page was opened before this site was updated. So it cannot tell whether you changed the visibility. Nothing was saved. Reload the page and save again.';

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

/** A group ending up private whose declaration could not be withdrawn. The
 *  row, the profile and the rules all come after the withdrawal, so none of
 *  them was written, and browse keeps showing the text it showed before this
 *  save. The host has the change when `flipped`; the form now shows private,
 *  so saving again has no host change to make and withdraws first. */
function notWithdrawn(e: unknown, flipped: boolean): GroupFormFailure {
	return {
		ok: false,
		error: `The group's PDS ${flipped ? 'now reads' : 'reads'} it as private, but its declaration could not be withdrawn: ${describeError(
			e
		)}. ${STILL_LISTED} Its name, description, approval setting, profile and rules were not saved, so browse still shows what it showed before. Saving the settings again finishes it.`
	};
}

/** The row refused this save after an earlier write landed. Going private,
 *  that is the withdrawal, and the host when `flipped`. Going public, only a
 *  flip lands before the row. The group already has the visibility the host
 *  reports, and the form now shows it, so saving again has no host change to
 *  make and writes the rest. */
function rowNotSaved(e: unknown, to: GroupVisibility, flipped: boolean): GroupFormFailure {
	const host = `The group's PDS ${flipped ? 'now reads' : 'reads'} it as ${to}`;
	const landed =
		to === 'private'
			? `${host} and its declaration is withdrawn, so browse does not list it, but this site did not save the change: ${describeError(
					e
				)}. The group's profile and rules were not updated either.`
			: `${host}, but this site did not save the change: ${describeError(
					e
				)}. The group's declaration, profile and rules were not updated either.`;
	return { ok: false, error: `${landed} Saving the settings again finishes it.` };
}

/** A group ending up public saved its row, then could not read the host again
 *  before the declaration. Announcing needs a fresh public answer, so this
 *  save neither publishes nor withdraws the declaration, and the profile and
 *  the rules after it are not written. The group may already have been
 *  declared, or not, so the message says only what this save did. */
function notAnnounced(e: unknown, flipped: boolean): GroupFormFailure {
	const landed = flipped
		? "The group's PDS took the change to public and this site saved the settings"
		: 'This site saved the settings';
	return {
		ok: false,
		error: `${landed}, but this save neither published nor withdrew the group's declaration, which is what lists it in browse: its PDS did not answer when asked again whether it is public (${describeError(
			e
		)}). The declaration is as it was before this save, and the group's profile and rules were not updated. Saving the settings again finishes it.`
	};
}

/** A write to the group's records failed after the row was saved, and after the
 *  host when `to` names the visibility it took. `listed` says the group ended
 *  up private and its declaration was not withdrawn before the failure.
 *
 *  Saving again finishes it on either side. The form then shows what the host
 *  holds, so the next save has no host change to make, and it writes the
 *  declaration (or withdraws it), the profile and the rules again. */
function recordsNotUpdated(
	e: unknown,
	to: GroupVisibility | null,
	listed: boolean
): GroupFormFailure {
	const landed = to
		? `Settings were saved and the group's PDS now reads it as ${to}`
		: 'Settings were saved';
	return {
		ok: false,
		error: `${landed}, but this group's records were not updated: ${describeError(e)}.${
			listed ? ` ${STILL_LISTED}` : ''
		} Saving the settings again finishes it.`
	};
}

/** What the read phase found, and what this save decided, carried into the
 *  write phase. */
interface SaveState {
	env: CredentialStoreEnv;
	db: D1Database;
	/** The group as it was loaded. */
	group: GroupRow;
	/** The group as this save describes it. */
	fresh: GroupRow;
	callerDid: string;
	data: UpdateGroupData;
	reader: GroupSpaceReader;
	about: GroupAbout;
	writer: GroupRepoWriter;
	/** Whether this save moved the host. */
	flipped: boolean;
	/** The approval this save writes: the form's, or the row's when the save
	 *  settles on a visibility the form did not choose. */
	requireApproval: boolean;
}

function writeRow(s: SaveState): Promise<void> {
	return updateGroup(s.db, s.group.id, {
		name: s.data.name,
		description: s.data.description || null,
		requireApproval: s.requireApproval
	});
}

/** Declares the group for `public` and withdraws its declaration otherwise
 *  (`reconcileGroupDeclaration`). Switching back to public declares it again,
 *  dated from the group's creation date (taken from the profile, so no extra
 *  read), because the declaration says when the group was created, not when
 *  its visibility last changed. */
function reconcileDeclaration(s: SaveState, visibility: GroupVisibility) {
	return reconcileGroupDeclaration({
		db: s.db,
		env: s.env,
		group: s.fresh,
		visibility,
		callerDid: s.callerDid,
		writer: s.writer,
		createdAt: s.about.profile?.createdAt ?? undefined
	});
}

/** The profile, then the rules. The profile's `joinPolicy` is derived from
 *  `visibility` and the approval setting. */
async function writeProfileAndRules(s: SaveState, visibility: GroupVisibility): Promise<void> {
	await writeGroupProfile({
		db: s.db,
		env: s.env,
		group: s.fresh,
		visibility,
		callerDid: s.callerDid,
		writer: s.writer,
		profile: {
			name: s.data.name,
			description: s.data.description || null,
			// Not on the settings form, so it is kept rather than cleared. It
			// comes from the record when there is one, so a stale row cannot be
			// written back into it.
			locationName: groupFace(s.about.profile, s.group, visibility).locationName,
			// Preserved, so editing a group does not restamp its creation date.
			createdAt: s.about.profile?.createdAt ?? undefined
		}
	});
	await setGroupRules({
		db: s.db,
		env: s.env,
		group: s.fresh,
		callerDid: s.callerDid,
		writer: s.writer,
		desired: splitRuleLines(s.data.rules),
		existing: s.about.rules
	});
}

/** A save that leaves the group private: the withdrawal first, then the row,
 *  so the row never takes new text while the group is still announced. A
 *  group switched to private has its declaration deleted, not just left
 *  alone: the declaration is the only record an anonymous peer can see, and a
 *  stale one keeps announcing a group that asked not to be announced. */
async function saveAsPrivate(s: SaveState): Promise<GroupFormResult> {
	try {
		await reconcileDeclaration(s, 'private');
	} catch (e) {
		return notWithdrawn(e, s.flipped);
	}
	try {
		await writeRow(s);
	} catch (e) {
		return rowNotSaved(e, 'private', s.flipped);
	}
	try {
		await writeProfileAndRules(s, 'private');
	} catch (e) {
		return recordsNotUpdated(e, s.flipped ? 'private' : null, false);
	}
	return { ok: true };
}

/** A save that leaves the group public: the row first, then a fresh host read,
 *  and the declaration only when that read still says public. Any other
 *  answer means someone moved the host while this save ran; the group is then
 *  withdrawn rather than announced, and the profile follows the same read. */
async function saveAsPublic(s: SaveState): Promise<GroupFormResult> {
	try {
		await writeRow(s);
	} catch (e) {
		// Without a flip nothing has landed, and the row's refusal is the whole
		// answer.
		return s.flipped ? rowNotSaved(e, 'public', true) : formError(e);
	}

	let now: GroupVisibility;
	try {
		now = await readGroupVisibility(s.reader, s.group);
	} catch (e) {
		return notAnnounced(e, s.flipped);
	}

	// Whether the declaration step finished, so a failure after it can say
	// whether the group is still listed.
	let declarationDone = false;
	try {
		await reconcileDeclaration(s, now);
		declarationDone = true;
		await writeProfileAndRules(s, now);
	} catch (e) {
		return recordsNotUpdated(
			e,
			s.flipped && now === 'public' ? 'public' : null,
			!declarationRequired(now) && !declarationDone
		);
	}
	return { ok: true };
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

	// Every read before the first write, the host's visibility among them.
	// `failed` names the read in progress, so a failure says which one it was.
	const noCredential = 'this site holds no credential it can use for the group';
	let failed = noCredential;
	let reader: GroupSpaceReader;
	let host: GroupVisibility;
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	try {
		const found = await groupSpaceReader(env, db, group);
		if (!found) throw new GroupCredentialError(group.group_did);
		reader = found;
		failed = "the group's PDS did not say which visibility it enforces";
		host = await readGroupVisibility(reader, group);
		failed = "the group's profile and rules could not be read from its PDS";
		about = await readGroupAbout(reader, group);
		failed = noCredential;
		writer = await groupWriter(env, db, group);
	} catch (e) {
		return nothingSaved(failed, e);
	}

	// Which visibility the group leaves this save with (the header's table).
	// Only a choice that differs from what the form showed is a change, and
	// only when the host still holds what the form showed does the change move
	// the host. Otherwise the host's value stands.
	const shown = data.shownVisibility;
	if (shown === undefined && data.visibility !== host) {
		return { ok: false, error: SHOWN_UNKNOWN };
	}
	const flipped = shown !== undefined && data.visibility !== shown && shown === host;
	const visibility: GroupVisibility = flipped ? data.visibility : host;

	// The approval control is drawn for the chosen visibility: a private choice
	// fixes it on. When the save settles on the other visibility, the form's
	// approval was drawn for a group this one will not be, so the row's stands.
	const requireApproval =
		visibility === data.visibility ? data.requireApproval : Boolean(group.require_approval);

	// The group as this save describes it. The records must describe the group
	// as it is after the save: the declaration and the about space's read policy
	// follow the visibility this save settles on, and the profile's `joinPolicy`
	// is derived from that and the approval above.
	const fresh: GroupRow = {
		...group,
		name: data.name,
		description: data.description || null,
		require_approval: requireApproval ? 1 : 0
	};

	// The host. A failure here, including the permission read in front of it,
	// stops the save before anything is written.
	if (flipped) {
		try {
			await setAboutSpaceReadPolicy({
				db,
				env,
				group: fresh,
				callerDid,
				visibility
			});
		} catch (e) {
			return hostRefused(e);
		}
	}

	const state: SaveState = {
		env,
		db,
		group,
		fresh,
		callerDid,
		data,
		reader,
		about,
		writer,
		flipped,
		requireApproval
	};
	return declarationRequired(visibility) ? saveAsPublic(state) : saveAsPrivate(state);
}

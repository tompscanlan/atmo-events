// The settings save, as a plain function so a test can call it.
// `updateGroupForm` resolves the group and checks MANAGE_GROUP first.
//
// Each failure between two writes leaves a different half-state, so the order
// is fixed, and every read comes before the first write:
//
//   refuse -> reads -> decide the visibility -> host, if it changed -> then
//     private   withdraw the declaration -> row -> access -> profile -> rules
//     public    row -> read the host again -> access -> declaration -> profile -> rules
//
// The visibility lives only at the host, and another client can change it
// while a settings tab is open. So the form also sends the visibility it
// showed, and only a choice that differs from it is a change:
//
//   chosen = shown           untouched, so the host's value stands
//   chosen != shown = host   a change, so the host takes the choice
//   chosen != shown != host  the host already moved, so nothing changes
//   nothing shown            refused if the choice differs from the host,
//                            since a change and a stale default look alike
//
// Every later step follows the visibility this settles on. The host is written
// first. If it refuses, nothing else is written. After it, a failure leaves
// the host ahead of the records, and saving again writes the rest.
//
// Browse shows a declared group's name from the row. So a group going private
// withdraws its declaration before the row takes new text. A group going
// public writes the row first, and is declared only if a fresh host read still
// says public. The gap between that read and the write is left to the repair
// (server/repair.ts).
//
// The about space's access record says the visibility too, and is written only
// when it says something else. A declared group's access must say public, so it
// goes before a declaration is published and after one is withdrawn.

import { updateGroup } from './server/repo';

import { approvalRefusal, groupFace, splitRuleLines } from './about-record';
import {
	groupSpaceReader,
	readAboutAccess,
	readGroupAbout,
	type GroupAbout,
	type GroupSpaceReader
} from './server/about-read';
import { setGroupRules, writeGroupProfile, alignAboutAccess } from './server/about-writer';
import { ABOUT_SPACE_READER_ROLES, type GroupAccessFields } from './members-record';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { declarationRequired } from './declaration-record';
import { readGroupVisibility, setAboutSpaceReadPolicy } from './server/spaces';
import { knownFormError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import type { GroupRow, GroupVisibility } from './types';

import { groupWriter, type GroupRepoWriter } from './server/group-write';
import { errorText } from './server/errors';
import { type CredentialStoreEnv, GroupCredentialError } from './server/session';
export interface UpdateGroupData {
	name: string;
	description?: string;
	/** The visibility chosen on the form. */
	visibility: GroupVisibility;
	/** The visibility the form showed: the host's, as the page read it. Absent
	 *  when the page could not read it. */
	shownVisibility?: GroupVisibility;
	requireApproval: boolean;
	/** One rule per non-empty line. */
	rules?: string;
}

const STILL_LISTED = 'Its declaration was not withdrawn, so it is still listed in browse.';

const SHOWN_UNKNOWN =
	'This save cannot tell which visibility the page showed: either the page could not read it when it opened, or the page was opened before this site was updated. So it cannot tell whether you changed the visibility. Nothing was saved. Reload the page and save again.';

/** A read failed before the first write, so nothing landed. */
function nothingSaved(failed: string, e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `Nothing was saved, because ${failed}: ${errorText(e)}. Saving again will retry it.`
	};
}

function hostRefused(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `The visibility change did not reach the group's PDS: ${errorText(
			e
		)}. Nothing was saved, so the group's visibility was not changed, and saving again will retry it.`
	};
}

function notWithdrawn(e: unknown, flipped: boolean): GroupFormFailure {
	return {
		ok: false,
		error: `The group's PDS ${flipped ? 'now reads' : 'reads'} it as private, but its declaration could not be withdrawn: ${errorText(
			e
		)}. ${STILL_LISTED} Its name, description, approval setting, profile and rules were not saved, so browse still shows what it showed before. Saving the settings again finishes it.`
	};
}

/** The row refused this save after an earlier write landed. */
function rowNotSaved(e: unknown, to: GroupVisibility, flipped: boolean): GroupFormFailure {
	const host = `The group's PDS ${flipped ? 'now reads' : 'reads'} it as ${to}`;
	const landed =
		to === 'private'
			? `${host} and its declaration is withdrawn, so browse does not list it, but this site did not save the change: ${errorText(
					e
				)}. The group's profile and rules were not updated either.`
			: `${host}, but this site did not save the change: ${errorText(
					e
				)}. The group's declaration, profile and rules were not updated either.`;
	return { ok: false, error: `${landed} Saving the settings again finishes it.` };
}

/** A group ending up public saved its row, then could not read the host again
 *  before the declaration. */
function notAnnounced(e: unknown, flipped: boolean): GroupFormFailure {
	const landed = flipped
		? "The group's PDS took the change to public and this site saved the settings"
		: 'This site saved the settings';
	return {
		ok: false,
		error: `${landed}, but this save neither published nor withdrew the group's declaration, which is what lists it in browse: its PDS did not answer when asked again whether it is public (${errorText(
			e
		)}). The declaration is as it was before this save, and the group's profile and rules were not updated. Saving the settings again finishes it.`
	};
}

/** A record write failed after the row was saved. `to` is the visibility the
 *  host took, when this save moved it. `listed` means a group ending up
 *  private still has its declaration. */
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
		error: `${landed}, but this group's records were not updated: ${errorText(e)}.${
			listed ? ` ${STILL_LISTED}` : ''
		} Saving the settings again finishes it.`
	};
}

/** What the read phase found and what this save decided. */
interface SaveState {
	/** The group as it was loaded. */
	group: GroupRow;
	/** The group as this save describes it. */
	fresh: GroupRow;
	data: UpdateGroupData;
	about: GroupAbout;
	/** The about space's access record as read, then as this save last wrote it. */
	access: GroupAccessFields | null;
	/** Whether this save moved the host. */
	flipped: boolean;
	requireApproval: boolean;
	/** What every write of this save shares: the group as this save describes it,
	 *  the caller, and the one writer and reader the save built. */
	as: {
		db: D1Database;
		env: CredentialStoreEnv;
		group: GroupRow;
		callerDid: string;
		writer: GroupRepoWriter;
		reader: GroupSpaceReader;
	};
}

function writeRow(s: SaveState): Promise<void> {
	return updateGroup(s.as.db, s.group.id, {
		name: s.data.name,
		description: s.data.description || null,
		requireApproval: s.requireApproval
	});
}

/** Declares a public group and withdraws the declaration otherwise. A new
 *  declaration is dated from the group's creation, not from this save. */
function reconcileDeclaration(s: SaveState, visibility: GroupVisibility) {
	return reconcileGroupDeclaration({
		...s.as,
		visibility,
		createdAt: s.about.profile?.createdAt ?? undefined
	});
}

/** Writes the about space's access record when it does not already say
 *  `visibility`, and keeps what it wrote, so a second call writes nothing. */
async function alignAccess(s: SaveState, visibility: GroupVisibility): Promise<void> {
	if (await alignAboutAccess({ ...s.as, visibility }, s.access)) {
		s.access = { roles: [...ABOUT_SPACE_READER_ROLES], public: visibility === 'public' };
	}
}

/** The about space's records: the access record, if it disagrees, then the
 *  profile, whose `joinPolicy` is derived from `visibility` and the approval,
 *  then the rules. */
async function writeAboutRecords(s: SaveState, visibility: GroupVisibility): Promise<void> {
	await alignAccess(s, visibility);
	await writeGroupProfile({
		...s.as,
		visibility,
		profile: {
			name: s.data.name,
			description: s.data.description || null,
			// Not on the settings form, so kept. Read from the record when there
			// is one, so a stale row is not written back.
			locationName: groupFace(s.about.profile, s.group, visibility).locationName,
			createdAt: s.about.profile?.createdAt ?? undefined
		}
	});
	await setGroupRules({
		...s.as,
		desired: splitRuleLines(s.data.rules),
		existing: s.about.rules
	});
}

/** The declaration is deleted, not left alone: it is the only record an
 *  anonymous peer can see, and a stale one keeps announcing the group. */
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
		await writeAboutRecords(s, 'private');
	} catch (e) {
		return recordsNotUpdated(e, s.flipped ? 'private' : null, false);
	}
	return { ok: true };
}

/** If the fresh host read says private, someone moved the host during this
 *  save, so the declaration is withdrawn and the profile follows that read. */
async function saveAsPublic(s: SaveState): Promise<GroupFormResult> {
	try {
		await writeRow(s);
	} catch (e) {
		// Without a flip nothing has landed yet.
		if (s.flipped) return rowNotSaved(e, 'public', true);
		return (
			knownFormError(e) ?? nothingSaved("this site's copy of the group could not be updated", e)
		);
	}

	let now: GroupVisibility;
	try {
		now = await readGroupVisibility(s.as.reader, s.group);
	} catch (e) {
		return notAnnounced(e, s.flipped);
	}

	let declarationDone = false;
	try {
		// Public: the access record before the declaration. Private, because the
		// host moved during this save: after the withdrawal, with the profile.
		if (declarationRequired(now)) await alignAccess(s, now);
		await reconcileDeclaration(s, now);
		declarationDone = true;
		await writeAboutRecords(s, now);
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
	// A private group must require approval to join.
	const approval = approvalRefusal(data.visibility, data.requireApproval);
	if (approval) return { ok: false, error: approval };

	// `failed` names the read in progress, for the error message.
	const noCredential = 'this site holds no credential it can use for the group';
	let failed = noCredential;
	let reader: GroupSpaceReader;
	let host: GroupVisibility;
	let about: GroupAbout;
	let access: GroupAccessFields | null;
	let writer: GroupRepoWriter;
	try {
		const found = await groupSpaceReader(env, group);
		if (!found) throw new GroupCredentialError(group.group_did);
		reader = found;
		failed = "the group's PDS did not say which visibility it enforces";
		host = await readGroupVisibility(reader, group);
		failed = "the group's profile and rules could not be read from its PDS";
		about = await readGroupAbout(reader, group);
		failed = "the group's access record could not be read from its PDS";
		access = await readAboutAccess(reader, group);
		failed = noCredential;
		writer = await groupWriter(env, group);
	} catch (e) {
		return nothingSaved(failed, e);
	}

	// See the table in the header.
	const shown = data.shownVisibility;
	if (shown === undefined && data.visibility !== host) {
		return { ok: false, error: SHOWN_UNKNOWN };
	}
	const flipped = shown !== undefined && data.visibility !== shown && shown === host;
	const visibility: GroupVisibility = flipped ? data.visibility : host;

	// The form's approval control was drawn for the chosen visibility. When the
	// save settles on the other one, the row's approval stands.
	const requireApproval =
		visibility === data.visibility ? data.requireApproval : Boolean(group.require_approval);

	const fresh: GroupRow = {
		...group,
		name: data.name,
		description: data.description || null,
		require_approval: requireApproval ? 1 : 0
	};

	// A refusal here, the permission check included, stops the save before any
	// write.
	if (flipped) {
		try {
			await setAboutSpaceReadPolicy({ db, env, group: fresh, callerDid, reader, visibility });
		} catch (e) {
			return hostRefused(e);
		}
	}

	const state: SaveState = {
		group,
		fresh,
		data,
		about,
		access,
		flipped,
		requireApproval,
		as: { db, env, group: fresh, callerDid, writer, reader }
	};
	return declarationRequired(visibility) ? saveAsPublic(state) : saveAsPrivate(state);
}

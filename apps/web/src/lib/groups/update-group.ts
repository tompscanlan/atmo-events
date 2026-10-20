// The settings save, as a plain function so a test can call it.
// `updateGroupForm` resolves the group and checks MANAGE_GROUP first.
//
// The group's visibility is its about space's `access.public`. The group's host
// decides every read of the space from that record, so the save sends no read
// policy and no member list: the record is the policy. (Spec: FR-214.) Each
// failure between two writes leaves a different half-state, so the order is
// fixed, and every read comes before the first write:
//
//   refuse -> reads -> decide the visibility -> then
//     private   withdraw the declaration -> access, if public -> row -> profile
//                 -> rules
//     public    access, if private -> row -> read access again -> declaration
//                 -> profile -> rules
//
// Saving again finishes a save that stopped part way.
//
// Another client can change the visibility while a settings tab is open. So the
// form also sends the visibility it showed, and only a choice that differs from
// it is a change:
//
//   chosen = shown             untouched, so the record's value stands
//   chosen != shown = record   a change, so the record takes the choice
//   chosen != shown != record  the record already moved, so nothing changes
//   nothing shown              refused if the choice differs from the record,
//                              since a change and a stale default look alike
//
// Every later step follows the visibility this settles on.
//
// Browse shows a declared group's name from the row, and a group is declared
// only while its access says public. So a group going private withdraws its
// declaration, and has our index drop it, before the record says private and
// before the row takes new text. If the index cannot be told, the save stops
// there. A group going public writes the row first, and is declared only if a
// fresh read of its access still says public. A group made private between
// that read and the write keeps a declaration until its settings are saved
// again.

import {
	approvalRefusal,
	groupFace,
	GROUP_PROFILE_COLLECTION,
	splitRuleLines
} from './about-record';
import {
	readAboutAccess,
	readGroupAbout,
	type GroupAbout,
	type GroupSpaceReader
} from './server/about-read';
import { setGroupRules, writeGroupProfile, alignAboutAccess } from './server/about-writer';
import {
	ABOUT_SPACE_READER_ROLES,
	groupAccessRecord,
	parseGroupAccess,
	type GroupAccessFields
} from './members-record';
import { DeclarationIndexError, reconcileGroupDeclaration } from './server/declaration-writer';
import { declarationRequired } from './declaration-record';
import { visibilityFromAccess } from './server/spaces';
import { knownFormError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';

import {
	GroupPermissionError,
	groupWriter,
	requireGroupWrite,
	type GroupRepoWriter
} from './server/group-write';
import { spaceWrite } from './grants';
import { errorText } from './server/errors';
import { type CredentialStoreEnv } from './server/session';
import { updateGroup } from './server/db/groups';
const PROFILE_WRITE = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');

export interface UpdateGroupData {
	name: string;
	description?: string;
	/** The visibility chosen on the form. */
	visibility: GroupVisibility;
	/** The visibility the form showed: the access record's, as the page read it. Absent
	 *  when the page could not read it. */
	shownVisibility?: GroupVisibility;
	requireApproval: boolean;
	/** One rule per non-empty line. */
	rules?: string;
}

const STILL_LISTED = 'Its declaration was not withdrawn, so it is still listed in browse.';

const NO_READ_ACCESS =
	'Nothing was saved: your sign-in does not let this site read the group’s spaces, so the save cannot see what it would change. Signing in again may fix it.';

const SHOWN_UNKNOWN =
	'This save cannot tell which visibility the page showed: either the page could not read it when it opened, or the page was opened before this site was updated. So it cannot tell whether you changed the visibility. Nothing was saved. Reload the page and save again.';

/** A read failed before the first write, so nothing landed. */
function nothingSaved(failed: string, e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `Nothing was saved, because ${failed}: ${errorText(e)}. Saving again will retry it.`
	};
}

/** The save's first visibility write failed: the access record's, opening the
 *  group. */
function visibilityRefused(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `The visibility change did not reach the group's PDS: ${errorText(
			e
		)}. Nothing was saved, so the group's visibility was not changed, and saving again will retry it.`
	};
}

/** A narrowing that stopped before the record said private. The record is the
 *  visibility, so the group is still public, and the page shows it so: an
 *  untouched save would leave it public. The owner chooses private again. */
const STILL_PUBLIC =
	'Its access record still says public, so the group is still public, and its name, description, approval setting, profile and rules were not saved. Choose private and save the settings again to finish making it private.';

/** A narrowing withdrew the declaration, and the access record then refused to
 *  say private. */
function accessNotNarrowed(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `Its declaration is withdrawn, but its access record could not be changed: ${errorText(e)}. ${STILL_PUBLIC}`
	};
}

/** The declaration was not withdrawn, or our index was not told. Before a flip's
 *  record write, so a flipped group is still public. The withdrawal is a
 *  narrowing's first write, and a refusal by the caller's roles is not one that
 *  saving again finishes. */
function notWithdrawn(e: unknown, flipped: boolean): GroupFormFailure {
	if (e instanceof GroupPermissionError) {
		return {
			ok: false,
			error: `Not allowed: ${e.reason}. Nothing was saved: the group is still ${
				flipped ? 'public' : 'private'
			} and still listed in browse.`
		};
	}
	const landed =
		e instanceof DeclarationIndexError
			? `Its declaration is withdrawn at the group's host, but browse still lists it, because ${errorText(e)}.`
			: `Its declaration could not be withdrawn: ${errorText(e)}. ${STILL_LISTED}`;
	return {
		ok: false,
		error: flipped
			? `${landed} ${STILL_PUBLIC}`
			: `${landed} Its name, description, approval setting, profile and rules were not saved, so browse still shows what it showed before. Saving the settings again finishes it.`
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

/** A group ending up public saved its row, then could not read its access record
 *  again before the declaration. */
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
 *  group took, when this save moved it. `listed` means a group ending up
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
	/** Whether the owner changed the visibility. */
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

/** This site's copy of the group, which the group's host never sees, so the
 *  gate checks it here, on the scope that writes the profile it copies. */
async function writeRow(s: SaveState): Promise<void> {
	await requireGroupWrite(s.as, PROFILE_WRITE, { appOnly: true });
	await updateGroup(s.as.db, s.group.id, {
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
		s.access = parseGroupAccess(
			groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: visibility === 'public'
			})
		);
	}
}

/** The profile, whose `joinPolicy` is derived from `visibility` and the
 *  approval, then the rules. */
async function writeAboutRecords(s: SaveState, visibility: GroupVisibility): Promise<void> {
	await writeGroupProfile({
		...s.as,
		visibility,
		profile: {
			name: s.data.name,
			description: s.data.description || null,
			// Not on the settings form, so kept. Read from the record when there
			// is one, so a stale row is not written back.
			locationName: groupFace(s.about.profile, s.group, visibility).locationName,
			createdAt: s.about.profile?.createdAt ?? undefined,
			// Not on the settings form either, and the save rewrites the whole record.
			avatar: s.about.profile?.avatar ?? null
		}
	});
	await setGroupRules({
		...s.as,
		desired: splitRuleLines(s.data.rules),
		existing: s.about.rules
	});
}

/** A narrowing: the declaration goes first, then the record says private. The
 *  declaration is deleted, not left alone: it is the only record an anonymous
 *  peer can see, and a stale one keeps announcing the group. */
async function saveAsPrivate(s: SaveState): Promise<GroupFormResult> {
	// A refusal here stops the save before any write.
	try {
		await reconcileDeclaration(s, 'private');
	} catch (e) {
		return notWithdrawn(e, s.flipped);
	}
	try {
		await alignAccess(s, 'private');
	} catch (e) {
		return accessNotNarrowed(e);
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

/** A widening: the record says public first. If the fresh read of the record
 *  says private, someone narrowed it during this save, so the declaration is
 *  withdrawn and the profile follows that read. */
async function saveAsPublic(s: SaveState): Promise<GroupFormResult> {
	// A refusal at the record stops the save before any write.
	try {
		await alignAccess(s, 'public');
	} catch (e) {
		return visibilityRefused(e);
	}
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
		const fresh = await readAboutAccess(s.as.reader, s.group);
		now = visibilityFromAccess(fresh);
		s.access = fresh;
	} catch (e) {
		return notAnnounced(e, s.flipped);
	}

	let declarationDone = false;
	try {
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
	caller: { did: string; reader: GroupSpaceReader | null },
	data: UpdateGroupData
): Promise<GroupFormResult> {
	// A private group must require approval to join.
	const approval = approvalRefusal(data.visibility, data.requireApproval);
	if (approval) return { ok: false, error: approval };

	// What the save reads first, it reads with the caller's own access (TS
	// 2026-10-15); only the writes go as the group, on the caller's own group
	// session.
	const { did: callerDid, reader } = caller;
	if (!reader) return { ok: false, error: NO_READ_ACCESS };

	// `failed` names the read in progress, for the error message.
	const noCredential = 'this site holds no credential it can use for the group';
	let failed = noCredential;
	let access: GroupAccessFields | null;
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	try {
		if (!group.about_space_uri) throw new Error(`${group.group_did} has no about space yet`);
		failed = "the group's access record could not be read from its PDS";
		access = await readAboutAccess(reader, group);
		failed = "the group's profile and rules could not be read from its PDS";
		about = await readGroupAbout(reader, group);
		failed = noCredential;
		writer = await groupWriter(env, group, callerDid);
	} catch (e) {
		// A caller with no group session is theirs to fix, not a save to retry.
		return knownFormError(e) ?? nothingSaved(failed, e);
	}

	// See the table in the header.
	const current = visibilityFromAccess(access);
	const shown = data.shownVisibility;
	if (shown === undefined && data.visibility !== current) {
		return { ok: false, error: SHOWN_UNKNOWN };
	}
	const flipped = shown !== undefined && data.visibility !== shown && shown === current;
	const visibility: GroupVisibility = flipped ? data.visibility : current;

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

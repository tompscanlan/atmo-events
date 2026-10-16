// The settings save, as a plain function so a test can call it.
// `updateGroupForm` resolves the group and checks MANAGE_GROUP first.
//
// The group's visibility is its about space's `access.public`, and the space's
// read policy at the host follows it. No moment may find the space more open
// than the record says. (Spec: FR-214.) Each failure between two writes leaves
// a different half-state, so the order is fixed, and every read comes before
// the first write:
//
//   refuse -> reads -> decide the visibility -> then
//     private   host, if public -> withdraw the declaration -> access, if public
//                 -> row -> profile -> rules
//     public    access, if private -> host, if private -> row -> read access
//                 again -> declaration -> profile -> rules
//
// A narrowing closes the host first and a widening opens the record first, so
// a failure between the two leaves the host closed while the record says
// public, never the reverse. Saving again finishes it. The host is moved
// whenever it disagrees with the visibility the save settles on, so a save also
// finishes an earlier one that stopped between the two.
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
// fresh read of its access still says public. The gap between that read and the
// write is left to the repair (server/repair.ts).

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
import {
	aboutSpaceReadPolicy,
	groupSpaceUpdater,
	setAboutSpaceReadPolicy,
	visibilityFromAccess,
	type GroupSpaceUpdater
} from './server/spaces';
import { knownFormError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';

import {
	GroupPermissionError,
	groupWriter,
	requireGroupWrite,
	type GroupRepoWriter
} from './server/group-write';
import { isHostGroup } from './server/host-kind';
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

/** The save's first visibility write failed: the host's, closing it, or the
 *  access record's, opening it. */
function visibilityRefused(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `The visibility change did not reach the group's PDS: ${errorText(
			e
		)}. Nothing was saved, so the group's visibility was not changed, and saving again will retry it.`
	};
}

/** A widening wrote the access record, or found it already public, and the
 *  host then refused to open the about space. */
function notOpened(e: unknown, wroteAccess: boolean): GroupFormFailure {
	const record = wroteAccess
		? "The group's access record now says public"
		: "The group's access record says public";
	return {
		ok: false,
		error: `${record}, but its PDS did not open the group to everyone: ${errorText(
			e
		)}. Its name, description, approval setting, profile and rules were not saved, and browse does not list it. Saving the settings again finishes it.`
	};
}

/** A narrowing that stopped before the record said private. The record is the
 *  visibility, so the group is still public, and the page shows it so: an
 *  untouched save would open the host again. The owner chooses private again. */
const STILL_PUBLIC =
	'Its access record still says public, so the group is still public, and its name, description, approval setting, profile and rules were not saved. Choose private and save the settings again to finish making it private.';

/** A narrowing closed the host and withdrew the declaration, and the access
 *  record then refused to say private. A group host closes nothing ahead of the
 *  record (`atHost`). */
function accessNotNarrowed(e: unknown, atHost: boolean): GroupFormFailure {
	const landed = atHost
		? 'Its declaration is withdrawn'
		: "The group's PDS has closed it to non-members and its declaration is withdrawn";
	return {
		ok: false,
		error: `${landed}, but its access record could not be changed: ${errorText(e)}. ${STILL_PUBLIC}`
	};
}

/** The declaration was not withdrawn, or our index was not told. Before a flip's
 *  record write, so a flipped group is still public. A group host keeps the read
 *  policy from the record itself (`atHost`), so there the withdrawal is the
 *  first write, and a refusal by the caller's roles is not one that saving
 *  again finishes. */
function notWithdrawn(e: unknown, flipped: boolean, atHost: boolean): GroupFormFailure {
	if (atHost && e instanceof GroupPermissionError) {
		return {
			ok: false,
			error: `Not allowed: ${e.reason}. Nothing was saved: the group is still ${
				flipped ? 'public' : 'private'
			} and still listed in browse.`
		};
	}
	const host = atHost
		? null
		: flipped
			? "The group's PDS has closed it to non-members"
			: "The group's PDS reads it as private";
	const landed =
		e instanceof DeclarationIndexError
			? `${host ? `${host} and its declaration is withdrawn there` : "Its declaration is withdrawn at the group's host"}, but browse still lists it, because ${errorText(e)}.`
			: `${host ? `${host}, but its` : 'Its'} declaration could not be withdrawn: ${errorText(e)}. ${STILL_LISTED}`;
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
	/** The about space's read policy as read, then as this save last set it. */
	hostPolicy: string;
	/** Whether the owner changed the visibility. */
	flipped: boolean;
	/** Whether the group is at a group host, which keeps its read policies. */
	atHost: boolean;
	requireApproval: boolean;
	/** What every write of this save shares: the group as this save describes it,
	 *  the caller, and the one writer and reader the save built. `updater` is set
	 *  when the save moves the about space's read policy. */
	as: {
		db: D1Database;
		env: CredentialStoreEnv;
		group: GroupRow;
		callerDid: string;
		writer: GroupRepoWriter;
		reader: GroupSpaceReader;
		updater?: GroupSpaceUpdater;
	};
}

/** This site's copy of the group, which a group host never sees, so the gate
 *  checks it at a host too, on the scope that writes the profile it copies. */
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

/** Moves the about space's read policy to `visibility`'s when it is not there
 *  already, and keeps what it set. Gated on the scope that writes `access`. */
async function alignHost(s: SaveState, visibility: GroupVisibility): Promise<void> {
	const readPolicy = aboutSpaceReadPolicy(visibility);
	if (s.hostPolicy === readPolicy) return;
	await setAboutSpaceReadPolicy({ ...s.as, visibility });
	s.hostPolicy = readPolicy;
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

/** A narrowing: the host closes first, then the declaration goes, then the
 *  record says private. The declaration is deleted, not left alone: it is the
 *  only record an anonymous peer can see, and a stale one keeps announcing the
 *  group. */
async function saveAsPrivate(s: SaveState): Promise<GroupFormResult> {
	// A refusal here, the permission check included, stops the save before any
	// write.
	try {
		await alignHost(s, 'private');
	} catch (e) {
		return visibilityRefused(e);
	}
	try {
		await reconcileDeclaration(s, 'private');
	} catch (e) {
		return notWithdrawn(e, s.flipped, s.atHost);
	}
	try {
		await alignAccess(s, 'private');
	} catch (e) {
		return accessNotNarrowed(e, s.atHost);
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

/** A widening: the record says public first, then the host opens. If the fresh
 *  read of the record says private, someone narrowed it during this save, so
 *  the host closes again, the declaration is withdrawn and the profile follows
 *  that read. */
async function saveAsPublic(s: SaveState): Promise<GroupFormResult> {
	// A refusal at the record, the permission check included, stops the save
	// before any write.
	const wroteAccess = visibilityFromAccess(s.access) !== 'public';
	const opensHost = s.hostPolicy !== aboutSpaceReadPolicy('public');
	try {
		await alignAccess(s, 'public');
	} catch (e) {
		return visibilityRefused(e);
	}
	try {
		await alignHost(s, 'public');
	} catch (e) {
		return notOpened(e, wroteAccess);
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
		// Whoever narrowed the record closed the host first, but this save may
		// have opened it again since.
		if (!declarationRequired(now) && opensHost) await alignHost(s, now);
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
	let hostPolicy: string;
	let about: GroupAbout;
	let writer: GroupRepoWriter;
	let atHost: boolean;
	try {
		if (!group.about_space_uri) throw new Error(`${group.group_did} has no about space yet`);
		failed = "the group's access record could not be read from its PDS";
		access = await readAboutAccess(reader, group);
		failed = "the group's PDS did not say which visibility it enforces";
		({ readPolicy: hostPolicy } = await reader.getSpace(group.about_space_uri));
		failed = "the group's profile and rules could not be read from its PDS";
		about = await readGroupAbout(reader, group);
		failed = noCredential;
		writer = await groupWriter(env, group, callerDid);
		atHost = await isHostGroup(env, group.group_did);
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

	// The read policy is the stand-in host's to keep, on the session it acts on
	// (./server/session.ts), so a save that moves it finds that session before
	// anything is written.
	let updater: GroupSpaceUpdater | undefined;
	if (hostPolicy !== aboutSpaceReadPolicy(visibility)) {
		try {
			updater = await groupSpaceUpdater({ env, group });
		} catch (e) {
			return knownFormError(e) ?? nothingSaved(noCredential, e);
		}
	}

	const state: SaveState = {
		group,
		fresh,
		data,
		about,
		access,
		hostPolicy,
		flipped,
		atHost,
		requireApproval,
		as: { db, env, group: fresh, callerDid, writer, reader, updater }
	};
	return declarationRequired(visibility) ? saveAsPublic(state) : saveAsPrivate(state);
}

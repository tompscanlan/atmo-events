// Every read comes before the first write, and the writes go in this order, so saving
// again finishes a save that stopped partway:
//
//   private  withdraw the declaration -> access says private -> row -> profile
//   public   access says public -> row -> read access again -> declare if listed -> profile
//
// A visibility choice equal to the one the form showed keeps the record's.
import { GROUP_PROFILE_COLLECTION, type GroupJoinPolicy } from './about-record';
import { readAboutAccess, readGroupProfile, type GroupSpaceReader } from './server/about-read';
import { alignAboutAccess, writeGroupProfile } from './server/about-writer';
import { DeclarationIndexError, reconcileGroupDeclaration } from './server/declaration-writer';
import { visibilityFromAccess } from './server/spaces';
import { knownFormError } from './form-error';
import type { GroupFormFailure, GroupFormResult } from './form-result';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';
import { requireGroupWrite } from './server/group-write';
import { hostGroupWriter } from './server/host';
import { spaceWrite } from './grants';
import { errorText } from './server/errors';
import type { CredentialStoreEnv } from './server/session';
import { updateGroup } from './server/db/groups';

const PROFILE_WRITE = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');

export interface UpdateGroupData {
	name: string;
	description?: string;
	visibility: GroupVisibility;
	/** Absent when the page could not read it. */
	shownVisibility?: GroupVisibility;
	joinPolicy: GroupJoinPolicy;
	listed: boolean;
}

function nothingSaved(why: string, next = 'Saving again retries it.'): GroupFormFailure {
	return { ok: false, error: `Nothing was saved: ${why}. ${next}` };
}

function savedPartway(e: unknown): GroupFormFailure {
	return {
		ok: false,
		error: `The save stopped partway: ${errorText(e)}. Saving the settings again finishes it.`
	};
}

export async function runUpdateGroup(
	env: CredentialStoreEnv,
	db: D1Database,
	group: GroupRow,
	caller: { did: string; reader: GroupSpaceReader | null },
	data: UpdateGroupData
): Promise<GroupFormResult> {
	const { did: callerDid, reader } = caller;
	if (!reader) {
		return nothingSaved(
			'your sign-in does not let this site read the group’s spaces',
			'Signing in again may fix it.'
		);
	}

	let access, profile, writer;
	try {
		if (!group.about_space_uri) throw new Error(`${group.group_did} has no meta space yet`);
		access = await readAboutAccess(reader, group);
		profile = await readGroupProfile(reader, group);
		writer = await hostGroupWriter(env, group, callerDid);
	} catch (e) {
		return knownFormError(e) ?? nothingSaved(errorText(e));
	}

	const current = visibilityFromAccess(access);
	const shown = data.shownVisibility;
	if (shown === undefined && data.visibility !== current) {
		return nothingSaved(
			'this page could not tell whether you changed the visibility',
			'Reload the page and save again.'
		);
	}
	const visibility = shown === current ? data.visibility : current;

	const as = { db, env, group, callerDid, writer, reader };
	const description = data.description || null;
	const declare = (now: GroupVisibility) =>
		reconcileGroupDeclaration({ ...as, visibility: now, listed: data.listed });
	const writeRow = async () => {
		await requireGroupWrite(as, PROFILE_WRITE, { appOnly: true });
		await updateGroup(db, group.id, { name: data.name, description });
	};

	let wrote = false;
	try {
		if (visibility === 'private') {
			await declare('private');
			wrote = true;
			await alignAboutAccess({ ...as, visibility }, access);
			await writeRow();
		} else {
			wrote = await alignAboutAccess({ ...as, visibility }, access);
			await writeRow();
			wrote = true;
			await declare(visibilityFromAccess(await readAboutAccess(reader, group)));
		}
		await writeGroupProfile({
			...as,
			profile: { name: data.name, description, joinPolicy: data.joinPolicy, base: profile?.record }
		});
	} catch (e) {
		if (wrote || e instanceof DeclarationIndexError) return savedPartway(e);
		return knownFormError(e) ?? nothingSaved(errorText(e));
	}
	return { ok: true };
}

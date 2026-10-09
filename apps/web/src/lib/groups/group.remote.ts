// Creating a group, its settings, and its repair, as remote forms.
import { error } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { can } from './permissions';
import type { GroupFormResult } from './form-result';
import { knownFormError, notAllowed } from './form-error';
import { didField, groupSettingsFields, labelField, shownVisibilityField } from './form-fields';
import { runCreateGroup, type CreateGroupOutcome } from './create-group';
import { runUpdateGroup } from './update-group';
import { groupRequestContext } from './remote-context';
import { describeRepair, repairGroup } from './server/repair';
import { errorText } from './server/errors';

export const createGroupForm = form(
	v.object({
		...groupSettingsFields,
		label: labelField,
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		/** The group account's login. Length and shape are checked by
		 *  `runCreateGroup`, so its refusal reads as a sentence. */
		email: v.pipe(v.string(), v.trim(), v.maxLength(254)),
		/** Underscored so SvelteKit never echoes it back with a failed form. */
		_password: v.pipe(v.string(), v.maxLength(256))
	}),
	async ({ _password: password, ...data }): Promise<CreateGroupOutcome> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		// No redirect: the result carries the owner's rotation key, which is shown
		// once and stored nowhere, so a 303 would lose it.
		return runCreateGroup(platform!.env, locals.did, { ...data, password });
	}
);

export const updateGroupForm = form(
	v.object({
		groupDid: didField,
		...groupSettingsFields,
		/** What the form showed, so the save can tell a change from a stale default. */
		shownVisibility: shownVisibilityField
	}),
	async (data): Promise<GroupFormResult> => {
		const { db, env, group, membership, callerDid } = await groupRequestContext(data.groupDid);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		return runUpdateGroup(env, db, group, callerDid, data);
	}
);

/** Repairs a group whose records and this site's copy no longer agree
 *  (./server/repair.ts). Needs MANAGE_GROUP. */
export const repairGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ summary: string }>> => {
		const { db, env, group, membership, callerDid, reader } = await groupRequestContext(
			data.groupDid
		);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		try {
			const result = await repairGroup({ db, env, group, callerDid, reader });
			return { ok: true, summary: describeRepair(result) };
		} catch (e) {
			// Otherwise the PDS or the database failed partway. Every repair write
			// is checked first, so a second run continues from there.
			return (
				knownFormError(e) ?? {
					ok: false,
					error: `The repair stopped partway: ${errorText(
						e
					)}. Anything it wrote is kept, and running it again continues from there.`
				}
			);
		}
	}
);

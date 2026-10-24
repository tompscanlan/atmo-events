// Creating a group, its settings, and its refresh from the host, as remote forms.
import { error } from '@sveltejs/kit';
import { form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { can } from './permissions';
import type { GroupFormResult } from './form-result';
import { knownFormError, notAllowed } from './form-error';
import { didField, groupSettingsFields, shownVisibilityField } from './form-fields';
import { hostCreation, startCreateAtHost } from './create-at-host';
import { groupLinkClient } from './server/session';
import { kvAvatarStash } from './server/avatar-stash';
import { GROUP_CREATE_REDIRECT_PATH } from '$lib/atproto/settings';
import { runUpdateGroup } from './update-group';
import { groupRequestContext } from './remote-context';
import { describeRefresh, refreshGroup } from './server/refresh';
import { errorText } from './server/errors';

export const createGroupForm = form(
	v.object({
		...groupSettingsFields,
		locationName: v.optional(v.pipe(v.string(), v.maxLength(200))),
		/** The group's picture. Its type and size are checked by the create, so the
		 *  refusal reads as a sentence. An empty file input arrives as no value. */
		avatar: v.optional(v.file())
	}),
	async ({ avatar, ...data }): Promise<GroupFormResult<{ signUpUrl: string }>> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		const env = platform!.env;
		// The group host signs the creator up and makes the group, and the page
		// goes on to its sign-up page.
		const hostUrl = hostCreation(env);
		if (!hostUrl)
			return { ok: false, error: 'Group creation is not configured on this deployment.' };
		return startCreateAtHost({
			db: env.DB,
			client: groupLinkClient(env, locals.did),
			hostUrl,
			callerDid: locals.did,
			fields: data,
			redirectUri: env.OAUTH_PUBLIC_URL + GROUP_CREATE_REDIRECT_PATH,
			...(avatar ? { avatar: { image: avatar, stash: kvAvatarStash(env.OAUTH_STATES) } } : {})
		});
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
		const { db, env, group, membership, callerDid, reader } = await groupRequestContext(
			data.groupDid
		);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		return runUpdateGroup(env, db, group, { did: callerDid, reader }, data);
	}
);

/** Re-reads a group from its host into this site's copy (./server/refresh.ts).
 *  Needs MANAGE_GROUP. */
export const refreshGroupForm = form(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult<{ summary: string }>> => {
		const { db, env, group, membership, callerDid, reader } = await groupRequestContext(
			data.groupDid
		);
		if (!can(membership.permissions, 'MANAGE_GROUP')) {
			return notAllowed(membership, 'MANAGE_GROUP');
		}
		try {
			const result = await refreshGroup({ db, env, group, callerDid, reader });
			return { ok: true, summary: describeRefresh(result) };
		} catch (e) {
			// Otherwise the host or the database failed partway. Nothing at the host
			// changed, and running it again starts over.
			return (
				knownFormError(e) ?? {
					ok: false,
					error: `The refresh stopped partway: ${errorText(e)}. Nothing at the host was changed. Try it again.`
				}
			);
		}
	}
);

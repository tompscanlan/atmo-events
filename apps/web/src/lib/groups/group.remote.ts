// Creating a group and saving its settings, as remote forms.
import { error } from '@sveltejs/kit';
import { command, form, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import { can } from './permissions';
import type { GroupFormResult } from './form-result';
import { notAllowed } from './form-error';
import {
	didField,
	groupRulesField,
	groupSettingsFields,
	shownVisibilityField
} from './form-fields';
import { finishGroupSetup, hostCreation, startCreateAtHost } from './create-at-host';
import { groupLinkClient } from './server/session';
import { GROUP_CREATE_REDIRECT_PATH } from '$lib/atproto/settings';
import { runUpdateGroup } from './update-group';
import { groupRequestContext } from './remote-context';

export const createGroupForm = form(
	v.object({ ...groupSettingsFields, rules: groupRulesField }),
	async (data): Promise<GroupFormResult<{ signUpUrl: string }>> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did) error(401, 'Sign in to create a group');
		const env = platform!.env;
		// The group host signs the creator up and makes the group.
		const hostUrl = hostCreation(env);
		if (!hostUrl)
			return { ok: false, error: 'Group creation is not configured on this deployment.' };
		return startCreateAtHost({
			client: groupLinkClient(env, locals.did),
			hostUrl,
			callerDid: locals.did,
			fields: data,
			redirectUri: env.OAUTH_PUBLIC_URL + GROUP_CREATE_REDIRECT_PATH
		});
	}
);

export const finishGroupSetupCommand = command(
	v.object({ groupDid: didField }),
	async (data): Promise<GroupFormResult> => {
		const { locals, platform } = getRequestEvent();
		if (!locals.did || !platform?.env.DB) error(401, 'Sign in to finish setting up a group');
		const env = platform.env;
		return finishGroupSetup({
			env: { ...env, DB: env.DB },
			groupDid: data.groupDid,
			callerDid: locals.did
		});
	}
);

export const updateGroupForm = form(
	v.object({
		groupDid: didField,
		...groupSettingsFields,
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

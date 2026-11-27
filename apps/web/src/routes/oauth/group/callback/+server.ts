import { error, redirect } from '@sveltejs/kit';
import { CREATE_IN_THIS_BUILD } from '#lib/groups/build.js';
import { groupPath } from '#lib/groups/server/context.js';
import { finishCreatedGroup } from '#lib/groups/server/create.js';
import { finishGroupLink, groupSignInAvailable } from '#lib/groups/server/sign-in.js';

// Where the group's host returns after a person approves this site as the group. It sets
// no cookie: the browser stays signed in as that person.
export async function GET({ url, locals }) {
	if (!groupSignInAvailable()) error(404, 'Not found');
	const result = await finishGroupLink(url.searchParams, locals.did);
	if (!result.ok) {
		console.error(`[groups] a group link was refused: ${result.reason}`);
		redirect(303, '/groups?link=failed');
	}
	console.info(`[groups] ${result.groupDid} linked by ${locals.did}`);
	// A group they made here is set up once it is linked. Only a build that makes groups here has any.
	const made = CREATE_IN_THIS_BUILD
		? await finishCreatedGroup(result.groupDid, locals.did as string)
		: null;
	redirect(303, `${groupPath(result.groupDid)}?link=${made === 'created' ? 'created' : 'linked'}`);
}

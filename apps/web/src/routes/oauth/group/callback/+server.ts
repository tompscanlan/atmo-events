import { redirect } from '@sveltejs/kit';
import { groupPath } from '#lib/groups/server/context.js';
import { finishGroupLink, groupSignInAvailable } from '#lib/groups/server/sign-in.js';

// Where the group's host returns after a person approves this site as the group. It sets
// no cookie: the browser stays signed in as that person.
export async function GET({ url, locals }) {
	if (!groupSignInAvailable()) redirect(303, '/groups');
	const result = await finishGroupLink(url.searchParams, locals.did);
	if (!result.ok) {
		console.error(`[groups] a group link was refused: ${result.reason}`);
		redirect(303, '/groups?link=failed');
	}
	console.info(`[groups] ${result.groupDid} linked by ${locals.did}`);
	redirect(303, `${groupPath(result.groupDid)}?link=linked`);
}

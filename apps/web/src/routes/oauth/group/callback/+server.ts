import { redirect } from '@sveltejs/kit';
import { groupPath, requireGroupWriter } from '#lib/groups/server/context.js';
import { finishSetup } from '#lib/groups/server/create.js';
import { resolveGroup } from '#lib/groups/server/group.js';
import { finishGroupSignIn, groupSignInAvailable } from '#lib/groups/server/sign-in.js';

// Where the group's host returns after a person approves this site as the group, or makes
// a new group. It sets no cookie: the browser stays signed in as that person.
export async function GET({ url, locals }) {
	if (!groupSignInAvailable()) redirect(303, '/groups');
	const result = await finishGroupSignIn(url.searchParams, locals.did);
	if (!result.ok) {
		console.error(`[groups] a group sign-in was refused: ${result.reason}`);
		redirect(303, '/groups?link=failed');
	}
	console.info(`[groups] ${result.groupDid} signed in by ${locals.did}`);
	if (!result.created) redirect(303, `${groupPath(result.groupDid)}?link=linked`);

	// The creator is linked now, so a setup that stops partway is theirs to finish from the
	// group's page.
	let setup = 'done';
	try {
		const writer = await requireGroupWriter(result.groupDid, locals.did);
		const group = (await resolveGroup(result.groupDid)) ?? { did: result.groupDid, handle: null };
		await finishSetup(writer, group, { settings: result.created, by: locals.did as string });
	} catch (e) {
		console.error(`[groups] ${result.groupDid}'s setup stopped:`, e);
		setup = 'stopped';
	}
	redirect(303, `${groupPath(result.groupDid)}?created=${setup}`);
}

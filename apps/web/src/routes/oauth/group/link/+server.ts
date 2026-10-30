import { error, redirect } from '@sveltejs/kit';
import { atGroupHost, resolveGroup } from '#lib/groups/server/group.js';
import { groupSignInAvailable, startGroupLink } from '#lib/groups/server/sign-in.js';

// Starts signing in as a group. The group host decides who may: it turns away anyone
// without a role in the group.
export async function POST({ request, locals }) {
	if (!groupSignInAvailable()) error(404, 'Not found');
	if (!locals.did) redirect(303, '/login');

	const value = (await request.formData()).get('group');
	const actor = typeof value === 'string' ? value.trim().replace(/^@/, '') : '';
	const group = actor ? await resolveGroup(actor) : null;
	if (!group || !atGroupHost(group)) redirect(303, '/groups?link=not-here');

	let url: URL;
	try {
		url = await startGroupLink(group.did, locals.did);
	} catch (e) {
		console.error(`[groups] starting a link to ${group.did} failed:`, e);
		redirect(303, '/groups?link=failed');
	}
	// The OAuth client built it from the group's authorization server, not from input.
	redirect(303, url.toString(), { external: true });
}

import { error, redirect } from '@sveltejs/kit';
import { parseGroupSettings } from '#lib/groups/server/settings.js';
import { groupSignInAvailable, startGroupCreate } from '#lib/groups/server/sign-in.js';

// Starts making a group at this site's group host. The host makes the account during the
// creator's sign-in; the callback writes the settings.
export async function POST({ request, locals }) {
	if (!groupSignInAvailable()) error(404, 'Not found');
	if (!locals.did) redirect(303, '/login');

	const form = await request.formData();
	const settings = parseGroupSettings({
		name: form.get('name'),
		description: form.get('description') ?? '',
		joinPolicy: form.get('joinPolicy'),
		public: form.get('visibility') === 'public',
		listed: form.get('listed') === 'on'
	});
	if (!settings) redirect(303, '/groups/create?invalid=1');

	let url: URL;
	try {
		url = await startGroupCreate(locals.did, settings);
	} catch (e) {
		console.error('[groups] starting a create failed:', e);
		redirect(303, '/groups/create?failed=1');
	}
	// The OAuth client built it from the host's authorization server, not from input.
	redirect(303, url.toString(), { external: true });
}

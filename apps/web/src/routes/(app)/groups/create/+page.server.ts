import { env } from 'cloudflare:workers';
import { error, redirect } from '@sveltejs/kit';
import { groupSignInAvailable } from '#lib/groups/server/sign-in.js';

export function load({ locals, url }) {
	if (!env.GROUP_HOST_URL) error(404, 'Not found');
	if (!locals.did) redirect(303, '/login');
	return {
		pageTitle: 'Make a group',
		available: groupSignInAvailable(),
		notice: url.searchParams.has('invalid')
			? 'Check the name and description: a name is needed, up to 64 characters.'
			: url.searchParams.has('failed')
				? 'The group host could not be reached. Try again shortly.'
				: null
	};
}

import { error, json } from '@sveltejs/kit';
import { groupClientMetadata, groupSignInAvailable } from '#lib/groups/server/sign-in.js';

// The client a person signs in as a group with, at the group's host. Its own client_id,
// sharing the library's key.
export function GET() {
	if (!groupSignInAvailable()) error(404, 'Not found');
	return json(groupClientMetadata());
}

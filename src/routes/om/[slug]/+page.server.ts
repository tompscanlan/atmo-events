import { fail } from '@sveltejs/kit';
import { getEvent, attendEvent, cancelAttendEvent } from '$lib/openmeet/client';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.openmeetToken) {
		return { state: 'unauthenticated' as const, event: null };
	}

	try {
		const event = await getEvent(locals.openmeetToken, params.slug);

		if (!event) {
			return { state: 'not_found' as const, event: null };
		}

		return { state: 'ok' as const, event };
	} catch {
		return { state: 'not_found' as const, event: null };
	}
};

export const actions: Actions = {
	attend: async ({ params, locals }) => {
		if (!locals.openmeetToken) {
			return fail(401, { error: 'Not connected to OpenMeet' });
		}
		const result = await attendEvent(locals.openmeetToken, params.slug);
		if (!result) {
			return fail(500, { error: 'Failed to RSVP' });
		}
		return { success: true, status: result.status };
	},
	cancel: async ({ params, locals }) => {
		if (!locals.openmeetToken) {
			return fail(401, { error: 'Not connected to OpenMeet' });
		}
		const ok = await cancelAttendEvent(locals.openmeetToken, params.slug);
		if (!ok) {
			return fail(500, { error: 'Failed to cancel RSVP' });
		}
		return { success: true };
	}
};

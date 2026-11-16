import { redirect, type Cookies } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import { forgetAsked, privateEventAccess } from '#lib/private-events/permissions-asked.js';
import { holdsHostGrant } from '#lib/private-events/scopes.js';
import { ownCalendars } from '#lib/private-events/server/calendars.js';
import { callerSession, type CallerSession } from '#lib/private-events/server/caller.js';
import { privateEventsBeta } from '#lib/private-events/server/beta.js';
import { privateEventsEnabled, spacesServer } from '#lib/private-events/server/enabled.js';

/** Why "invited people only" needs a step first; null when it doesn't. */
function hostAccess(caller: CallerSession | null, cookies: Cookies) {
	if (!caller) return null;
	if (!holdsHostGrant(caller.scope, caller.did)) return privateEventAccess(cookies, caller.did);
	forgetAsked(cookies);
	return null;
}

/** The host's own shared calendars, to put the event on, with the one the address names when it is
 *  theirs; none when they can't be read. `capped` when there may be more. */
async function calendarsOf(caller: CallerSession | null, wanted: string | null) {
	const none = { calendars: [], capped: false };
	if (!caller || !holdsHostGrant(caller.scope, caller.did)) return none;
	const found = await ownCalendars(caller, wanted ? { wanted } : {}).catch((e) => {
		console.error(`[private-events] ${caller.did}: calendars unread for /create:`, e);
		return none;
	});
	return {
		calendars: found.calendars.map(({ key, name }) => ({ key, name })),
		capped: found.capped
	};
}

export async function load({ locals, cookies, url, setHeaders }) {
	if (!locals.did) {
		redirect(303, '/login');
	}

	// Offered to those who turned the beta on in Settings.
	const enabled = privateEventsEnabled() && (await privateEventsBeta(locals));
	const caller = enabled ? await callerSession(locals.session ?? null) : null;
	const own = enabled ? await calendarsOf(caller, url.searchParams.get('calendar')) : null;
	// The host's calendar names are seen only by them, so this page is then kept nowhere.
	if (own && own.calendars.length > 0) {
		setHeaders({ 'cache-control': 'private, no-store' });
	}
	return {
		pageTitle: 'Create Event',
		actorDid: locals.did,
		rkey: tidNow(),
		privateEvents: enabled,
		hostAccess: enabled ? hostAccess(caller, cookies) : null,
		spacesServer: enabled ? spacesServer() : null,
		calendars: own?.calendars ?? [],
		calendarsCapped: own?.capped ?? false
	};
}

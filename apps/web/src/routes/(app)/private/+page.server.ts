import { error, redirect } from '@sveltejs/kit';
import { forgetAsked, privateEventAccess } from '#lib/private-events/permissions-asked.js';
import { holdsCalendarGrant, holdsGuestGrant, holdsHostGrant } from '#lib/private-events/scopes.js';
import { myPrivateEventsAndCalendars } from '#lib/private-events/server/calendars.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsBeta } from '#lib/private-events/server/beta.js';
import { privateEventsEnabled, spacesServer } from '#lib/private-events/server/enabled.js';

export async function load({ locals, cookies, setHeaders }) {
	if (!privateEventsEnabled()) error(404, 'Not found');
	setHeaders({ 'cache-control': 'no-store' });
	const caller = await callerSession(locals.session ?? null);
	if (!caller) redirect(303, '/login');
	const beta = await privateEventsBeta(locals);
	const base = {
		pageTitle: 'Calendars',
		did: caller.did,
		beta,
		// Shared calendars are offered with the beta on. Making one asks for one more permission.
		calendarAccess: !beta
			? null
			: holdsCalendarGrant(caller.scope, caller.did)
				? ('ready' as const)
				: privateEventAccess(cookies, caller.did)
	};
	if (!holdsGuestGrant(caller.scope) && !holdsHostGrant(caller.scope, caller.did)) {
		return {
			...base,
			canList: false,
			calendars: [],
			incomplete: false,
			capped: false,
			access: privateEventAccess(cookies, caller.did),
			spacesServer: spacesServer()
		};
	}
	forgetAsked(cookies);
	// Events apart from any calendar are read only to tell them from calendars, and never sent: they
	// are listed in Your events on the home page.
	const { calendars, incomplete, capped } = await myPrivateEventsAndCalendars(caller, {
		calendarEvents: false
	}).catch((e) => {
		console.error(`[private-events] ${caller.did}: private events unread:`, e);
		error(503, 'Your calendars could not be read right now. Try again shortly.');
	});
	return {
		...base,
		canList: true,
		calendars,
		incomplete,
		capped,
		access: null,
		spacesServer: spacesServer()
	};
}

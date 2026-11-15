import { error } from '@sveltejs/kit';
import { getActor } from '#lib/actor.js';
import { forgetAsked, privateEventAccess } from '#lib/private-events/permissions-asked.js';
import { holdsGuestGrant, holdsHostGrant } from '#lib/private-events/scopes.js';
import { readCalendarPage } from '#lib/private-events/server/calendars.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsEnabled, spacesServer } from '#lib/private-events/server/enabled.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';

/** Byte for byte, so someone kept out can't tell a calendar that exists from one that doesn't, or
 *  from one that was deleted. */
const CALENDAR_NOT_AVAILABLE =
	"This calendar isn't available. It may have been deleted, or you may not be on it.";

// Each step below is the same at any address, so it says nothing about whether this calendar exists.
export async function load({ params, locals, cookies, setHeaders }) {
	if (!privateEventsEnabled()) error(404, 'Not found');
	setHeaders({ 'cache-control': 'no-store' });
	const host = await getActor(params.actor, timeLimitedNetwork());
	if (!host) error(404, CALENDAR_NOT_AVAILABLE);

	const caller = await callerSession(locals.session ?? null);
	const base = { pageTitle: 'Shared calendar', robots: 'noindex' };
	if (!caller) return { ...base, view: 'signed-out' as const };

	const isOwner = caller.did === host;
	const granted = isOwner
		? holdsHostGrant(caller.scope, caller.did)
		: holdsGuestGrant(caller.scope);
	if (!granted) {
		return {
			...base,
			view: 'grant' as const,
			isOwner,
			did: caller.did,
			access: privateEventAccess(cookies, caller.did),
			spacesServer: spacesServer()
		};
	}
	forgetAsked(cookies);
	const found = await readCalendarPage(caller, host, params.key).catch((e) => {
		console.error(`[private-events] ${host}: calendar ${params.key} unread for ${caller.did}:`, e);
		error(503, 'This calendar could not be read right now. Try again shortly.');
	});
	if (!found) error(404, CALENDAR_NOT_AVAILABLE);

	return {
		...base,
		view: 'calendar' as const,
		pageTitle: found.name ?? 'Shared calendar',
		calendar: found,
		isOwner,
		actor: found.ownerHandle ?? host
	};
}

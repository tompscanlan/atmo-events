import { error } from '@sveltejs/kit';
import { getActor } from '#lib/actor.js';
import { holdsHostGrant } from '#lib/private-events/scopes.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsEnabled } from '#lib/private-events/server/enabled.js';
import { isOwnCalendar, readPrivateEventForEdit } from '#lib/private-events/server/events.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

const EVENT_NOT_AVAILABLE = "This event isn't available.";

export async function load({ params, locals, setHeaders }) {
	if (!privateEventsEnabled()) error(404, 'Not found');
	setHeaders({ 'cache-control': 'no-store' });
	const host = await getActor(params.actor, timeLimitedNetwork());
	const caller = await callerSession(locals.session ?? null);
	if (!host || caller?.did !== host || !holdsHostGrant(caller.scope, caller.did)) {
		error(404, EVENT_NOT_AVAILABLE);
	}
	const keys = { spaceKey: params.key, rkey: params.rkey };
	// A single event's space with no name is no calendar: the same as a made-up address.
	const [eventData, onCalendar] = await Promise.all([
		readPrivateEventForEdit(caller, keys),
		// A space that isn't there reads as kept out, as `readPrivateEventForEdit` takes it.
		isOwnCalendar(caller, params.key).catch((e) => {
			if (isSpaceAccessDenied(e)) return false;
			throw e;
		})
	]).catch((e) => {
		console.error(`[private-events] event unread for its edit page: ${errorKind(e)}`);
		error(503, 'This event could not be read right now. Try again shortly.');
	});
	if (!eventData || !onCalendar) error(404, EVENT_NOT_AVAILABLE);
	return {
		pageTitle: 'Edit private event',
		eventData,
		actorDid: host,
		rkey: params.rkey,
		calendarKey: params.key
	};
}

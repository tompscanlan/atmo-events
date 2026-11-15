import { holdsGuestGrant, holdsHostGrant } from '#lib/private-events/scopes.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsEnabled } from '#lib/private-events/server/enabled.js';

/** `privateEventsGranted`: their session already lets atmo open private events, so the tab shows
 *  without the beta. A guest who answered from a host's link never turns the beta on, and the tab is
 *  their way back. Read from the session atmo holds, without asking their server. Both are typed
 *  optional, as before, so a page's test data needn't carry them. */
export async function load({
	locals
}: {
	locals: App.Locals;
}): Promise<{ privateEventsEnabled?: boolean; privateEventsGranted?: boolean }> {
	const enabled = privateEventsEnabled();
	if (!enabled || !locals.did)
		return { privateEventsEnabled: enabled, privateEventsGranted: false };
	const caller = await callerSession(locals.session ?? null);
	const granted =
		!!caller && (holdsGuestGrant(caller.scope) || holdsHostGrant(caller.scope, caller.did));
	return { privateEventsEnabled: enabled, privateEventsGranted: granted };
}

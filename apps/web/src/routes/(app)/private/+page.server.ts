import { error, redirect } from '@sveltejs/kit';
import { forgetAsked, privateEventAccess } from '#lib/private-events/permissions-asked.js';
import {
	GUEST_SCOPES,
	holdsGuestGrant,
	holdsHostGrant,
	holdsInboxGrant,
	HOST_SCOPES
} from '#lib/private-events/scopes.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsBeta } from '#lib/private-events/server/beta.js';
import { privateEventsEnabled, spacesServer } from '#lib/private-events/server/enabled.js';
import { myPrivateEvents } from '#lib/private-events/server/events.js';
import { ensureInbox, readInvitations } from '#lib/private-events/server/invites.js';

export async function load({ locals, cookies, setHeaders, url }) {
	if (!privateEventsEnabled()) error(404, 'Not found');
	setHeaders({ 'cache-control': 'no-store' });
	const caller = await callerSession(locals.session ?? null);
	if (!caller) redirect(303, '/login');
	const base = {
		pageTitle: 'Private events',
		did: caller.did,
		beta: await privateEventsBeta(locals)
	};
	const hosts = holdsHostGrant(caller.scope, caller.did);
	if (!holdsGuestGrant(caller.scope) && !hosts) {
		return {
			...base,
			events: null,
			invitations: null,
			invitationsIncomplete: false,
			invitationScopes: null,
			incomplete: false,
			access: privateEventAccess(cookies, caller.did),
			spacesServer: spacesServer()
		};
	}
	forgetAsked(cookies);
	// Someone who allowed private events before invitations existed has no inbox grant: the page
	// works as it did, and offers it. A new grant replaces the old, so it asks for what they hold too.
	const hasInbox = holdsInboxGrant(caller.scope, caller.did);
	await ensureInbox(caller, cookies, url);
	const [{ events, spaces, incomplete }, inbox] = await Promise.all([
		myPrivateEvents(caller).catch((e) => {
			console.error(`[private-events] ${caller.did}: private events unread:`, e);
			error(503, 'Your private events could not be read right now. Try again shortly.');
		}),
		hasInbox ? readInvitations(caller) : null
	]);
	// An event they host or have written in is on the list below, or was and they were taken off.
	const listed = new Set(spaces);
	return {
		...base,
		events,
		incomplete,
		invitations: inbox?.invitations.filter((invitation) => !listed.has(invitation.space)) ?? null,
		invitationsIncomplete: inbox?.incomplete ?? false,
		invitationScopes: hasInbox ? null : hosts ? HOST_SCOPES : GUEST_SCOPES,
		access: null,
		spacesServer: null
	};
}

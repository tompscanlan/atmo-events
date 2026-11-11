// What a person's own sign-in needs for private events, asked for when they first host or open one
// and never at sign-in, since most servers can't grant it yet. Values and pure checks only, so the
// OAuth config can import them.
import {
	EVENT_COLLECTION,
	INBOX_TYPE,
	INVITE_COLLECTION,
	PRIVATE_CALENDAR_TYPE,
	RSVP_COLLECTION
} from './ids';

const RECORD_ACTIONS = 'action=read&action=create&action=update&action=delete';

/** Their own events and their own answers to them, and managing each event's space. */
export const HOST_SCOPE = `space:${PRIVATE_CALENDAR_TYPE}?authority=self&collection=${EVENT_COLLECTION}&collection=${RSVP_COLLECTION}&${RECORD_ACTIONS}&manage=create&manage=update&manage=delete`;

/** Reading any private event that lets them in, and their own answer to it. No manage rights here:
 *  the only one a guest is asked for is making their own invitation inbox, below. */
export const GUEST_SCOPE = `space:${PRIVATE_CALENDAR_TYPE}?authority=*&collection=${RSVP_COLLECTION}&${RECORD_ACTIONS}`;

/** Making their own invitation inbox and reading the invites in it. The one manage right a guest is
 *  asked for: creating a space of the inbox type under their own account, and nothing to change or
 *  delete one. Collection and action are named, since a PDS widens a grant that names only a type
 *  from the type's declaration at every refresh. */
export const INBOX_OWNER_SCOPE = `space:${INBOX_TYPE}?authority=self&collection=${INVITE_COLLECTION}&action=read&manage=create`;

/** Putting an invite into a guest's inbox and taking it back. It reads nobody's inbox. */
export const INVITER_SCOPE = `space:${INBOX_TYPE}?authority=*&collection=${INVITE_COLLECTION}&action=create&action=delete`;

/** What a host is asked for. A host may also be someone else's guest, and a new grant must not cost
 *  them the other. `invitations` is the deployment's setting: off, nothing names the inbox type. */
export function hostScopes(invitations: boolean): readonly string[] {
	return invitations
		? [HOST_SCOPE, GUEST_SCOPE, INBOX_OWNER_SCOPE, INVITER_SCOPE]
		: [HOST_SCOPE, GUEST_SCOPE];
}

export function guestScopes(invitations: boolean): readonly string[] {
	return invitations ? [GUEST_SCOPE, INBOX_OWNER_SCOPE] : [GUEST_SCOPE];
}

/** Every one a sign-in may ask for, which the client has to declare. */
export const privateEventScopes = hostScopes;

const DEFAULT_ACTIONS: readonly string[] = ['read', 'create', 'update', 'delete'];

function grantsFor(scope: string, type: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${type}?`))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)));
}

const calendarGrants = (scope: string) => grantsFor(scope, PRIVATE_CALENDAR_TYPE);

function allows(grant: URLSearchParams, collection: string, action: string): boolean {
	const actions = grant.getAll('action');
	const collections = grant.getAll('collection');
	return (
		(actions.length > 0 ? actions : DEFAULT_ACTIONS).includes(action) &&
		(collections.includes('*') || collections.includes(collection))
	);
}

const allowsRecords = (grant: URLSearchParams, collection: string) =>
	allows(grant, collection, 'create');

/** A stock PDS drops a space grant it doesn't know, so this also says their PDS has spaces. A PDS
 *  hands `authority=self` back as the person's own DID, and leaves out `action` when it's all four. */
export function holdsHostGrant(scope: string, did: string): boolean {
	return calendarGrants(scope).some((grant) => {
		const authority = grant.get('authority') ?? 'self';
		const manage = grant.getAll('manage');
		return (
			(authority === 'self' || authority === did) &&
			['create', 'update', 'delete'].every((op) => manage.includes(op)) &&
			allowsRecords(grant, EVENT_COLLECTION) &&
			allowsRecords(grant, RSVP_COLLECTION)
		);
	});
}

export function holdsGuestGrant(scope: string): boolean {
	return calendarGrants(scope).some(
		(grant) => grant.get('authority') === '*' && allowsRecords(grant, RSVP_COLLECTION)
	);
}

/** They can have an invitation inbox and atmo can read it. Someone who allowed private events
 *  before invitations existed holds the grants above without this one. */
export function holdsInboxGrant(scope: string, did: string): boolean {
	return grantsFor(scope, INBOX_TYPE).some((grant) => {
		const authority = grant.get('authority') ?? 'self';
		return (
			(authority === 'self' || authority === did) &&
			grant.getAll('manage').includes('create') &&
			allows(grant, INVITE_COLLECTION, 'read')
		);
	});
}

export function holdsInviterGrant(scope: string): boolean {
	return grantsFor(scope, INBOX_TYPE).some(
		(grant) =>
			grant.get('authority') === '*' &&
			allows(grant, INVITE_COLLECTION, 'create') &&
			allows(grant, INVITE_COLLECTION, 'delete')
	);
}

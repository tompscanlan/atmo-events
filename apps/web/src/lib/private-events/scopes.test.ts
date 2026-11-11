import { describe, expect, it } from 'vitest';
import {
	GUEST_SCOPE,
	GUEST_SCOPES,
	HOST_SCOPE,
	HOST_SCOPES,
	holdsGuestGrant,
	holdsHostGrant,
	holdsInboxGrant,
	holdsInviterGrant,
	INBOX_OWNER_SCOPE,
	INVITER_SCOPE
} from './scopes';

const DID = 'did:plc:clv7dvrmqbpocpi5mt5sfsux';
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';

// As the spaces alpha hands a host's grant back: its authority as their DID, no `action`.
const HOST_AS_GRANTED = `space:rsvp.atmo.dev.space?authority=${DID}&collection=${EVENT}&collection=${RSVP}&manage=create&manage=update&manage=delete`;
const GUEST_AS_GRANTED = `space:rsvp.atmo.dev.space?authority=*&collection=${RSVP}&action=read&action=create&action=update&action=delete`;

describe('private event grants', () => {
	it('reads a host’s grant as a PDS hands it back', () => {
		expect(holdsHostGrant(`atproto ${HOST_AS_GRANTED}`, DID)).toBe(true);
	});

	it('does not read a grant over someone else’s spaces as hosting', () => {
		expect(holdsHostGrant(`atproto ${HOST_AS_GRANTED}`, 'did:plc:someoneelse')).toBe(false);
	});

	it('reads a guest’s grant as a PDS hands it back', () => {
		expect(holdsGuestGrant(`atproto ${GUEST_AS_GRANTED}`)).toBe(true);
	});

	it('tells a host from a guest', () => {
		expect(holdsHostGrant(`atproto ${HOST_SCOPE}`, DID)).toBe(true);
		expect(holdsGuestGrant(`atproto ${HOST_AS_GRANTED}`)).toBe(false);
		expect(holdsHostGrant(`atproto ${GUEST_AS_GRANTED}`, DID)).toBe(false);
	});

	it('never asks a guest for manage rights', () => {
		expect(GUEST_SCOPE).not.toContain('manage=');
	});

	it('finds nothing in what a stock PDS leaves after dropping the grants', () => {
		const left = 'atproto include:community.lexicon.calendar.authFull';
		expect(holdsHostGrant(left, DID)).toBe(false);
		expect(holdsGuestGrant(left)).toBe(false);
	});

	it('does not take a grant for another space type', () => {
		const other = GUEST_AS_GRANTED.replace('rsvp.atmo.dev.space', 'com.example.forum');
		expect(holdsGuestGrant(`atproto ${other}`)).toBe(false);
	});
});

// As the spaces alpha hands an inbox owner's grant back: its authority as their DID.
const OWNER_AS_GRANTED = `space:rsvp.atmo.dev.inbox?authority=${DID}&collection=rsvp.atmo.dev.invite&action=read&manage=create`;

describe('invitation inbox grants', () => {
	it('reads an owner’s grant as a PDS hands it back', () => {
		expect(holdsInboxGrant(`atproto ${OWNER_AS_GRANTED}`, DID)).toBe(true);
		expect(holdsInboxGrant(`atproto ${INBOX_OWNER_SCOPE}`, DID)).toBe(true);
	});

	it('does not read a grant over someone else’s inbox as owning one', () => {
		expect(holdsInboxGrant(`atproto ${OWNER_AS_GRANTED}`, 'did:plc:someoneelse')).toBe(false);
	});

	it('tells an owner from an inviter', () => {
		expect(holdsInviterGrant(`atproto ${INVITER_SCOPE}`)).toBe(true);
		expect(holdsInviterGrant(`atproto ${OWNER_AS_GRANTED}`)).toBe(false);
		expect(holdsInboxGrant(`atproto ${INVITER_SCOPE}`, DID)).toBe(false);
	});

	it('finds neither in the private event grants of before invitations', () => {
		const before = `atproto ${HOST_AS_GRANTED} ${GUEST_AS_GRANTED}`;
		expect(holdsInboxGrant(before, DID)).toBe(false);
		expect(holdsInviterGrant(before)).toBe(false);
	});

	it('finds neither in what a stock PDS leaves after dropping the grants', () => {
		expect(holdsInboxGrant('atproto', DID)).toBe(false);
		expect(holdsInviterGrant('atproto')).toBe(false);
	});

	it('asks a guest to let atmo make their inbox, and for no other manage right', () => {
		const manage = GUEST_SCOPES.flatMap((scope) =>
			new URLSearchParams(scope.slice(scope.indexOf('?') + 1)).getAll('manage')
		);
		expect(manage).toEqual(['create']);
		expect(INBOX_OWNER_SCOPE).toContain('authority=self');
	});

	it('lets an inviter write and take back invites, and read or change none', () => {
		const grant = new URLSearchParams(INVITER_SCOPE.slice(INVITER_SCOPE.indexOf('?') + 1));
		expect(grant.getAll('action').sort()).toEqual(['create', 'delete']);
		expect(grant.getAll('manage')).toEqual([]);
		expect(grant.getAll('collection')).toEqual(['rsvp.atmo.dev.invite']);
	});

	it('names a collection and an action in each, since a PDS widens a grant that names only a type', () => {
		for (const scope of [INBOX_OWNER_SCOPE, INVITER_SCOPE]) {
			expect(scope).toContain('collection=');
			expect(scope).toContain('action=');
		}
	});

	it('asks a guest for an inbox and a host for both, with what each already held', () => {
		expect(GUEST_SCOPES).toEqual([GUEST_SCOPE, INBOX_OWNER_SCOPE]);
		expect(HOST_SCOPES).toEqual([HOST_SCOPE, GUEST_SCOPE, INBOX_OWNER_SCOPE, INVITER_SCOPE]);
	});
});

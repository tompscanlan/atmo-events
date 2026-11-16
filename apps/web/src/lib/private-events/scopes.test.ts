import { describe, expect, it } from 'vitest';
import {
	CALENDAR_SCOPE,
	GUEST_SCOPE,
	HOST_SCOPE,
	HOST_SCOPES,
	holdsCalendarGrant,
	holdsGuestGrant,
	holdsHostGrant
} from './scopes';

const DID = 'did:plc:clv7dvrmqbpocpi5mt5sfsux';
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';

// As the spaces alpha hands a host's grant back: its authority as their DID, no `action`.
const HOST_AS_GRANTED = `space:community.lexicon.calendar.collection?authority=${DID}&collection=${EVENT}&collection=${RSVP}&manage=create&manage=update&manage=delete`;
const GUEST_AS_GRANTED = `space:community.lexicon.calendar.collection?authority=*&collection=${RSVP}&action=read&action=create&action=update&action=delete`;
const CALENDAR_AS_GRANTED = `space:community.lexicon.calendar.collection?authority=${DID}&collection=rsvp.atmo.dev.calendar`;

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
		const other = GUEST_AS_GRANTED.replace(
			'community.lexicon.calendar.collection',
			'com.example.forum'
		);
		expect(holdsGuestGrant(`atproto ${other}`)).toBe(false);
	});

	it('reads a calendar grant beside the host’s, as a PDS hands it back', () => {
		const granted = `atproto ${HOST_AS_GRANTED} ${CALENDAR_AS_GRANTED} ${GUEST_AS_GRANTED}`;
		expect(holdsCalendarGrant(granted, DID)).toBe(true);
		expect(holdsHostGrant(granted, DID)).toBe(true);
	});

	it('still reads a host grant from before calendars as hosting, but not as calendars', () => {
		const before = `atproto ${HOST_AS_GRANTED} ${GUEST_AS_GRANTED}`;
		expect(holdsHostGrant(before, DID)).toBe(true);
		expect(holdsCalendarGrant(before, DID)).toBe(false);
	});

	it('does not read calendar names alone, or over someone else’s spaces, as calendars', () => {
		expect(holdsCalendarGrant(`atproto ${CALENDAR_AS_GRANTED}`, DID)).toBe(false);
		const theirs = `atproto ${HOST_AS_GRANTED} ${CALENDAR_AS_GRANTED}`;
		expect(holdsCalendarGrant(theirs, 'did:plc:someoneelse')).toBe(false);
	});

	it('asks a new host for calendars too', () => {
		expect(holdsCalendarGrant(`atproto ${HOST_SCOPES.join(' ')}`, DID)).toBe(true);
	});

	it('keeps the host scope as it was, since a sign-in asks again for every scope it asked for', () => {
		expect(HOST_SCOPE).toBe(
			`space:community.lexicon.calendar.collection?authority=self&collection=${EVENT}&collection=${RSVP}&action=read&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`
		);
		expect(CALENDAR_SCOPE).not.toContain('manage=');
	});
});

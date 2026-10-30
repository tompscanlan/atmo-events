import { describe, expect, it } from 'vitest';
import {
	CALENDAR_RSVP_SCOPE,
	holdsCalendarGrant,
	holdsGroupScopes,
	holdsMetaRead,
	holdsSpaceList,
	LIST_GROUP_SPACES_SCOPE
} from './scopes';

// What a 10-29 alpha PDS returns for the participate set, expanded, with the list scope and
// the calendar grant, which it hands back as asked.
const EXPANDED = [
	'atproto',
	'space:group.opensocial.meta?authority=*&skey=self&action=read',
	'space:group.opensocial.members?authority=*&skey=self&collection=group.opensocial.acceptance',
	LIST_GROUP_SPACES_SCOPE,
	CALENDAR_RSVP_SCOPE
].join(' ');

describe('group scope checks', () => {
	it('reads the expanded participate set, the list scope and the calendar grant as enough', () => {
		expect(holdsGroupScopes(EXPANDED)).toBe(true);
		expect(holdsGroupScopes(EXPANDED.replace(CALENDAR_RSVP_SCOPE, ''))).toBe(false);
	});

	it('needs a meta read for any group, not one of the signer’s own', () => {
		expect(holdsMetaRead('space:group.opensocial.meta?action=read')).toBe(false);
		expect(holdsMetaRead('space:group.opensocial.meta?authority=*&action=read')).toBe(true);
		expect(holdsMetaRead('space:group.opensocial.meta?authority=*&action=create')).toBe(false);
	});

	it('needs the list scope at any space key, since listSpaces asks for any', () => {
		expect(holdsSpaceList(EXPANDED.replace(LIST_GROUP_SPACES_SCOPE, ''))).toBe(false);
		expect(
			holdsSpaceList('space:group.opensocial.members?authority=*&skey=self&action=read_self')
		).toBe(false);
		expect(holdsSpaceList(LIST_GROUP_SPACES_SCOPE)).toBe(true);
	});

	it('reads a sign-in without groups as not enough', () => {
		expect(holdsGroupScopes('atproto include:community.lexicon.calendar.authFull')).toBe(false);
	});

	it('takes the calendar grant for RSVPs in any group, or the one it names', () => {
		const group = 'did:plc:group';
		expect(holdsCalendarGrant(CALENDAR_RSVP_SCOPE, 'create', group)).toBe(true);
		const oneGroup = CALENDAR_RSVP_SCOPE.replace('authority=*', `authority=${group}`);
		expect(holdsCalendarGrant(oneGroup, 'delete', group)).toBe(true);
		expect(holdsCalendarGrant(oneGroup, 'read')).toBe(false);
		expect(holdsCalendarGrant(oneGroup, 'create', 'did:plc:other')).toBe(false);
	});

	it('writes RSVPs only with a grant naming their collection, while any read grant reads', () => {
		const readOnly = 'space:rsvp.atmo.group.calendar?authority=*&action=read';
		expect(holdsCalendarGrant(readOnly, 'read')).toBe(true);
		expect(holdsCalendarGrant(readOnly, 'create')).toBe(false);
		const events = CALENDAR_RSVP_SCOPE.replace(
			'community.lexicon.calendar.rsvp',
			'community.lexicon.calendar.event'
		);
		expect(holdsCalendarGrant(events, 'create')).toBe(false);
	});
});

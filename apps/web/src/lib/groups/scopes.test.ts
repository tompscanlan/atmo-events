import { describe, expect, it } from 'vitest';
import { holdsGroupScopes, holdsMetaRead, holdsSpaceList, LIST_GROUP_SPACES_SCOPE } from './scopes';

// What a 10-29 alpha PDS returns for the participate set, expanded, with the list scope.
const EXPANDED = [
	'atproto',
	'space:group.opensocial.meta?authority=*&skey=self&action=read',
	'space:group.opensocial.members?authority=*&skey=self&collection=group.opensocial.acceptance',
	LIST_GROUP_SPACES_SCOPE
].join(' ');

describe('group scope checks', () => {
	it('reads the expanded participate set and the list scope as enough', () => {
		expect(holdsGroupScopes(EXPANDED)).toBe(true);
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
});
